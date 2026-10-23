'use strict';

const http = require('http');
const crypto = require('crypto');
const cfg = require('./config');
const { GoogleAiModeEngine } = require('./engine');
const { buildQuery, parseToolCalls } = require('./prompt');

const engine = new GoogleAiModeEngine();

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

function json(res, code, body) {
  const data = JSON.stringify(body);
  res.writeHead(code, {
    ...CORS,
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
  });
  res.end(data);
}

function authOk(req) {
  if (!cfg.apiKey) return true;
  const h = req.headers['authorization'] || '';
  const token = h.replace(/^Bearer\s+/i, '').trim();
  if (!token) return true; // Cursor bazen bos anahtar gonderir
  return token === cfg.apiKey;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 8 * 1024 * 1024) {
        reject(new Error('Istek cok buyuk'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch (e) {
        reject(new Error(`Gecersiz JSON: ${e.message}`));
      }
    });
    req.on('error', reject);
  });
}

const newId = (p) => `${p}-${crypto.randomBytes(12).toString('hex')}`;

function usageOf(text) {
  const t = Math.max(1, Math.ceil((text || '').length / 4));
  return { prompt_tokens: 0, completion_tokens: t, total_tokens: t };
}

function formatContent(answer) {
  let out = answer.text;
  if (answer.sources && answer.sources.length) {
    out += '\n\n---\nKaynaklar:\n';
    answer.sources.forEach((s, i) => {
      out += `${i + 1}. [${s.title}](${s.url})\n`;
    });
  }
  return out;
}

async function handleChat(req, res, body) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const tools = Array.isArray(body.tools) ? body.tools : [];
  const model = body.model || cfg.modelIds[0];

  const query = buildQuery({ messages, tools, model });
  if (!query) {
    return json(res, 400, { error: { message: 'Bos istek: mesaj yok.', type: 'invalid_request_error' } });
  }

  let answer;
  try {
    answer = await engine.ask(query);
  } catch (e) {
    return json(res, 502, {
      error: {
        message: e.message,
        type: 'upstream_error',
        code: /BLOCKED/.test(e.message) ? 'blocked' : 'extraction_failed',
      },
    });
  }

  const parsed = parseToolCalls(answer.text, tools);
  const chatId = newId('chatcmpl');
  const created = Math.floor(Date.now() / 1000);

  const message = {
    role: 'assistant',
    content: parsed.toolCalls.length ? parsed.content || null : formatContent(answer),
  };
  if (parsed.toolCalls.length) message.tool_calls = parsed.toolCalls;

  if (!body.stream) {
    return json(res, 200, {
      id: chatId,
      object: 'chat.completion',
      created,
      model,
      choices: [{ index: 0, message, finish_reason: parsed.toolCalls.length ? 'tool_calls' : 'stop' }],
      usage: usageOf(answer.text),
    });
  }

  // ---- SSE streaming ----
  res.writeHead(200, {
    ...CORS,
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
  const base = { id: chatId, object: 'chat.completion.chunk', created, model };
  const chunk = (delta, finish) =>
    send({ ...base, choices: [{ index: 0, delta, finish_reason: finish ?? null }] });

  chunk({ role: 'assistant', content: '' });

  if (parsed.toolCalls.length) {
    chunk({
      tool_calls: parsed.toolCalls.map((tc, i) => ({
        index: i,
        id: tc.id,
        type: 'function',
        function: { name: tc.function.name, arguments: '' },
      })),
    });
    for (let i = 0; i < parsed.toolCalls.length; i += 1) {
      chunk({ tool_calls: [{ index: i, function: { arguments: parsed.toolCalls[i].function.arguments } }] });
    }
    chunk({}, 'tool_calls');
  } else {
    const full = formatContent(answer);
    const parts = full.match(/[\s\S]{1,24}/g) || [full];
    for (const p of parts) {
      chunk({ content: p });
      await new Promise((r) => setTimeout(r, 12));
    }
    chunk({}, 'stop');
  }

  res.write('data: [DONE]\n\n');
  return res.end();
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    return res.end();
  }

  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'GET' && (url.pathname === '/health' || url.pathname === '/')) {
    return json(res, 200, {
      status: 'ok',
      busy: engine.busy,
      models: cfg.modelIds,
      profile: cfg.profileDir,
    });
  }

  if (req.method === 'GET' && url.pathname === '/v1/models') {
    return json(res, 200, {
      object: 'list',
      data: cfg.modelIds.map((m) => ({
        id: m,
        object: 'model',
        created: Math.floor(Date.now() / 1000),
        owned_by: 'google-ai-mode-bridge',
      })),
    });
  }

  if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
    if (!authOk(req)) {
      return json(res, 401, { error: { message: 'Gecersiz API anahtari.', type: 'auth_error' } });
    }
    let body;
    try {
      body = await readBody(req);
    } catch (e) {
      return json(res, 400, { error: { message: e.message, type: 'invalid_request_error' } });
    }
    try {
      return await handleChat(req, res, body);
    } catch (e) {
      if (!res.headersSent) {
        return json(res, 500, { error: { message: e.message, type: 'server_error' } });
      }
      res.end();
      return undefined;
    }
  }

  return json(res, 404, { error: { message: `Bilinmeyen yol: ${url.pathname}`, type: 'not_found' } });
});

server.listen(cfg.port, cfg.host, () => {
  const base = `http://${cfg.host}:${cfg.port}`;
  console.log('');
  console.log('  Google AI Mode -> OpenAI uyumlu kopru');
  console.log('  ------------------------------------');
  console.log(`  Base URL : ${base}/v1`);
  console.log(`  API Key  : ${cfg.apiKey}`);
  console.log(`  Modeller : ${cfg.modelIds.join(', ')}`);
  console.log(`  Saglik   : ${base}/health`);
  console.log(`  Profil   : ${cfg.profileDir}`);
  console.log('');
  console.log('  Cursor: Settings > Models > OpenAI API');
  console.log(`    Base URL: ${base}/v1`);
  console.log(`    API Key : ${cfg.apiKey}`);
  console.log('');
});

async function shutdown() {
  console.log('\nKapatiliyor...');
  await engine.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
