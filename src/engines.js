'use strict';

/**
 * Motor secimi (tek yerden).
 *
 *   AIM_ENGINE=hybrid   once HTTP, olmazsa Chromium  (varsayilan)
 *   AIM_ENGINE=http     yalnizca tarayicisiz
 *   AIM_ENGINE=browser  yalnizca Chromium
 */

const cfg = require('./config');
const { HttpEngine } = require('./http-engine');
const { GoogleAiModeEngine } = require('./engine');
const { HybridEngine } = require('./hybrid-engine');

function createEngine(kind = cfg.engine) {
  if (kind === 'browser') return new GoogleAiModeEngine();
  if (kind === 'http') return new HttpEngine();
  return new HybridEngine();
}

module.exports = { createEngine };
