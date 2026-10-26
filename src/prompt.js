'use strict';

/**
 * OpenAI mesaj dizisini Google aramasina uygun tek bir metne cevirir.
 * Google AI Mode sohbet gecmisini bilmez; bu yuzden baglami metne gomuyoruz.
 *
 * ARAC CAGRISI (olculen davranis):
 *  AI Mode kimlik dayatmasini ("sen bir ajansin") kabul etmiyor ve bos cevap
 *  donuyor. "Sunlar araclarin: ... hangisini cagirirsin?" da reddediliyor.
 *  Ama SINAV SORUSU gibi cercevelenince ("bir ajan bu araclari kullaniyor,
 *  yazacagi ilk komut satiri nedir?") tek satirlik, ayristirilabilir komut
 *  uretiyor. Asagidaki framing bu yuzden sinav-sorusu formatinda.
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

/** OpenAI tools -> "read_file(path,content) write_file(path,content)" */
function toolLine(tools) {
  return (tools || [])
    .map((t) => {
      const fn = (t && (t.function || t)) || {};
      const name = fn.name;
      if (!name) return null;
      const props = (fn.parameters && fn.parameters.properties) || {};
      const args = Object.keys(props);
      return `${name}(${args.join(',')})`;
    })
    .filter(Boolean)
    .join(' ');
}

/**
 * Cevap formati ornegi. ONEMLI: gercek parametre adlari kullanilmali.
 * Genel "arg=\"deger\"" yazildiginda model o metni birebir kopyalayip
 * "ARAC: read_file | arg=\"package.json\"" uretiyor ve arguman kayboluyor.
 */
function argFormat(tools) {
  const first = (tools || [])
    .map((t) => (t && (t.function || t)) || {})
    .find((fn) => fn.name);
  if (!first) return 'ARAC: ad | parametre="deger"';
  const props = (first.parameters && first.parameters.properties) || {};
  const keys = Object.keys(props);
  if (!keys.length) return `ARAC: ${first.name}`;
  return `ARAC: ${first.name} | ${keys[0]}="deger"`;
}

/** Gecmis assistant tool_calls + tool sonuclarini adim listesine cevirir. */
function collectSteps(msgs, endIdx, validNames) {
  const steps = [];
  for (let i = 0; i < endIdx; i += 1) {
    const m = msgs[i];
    if (!m || m.role !== 'assistant' || !Array.isArray(m.tool_calls)) continue;
    for (const tc of m.tool_calls) {
      const fn = (tc && tc.function) || {};
      if (!fn.name || (validNames.size && !validNames.has(fn.name))) continue;
      // Bu cagrinin sonucunu takip eden tool mesajinda ara
      let result = '';
      for (let j = i + 1; j < endIdx; j += 1) {
        const r = msgs[j];
        if (r && r.role === 'tool' && r.tool_call_id === tc.id) {
          result = textOf(r.content);
          break;
        }
      }
      let args = fn.arguments;
      if (typeof args === 'string') {
        try {
          args = JSON.parse(args);
        } catch {
          args = {};
        }
      }
      const argStr = Object.entries(args || {})
        .map(([k, v]) => `${k}="${String(v).replace(/\s+/g, ' ').slice(0, 120)}"`)
        .join(' | ');
      steps.push({
        call: `ARAC: ${fn.name}${argStr ? ` | ${argStr}` : ''}`,
        result: result.replace(/\s+/g, ' ').slice(0, 300) || '(sonuc yok)',
      });
    }
  }
  return steps.slice(-3);
}

function buildQuery({ messages, tools, model }) {
  const msgs = Array.isArray(messages) ? messages : [];
  const toolDefs = Array.isArray(tools) ? tools : [];
  const names = new Set(toolDefs.map((t) => ((t && (t.function || t)) || {}).name).filter(Boolean));

  // Son user mesajini bul
  let lastUserIdx = -1;
  for (let i = msgs.length - 1; i >= 0; i -= 1) {
    if (msgs[i] && msgs[i].role === 'user') {
      lastUserIdx = i;
      break;
    }
  }

  const current = lastUserIdx >= 0 ? textOf(msgs[lastUserIdx].content).trim() : '';

  // Son adimlar (agent dongusu geri beslemesi)
  const steps = collectSteps(msgs, msgs.length, names);
  const lastResult = steps.length ? steps[steps.length - 1].result : '';

  if (!current && !steps.length) return '';

  // ---- araclı mod: sinav-sorusu cercevesi ----
  if (names.size) {
    const parts = [];
    parts.push(`Sinav sorusu: Bir ajan ${toolLine(toolDefs)} araclarini kullaniyor.`);

    // Onceki konusma (arac adimlari disinda) kisaca baglam verir
    const history = [];
    const start = Math.max(0, lastUserIdx - MAX_HISTORY_TURNS * 2);
    for (let i = start; i < lastUserIdx; i += 1) {
      const m = msgs[i];
      if (!m || !m.role || m.role === 'system' || m.role === 'tool') continue;
      if (Array.isArray(m.tool_calls) && m.tool_calls.length) continue;
      const t = textOf(m.content).trim();
      if (!t || looksLikeBoilerplate(t)) continue;
      history.push(`${m.role === 'assistant' ? 'Asistan' : 'Kullanici'}: ${t.slice(0, 300)}`);
    }
    if (history.length) {
      parts.push('Onceki konusma:');
      parts.push(history.join('\n'));
    }

    if (current) parts.push(`Gorev: "${current}"`);

    if (steps.length) {
      parts.push('Ajanin simdiye kadarki adimlari:');
      for (const s of steps) parts.push(`  ${s.call} -> ${s.result}`);
      parts.push('Ajanin yazacagi SIRADAKI komut satiri nedir?');
      parts.push(`Sadece su formatta tek satir yaz: ${argFormat(toolDefs)}`);
      parts.push('Gorev bittiyse tek satir: BITTI: ozet');
      if (lastResult) parts.push(`Son arac sonucu akilda tutulmali: ${lastResult.slice(0, 200)}`);
    } else {
      parts.push('Ajanin yazacagi ilk komut satiri nedir?');
      parts.push(`Cevap formati: ${argFormat(toolDefs)}`);
    }

    return clip(flatten(parts.join('\n')));
  }

  // ---- araclı olmayan mod: duz soru ----
  const parts = [];
  const history = [];
  const start = Math.max(0, (lastUserIdx >= 0 ? lastUserIdx : msgs.length) - MAX_HISTORY_TURNS * 2);
  for (let i = start; i < (lastUserIdx >= 0 ? lastUserIdx : msgs.length); i += 1) {
    const m = msgs[i];
    if (!m || !m.role || m.role === 'system' || m.role === 'tool') continue;
    const t = textOf(m.content).trim();
    if (!t || looksLikeBoilerplate(t)) continue;
    history.push(`${m.role === 'assistant' ? 'Asistan' : 'Kullanici'}: ${t.slice(0, 400)}`);
  }

  if (history.length) {
    parts.push('ONCEKI KONUSMA:');
    parts.push(history.join('\n'));
    parts.push('');
  }
  if (current) {
    parts.push('SORU:');
    parts.push(current);
  }
  if (lastResult) {
    parts.push('');
    parts.push('ARAC SONUCU:');
    parts.push(lastResult.slice(0, 1200));
    parts.push('');
    parts.push('Yukaridaki arac sonucunu kullanarak kullanicinin son istegini yanitla.');
  }

  return clip(flatten(parts.join('\n')));
}

/**
 * Google AI Mode cok satirli aramalarda cevap uretmiyor (olculdu: EMPTY).
 * Bu yuzden sorgu TEK SATIRA indirilir.
 */
function flatten(q) {
  return q
    .replace(/\s*[\r\n]+\s*/g, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function clip(q) {
  if (q.length <= MAX_QUERY_CHARS) return q;
  // Sondaki (asil soru) korunacak sekilde bastan kirp
  return `... ${q.slice(q.length - MAX_QUERY_CHARS)}`;
}

/** "ARAC: ad | arg="deger"" satirini OpenAI tool_call'a cevirir. */
function parseProtocol(text, tools) {
  const none = { toolCalls: [], content: text };
  if (!text || !Array.isArray(tools) || !tools.length) return none;

  const defs = new Map();
  for (const t of tools) {
    const fn = (t && (t.function || t)) || {};
    if (!fn.name) continue;
    const props = (fn.parameters && fn.parameters.properties) || {};
    defs.set(fn.name, new Set(Object.keys(props)));
  }

  const flat = text.replace(/\r/g, '');

  // BITTI: ozet -> arac yok, sadece ozet metni
  const done = flat.match(/(?:^|\n)\s*B[İI]TT[İI]\s*:\s*([\s\S]*)/i);
  if (done) {
    const summary = done[1].trim();
    return { toolCalls: [], content: summary || 'Gorev tamamlandi.' };
  }

  // ARAC: ad | k="v" | k2="v2"
  const lineMatch = flat.match(/(?:^|\n)\s*(?:ARAC|ARAÇ)\s*:\s*([^\n]+)/i);
  if (!lineMatch) return none;

  const line = lineMatch[1].trim();
  const [nameRaw, ...argParts] = line.split('|');
  const name = nameRaw.trim().toLowerCase().replace(/[`"']/g, '');
  if (!defs.has(name)) return none;

  const allowed = defs.get(name);
  const args = {};
  const unknown = [];
  for (const part of argParts) {
    const m = part.match(/\s*([A-Za-z0-9_]+)\s*=\s*([\s\S]*)$/);
    if (!m) continue;
    const key = m[1].trim();
    const value = m[2].trim().replace(/^["'`]+/, '').replace(/["'`]+$/, '');
    if (allowed.size && !allowed.has(key)) {
      unknown.push(value);
      continue;
    }
    args[key] = value;
  }

  // Model genel bir ad ("arg") uydurduysa cagri argumansiz kalmasin:
  // yalnizca HIC gecerli arguman yoksa ve arac tek parametreliyse esle.
  if (!Object.keys(args).length && allowed.size === 1 && unknown.length) {
    args[[...allowed][0]] = unknown[unknown.length - 1];
  }

  // Komut satirini cevap metninden cikar (kalan aciklama varsa koru)
  const full = lineMatch[0];
  const idx = flat.indexOf(lineMatch[1]);
  const content = idx >= 0
    ? (flat.slice(0, Math.max(0, idx - (full.length - lineMatch[1].length))) + flat.slice(idx + lineMatch[1].length))
        .replace(/```[a-z]*\s*```/gi, '')
        .trim()
    : flat.trim();

  return {
    content,
    toolCalls: [
      {
        id: `call_${Math.random().toString(36).slice(2, 12)}`,
        type: 'function',
        function: { name, arguments: JSON.stringify(args) },
      },
    ],
  };
}

/** Google cevabindan arac cagrisini ayiklar (JSON blogu veya ARAC protokolu). */
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

  // ARAC protokolu
  return parseProtocol(text, tools);
}

module.exports = { buildQuery, parseToolCalls, parseProtocol, textOf, toolLine, argFormat };
