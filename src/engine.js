'use strict';

const { chromium } = require('playwright');
const cfg = require('./config');
const { cleanClipboard, cleanLiveText } = require('./clean');

/**
 * Acik motor ornekleri. Node sonlanirken tarayicilari kapatmak icin tutulur;
 * aksi halde Chrome arkada kalip profil kilidini birakiyor ve sonraki
 * calistirmalar "Target page, context or browser has been closed" veriyor.
 */
const ENGINES = new Set();

let cleanedUp = false;
function cleanupAll() {
  if (cleanedUp) return;
  cleanedUp = true;
  for (const e of ENGINES) {
    try {
      if (e.context) e.context.close().catch(() => {});
    } catch {
      /* yoksay */
    }
  }
}
process.on('exit', cleanupAll);
process.on('SIGINT', () => {
  cleanupAll();
  process.exit(0);
});
process.on('SIGTERM', () => {
  cleanupAll();
  process.exit(0);
});

/**
 * Google AI Mode'u surup cevabi toplayan motor.
 *
 * Iki katmanli kazima:
 *  1) ASIL: Cevap blogundaki "Kopyala" dugmesine basip panoyu okur. Google bu
 *     dugmeyle cevabin TAM markdown halini verir; tablo/bicim bozulmaz.
 *  2) YEDEK: Pano calismazsa DOM'dan metin cikarir.
 *
 * Istekler tek sayfa uzerinde SIRAYLA calisir (Google paralel sekmelerde
 * bot korumasini tetikliyor).
 */
class GoogleAiModeEngine {
  constructor() {
    this.context = null;
    this.page = null;
    this.queue = Promise.resolve();
    this.pending = 0;
    this.lastAnswer = null;
    this.usedHeadedFallback = false;
    ENGINES.add(this);
  }

  get busy() {
    return this.pending > 0;
  }

  async ensureBrowser() {
    if (this.context && this.page && !this.page.isClosed()) return this.page;

    this.context = await this.launch(cfg.headless);
    await this.afterLaunch();
    return this.page;
  }

  async launch(headless) {
    return chromium.launchPersistentContext(cfg.profileDir, {
      headless,
      channel: cfg.chromeChannel,
      locale: cfg.locale,
      viewport: { width: 1280, height: 900 },
      args: [
        '--disable-blink-features=AutomationControlled',
        '--no-first-run',
        '--no-default-browser-check',
      ],
      ignoreDefaultArgs: ['--enable-automation'],
    });
  }

  async afterLaunch() {
    const pages = this.context.pages();
    this.page = pages[0] || (await this.context.newPage());
    for (const p of pages.slice(1)) await p.close().catch(() => {});

    await this.page.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });

    // Pano okuma izni (kopyalama yontemi icin)
    await this.context
      .grantPermissions(['clipboard-read', 'clipboard-write'], { origin: 'https://www.google.com' })
      .catch(() => {});

    this.context.on('close', () => {
      this.context = null;
      this.page = null;
    });
  }

  /**
   * Headless tarayici Google tarafindan engellenirse gorunur pencereye gec.
   * MCP arka planda calistigi icin bu, "sessizce calismiyor" durumunu onler.
   */
  async fallbackToHeaded() {
    if (!cfg.headless || this.usedHeadedFallback) return false;
    this.usedHeadedFallback = true;
    try {
      if (this.context) await this.context.close().catch(() => {});
    } catch {
      /* yoksay */
    }
    this.context = null;
    this.page = null;
    this.context = await this.launch(false);
    await this.afterLaunch();
    return true;
  }

  enqueue(fn) {
    const run = this.queue.then(async () => {
      this.pending += 1;
      try {
        return await fn();
      } finally {
        this.pending -= 1;
      }
    });
    this.queue = run.catch(() => {});
    return run;
  }

  async close() {
    if (this.context) await this.context.close().catch(() => {});
    this.context = null;
    this.page = null;
  }

  async ask(query, opts = {}) {
    const onDelta = typeof opts.onDelta === 'function' ? opts.onDelta : null;
    return this.enqueue(() => this._ask(query, false, onDelta));
  }

  async _ask(query, isRetry = false, onDelta = null) {
    const page = await this.ensureBrowser();
    const lang = cfg.locale.split('-')[0];
    const url = `https://www.google.com/search?q=${encodeURIComponent(query)}&udm=50&hl=${lang}`;

    // Google SPA ayni sayfada kalip ONCEKI cevabin DOM'unu birakabiliyor.
    // Bu yuzden her istekte bos sayfadan baslayip temiz bir DOM elde ediyoruz.
    await page.goto('about:blank').catch(() => {});
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: cfg.navTimeout });
    await this.dismissConsent(page);

    const blocked = await this.detectBlock(page);
    if (blocked) {
      // Headless engellendiyse gorunur pencerede bir kez daha dene
      if (!isRetry && (await this.fallbackToHeaded())) {
        return this._ask(query, true);
      }
      throw new Error(`BLOCKED: ${blocked}`);
    }

    let mode = 'ai-mode';
    let ready = await this.waitForAnswer(page, cfg.answerTimeout, onDelta);

    // AI Mode cevabi gelmediyse sayfadaki AI Overview'a bak (varsa hemen doner)
    if (!ready) {
      ready = await this.waitForOverview(page, 15000);
      if (ready) mode = 'overview';
    }

    // Hala yok: headless engeli olabilir, gorunur pencerede bir kez daha dene
    if (!ready && !isRetry && (await this.fallbackToHeaded())) {
      return this._ask(query, true, onDelta);
    }

    if (!ready) {
      // Teshis bilgisi: ne oldugunu anlamak icin sayfa durumunu topla
      const diag = await page
        .evaluate(() => {
          const body = (document.body.innerText || '').replace(/\s+/g, ' ').trim();
          return {
            url: location.href,
            title: document.title,
            bodyLen: body.length,
            head: body.slice(0, 220),
            aim: !!document.querySelector('#aim-chrome-initial-inline-async-container'),
            sge: !!document.querySelector('[data-attrid*="SGE"]'),
            captcha: !!document.querySelector('#captcha-form, form[action*="sorry"], iframe[src*="recaptcha"]'),
          };
        })
        .catch(() => null);

      throw new Error(
        `EMPTY: Sayfada AI cevabi bulunamadi. ${diag ? JSON.stringify(diag).slice(0, 600) : ''} ` +
          "`npm run login` ile tarayiciyi acip Google AI Mode'a erisimini dogrula.",
      );
    }

    // 1) Pano yolu (asil) - cevap tamamlanana kadar bekle, gerekirse tekrar kopyala
    let text = '';
    let gotoLinks = [];
    let dom = null;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const copied = await this.copyAnswer(page).catch(() => null);
      if (copied && copied.length > 40) {
        const parsed = cleanClipboard(copied);
        if (parsed.text.length > text.length) {
          text = parsed.text;
          gotoLinks = parsed.gotoRefs;
        }
      }
      dom = await this.extractDom(page).catch(() => null);

      // Pano metni asildir: Google tam markdown verir. Sadece pano bossa DOM'a duseriz.
      if (text) break;
      await page.waitForTimeout(1500);
    }

    // 2) DOM yedegi: yalnizca pano hicbir sey vermediyse
    if (!text && dom && dom.text && dom.text.length > 40) {
      text = dom.text;
    }
    if (!gotoLinks.length && dom && dom.gotoLinks) gotoLinks = dom.gotoLinks;

    if (!text) throw new Error('EMPTY: Cevap metni cikarilamadi.');

    let sources = [];
    if (cfg.includeSources) {
      sources = await this.resolveSources(page, dom, gotoLinks);
    }

    const answer = { text, sources: sources.slice(0, cfg.maxSources), mode };
    this.lastAnswer = answer;
    return answer;
  }

  /**
   * AI Mode blogu yoksa normal arama sonucundaki AI Overview'u bekler.
   * Bu, bolgesel olarak AI Mode kapali hesaplar icin yedektir.
   */
  async waitForOverview(page, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    let last = '';
    let stable = Date.now();
    while (Date.now() < deadline) {
      const st = await page
        .evaluate(() => {
          const main = document.querySelector('div[role="main"]') || document.body;
          // AI Overview kutusu: "AI Bakışı" / "AI Overview"
          const markers = Array.from(main.querySelectorAll('h1, h2, h3, div, span')).filter((el) => {
            const t = (el.innerText || '').trim();
            return /^(AI Bakışı|AI Overview|Yapay zekâ destekli özet)/i.test(t) && t.length < 60;
          });
          if (!markers.length) return { len: 0, text: '' };
          // Basligin en yakin anlamli kapsayicisini al
          let root = markers[0];
          for (let i = 0; i < 5 && root.parentElement; i += 1) {
            const t = (root.parentElement.innerText || '').trim();
            if (t.length > 200) {
              root = root.parentElement;
              break;
            }
            root = root.parentElement;
          }
          return { len: (root.innerText || '').trim().length, text: (root.innerText || '').trim() };
        })
        .catch(() => ({ len: 0, text: '' }));

      if (st.text && st.text !== last) {
        last = st.text;
        stable = Date.now();
      }
      if (last.length > 120 && Date.now() - stable > cfg.stableMs) return true;
      await page.waitForTimeout(cfg.pollMs);
    }
    return false;
  }

  /**
   * Cevap blogu hazir mi? data-complete + metin uzunlugu kontrol eder.
   *
   * onDelta verilirse cevap YAZILIRKEN canli akitilir: her turda DOM'dan
   * okunan temiz metnin, daha once gonderilmemis kuyrugu iletilir. Boylece
   * "Kopyala"ya basip sonucu tek seferde almak yerine kullanici cevabi
   * olustugu anda gorur.
   */
  async waitForAnswer(page, timeoutMs, onDelta = null) {
    const deadline = Date.now() + timeoutMs;
    let lastLen = 0;
    let lastText = '';
    let stableSince = Date.now();
    const minLen = 120; // daha kisa metin genelde yukleniyor demektir

    // Canli akis durumu
    let sentRawLen = 0; // ham metnin islenmis uzunlugu
    let snapshot = ''; // son okunan HAM metin
    const livePoll = onDelta ? Math.min(cfg.pollMs, 150) : cfg.pollMs;

    /**
     * Ham DOM metninin YALNIZCA yeni eklenen bolumunu temizleyip iletir.
     *
     * Neden delta yerine "yeni bolge": temizlik (cleanLiveText) bazi satirlari
     * atabildigi icin temizlenmis metin uzerinden delta hesaplamak mükerrer
     * veya eksik gonderime yol aciyor. Ham metin ise sona eklenerek buyudugu
     * icin islenmis uzunlugu tutmak yeterli ve birebir.
     */
    const emitLive = (rawNow) => {
      if (!onDelta || !rawNow) return;
      if (rawNow.length < sentRawLen) {
        // Google metni bastan yazdi (nadir). Kaldigimiz yerden devam et.
        sentRawLen = 0;
      }
      let fresh = rawNow.slice(sentRawLen);
      if (!fresh) return;

      // Yarim kelime gostermemek icin son bosluk/yeni satirdan kes
      const cut = Math.max(fresh.lastIndexOf(' '), fresh.lastIndexOf('\n'));
      if (cut <= 0) return;
      fresh = fresh.slice(0, cut + 1);

      const chunk = cleanLiveText(fresh);
      sentRawLen += fresh.length;
      if (!chunk) return;
      onDelta(chunk.endsWith('\n') ? chunk : `${chunk} `);
    };

    const flushLive = (rawFinal) => {
      if (!onDelta) return;
      const rest = cleanLiveText((rawFinal || snapshot).slice(sentRawLen));
      if (!rest.trim()) return;
      sentRawLen = (rawFinal || snapshot).length;
      onDelta(rest);
    };

    // Ilk okumayi erken yap: cevap yazilmaya baslar baslamaz akit
    await page.waitForTimeout(250);

    while (Date.now() < deadline) {
      const st = await page
        .evaluate(() => {
          const root =
            document.querySelector('#aim-chrome-initial-inline-async-container') ||
            document.querySelector('[data-attrid*="SGE"]') ||
            document.querySelector('block-component');
          if (!root) return { len: 0, complete: false, text: '', busy: false };
          const text = (root.innerText || '').trim();
          // Google cevap blogu bitince data-complete="true" isaretler
          const marks = root.querySelectorAll('[data-complete]');
          const complete =
            marks.length > 0 && Array.from(marks).every((e) => e.getAttribute('data-complete') === 'true');
          // Cevap hala yaziliyor mu? (streaming gostergesi)
          const busy = !!document.querySelector('[role="progressbar"]:not([style*="display: none"])');
          return { len: text.length, complete, text, busy };
        })
        .catch(() => ({ len: 0, complete: false, text: '', busy: false }));

      if (st.text && st.text !== snapshot) {
        snapshot = st.text;
        emitLive(snapshot);
      }

      if (st.text !== lastText) {
        lastText = st.text;
        lastLen = st.len;
        stableSince = Date.now();
      }

      const stableFor = Date.now() - stableSince;
      if (lastLen >= minLen && st.complete && !st.busy && stableFor >= cfg.stableMs) {
        flushLive(snapshot);
        return true;
      }
      // data-complete hic gorunmuyorsa: uzun ve uzun suredir sabit metin yeterli
      if (lastLen >= minLen * 2 && stableFor >= cfg.stableMs * 3) {
        flushLive(snapshot);
        return true;
      }

      await page.waitForTimeout(livePoll);
    }
    flushLive(snapshot);
    return lastLen >= minLen;
  }

  /** Cevap blogundaki "Kopyala" dugmesine basip panoyu okur. */
  async copyAnswer(page) {
    const prev = await page.evaluate(() => navigator.clipboard.readText().catch(() => '')).catch(() => '');

    const clicked = await page
      .evaluate(() => {
        const root =
          document.querySelector('#aim-chrome-initial-inline-async-container') ||
          document.querySelector('[data-attrid*="SGE"]') ||
          document.body;
        const cands = Array.from(root.querySelectorAll('button, [role="button"]'));
        const btn = cands.find((b) => {
          const label = `${b.getAttribute('aria-label') || ''} ${b.innerText || ''}`;
          return /metni kopyala|kopyala|copy text|copy/i.test(label) && !/bağlantı|link/i.test(label);
        });
        if (!btn) return false;
        btn.click();
        return true;
      })
      .catch(() => false);

    if (!clicked) return null;

    // Pano guncellenene kadar kisa bekleme
    for (let i = 0; i < 20; i += 1) {
      await page.waitForTimeout(200);
      const now = await page.evaluate(() => navigator.clipboard.readText().catch(() => '')).catch(() => '');
      if (now && now !== prev && now.length > 40) return now;
    }
    return null;
  }

  /** DOM'dan metin cikarma (pano yolu basarisiz olursa). */
  async extractDom(page) {
    return page.evaluate(() => {
      const clean = (s) =>
        (s || '')
          .replace(/\u00a0/g, ' ')
          .replace(/[ \t]+/g, ' ')
          .replace(/\n{3,}/g, '\n\n')
          .trim();

      const root =
        document.querySelector('#aim-chrome-initial-inline-async-container') ||
        document.querySelector('[data-attrid*="SGE"]') ||
        document.querySelector('block-component') ||
        document.querySelector('div[role="main"]');
      if (!root) return { text: '', sources: [], gotoLinks: [] };

      const clone = root.cloneNode(true);
      clone.style.cssText =
        'position:fixed!important;left:-20000px!important;top:0!important;' +
        'width:1100px!important;height:auto!important;pointer-events:none!important;z-index:-1!important;';
      document.body.appendChild(clone);

      for (const el of Array.from(
        clone.querySelectorAll('script, style, noscript, svg, img, video, audio, canvas, iframe, button, [role="button"]'),
      )) {
        el.remove();
      }
      // NOT: Kaynak kartlarini DOM'dan silmeye calismiyoruz. AI Mode, cevap
      // icindeki varlik adlarini (or. "Berlin") da /goto linki olarak isaretliyor;
      // kart silme bu kelimeleri cevaptan dusuruyor. Kaynaklar zaten ayrica
      // toplandigi icin metinde kartlarin kalmasi sorun degil.

      const blockTags = new Set([
        'P', 'DIV', 'LI', 'UL', 'OL', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
        'TR', 'TD', 'TH', 'TABLE', 'BLOCKQUOTE', 'PRE', 'SECTION', 'ARTICLE', 'BR',
      ]);
      const items = [];
      (function walk(node) {
        for (const child of Array.from(node.childNodes)) {
          if (child.nodeType === Node.TEXT_NODE) {
            const t = (child.nodeValue || '').replace(/\u00a0/g, ' ');
            if (t.trim()) items.push({ type: 'text', v: t });
            continue;
          }
          if (child.nodeType !== Node.ELEMENT_NODE) continue;
          const isBlock = blockTags.has(child.tagName);
          if (isBlock) items.push({ type: 'break' });
          walk(child);
          if (isBlock) items.push({ type: 'break' });
        }
      })(clone);

      const merged = [];
      let cur = '';
      for (const it of items) {
        if (it.type === 'break') {
          if (cur.trim()) merged.push(cur.replace(/\s+/g, ' ').trim());
          cur = '';
          continue;
        }
        if (!cur) cur = it.v;
        else if (/[.,;:!?)]\s*$/.test(cur) || /^\s*[.,;:!?)]/.test(it.v)) cur += it.v;
        else cur += ` ${it.v}`;
      }
      if (cur.trim()) merged.push(cur.replace(/\s+/g, ' ').trim());

      clone.remove();

      const junkRe = [
        /^kopyalandı/i, /^kopyalanamadı/i, /^kopyala$/i, /^copy$/i,
        /^ai modu$/i, /^ai mode$/i, /için ai modu yanıtı/i,
        /^tümü$/i, /^görseller$/i, /^haberler$/i, /^videolar$/i, /^alışveriş$/i,
        /^daha fazla$/i, /^tümünü göster$/i, /^show more$/i,
        /^haritayı genişlet$/i, /^yakınlaştır$/i, /^uzaklaştır$/i, /^map data/i,
        /^yapay zek[âa] destekli/i, /^hata yapabildi/i,
        /verdiği yanıtları doğrulay/i, /^kaynaklar$|^sources$/i,
        /^bu herkese açık bağlantı/i, /^bu sohbetin bir kopyası/i,
        /^bizi bilgilendirdiğiniz/i, /^iyi yanıt$/i, /^kötü yanıt$/i,
        /^google, geri bildiriminizi/i, /^yasal sorunlar için/i,
        /^gizlilik politikamız/i, /^hizmet şartlarımız/i,
        /^bağlantı şu anda/i, /^paylaş$|^share$/i,
      ];
      const codeRe = /_setImageSrc|data:image\/|base64,|document\.querySelector|window\.\w+\s*=/i;
      const isJunk = (s) => {
        const t = s.trim();
        if (!t || t.length > 4000) return true;
        if (codeRe.test(t)) return true;
        return junkRe.some((re) => re.test(t));
      };

      const lines = [];
      for (const m of merged) {
        const t = m.trim();
        if (isJunk(t)) continue;
        if (lines.length && lines[lines.length - 1] === t) continue;
        lines.push(t);
      }

      const scope = document.querySelector('div[role="main"]') || document.body;
      const seen = new Set();
      const gotoLinks = [];
      const sources = [];
      for (const a of scope.querySelectorAll('a[href]')) {
        const raw = a.getAttribute('href') || '';
        if (raw.includes('/goto?url=')) {
          if (!seen.has(raw)) {
            seen.add(raw);
            gotoLinks.push(raw);
          }
          continue;
        }
        if (!/^https?:/i.test(raw)) continue;
        if (/google\.com|gstatic\.com|googleusercontent\.com|policies\.google|support\.google/i.test(raw)) continue;
        if (seen.has(raw)) continue;
        seen.add(raw);
        sources.push({ title: clean(a.innerText || a.getAttribute('aria-label') || ''), url: raw });
      }

      return { text: clean(lines.join('\n')), sources, gotoLinks };
    });
  }

  /** /goto?url=... linklerini gercek adreslere cevirir. */
  async resolveSources(page, dom, gotoLinks) {
    const out = [];
    const direct = (dom && dom.sources) || [];
    for (const s of direct) out.push(s);

    const links = (gotoLinks || []).slice(0, cfg.maxSources + 4);
    for (const raw of links) {
      const abs = raw.startsWith('http') ? raw : `https://www.google.com${raw}`;
      try {
        const resp = await page.request.get(abs, { maxRedirects: 0, timeout: 8000 });
        const loc = resp.headers()['location'];
        if (loc && /^https?:/i.test(loc)) {
          let title = loc;
          try {
            title = new URL(loc).hostname.replace(/^www\./, '');
          } catch {
            /* yoksay */
          }
          out.push({ title, url: loc });
        }
      } catch {
        /* tek link hatasi istegi bozmasin */
      }
    }

    const uniq = [];
    const seen = new Set();
    for (const s of out) {
      if (!s || !s.url) continue;
      const key = s.url.replace(/[#?].*$/, '');
      if (seen.has(key)) continue;
      seen.add(key);
      if (/google\.com|gstatic\.com/i.test(s.url)) continue;
      // Video sure etiketi gibi basliklari hostname ile degistir
      if (!s.title || /^\d{1,2}:\d{2}$/.test(s.title.trim())) {
        try {
          s.title = new URL(s.url).hostname.replace(/^www\./, '');
        } catch {
          s.title = s.url;
        }
      }
      uniq.push(s);
    }
    return uniq;
  }

  async dismissConsent(page) {
    const labels = ['Tümünü kabul et', 'Kabul et', 'Accept all', 'I agree', 'Alle akzeptieren', 'Agree to all'];
    for (const label of labels) {
      try {
        const btn = page.getByRole('button', { name: label, exact: false }).first();
        if (await btn.isVisible({ timeout: 600 }).catch(() => false)) {
          await btn.click({ timeout: 2500 }).catch(() => {});
          await page.waitForTimeout(1000);
          return;
        }
      } catch {
        /* yoksay */
      }
    }
    for (const frame of page.frames()) {
      if (!/consent/i.test(frame.url())) continue;
      try {
        const btn = frame.getByRole('button', { name: /kabul|accept|agree/i }).first();
        if (await btn.isVisible({ timeout: 600 }).catch(() => false)) {
          await btn.click({ timeout: 2500 }).catch(() => {});
          await page.waitForTimeout(1000);
        }
      } catch {
        /* yoksay */
      }
    }
  }

  async detectBlock(page) {
    const current = page.url();
    if (/\/sorry\//.test(current)) {
      return `Google dogrulama istedi (${current}). Tarayiciyi acip elle gecmen gerekiyor.`;
    }
    const has = await page
      .evaluate(() => {
        return !!(
          document.querySelector('#captcha-form') ||
          document.querySelector('form[action*="sorry"]') ||
          document.querySelector('iframe[src*="recaptcha"]') ||
          /unusual traffic|olağan dışı trafik|otomatik sorgu/i.test(document.body?.innerText || '')
        );
      })
      .catch(() => false);
    if (has) return 'Google captcha / "olagan disi trafik" ekrani gosterdi.';
    return null;
  }
}

module.exports = { GoogleAiModeEngine };
