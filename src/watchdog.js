'use strict';

/**
 * Kopruyu ayakta tutan gozcu.
 *
 * Neden: sunucu bir terminalde acik kaldigi surece yasiyordu; terminal
 * kapaninca ya da surec cokunce Cline "ECONNREFUSED 127.0.0.1:8787"
 * aliyordu. Bu betik sunucuyu alt surec olarak baslatir ve beklenmedik
 * sekilde olurse yeniden ayaga kaldirir.
 *
 *   npm run serve     (terminali acik birak)
 */

const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const cfg = require('./config');

const SERVER = path.join(__dirname, 'server.js');
const RESTART_DELAY_MS = 3000;
const STABLE_MS = 30000;

let child = null;
let shuttingDown = false;
let lastStart = 0;

function log(msg) {
  console.log(`[gozcu] ${msg}`);
}

function start() {
  lastStart = Date.now();
  child = spawn(process.execPath, [SERVER], { stdio: 'inherit', env: process.env });

  child.on('exit', (code, signal) => {
    if (shuttingDown) return;

    const lived = Date.now() - lastStart;
    if (code === 1 && lived < 2000) {
      // Hemen oluyorsa yeniden denemek anlamsiz: genelde port dolu ya da
      // yapilandirma hatasi. Sonsuz donguye girmeyelim.
      log('Sunucu hemen kapandi. Ayarlari kontrol edip tekrar dene.');
      process.exit(1);
    }

    log(`Sunucu kapandi (kod=${code} sinyal=${signal || '-'}). ${RESTART_DELAY_MS / 1000}s sonra yeniden baslatiliyor...`);
    setTimeout(start, RESTART_DELAY_MS);
  });

  child.on('error', (e) => log(`Baslatilamadi: ${e.message}`));

  // Kararli calisiyorsa bilgi ver
  setTimeout(() => {
    if (child && !shuttingDown && Date.now() - lastStart >= STABLE_MS - 500) {
      checkHealth();
    }
  }, STABLE_MS);
}

function checkHealth() {
  const req = http.get(
    { host: cfg.host, port: cfg.port, path: '/health', timeout: 4000 },
    (res) => {
      let buf = '';
      res.on('data', (d) => (buf += d));
      res.on('end', () => {
        if (res.statusCode === 200) log(`Hazir: http://${cfg.host}:${cfg.port}/v1`);
        else log(`Saglik kontrolu ${res.statusCode} dondu.`);
      });
    },
  );
  req.on('error', (e) => log(`Saglik kontrolu basarisiz: ${e.code || e.message}`));
  req.on('timeout', () => req.destroy());
}

function stop(exitCode) {
  if (shuttingDown) return;
  shuttingDown = true;
  log('Kapatiliyor...');
  if (child && child.exitCode === null) {
    child.kill('SIGTERM');
    setTimeout(() => {
      if (child && child.exitCode === null) child.kill('SIGKILL');
      process.exit(exitCode);
    }, 3000).unref();
  } else {
    process.exit(exitCode);
  }
}

process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));

log(`Kopru izleniyor: http://${cfg.host}:${cfg.port}/v1`);
start();
