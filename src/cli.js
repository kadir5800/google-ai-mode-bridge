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
    console.error(`\nHata: ${e.message}`);
    process.exitCode = 1;
  } finally {
    if (typeof engine.close === 'function') await engine.close();
  }
})();
