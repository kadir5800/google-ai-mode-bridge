'use strict';

/**
 * Tek seferlik soru sor:
 *   npm run ask -- "Turkiye'de en yuksek kisim neresi?"
 */
const { GoogleAiModeEngine } = require('./engine');

(async () => {
  const query = process.argv.slice(2).join(' ').trim();
  if (!query) {
    console.error('Kullanim: npm run ask -- "sorunuz"');
    process.exit(1);
  }
  const engine = new GoogleAiModeEngine();
  try {
    const answer = await engine.ask(query);
    console.log(`\n[mod: ${answer.mode}]\n`);
    console.log(answer.text);
    if (answer.sources.length) {
      console.log('\nKaynaklar:');
      answer.sources.forEach((s, i) => console.log(`  ${i + 1}. ${s.title} - ${s.url}`));
    }
  } catch (e) {
    console.error(`\nHata: ${e.message}`);
    process.exitCode = 1;
  } finally {
    await engine.close();
  }
})();
