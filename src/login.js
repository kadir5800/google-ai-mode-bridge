'use strict';

/**
 * Tek seferlik "giris / dogrulama" penceresi.
 * AI Mode bazi hesaplarda girisli olmayi veya cerez onayini gerektiriyor.
 * Bu script tarayiciyi GORUNUR sekilde acar; sen isini bitirince
 * terminalde Enter'a bas, profil kaydedilir.
 */
const { GoogleAiModeEngine } = require('./engine');
const readline = require('readline');

(async () => {
  const engine = new GoogleAiModeEngine();
  const page = await engine.ensureBrowser();
  await page.goto('https://www.google.com/search?q=test&udm=50', { waitUntil: 'domcontentloaded' });

  console.log('\nTarayici acildi.');
  console.log('1) Cerez/consent ekranini kabul et.');
  console.log("2) AI Mode'un gercekten cevap verdigini gor (bir soru yaz).");
  console.log('3) Gerekirse Google hesabina giris yap.');
  console.log('Hazir oldugunda burada Enter\'a bas...\n');

  await new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question('', () => {
      rl.close();
      resolve();
    });
  });

  console.log('Profil kaydediliyor...');
  await engine.close();
  console.log('Tamam. Artik `npm start` ile sunucuyu baslatabilirsin.');
})();
