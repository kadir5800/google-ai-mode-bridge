'use strict';

/**
 * AI Mode'u beyin olarak kullanan agent dongusu.
 *
 * AI Mode native function calling yapamaz, ama BASIT BIR METIN PROTOKOLU
 * uretebiliyor (test edildi):
 *
 *    ARAC: read_file | path="a.txt"
 *    ARAC: list_dir  | path="src"
 *    ARAC: write_file| path="a.txt" | content="merhaba"
 *    BITTI: <ozet>
 *
 * Dongu istemci tarafinda: arac calisir -> gozlem metne eklenir -> tekrar sorulur.
 * Yani agent davranisi modelden degil, bu donguden gelir.
 */

const fs = require('fs/promises');
const path = require('path');
const { GoogleAiModeEngine } = require('./engine');

// ---------------------------------------------------------------- araclar

const WORKSPACE = process.cwd();

/** Guvenlik: workspace disina cikmayi engelle. */
function safePath(p) {
  const abs = path.resolve(WORKSPACE, p);
  const rel = path.relative(WORKSPACE, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Erisim reddedildi (workspace disi): ${p}`);
  }
  return abs;
}

const TOOLS = {
  list_dir: {
    args: ['path'],
    desc: 'Dizindeki dosyalari listeler',
    run: async ({ path: p = '.' }) => {
      const dir = safePath(p);
      const items = await fs.readdir(dir, { withFileTypes: true });
      return (
        items
          .slice(0, 200)
          .map((i) => (i.isDirectory() ? `${i.name}/` : i.name))
          .join('\n') || '(bos)'
      );
    },
  },

  read_file: {
    args: ['path'],
    desc: 'Dosya icerigini okur',
    run: async ({ path: p }) => {
      const abs = safePath(p);
      const st = await fs.stat(abs);
      if (st.size > 200_000) throw new Error('Dosya cok buyuk (>200KB)');
      return await fs.readFile(abs, 'utf8');
    },
  },

  write_file: {
    args: ['path', 'content'],
    desc: 'Dosyaya yazar (varsa uzerine yazar)',
    run: async ({ path: p, content = '' }) => {
      const abs = safePath(p);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, content, 'utf8');
      return `Yazildi: ${p} (${content.length} karakter)`;
    },
  },

  grep: {
    args: ['pattern', 'path'],
    desc: 'Dosyalarda metin arar',
    run: async ({ pattern, path: p = '.' }) => {
      const abs = safePath(p);
      const re = new RegExp(pattern, 'i');
      const hits = [];
      async function walk(dir) {
        for (const e of await fs.readdir(dir, { withFileTypes: true })) {
          if (e.name === 'node_modules' || e.name === '.git') continue;
          const full = path.join(dir, e.name);
          if (e.isDirectory()) {
            await walk(full);
            continue;
          }
          if (e.size > 500_000) continue;
          const txt = await fs.readFile(full, 'utf8').catch(() => '');
          txt.split('\n').forEach((ln, i) => {
            if (re.test(ln)) hits.push(`${path.relative(WORKSPACE, full)}:${i + 1}: ${ln.trim().slice(0, 120)}`);
          });
          if (hits.length > 40) return;
        }
      }
      await walk(abs);
      return hits.slice(0, 40).join('\n') || '(eslesme yok)';
    },
  },
};

const TOOL_LIST = Object.entries(TOOLS)
  .map(([name, t]) => `- ${name}(${t.args.join(', ')}): ${t.desc}`)
  .join('\n');

// ---------------------------------------------------------------- protokol

/**
 * AI Mode'a verilecek metni kurar.
 *
 * OLCULEN DAVRANIS (onemli):
 *  - "Su araclara sahipsin..."      -> AI Mode reddediyor / bos cevap
 *  - "Sen bir ajansin..."           -> reddediyor
 *  - "Sinav sorusu: bir ajan ..."   -> DOGRU FORMATI URETIYOR  ✅
 *
 * Ek olarak: AI Mode COK SATIRLI sorgularda bos cevap donuyor. Prompt bu
 * yuzden tek satira indirilir (buildPrompt sonunda).
 *
 * Bu yuzden prompt bir SINAV SORUSU gibi cercevelenir: AI Mode kimlik
 * dayatmasini kabul etmiyor ama "bu senaryoda ajan ne yazardı" sorusuna
 * formatli cevap veriyor.
 */
function buildPrompt({ task, history, observation }) {
  const tools = Object.keys(TOOLS)
    .map((n) => `${n}(${TOOLS[n].args.join(',')})`)
    .join(' ');

  const parts = [];

  if (history.length) {
    parts.push(`Sinav sorusu: Bir ajan ${tools} araclarini kullaniyor.`);
    parts.push(`Gorev: "${task}"`);
    parts.push('Ajanin simdiye kadarki adimlari:');
    for (const h of history.slice(-3)) {
      parts.push(
        `  ${h.call} -> ${h.result.replace(/\s+/g, ' ').slice(0, 250)}`,
      );
    }
    parts.push('Ajanin yazacagi SIRADAKI komut satiri nedir?');
    parts.push('Sadece su formatta tek satir yaz: ARAC: ad | arg="deger"');
    parts.push('Gorev bittiyse: BITTI: ozet');
  } else {
    parts.push(`Sinav sorusu: Bir ajan ${tools} araclarini kullaniyor.`);
    parts.push(`Gorev: "${task}".`);
    parts.push('Ajanin yazacagi ilk komut satiri nedir?');
    parts.push('Cevap formati: ARAC: ad | arg="deger"');
    if (observation) {
      parts.push(`Not: ${observation.replace(/\s+/g, ' ').slice(0, 300)}`);
    }
  }

  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

/** Cevaptan arac cagrisini ayiklar. */
function parseAction(text) {
  if (!text) return null;
  const flat = text.replace(/\r/g, '');

  // BITTI
  const doneMatch = flat.match(/(?:^|\n)\s*B[İI]TT[İI]\s*:\s*([\s\S]*)/i);
  if (doneMatch) return { type: 'done', summary: doneMatch[1].trim() };

  // ARAC: ad | k="v" | k2="v2"
  const lineMatch = flat.match(/(?:^|\n)\s*(?:ARAC|ARAÇ)\s*:\s*([^\n]+)/i);
  if (!lineMatch) return null;

  const line = lineMatch[1].trim();
  const [nameRaw, ...argParts] = line.split('|');
  const name = nameRaw.trim().toLowerCase().replace(/[`"']/g, '');
  if (!TOOLS[name]) return { type: 'unknown', name, raw: line };

  const args = {};
  for (const part of argParts) {
    const m = part.match(/\s*([A-Za-z0-9_]+)\s*=\s*([\s\S]*)$/);
    if (!m) continue;
    let value = m[2].trim();
    // tirnaklari soy
    value = value.replace(/^["'`]+/, '').replace(/["'`]+$/, '');
    args[m[1].trim()] = value;
  }

  return { type: 'call', name, args, raw: line };
}

// ---------------------------------------------------------------- dongu

async function runAgent(task, opts = {}) {
  const engine = new GoogleAiModeEngine();
  const maxSteps = opts.maxSteps || 6;
  const history = [];
  const transcript = [];

  console.log(`\nGOREV: ${task}`);
  console.log(`Workspace: ${WORKSPACE}`);
  console.log(`Maks adim: ${maxSteps}\n`);

  let observation = '';

  try {
    for (let step = 1; step <= maxSteps; step += 1) {
      const prompt = buildPrompt({ task, history, observation });
      const t0 = Date.now();

      process.stdout.write(`[${step}/${maxSteps}] AI Mode'a soruluyor... `);
      let answer;
      try {
        answer = await engine.ask(prompt);
      } catch (e) {
        console.log(`HATA\n  ${e.message.slice(0, 200)}`);
        transcript.push({ step, error: e.message });
        break;
      }
      console.log(`${((Date.now() - t0) / 1000).toFixed(1)}s`);

      const raw = answer.text.trim();
      transcript.push({ step, raw });

      const action = parseAction(raw);

      if (!action) {
        console.log('  Yorumlanamadi. Ham cevap:');
        console.log(`  ${raw.slice(0, 300).replace(/\n/g, '\n  ')}`);
        break;
      }

      if (action.type === 'done') {
        console.log(`\nBITTI: ${action.summary}`);
        transcript.push({ step, done: action.summary });
        break;
      }

      if (action.type === 'unknown') {
        console.log(`  Bilinmeyen arac: ${action.name}`);
        observation = `HATA: "${action.name}" diye bir arac yok. Mevcut araclar: ${Object.keys(TOOLS).join(', ')}`;
        history.push({ call: action.raw, result: observation });
        continue;
      }

      console.log(`  ARAC: ${action.name} ${JSON.stringify(action.args).slice(0, 120)}`);

      let result;
      try {
        result = await TOOLS[action.name].run(action.args);
      } catch (e) {
        result = `HATA: ${e.message}`;
      }

      const preview = String(result).replace(/\n/g, ' ').slice(0, 120);
      console.log(`  SONUC: ${preview}${String(result).length > 120 ? '...' : ''}`);

      history.push({ call: action.raw, result: String(result) });
      observation = String(result);
      transcript.push({ step, tool: action.name, args: action.args, result: String(result).slice(0, 2000) });
    }
  } finally {
    await engine.close();
  }

  return transcript;
}

module.exports = { runAgent, parseAction, TOOLS };

// CLI
if (require.main === module) {
  const task = process.argv.slice(2).join(' ').trim();
  if (!task) {
    console.error('Kullanim: npm run agent -- "gorev tanimi"');
    process.exit(1);
  }
  runAgent(task)
    .then(() => process.exit(0))
    .catch((e) => {
      console.error(`Beklenmeyen hata: ${e.message}`);
      process.exit(1);
    });
}
