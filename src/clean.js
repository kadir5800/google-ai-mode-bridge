'use strict';

/**
 * Google AI Mode "Kopyala" ciktisini temizler.
 *
 * Pano icerigi markdown benzeri gelir ve Google'in kendi ic linklerini icerir:
 *   Agir Dag (https://www.google.com/search?kgmid=%2Fm%2F01tkw9)  -> Agir Dag
 *   [1] (/goto?url=CAES...)                                      -> [1]
 *
 * Bu modul linkleri ayiklar ve gercek kaynak adreslerini toplar.
 */

const GOTO_RE = /\/goto\?url=([A-Za-z0-9_-]+)/g;

/** Panodaki tum /goto referanslarini dondurur. */
function extractGotoRefs(raw) {
  const out = [];
  const seen = new Set();
  let m;
  GOTO_RE.lastIndex = 0;
  while ((m = GOTO_RE.exec(raw)) !== null) {
    const path = `/goto?url=${m[1]}`;
    if (seen.has(path)) continue;
    seen.add(path);
    out.push(path);
  }
  return out;
}

/** markdown linkini [etiket](hedef) icinden etiketle degistirir. */
function stripLinks(text) {
  let out = text;

  // [1](/goto?url=...) gibi atif isaretleri: numarayi koru
  out = out.replace(/\[\^?(\d+)\]\s*\(\/goto\?url=[^)]*\)/g, '[$1]');

  // Google arama linkleri: sadece etiket kalsin
  out = out.replace(/\(https?:\/\/www\.google\.com\/search\?[^)]*\)/g, '');

  // Kalan markdown linkleri: [etiket](url) -> etiket (url)
  out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (_, label, url) => {
    if (/^https?:\/\/www\.google\.com/i.test(url)) return label;
    return label;
  });

  // Cikplak (url) parantezleri
  out = out.replace(/\s*\(https?:\/\/www\.google\.com\/[^)]*\)/g, '');

  // Bos atif isaretleri
  out = out.replace(/\[\d+\]\s*(?=\n|$)/g, '');

  // Link kalintisindan kalan bosluk: "Dağı 'dır" -> "Dağı'dır"
  out = out.replace(/[ \t]+([’'])/g, '$1');
  // Atif isaretlerini topla: "[1],[2]," -> "[1], [2]"
  out = out.replace(/\],\s*\[/g, '], [');

  return out;
}

/** Pano metnini son kullanici icin temizler. */
function cleanClipboard(raw) {
  if (!raw) return { text: '', gotoRefs: [] };

  const gotoRefs = extractGotoRefs(raw);

  let text = raw
    .replace(/\r\n/g, '\n')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+(?=\S)/g, ' ')
    .replace(/(?<=\S)[ \t]+/g, ' ');
  // NOT: sekmeler korunur (tablo sutunlari icin)

  text = stripLinks(text);

  // Arayuz kalintilari
  const junkRe = [
    /^kopyalandı$/i, /^kopyalanamadı$/i, /^kopyala$/i, /^copy$/i,
    /^panoya kopyalandı/i, /^panoya kopyalanamadı/i,
    /^herkese açık bağlantı paylaşın$/i, /^paylaş$|^share$/i,
    /^(facebook|gmail|x|reddit|whatsapp)$/i,
    /kopyalandı.*kopyalanamadı/i, /kopyalanamadı.*kopyala/i,
    /^bu herkese açık bağlantı/i, /^bu sohbetin bir kopyası/i,
    /^bizi bilgilendirdiğiniz/i, /^iyi yanıt$/i, /^kötü yanıt$/i,
    /^google, geri bildiriminizi/i, /^yasal sorunlar için/i,
    /^hata yapabildi/i, /verdiği yanıtları doğrulay/i,
    /^yapay zek[âa] destekli/i,
    /rich media, yapıştırma işlemine dahil edilmedi/i,
    /^\[rich media/i,
    /yapıştırma işlemine dahil edilmedi/i,
  ];

  const lines = text.split('\n');
  const kept = [];
  for (const ln of lines) {
    const t = ln.trimEnd();
    const s = t.trim();
    if (!s) {
      if (kept.length && kept[kept.length - 1] !== '') kept.push('');
      continue;
    }
    // Arayuz kalintisi satirlari (boslukla bitisik gelenler dahil)
    if (junkRe.some((re) => re.test(s))) continue;
    // Zaman damgasi / sure etiketleri (video kartlarindan)
    if (/^\d{1,2}:\d{2}$/.test(s)) continue;
    // Satir icinde gecen arayuz cumlelerini ayikla
    if (/kopyaland[ıi]\s*kopyalanamad[ıi]\s*kopyala/i.test(s)) continue;
    kept.push(t);
  }

  text = kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();

  // Sondaki bos atif satirlarini at
  text = text.replace(/\n+$/, '');

  return { text, gotoRefs };
}

/**
 * CANLI akis icin temizlik.
 *
 * Canli metin DOM'dan gelir (panodan degil), bu yuzden arayuz kalintilari
 * daha fazladir: "Dusunuyor...", "Kopyala", geri bildirim satirlari, kaynak
 * kartlari. Ayrica Google cevabi yazarken ayni satiri yeniden yazabiliyor;
 * tekrarlanan satirlar tekilleştirilir.
 */
const LIVE_JUNK = [
  /^kopyala$/i, /^copy$/i, /^metni kopyala$/i, /^copy text$/i,
  /^panoya kopyaland[ıi]?/i, /^kopyaland[ıi]$/i,
  /^d[üu][şs][üu]n[üu]yor/i, /^thinking/i, /^aran[ıi]yor/i, /^searching/i,
  /^show more$/i, /^daha fazla g[öo]ster$/i, /^t[üu]m[üu]n[üu] g[öo]ster$/i,
  /^kaynaklar$|^sources$/i, /^payla[şs]$|^share$/i,
  /^iyi yan[ıi]t$/i, /^k[öo]t[üu] yan[ıi]t$/i,
  /^ai mode$|^ai modu$/i, /i[çc]in ai modu yan[ıi]t[ıi]/i,
  /^hata yapabildi/i, /verdi[ğg]i yan[ıi]tlar[ıi] do[ğg]rula/i,
  /^yapay zek[âa] destekli/i, /^g[öo]rsel/i,
  /^google, geri bildirim/i, /^yasal sorunlar i[çc]in/i,
  /^bu herkese a[çc][ıi]k ba[ğg]lant[ıi]/i, /^bu sohbetin bir kopyas[ıi]/i,
  /^_(setImageSrc|data:image)/i, /base64,/i,
];

function cleanLiveText(raw) {
  if (!raw) return '';
  const lines = String(raw).replace(/\u00a0/g, ' ').split('\n');
  const kept = [];
  for (const ln of lines) {
    const t = ln.replace(/[ \t]+/g, ' ').trimEnd();
    const s = t.trim();
    if (!s) {
      if (kept.length && kept[kept.length - 1] !== '') kept.push('');
      continue;
    }
    if (LIVE_JUNK.some((re) => re.test(s))) continue;
    // Ayni satir tekrar tekrar yaziliyorsa (streaming yeniden cizimi) tek tut
    if (kept.length && kept[kept.length - 1].trim() === s) continue;
    kept.push(t);
  }
  return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

module.exports = { cleanClipboard, extractGotoRefs, stripLinks, cleanLiveText };
