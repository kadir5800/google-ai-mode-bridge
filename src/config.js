'use strict';

const path = require('path');

const ROOT = path.resolve(__dirname, '..');

/**
 * Tum ayarlar ortam degiskeni ile ezilebilir.
 * Gerekmedikce degistirmene gerek yok.
 */
module.exports = {
  // OpenAI uyumlu sunucu
  host: process.env.AIM_HOST || '127.0.0.1',
  port: Number(process.env.AIM_PORT || 8787),
  apiKey: process.env.AIM_API_KEY || 'google-ai-mode',

  // Model adlari (Cursor'da bu isimle gorunur)
  modelIds: (process.env.AIM_MODEL_IDS || 'google-ai-mode,google-ai-mode-search,gemini-web')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  // Tarayici
  // NOT: Profil yolu ASCII olmali. Chrome, Turkce karakter iceren
  // --user-data-dir yollarinda "mevcut oturumda aciliyor" hatasi verip kapaniyor.
  profileDir:
    process.env.AIM_PROFILE_DIR ||
    path.join(process.env.LOCALAPPDATA || require('os').tmpdir(), 'google-ai-mode-profile'),

  // Tarayicisiz (HTTP) motor icin veri dizini: cookies.json burada tutulur
  dataDir: process.env.AIM_DATA_DIR || ROOT,

  // Motor: "hybrid" (varsayilan: once HTTP, gerekirse Chromium),
  //        "http" (yalnizca tarayicisiz), "browser" (yalnizca Chromium)
  engine: process.env.AIM_ENGINE || 'hybrid',

  // Tarayicisiz motorda istekler arasi minimum bekleme (ms).
  // Google cok hizli ardisik isteklerde AI Mode'u gondermeyi birakiyor.
  minIntervalMs: Number(process.env.AIM_MIN_INTERVAL_MS || 1500),

  headless: process.env.AIM_HEADLESS === '1',
  chromeChannel: process.env.AIM_CHANNEL || 'chrome',
  locale: process.env.AIM_LOCALE || 'tr-TR',
  // AI Mode kapaliysa normal aramadaki AI Overview'a dus
  allowOverviewFallback: process.env.AIM_NO_FALLBACK !== '1',

  // Zamanlamalar (ms)
  navTimeout: Number(process.env.AIM_NAV_TIMEOUT || 45000),
  answerTimeout: Number(process.env.AIM_ANSWER_TIMEOUT || 40000),
  // Metin bu kadar sure degismezse cevap bitti sayilir
  stableMs: Number(process.env.AIM_STABLE_MS || 3500),
  pollMs: Number(process.env.AIM_POLL_MS || 350),
  // Ayni tarayici oturumunda istekleri siraya koy
  maxQueue: Number(process.env.AIM_MAX_QUEUE || 8),

  // Cevaba kaynak linkleri ekle
  includeSources: process.env.AIM_SOURCES !== '0',
  maxSources: Number(process.env.AIM_MAX_SOURCES || 6),
};
