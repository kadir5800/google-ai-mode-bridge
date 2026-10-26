'use strict';

/**
 * Tek seferlik soru sor:
 *   npm run ask -- "Turkiye'de en yuksek kisim neresi?"
 *
 * Motor secimi: AIM_ENGINE=http (varsayilan) | browser
 */
const { createEngine } = require('./engines');

(async () => {
  const query = process.argv.slice(2).join(' ').trim();
  if (!query) {
    console.error('Kullanim: npm run ask -- "sorunuz"');
    process.exit(1);
  }
  const engine = createEngine();
  try {
    const t0 = Date.now();
    const answer = await engine.ask(query);
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`\n[mod: ${answer.mode} | ${secs}s]\n`);
    console.log(answer.text);
    if (answer.sources && answer.sources.length) {
      console.log('\nKaynaklar:');
      answer.sources.forEach((s, i) => console.log(`  ${i + 1}. ${s.title}${s.url ? ` - ${s.url}` : ''}`));
    }
  } catch (e) {
    if (/RATE_LIMIT/.test(e.message)) {
      console.error("\nGoogle bu IP'yi gecici olarak engelledi.\n");
      console.error(e.message.replace(/^RATE_LIMIT:\s*/, ''));
      console.error('\nNe yapmali:');
      console.error('  1. 5-10 dakika bekle (engel kendiliginden kalkar)');
      console.error('  2. Google hesabinla giris yap:  npm run login  ->  npm run export-cookies');
      console.error('  3. Istekleri seyrekle:  $env:AIM_MIN_INTERVAL_MS = "5000"');
    } else if (/THROTTLED/.test(e.message)) {
      console.error('\nGoogle AI Mode cevabini gondermedi (hiz siniri).\n');
      console.error(e.message.replace(/^THROTTLED:\s*/, ''));
    } else {
      console.error(`\nHata: ${e.message}`);
    }
    process.exitCode = 1;
  } finally {
    if (typeof engine.close === 'function') await engine.close();
  }
})();
