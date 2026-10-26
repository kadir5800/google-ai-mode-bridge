'use strict';

/**
 * Cerezleri Chrome profilinden bir kez disa aktarir.
 *
 * Tarayicisiz motor (src/http-engine.js) Google oturumunu cerezlerle tasir;
 * bu betik profildeki cerezleri cookies.json'a yazar. Cerezler suresi
 * doldugunda (haftalar/aylar) bu komutu tekrar calistirmak yeterli.
 *
 *   npm run export-cookies
 */

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const cfg = require('./config');

(async () => {
  console.log(`Profil: ${cfg.profileDir}`);
  const ctx = await chromium.launchPersistentContext(cfg.profileDir, {
    headless: true,
    channel: cfg.chromeChannel,
    locale: cfg.locale,
    args: ['--disable-blink-features=AutomationControlled', '--no-first-run'],
    ignoreDefaultArgs: ['--enable-automation'],
  });

  try {
    const cookies = await ctx.cookies();
    // Sadece Google alan adlari yeterli
    const relevant = cookies.filter((c) => /(^|\.)google\.com$/.test(c.domain));
    const file = path.join(cfg.dataDir, 'cookies.json');
    fs.writeFileSync(
      file,
      JSON.stringify(
        {
          exportedAt: new Date().toISOString(),
          cookies: relevant.length ? relevant : cookies,
        },
        null,
        2,
      ),
    );

    console.log(`\n${relevant.length || cookies.length} cerez yazildi: ${file}`);
    const names = (relevant.length ? relevant : cookies).map((c) => c.name);
    console.log(`Cerezler: ${names.join(', ')}`);
    console.log(
      names.includes('SID') || names.includes('__Secure-1PSID')
        ? '\nGoogle hesabi oturumu var (SID bulundu).'
        : '\nUYARI: Google hesabi oturumu yok (SID yok). AI Mode anonim calisacak;' +
            ' bazi hesaplarda/bolgelerde bos cevap donebilir. Giris icin: npm run login',
    );
  } finally {
    await ctx.close();
  }
})().catch((e) => {
  console.error(`Hata: ${e.message}`);
  process.exit(1);
});
