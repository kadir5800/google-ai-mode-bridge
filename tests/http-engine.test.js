'use strict';

/**
 * Tarayicisiz motorun ayristirma testleri.
 * Ag/tarayici gerektirmez; kayitli HTML parcalari uzerinde calisir.
 */

const test = require('node:test');
const assert = require('node:assert');
const { HttpEngine } = require('../src/http-engine');

const BOOTSTRAP_HTML = `
<div data-garc="GARC_TOKEN_123" data-lro-signature="LRO_SIG" data-lro-token="LRO_TOK"
     data-stkp="STKP_VAL" data-ei="EI_VAL"
     data-srtst="SRTST_VAL" data-xsrf-folwr-token="XSRF_VAL">
  <div data-xsrf-folif-token="XSRF_FOLIF"></div>
  <script>fetchAsyncContent('hKqGIf','folwr','hKqGIf',false);</script>
</div>`;

test('bootstrap tum folwr parametrelerini cikarir', () => {
  const b = HttpEngine.bootstrap(BOOTSTRAP_HTML);
  assert.equal(b.garc, 'GARC_TOKEN_123');
  assert.equal(b.mlro, 'LRO_TOK');
  assert.equal(b.mlros, 'LRO_SIG');
  assert.equal(b.srtst, 'SRTST_VAL');
  assert.equal(b.stkp, 'STKP_VAL');
  assert.equal(b.ei, 'EI_VAL');
  assert.equal(b.xsrf, 'XSRF_VAL');
});

test('bootstrap eksik alanlarda null doner (crash etmez)', () => {
  const b = HttpEngine.bootstrap('<html><body>bos</body></html>');
  assert.equal(b.garc, null);
  assert.equal(b.mlro, null);
  assert.equal(b.srtst, null);
});

test('xsrf yoksa folif tokenina duser', () => {
  const html = '<div data-garc="G" data-lro-token="M" data-srtst="S" data-xsrf-folif-token="FOLIF"></div>';
  const b = HttpEngine.bootstrap(html);
  assert.equal(b.xsrf, 'FOLIF');
});

test('kaynak kartlari TgQPHd yorumundan ayiklanir', () => {
  const card = JSON.stringify([
    [
      'id1',
      ['Ağrı Dağı - Vikipedi', 'Turkey highest peak', 'http://fav', 'https://tr.wikipedia.org', ['Wikipedia']],
    ],
  ]).replace(/"/g, '&quot;');
  const body = `<div><!--TgQPHd|||${card}--></div>`;
  const r = HttpEngine.parseAnswer(body);
  assert.equal(r.sources.length, 1);
  assert.equal(r.sources[0].title, 'Ağrı Dağı - Vikipedi');
  assert.equal(r.sources[0].url, 'https://tr.wikipedia.org');
});

test('HTML varliklari cozulur', () => {
  const t = HttpEngine.htmlToText('<p>T&#39;nin &amp; &quot;de&#287;eri&quot; &lt;x&gt;</p>');
  assert.match(t, /T'nin & "değeri" <x>/);
});

test('style/script bloklari metne sizmaz', () => {
  const t = HttpEngine.htmlToText(
    '<style>.a{color:red}</style><script>var x=1</script><p>gercek metin</p>',
  );
  assert.equal(t, 'gercek metin');
});

test('cevap govdesi n6owBd paragrafindan baslar', () => {
  const body =
    '<style>.junk{}</style><div>video karti</div>' +
    '<div class="n6owBd awi2gc" data-hveid="CAIIAQ">Asil cevap burada.</div>' +
    '<div>Panoya kopyalandı</div><div>Facebook</div>';
  const r = HttpEngine.parseAnswer(body);
  assert.match(r.text, /^Asil cevap burada\./);
  assert.doesNotMatch(r.text, /video karti|Panoya|Facebook|junk/);
});

test('arayuz kuyrugu cevabin sonundan kesilir', () => {
  const body =
    '<div class="n6owBd">Cevap.</div>' +
    '<div>Herkese açık bağlantı paylaşın</div><div>Facebook</div>';
  const r = HttpEngine.parseAnswer(body);
  assert.equal(r.text, 'Cevap.');
});

test('marker yoksa tum govdeye duser', () => {
  const body = '<div><p>Duz bir cevap metni burada yer aliyor ve yeterince uzun.</p></div>';
  const r = HttpEngine.parseAnswer(body);
  assert.match(r.text, /Duz bir cevap metni/);
});
