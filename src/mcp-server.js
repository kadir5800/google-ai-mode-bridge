#!/usr/bin/env node
'use strict';

/**
 * Google AI Mode - MCP sunucusu
 *
 * Cursor'in (veya herhangi bir MCP istemcisinin) agent'ina "google_ai_mode"
 * adinda gercek bir arac olarak baglanir. Cursor kendi function calling
 * yetenegiyle bu araci cagirir; boylece AI Mode agent'in bir YETENEGI olur.
 *
 * KRITIK: MCP stdio tasima katmani stdout'u protokol icin kullanir.
 * Bu dosyada ASLA console.log kullanilmaz; tum loglar stderr'e gider.
 */

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');

const cfg = require('./config');
const { GoogleAiModeEngine } = require('./engine');

const log = (...a) => process.stderr.write(`[ai-mode-mcp] ${a.join(' ')}\n`);

const engine = new GoogleAiModeEngine();

const server = new McpServer({
  name: 'google-ai-mode',
  version: '1.0.0',
});

function formatResult(answer) {
  let out = answer.text || '';
  if (answer.sources && answer.sources.length) {
    out += '\n\nKaynaklar:\n';
    answer.sources.forEach((s, i) => {
      out += `${i + 1}. ${s.title} - ${s.url}\n`;
    });
  }
  return out.trim();
}

server.registerTool(
  'google_ai_mode',
  {
    title: 'Google AI Mode ile web aramasi',
    description:
      "Google'in arama sonuclarindaki AI Mode'unu kullanarak guncel bilgi arar. " +
      'Kaynak linkleriyle birlikte derlenmis bir cevap doner. ' +
      'Guncel olaylar, fiyatlar, surumler, dokumantasyon veya internet bilgisi ' +
      'gerektiren sorularda kullan. Cevap 10-20 saniye surebilir.',
    inputSchema: {
      query: z
        .string()
        .min(2)
        .describe('Aranacak soru veya anahtar kelimeler. Dogal dilde yazilabilir.'),
      includeSources: z
        .boolean()
        .optional()
        .describe('Kaynak linklerini de dondur (varsayilan: true)'),
    },
  },
  async ({ query, includeSources }) => {
    const started = Date.now();
    log(`sorgu: ${query.slice(0, 120)}`);
    try {
      const answer = await engine.ask(query);
      const withSources = includeSources !== false && answer.sources.length > 0;
      const body = withSources
        ? formatResult(answer)
        : answer.text || '';

      log(`tamam ${Date.now() - started}ms, ${body.length} karakter, ${answer.sources.length} kaynak`);

      return {
        content: [{ type: 'text', text: body }],
      };
    } catch (e) {
      log(`hata: ${e.message}`);
      const friendly = /BLOCKED/.test(e.message)
        ? 'Google bu istegi engelledi (captcha/dogrulama). `npm run login` ile tarayiciyi acip elle dogrulama yapmasi gerekiyor.'
        : e.message;
      return {
        isError: true,
        content: [{ type: 'text', text: `AI Mode aramasi basarisiz: ${friendly}` }],
      };
    }
  },
);

server.registerTool(
  'google_ai_mode_login',
  {
    title: 'AI Mode oturum durumunu kontrol et',
    description:
      'Google AI Mode tarayici oturumunun calisip calismadigini kontrol eder. ' +
      'Aramalar basarisiz oldugunda teshis icin kullan.',
    inputSchema: {},
  },
  async () => {
    try {
      const page = await engine.ensureBrowser();
      const state = await page.evaluate(() => ({
        url: location.href,
        loggedIn: !!document.querySelector('a[aria-label*="Google Hesab"], img[aria-label*="profil" i]'),
      }));
      return {
        content: [
          {
            type: 'text',
            text:
              `Tarayici calisiyor.\nProfil: ${cfg.profileDir}\n` +
              `Google girisi: ${state.loggedIn ? 'evet' : 'hayir (gerekli olmayabilir)'}\n` +
              'Sorun varsa terminalde `npm run login` calistir.',
          },
        ],
      };
    } catch (e) {
      return {
        isError: true,
        content: [{ type: 'text', text: `Tarayici baslatilamadi: ${e.message}` }],
      };
    }
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log('hazir (stdio)');
}

async function shutdown() {
  try {
    await engine.close();
  } catch {
    /* yoksay */
  }
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

main().catch((e) => {
  log(`baslatma hatasi: ${e.message}`);
  process.exit(1);
});
