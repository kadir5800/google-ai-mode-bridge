'use strict';

/**
 * Hibrit motor: once tarayicisiz HTTP (~1-2s), olmazsa Chromium (yedek).
 *
 * Neden: HTTP yolu 10x hizli ve hafif, ama Google IP'yi gecici olarak
 * sinirladiginda AI Mode kapsayicisini gondermiyor (THROTTLED). Bu durumda
 * gercek tarayici ile ayni sayfa cok daha guvenilir calisiyor.
 *
 * AIM_FALLBACK=browser (varsayilan) | none
 */

const { HttpEngine } = require('./http-engine');
const { GoogleAiModeEngine } = require('./engine');

const FALLBACK_CODES = /THROTTLED|EMPTY:/;

class HybridEngine {
  constructor() {
    this.http = new HttpEngine();
    this.browser = new GoogleAiModeEngine();
    this.fallbackUsed = 0;
  }

  get busy() {
    return this.http.busy || this.browser.busy;
  }

  async ask(query, opts = {}) {
    try {
      return await this.http.ask(query, opts);
    } catch (e) {
      if (!FALLBACK_CODES.test(e.message)) throw e;
      if (process.env.AIM_FALLBACK === 'none') throw e;

      this.fallbackUsed += 1;
      process.stderr.write(`[hybrid] HTTP basarisiz (${e.message.slice(0, 60)}), Chromium'a geciliyor\n`);

      const answer = await this.browser.ask(query, opts);
      return { ...answer, mode: `${answer.mode}+fallback`, httpError: e.message };
    }
  }

  async close() {
    await this.browser.close().catch(() => {});
  }
}

module.exports = { HybridEngine };
