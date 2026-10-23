'use strict';

/**
 * Teshis: bir sorgu at, sayfanin HTML'ini ve bulunan cevap bloklarini diske yaz.
 *   npm run debug -- "test sorgusu"
 */
const fs = require('fs');
const path = require('path');
const { GoogleAiModeEngine } = require('./engine');
const cfg = require('./config');

(async () => {
  const query = process.argv.slice(2).join(' ').trim() || 'yapay zeka nedir';
  const engine = new GoogleAiModeEngine();
  const outDir = path.join(__dirname, '..', 'debug');
  fs.mkdirSync(outDir, { recursive: true });

  try {
    const page = await engine.ensureBrowser();
    const url = `https://www.google.com/search?q=${encodeURIComponent(query)}&udm=50`;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: cfg.navTimeout });
    await engine.dismissConsent(page);
    await page.waitForTimeout(9000);

    const html = await page.content();
    fs.writeFileSync(path.join(outDir, 'page.html'), html, 'utf8');
    await page.screenshot({ path: path.join(outDir, 'page.png') });
    fs.writeFileSync(path.join(outDir, 'url.txt'), page.url(), 'utf8');

    const dom = await engine.extractDom(page);
    const ready = await engine.waitForAnswer(page, 5000);
    fs.writeFileSync(path.join(outDir, 'extract.json'), JSON.stringify({ ready, dom }, null, 2), 'utf8');

    const blocked = await engine.detectBlock(page);
    console.log(`URL: ${page.url()}`);
    console.log(`AI Mode cevabi hazir mi: ${ready}`);
    console.log(`Engel: ${blocked || 'yok'}`);
    console.log(`DOM metin uzunlugu: ${dom.text.length}`);
    console.log(`DOM kaynak sayisi: ${dom.sources.length}`);
    console.log(`goto link sayisi: ${dom.gotoLinks.length}`);
    console.log(`\nDosyalar: ${outDir}`);
    if (dom.text) console.log(`\n--- Ilk 400 karakter ---\n${dom.text.slice(0, 400)}`);
  } catch (e) {
    console.error(`Hata: ${e.message}`);
    process.exitCode = 1;
  } finally {
    await engine.close();
  }
})();
