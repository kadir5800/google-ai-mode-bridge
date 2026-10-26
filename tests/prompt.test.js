'use strict';

/**
 * Prompt kurma ve protokol ayristirma testleri.
 * Calistir: npm test   (ag/tarayici gerektirmez)
 */

const test = require('node:test');
const assert = require('node:assert');
const { buildQuery, parseToolCalls, parseProtocol } = require('../src/prompt');

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Dosya okur',
      parameters: { type: 'object', properties: { path: { type: 'string' } } },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Dosya yazar',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' }, content: { type: 'string' } },
      },
    },
  },
];

test('arac listesi arama metnine sinav-sorusu olarak girer', () => {
  const q = buildQuery({
    messages: [{ role: 'user', content: 'package.json dosyasini oku' }],
    tools: TOOLS,
  });
  assert.match(q, /Sinav sorusu: Bir ajan/);
  assert.match(q, /read_file\(path\)/);
  assert.match(q, /write_file\(path,content\)/);
  assert.match(q, /Gorev: "package.json dosyasini oku"/);
  assert.match(q, /Cevap formati: ARAC: ad \| arg="deger"/);
});

test('kimlik dayatmasi kullanilmaz (AI Mode reddediyor)', () => {
  const q = buildQuery({
    messages: [{ role: 'user', content: 'test' }],
    tools: TOOLS,
  });
  assert.doesNotMatch(q, /sen bir ajan/i);
  assert.doesNotMatch(q, /you are an ai assistant/i);
  assert.doesNotMatch(q, /Su araclara sahipsin/i);
});

test('onceki arac adimlari ve sonuc baglama girer', () => {
  const messages = [
    { role: 'user', content: 'config oku' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        { id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } },
      ],
    },
    { role: 'tool', tool_call_id: 'c1', content: 'icerik: 42' },
  ];
  const q = buildQuery({ messages, tools: TOOLS });
  assert.match(q, /Ajanin simdiye kadarki adimlari:/);
  assert.match(q, /ARAC: read_file \| path="a\.txt" -> icerik: 42/);
  assert.match(q, /SIRADAKI komut satiri/);
});

test('ARAC satiri tool_call\'a cevrilir', () => {
  const r = parseProtocol('ARAC: read_file | path="package.json"', TOOLS);
  assert.equal(r.toolCalls.length, 1);
  assert.equal(r.toolCalls[0].function.name, 'read_file');
  assert.deepEqual(JSON.parse(r.toolCalls[0].function.arguments), { path: 'package.json' });
});

test('bitis satiri arac uretmez, ozet dondurur', () => {
  const r = parseProtocol('BITTI: package.json okundu, 3 dependency var.', TOOLS);
  assert.equal(r.toolCalls.length, 0);
  assert.match(r.content, /3 dependency/);
});

test('bilinmeyen arac yok sayilir', () => {
  const r = parseProtocol('ARAC: sil_dosya | path="a"', TOOLS);
  assert.equal(r.toolCalls.length, 0);
});

test('semada olmayan arguman atilir', () => {
  const r = parseProtocol('ARAC: read_file | path="a" | zararli="x"', TOOLS);
  const args = JSON.parse(r.toolCalls[0].function.arguments);
  assert.deepEqual(args, { path: 'a' });
});

test('JSON tool call blogu de desteklenir (geriye uyum)', () => {
  const txt = '```json\n{"name":"read_file","arguments":{"path":"a"}}\n```';
  const r = parseToolCalls(txt, TOOLS);
  assert.equal(r.toolCalls.length, 1);
  assert.equal(r.toolCalls[0].function.name, 'read_file');
});

test('arac yoksa arama metni sade soru olur', () => {
  const q = buildQuery({ messages: [{ role: 'user', content: 'merhaba' }], tools: [] });
  assert.equal(q, 'SORU: merhaba');
});

test('komut satiri cevap metninden tamamen cikarilir', () => {
  const txt = 'Ajanin ilk komutu:\nARAC: read_file | path="package.json"\nDevam?';
  const r = parseToolCalls(txt, TOOLS);
  assert.equal(r.toolCalls.length, 1);
  assert.doesNotMatch(r.content, /ARAC|read_file/);
  assert.match(r.content, /Ajanin ilk komutu/);
  assert.match(r.content, /Devam\?/);
});

test('sorgu her zaman tek satir (AI Mode cok satirda bos donuyor)', () => {
  const q = buildQuery({
    messages: [
      { role: 'user', content: 'ilk soru' },
      { role: 'assistant', content: 'cevap' },
      { role: 'user', content: 'package.json dosyasini oku' },
    ],
    tools: TOOLS,
  });
  assert.doesNotMatch(q, /\n/);
  assert.match(q, /Sinav sorusu: Bir ajan/);
});
