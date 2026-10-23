'use strict';

/**
 * OpenAI mesaj dizisini Google aramasina uygun tek bir metne cevirir.
 * Google AI Mode sohbet gecmisini bilmez; bu yuzden baglami metne gomuyoruz.
 */

const MAX_QUERY_CHARS = 1800;
const MAX_HISTORY_TURNS = 4;

function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => {
        if (typeof p === 'string') return p;
        if (p && p.type === 'text') return p.text || '';
        if (p && p.type === 'image_url') return '[gorsel]';
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

function looksLikeBoilerplate(s) {
  // Cursor'un dev sistem prompt'u aramaya gomulmemeli
  const t = s.toLowerCase();
  return (
    t.includes('you are an ai assistant') ||
    t.includes('you are cursor') ||
    t.includes('expert ai coding assistant') ||
    t.includes('# tools') ||
    t.includes('always follow these') ||
    s.length > 6000
  );
}

function buildToolInstruction(tools) {
  // ONEMLI: Google AI Mode bir arama motorudur; arama metnine "JSON olarak yanitla"
  // gibi talimatlar eklendiginde arama anlamsizlasip AI cevabi uretilmiyor.
  // Bu yuzden arac listesi aramaya GOMULMEZ. Asagidaki not yalnizca modelin
  // yanitinda arac cagrisi JSON'u gorurse ayiklamak icindir (parseToolCalls).
  return '';
}

function buildQuery({ messages, tools, model }) {
  const msgs = Array.isArray(messages) ? messages : [];

  // Son user mesajini bul
  let lastUserIdx = -1;
  for (let i = msgs.length - 1; i >= 0; i -= 1) {
    if (msgs[i] && msgs[i].role === 'user') {
      lastUserIdx = i;
      break;
    }
  }

  const toolBlock = ''; // arama metnine arac talimati eklenmez (bkz. buildToolInstruction)

  // Tool sonucu varsa (agent dongusu) onu one cikar
  let toolResult = '';
  for (let i = msgs.length - 1; i >= 0; i -= 1) {
    if (msgs[i] && msgs[i].role === 'tool') {
      toolResult = textOf(msgs[i].content).slice(0, 1200);
      break;
    }
  }

  const current = lastUserIdx >= 0 ? textOf(msgs[lastUserIdx].content).trim() : '';

  if (!current && !toolResult) return '';

  // Gecmis: son N tur (system/boilerplate haric)
  const history = [];
  const start = Math.max(0, (lastUserIdx >= 0 ? lastUserIdx : msgs.length) - MAX_HISTORY_TURNS * 2);
  for (let i = start; i < (lastUserIdx >= 0 ? lastUserIdx : msgs.length); i += 1) {
    const m = msgs[i];
    if (!m || !m.role || m.role === 'system') continue;
    const t = textOf(m.content).trim();
    if (!t || looksLikeBoilerplate(t)) continue;
    const label = m.role === 'assistant' ? 'Asistan' : 'Kullanici';
    history.push(`${label}: ${t.slice(0, 400)}`);
  }

  const parts = [];
  if (history.length) {
    parts.push('ONCEKI KONUSMA:');
    parts.push(history.join('\n'));
    parts.push('');
  }
  if (current) {
    parts.push('SORU:');
    parts.push(current);
  }
  if (toolResult) {
    parts.push('');
    parts.push('ARAC SONUCU:');
    parts.push(toolResult);
    parts.push('');
    parts.push('Yukaridaki arac sonucunu kullanarak kullanicinin son istegini yanitla.');
  }

  let q = parts.join('\n').trim();
  if (q.length > MAX_QUERY_CHARS) {
    // Sondaki (asil soru) korunacak sekilde bastan kirp
    q = `...\n${q.slice(q.length - MAX_QUERY_CHARS)}`;
  }
  return q;
}

/** Google cevabindan arac cagrisi JSON'u ayiklar. */
function parseToolCalls(text, tools) {
  const none = { toolCalls: [], content: text };
  if (!text || !Array.isArray(tools) || !tools.length) return none;

  const validNames = new Set(
    tools.map((t) => (t.function || t || {}).name).filter(Boolean),
  );

  // ```json ... ``` veya ciplak JSON blogu ara
  const blocks = [];
  const fenceRe = /```(?:json)?\s*([\s\S]*?)```/g;
  let m;
  while ((m = fenceRe.exec(text)) !== null) blocks.push(m[1].trim());
  if (!blocks.length) {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) blocks.push(text.slice(start, end + 1));
  }

  for (const raw of blocks) {
    let obj;
    try {
      obj = JSON.parse(raw);
    } catch {
      continue;
    }
    const call = obj && (obj.tool_call || obj.tool_calls?.[0] || obj);
    const fn = call && (call.function || call);
    const name = fn && (fn.name || call.name);
    if (!name || !validNames.has(name)) continue;

    let args = fn.arguments ?? call.arguments ?? {};
    if (typeof args === 'string') {
      try {
        args = JSON.parse(args);
      } catch {
        args = { input: args };
      }
    }

    // JSON blogunu metinden cikar
    const content = text.replace(raw, '').replace(/```(?:json)?\s*```/g, '').trim();

    return {
      content,
      toolCalls: [
        {
          id: `call_${Math.random().toString(36).slice(2, 12)}`,
          type: 'function',
          function: { name, arguments: JSON.stringify(args ?? {}) },
        },
      ],
    };
  }

  return none;
}

module.exports = { buildQuery, parseToolCalls, textOf };
