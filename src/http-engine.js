'use strict';

/**
 * AI Mode icin TARAYICISIZ istemci.
 *
 * Chromium yerine iki duz HTTP istegi kullanir:
 *   1) GET /search?q=...&udm=50        -> sayfa HTML'i (bootstrap token'lari)
 *   2) GET /async/folwr?...            -> AI Mode cevap HTML'i
 *
 * Ilk istek ~0.8-2.5s, ikincisi ~1-2s. Toplam ~4s; Chromium yolu ~10-20s.
 *
 * ONEMLI: folwr parametrelerinin hepsi (garc, mlro, mlros, srtst, stkp, ei)
 * ilk HTML'deki kapsayici div'in data-* ozniteliklerinde hazir gelir. JS'in
 * urettigi tek sey yok; bu yuzden tarayiciya gerek yok.
 *
 * Cerezler: Google oturumu gerekiyorsa profil dizininden bir kez disa
 * aktarilir (bkz. cookieStore).
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const cfg = require('./config');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36';

class HttpEngine {
  constructor() {
    this.cookieHeader = null;
    this.lastRequestAt = 0;
    this.queue = Promise.resolve();
    this.pending = 0;
    this.blockedUntil = 0;
  }

  get busy() {
    return this.pending > 0;
  }

  /**
   * Istekleri siraya koy + araya minimum bekleme koy.
   *
   * Google, art arda hizli isteklerde AI Mode kapsayicisini gondermeyi
   * birakiyor (sayfa 90KB'a dusuyor, tokenlar kayboluyor). Olculdu: pes pese
   * 3-4 istekten sonra bu oluyor. Bu yuzden her istek arasinda varsayilan
   * 1.5s bekliyoruz; AIM_MIN_INTERVAL_MS ile ayarlanabilir.
   */
  enqueue(fn) {
    const run = this.queue.then(async () => {
      this.pending += 1;
      try {
        const wait = this.lastRequestAt + cfg.minIntervalMs - Date.now();
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        return await fn();
      } finally {
        this.lastRequestAt = Date.now();
        this.pending -= 1;
      }
    });
    this.queue = run.catch(() => {});
    return run;
  }

  // ------------------------------------------------------------ cerezler

  cookieFile() {
    return path.join(cfg.dataDir || process.cwd(), 'cookies.json');
  }

  /** Profilden disa aktarilmis cerezleri yukler. */
  loadCookies() {
    if (this.cookieHeader) return this.cookieHeader;
    const file = this.cookieFile();
    if (!fs.existsSync(file)) {
      throw new Error(
        `Cerez dosyasi yok: ${file}\n  Bir kez "npm run login" (veya npm run export-cookies) calistir.`,
      );
    }
    const { cookies } = JSON.parse(fs.readFileSync(file, 'utf8'));
    this.cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
    return this.cookieHeader;
  }

  reloginHint() {
    return 'Google oturumu gecersiz olabilir: "npm run export-cookies" ile cerezleri yenile.';
  }

  // ------------------------------------------------------------ istekler

  headers() {
    return {
      'user-agent': UA,
      'accept-language': `${cfg.locale},tr;q=0.9,en;q=0.8`,
      cookie: this.loadCookies(),
      'sec-ch-ua': '"Google Chrome";v="155", "Chromium";v="155", "Not(A:Brand";v="24"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
    };
  }

  static decode(buf, encoding) {
    try {
      if (encoding === 'br') return zlib.brotliDecompressSync(buf).toString('utf8');
      if (encoding === 'gzip') return zlib.gunzipSync(buf).toString('utf8');
      if (encoding === 'deflate') return zlib.inflateSync(buf).toString('utf8');
    } catch {
      /* yoksay */
    }
    return buf.toString('utf8');
  }

  async get(url, extra = {}) {
    const res = await fetch(url, {
      headers: { ...this.headers(), ...extra, 'accept-encoding': 'gzip, deflate, br' },
    });
    const body = HttpEngine.decode(
      Buffer.from(await res.arrayBuffer()),
      res.headers.get('content-encoding'),
    );
    return { status: res.status, body };
  }

  // ------------------------------------------------------------ ayristirma

  /** Ilk HTML'den folwr parametrelerini cikarir. */
  static bootstrap(html) {
    const g = (re) => {
      const m = html.match(re);
      return m ? m[1] : null;
    };
    return {
      garc: g(/data-garc="([^"]+)"/),
      mlro: g(/data-lro-token="([^"]+)"/),
      mlros: g(/data-lro-signature="([^"]+)"/),
      srtst: g(/data-srtst="([^"]+)"/),
      stkp: g(/data-stkp="([^"]+)"/),
      ei: g(/data-ei="([^"]+)"/),
      xsrf: g(/data-xsrf-folwr-token="([^"]+)"/) || g(/data-xsrf-folif-token="([^"]+)"/),
    };
  }

  /**
   * folwr yanitindan ana cevap gövdesini ayirir.
   *
   * Yapi (olculdu):
   *   <div data-sn-op="2" data-target-container-id="7"> ... asil cevap ...
   *   <!--TgQPHd|||[["<id>",["Baslik","Ozet","favicon","https://site",["Kaynak"],"/goto?url=..."]]]-->
   * Kaynak kartlari bu yorum bloklarinda yapisal olarak gelir; metinden
   * temizlenip ayrica kaynak listesine donusturulur.
   */
  static parseAnswer(body) {
    // 1) kaynak kartlari: <!--TgQPHd|||[[...]]-->
    const sources = [];
    const seen = new Set();
    for (const m of body.matchAll(/<!--TgQPHd\|\|\|([\s\S]*?)-->/g)) {
      try {
        const json = m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&#39;/g, "'");
        const arr = JSON.parse(json);
        // item[1] TEK bir meta dizisi degil, meta dizilerinin LISTESI olabilir:
        //   [null, [ ["Baslik",...,"https://site",["Kaynak"],"/goto?url=..."] ]]
        // Eskiden item[1] ile tek meta sanilip dizi elemanlari virgulle
        // birlestiriliyordu -> baslik favicon URL'siyle birlesiyordu.
        for (const item of arr) {
          const raw = item && item[1];
          if (!Array.isArray(raw)) continue;
          const metas = Array.isArray(raw[0]) ? raw : [raw];
          for (const meta of metas) {
            if (!Array.isArray(meta)) continue;
            const [title, desc, , site, , href] = meta;
            if (!title || String(title).length < 3) continue;
            const url = [href, site].find((u) => typeof u === 'string' && /^https?:\/\//.test(u)) || null;
            if (!url) continue;
            const key = `${title}|${url}`;
            if (seen.has(key)) continue;
            seen.add(key);
            sources.push({ title: String(title), url, desc: desc ? String(desc).slice(0, 200) : '' });
          }
        }
      } catch {
        /* tek kart hatasi butunu bozmasin */
      }
    }

    // 2) kaynak kartlarini ve gomulu veriyi metinden cikar
    let h = body
      .replace(/<!--TgQPHd\|\|\|[\s\S]*?-->/g, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ');

    // 3) Cevap metninin baslangicini bul.
    //    Kaynak/video kartlari ve CSS bloklari cevabin onunde geliyor.
    //
    //    Olculen isaretler (oncelik sirasi):
    //      a) class="n6owBd ..."  -> cevabin ILK paragrafi  (en guvenilir)
    //      b) "... için AI Modu yanıtı" basligi
    //      c) hicbiri yoksa tum govde
    let h2 = h.replace(/<style[\s\S]*?<\/style>/gi, ' ');

    // 3a) Cevap icindeki kaynak atif ciplerini sil.
    //     Bunlar cumlenin sonuna yapistirilan kucuk balonlar:
    //       <div class="S9OuHf">...<span class="QNca8b">Wikipedia</span>... </div>
    //     Etiketler silinince metne "Wikipedia" ve "+1" gibi cop dusuyordu
    //     ("Ankara'dır. Wikipedia +1"). Cipi, icindeki site adiyla birlikte at.
    h2 = h2.replace(
      /<div[^>]*class="[^"]*\bS9OuHf\b[^"]*"[^>]*>[\s\S]*?<\/div>/gi,
      ' ',
    );
    // Cipin disinda kalan tek basina "+1" / "+2" sayaclari
    h2 = h2.replace(/<\/span>\s*\+\d+/g, ' </span>');

    const paraIdx = h2.search(/class="n6owBd\b/);
    const titleIdx = h2.search(/AI Modu yan\u0131t\u0131/i);

    let from = 0;
    if (paraIdx > 0) {
      // Etiketin KAPANISINDAN basla: boylece oznitelik artigi metne sizmaz.
      const close = h2.indexOf('>', paraIdx);
      from = close >= 0 ? close + 1 : paraIdx;
    } else if (titleIdx > 0) {
      // Basligin kendi metnini atlayip sonrasindan basla
      const close = h2.indexOf('</', titleIdx);
      from = close >= 0 ? close : titleIdx;
    }
    h2 = h2.slice(from);

    // 4) Cevabin SONUNU bul: kaynak kartlari / paylasim arayuzu buradan baslar.
    //    Ilk gorulen arayuz isareti cevabin bittigi yerdir.
    const endMarks = [
      'Panoya kopyaland\u0131',
      'Panoya kopyalanamad\u0131',
      'Herkese a\u00e7\u0131k ba\u011flant\u0131 payla\u015f\u0131n',
      'Bu herkese a\u00e7\u0131k ba\u011flant\u0131',
      'Bu yan\u0131t hakk\u0131nda',
      'T\u00fcm\u00fcn\u00fc g\u00f6ster',
      'Daha az g\u00f6ster',
    ];
    let end = h2.length;
    for (const mark of endMarks) {
      const i = h2.indexOf(mark);
      if (i >= 0 && i < end) end = i;
    }
    h2 = h2.slice(0, end);

    let text = HttpEngine.htmlToText(h2);
    // NOT: Buradaki esik kucuk olmali. Uzun bir esik, kisa ama gecerli
    // cevaplarda yedek yola dusup arayuz kuyrugunu geri getiriyor.
    if (!text.trim()) {
      text = HttpEngine.htmlToText(body);
    }
    return { text, sources };
  }

  /** HTML parcasini sade metne cevirir. */
  static htmlToText(body) {
    let h = body
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ');

    // Matematik bloklari: Google sayilari MathML/LaTeX olarak render ediyor ve
    // AYNI deger dort yerde geciyor (data-xpm-latex, <mn>, <annotation>, SVG).
    // Etiketler silinince sayi 3-4 kez metne dusuyor ("5.1375.137 5.137").
    // Bu yuzden matematik bloklarini tek degerle degistiriyoruz.
    h = h.replace(
      /<div[^>]*data-xpm-copy-root[^>]*>[\s\S]*?<\/math>[\s\S]*?<\/div>/gi,
      (block) => {
        const m =
          block.match(/data-xpm-latex="([^"]*)"/) ||
          block.match(/<annotation[^>]*>([\s\S]*?)<\/annotation>/i) ||
          block.match(/<mn>([\s\S]*?)<\/mn>/i);
        return m ? ` ${m[1]} ` : ' ';
      },
    );
    // MathML kalanlari (data-xpm-copy-root disinda)
    h = h.replace(/<math[\s\S]*?<\/math>/gi, ' ');
    h = h.replace(/<svg[\s\S]*?<\/svg>/gi, ' ');

    h = h.replace(/<\/(p|div|li|tr|h[1-6]|blockquote|section|article)>/gi, '\n');
    h = h.replace(/<br\s*\/?>/gi, '\n');
    h = h.replace(/<\/(td|th)>/gi, '\t');
    h = h.replace(/<[^>]+>/g, '');

    h = h
      .replace(/&#39;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&nbsp;/g, ' ')
      .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));

    const lines = h
      .split('\n')
      .map((l) => l.replace(/[ \t]+/g, ' ').trim())
      .filter((l) => l.length > 0);

    const junk = [
      /AI Modu yan\u0131t\u0131$/i,
      /^Payla\u015f\u0131ld\u0131$/i,
      /^Payla\u015f$/i,
      /^\d+ dosya$/i,
      /^AI Modu$/i,
      /^Kopyala$/i,
      /^Metni kopyala$/i,
      /^Daha fazla$/i,
      /^T\u00fcm\u00fcn\u00fc g\u00f6ster$/i,
      /^Kaynaklar$/i,
      /^\u0130yi yan\u0131t$/i,
      /^K\u00f6t\u00fc yan\u0131t$/i,
      /^Show more$/i,
      /^Wikipedia$|^Onedio$|^YouTube$/i,
      // Harita / gorsel yerlesim arayuzu
      /^Haritay\u0131 geni\u015flet$/i,
      /^Haritay\u0131 k\u00fc\u00e7\u00fclt$/i,
      /^Yak\u0131nla\u015ft\u0131r$/i,
      /^Uzakla\u015ft\u0131r$/i,
      /^Haritada g\u00f6ster$/i,
      /^Sokak g\u00f6r\u00fcn\u00fcm\u00fc$/i,
      /^Tam ekran$/i,
      /^Kaynaklar\u0131 g\u00f6ster$/i,
    ];

    const out = [];
    for (const l of lines) {
      if (junk.some((re) => re.test(l))) continue;
      if (out[out.length - 1] === l) continue;
      out.push(l);
    }
    // Guvenlik agi: ayni sayinin pes pese tekrari ("5.1375.137 5.137")
    const joined = out.join('\n').replace(/(\b\d[\d.,]*)(?:\s*\1\b)+/g, '$1');
    // Etiketler araya girince kesme isaretinden once bosluk kaliyor:
    // "Türkiye 'nin başkenti Ankara 'dır" -> "Türkiye'nin başkenti Ankara'dır"
    return joined.replace(/(\S)[ \t]+'(?=[a-zA-Z\u00c0-\u017f])/g, "$1'");
  }

  /** /goto?url=... referanslarini toplar. */
  static extractGotoRefs(html) {
    const out = [];
    const seen = new Set();
    for (const m of html.matchAll(/\/goto\?url=([A-Za-z0-9_-]+)/g)) {
      const p = `/goto?url=${m[1]}`;
      if (seen.has(p)) continue;
      seen.add(p);
      out.push(p);
    }
    return out;
  }

  // ------------------------------------------------------------ ana akis

  async ask(query, opts = {}) {
    return this.enqueue(() => this._ask(query, opts));
  }

  async _ask(query, opts = {}) {
    const onDelta = typeof opts.onDelta === 'function' ? opts.onDelta : null;
    const t0 = Date.now();

    // Onceki 429/captcha sonrasi bekleme penceresi hala gecerliyse
    // istek atmadan hemen hata ver: ayni IP'yi dovup engeli uzatmayalim.
    if (this.blockedUntil && Date.now() < this.blockedUntil) {
      const kalan = Math.ceil((this.blockedUntil - Date.now()) / 1000);
      throw new Error(
        `RATE_LIMIT: Google bu IP'yi gecici olarak engelledi. ${kalan} saniye daha bekle.`,
      );
    }

    const encoded = encodeURIComponent(query);
    const searchUrl = `https://www.google.com/search?q=${encoded}&udm=50&hl=tr`;

    // 1) arama sayfasi
    const first = await this.get(searchUrl, {
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'sec-fetch-dest': 'document',
      'sec-fetch-mode': 'navigate',
      'sec-fetch-site': 'none',
    });

    // 429 = Google bu IP'yi gecici olarak engelledi (captcha sayfasi doner).
    // Cerez yenilemek cozmez; beklemek gerekir. Durumu kaydedip kisa devre
    // yapiyoruz ki ayni IP'yi dovup engeli uzatmayalim.
    if (first.status === 429) {
      this.blockedUntil = Date.now() + cfg.blockCooldownMs;
      throw new Error(
        `RATE_LIMIT: Google bu IP'yi gecici olarak engelledi (HTTP 429). ` +
          `Yaklasik ${Math.round(cfg.blockCooldownMs / 60000)} dakika beklemek gerekiyor. ` +
          'Cerez yenilemek cozmez. Kalici cozum: Google hesabiyla giris (npm run login && npm run export-cookies) ' +
          've daha seyrek istek. Chromium yolu bu durumda genelde de calismaz.',
      );
    }

    if (first.status !== 200) {
      throw new Error(`HTTP ${first.status} (arama sayfasi).`);
    }

    // Gercek engel isaretleri. NOT: "captcha" / "/sorry/index" gibi metinler
    // sayfadaki JS kaynaginda da geciyor; yalnizca engel sayfasina ozgu
    // yapilara bakilir.
    if (
      /<form[^>]+id="captcha-form"/i.test(first.body) ||
      /<body[^>]*onload="[^"]*captcha/i.test(first.body)
    ) {
      this.blockedUntil = Date.now() + cfg.blockCooldownMs;
      throw new Error(
        `RATE_LIMIT: Google captcha dogrulamasi istedi. Yaklasik ` +
          `${Math.round(cfg.blockCooldownMs / 60000)} dakika beklemek gerekiyor. ` +
          'Tarayici ile cozmek icin: npm run login',
      );
    }

    const b = HttpEngine.bootstrap(first.body);
    if (!b.garc || !b.mlro || !b.srtst) {
      // AI Mode kapsayicisi hic gelmediyse Google bu istemciyi gecici olarak
      // yavaslatmis olabilir (sayfa ~90KB'a duser, tokenlar kaybolur).
      if (!/aim-chrome|aim-async|data-garc/i.test(first.body)) {
        throw new Error(
          'THROTTLED: Google AI Mode kapsayicisini gondermedi (gecici hiz siniri). ' +
            'Birkac dakika bekleyip tekrar dene. Sik istek atiyorsan AIM_MIN_INTERVAL_MS degerini artir. ' +
            'Kalici cozum: Google hesabinla giris yapip cerezleri yenile (npm run login && npm run export-cookies).',
        );
      }
      throw new Error(
        `EMPTY: AI Mode parametreleri bulunamadi (garc/mlro/srtst). ${this.reloginHint()}`,
      );
    }

    // 2) cevap HTML'i
    const p = new URLSearchParams();
    p.set('srtst', b.srtst);
    p.set('garc', b.garc);
    p.set('mlro', b.mlro);
    if (b.mlros) p.set('mlros', b.mlros);
    if (b.ei) p.set('ei', b.ei);
    p.set('q', query);
    p.set('yv', '3');
    if (b.stkp) p.set('stkp', b.stkp);
    p.set('hl', 'tr');
    p.set('udm', '50');
    p.set('cs', '0');
    p.set('async', `_fmt:adl,_xsrf:${b.xsrf || ''}`);

    const fol = await this.get(`https://www.google.com/async/folwr?${p.toString()}`, {
      accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
      referer: searchUrl,
      'x-sg-e': '1,isrpe=1,hcs=1',
    });

    if (fol.status !== 200) {
      throw new Error(`HTTP ${fol.status} (folwr). ${this.reloginHint()}`);
    }

    const parsed = HttpEngine.parseAnswer(fol.body);
    if (!parsed.text || parsed.text.length < 40) {
      throw new Error('EMPTY: Cevap metni cikarilamadi.');
    }

    // Yol boyunca tek parca geldigi icin akis "tum metni bir kerede" olur.
    // Yine de arayuz ayni kalsin diye onDelta'yi cagiriyoruz.
    if (onDelta) onDelta(parsed.text);

    return {
      text: parsed.text,
      sources: parsed.sources.slice(0, cfg.maxSources),
      mode: 'ai-mode-http',
      ms: Date.now() - t0,
    };
  }
}

module.exports = { HttpEngine };
