// Checks a hosted copy of the app (a Cloudflare Pages preview or production URL) the way a first visitor meets it:
//
//   node scripts/check-hosted.mjs <url> [--browser chromium|webkit]
//
// 1. The page arrives with the isolation headers and is cross-origin isolated (the engine gets its threads).
// 2. The service worker caches the whole build.
// 3. The engine analyses a position (a mate is found) and the bot answers a move.
// 4. Offline: the browser is cut off from the network, the page reloads from the cache, still isolated, and the bot
//    still answers.
// 5. Install (Chromium): a full manifest, and Chrome's own installability check finds nothing wrong.
// 6. Every request the page made went to the hosted origin itself.
//
// Screenshots go to test-results/hosted/. Exit code 0 when every check passes. A dev-time script: it is the only
// thing here that talks to the hosted site, and it sends nothing but ordinary page requests.
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { chromium, webkit } from '@playwright/test';
import { browserLaunchOptions } from './lib/browser.mjs';

const args = process.argv.slice(2);
const url = args.find((a) => /^https?:\/\//.test(a));
const browserName = args.includes('--browser') ? args[args.indexOf('--browser') + 1] : 'chromium';
if (!url || !['chromium', 'webkit'].includes(browserName)) {
  console.error('usage: node scripts/check-hosted.mjs <url> [--browser chromium|webkit]');
  process.exit(2);
}
const origin = new URL(url).origin;
const OUT = path.join('test-results', 'hosted');
fs.mkdirSync(OUT, { recursive: true });

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}

async function waitFor(fn, timeoutMs, stepMs = 250) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn().catch(() => undefined);
    if (value) return value;
    if (Date.now() > end) return undefined;
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

/** Plays e2-e4 on the Play board and waits for the bot's reply (its own engine and worker). */
async function botAnswers(page) {
  await page.evaluate(() => window.__wizardChessPlay?.controller.setBotMoveDelayMs(5));
  await page.getByTestId('play-layout').getByTestId('square-e2').click();
  await page.getByTestId('play-layout').getByTestId('square-e4').click();
  return waitFor(
    () => page.evaluate(() => window.__wizardChessPlay?.controller.getGameTree().getMainLine().length === 2),
    60_000,
  );
}

const launcher = browserName === 'webkit' ? webkit : chromium;
const browser = await launcher.launch(browserName === 'webkit' ? { headless: true } : browserLaunchOptions());
const killTimer = setTimeout(() => {
  console.error('check-hosted: over 10 minutes, giving up');
  void browser.close().finally(() => process.exit(3));
}, 10 * 60_000);

try {
  const context = await browser.newContext({ serviceWorkers: 'allow', viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  const foreign = new Set();
  page.on('request', (r) => {
    const u = r.url();
    if (/^https?:/.test(u) && new URL(u).origin !== origin) foreign.add(u);
  });

  // 1. Headers and isolation
  const response = await page.goto(url, { waitUntil: 'load', timeout: 60_000 });
  const h = response?.headers() ?? {};
  check(
    'page sent COOP/COEP',
    h['cross-origin-opener-policy'] === 'same-origin' && h['cross-origin-embedder-policy'] === 'require-corp',
    `COOP ${h['cross-origin-opener-policy']}, COEP ${h['cross-origin-embedder-policy']}`,
  );
  await page.getByTestId('play-layout').waitFor({ timeout: 60_000 });
  check('cross-origin isolated', await page.evaluate(() => window.crossOriginIsolated));
  for (const p of ['/sw.js', '/index.html']) {
    const r = await page.request.get(new URL(p, origin).href);
    check(
      `${p} is re-checked by browsers`,
      /no-cache/.test(r.headers()['cache-control'] ?? ''),
      r.headers()['cache-control'],
    );
  }

  // 2. The service worker caches the build
  const offlineText = await waitFor(async () => {
    const t = await page.getByTestId('stat-offline').textContent();
    return /^Ready: all \d+ files are cached$/.test(t ?? '') ? t : undefined;
  }, 180_000);
  check('service worker cached the build', Boolean(offlineText), offlineText ?? 'not ready within 3 min');
  check('service worker controls the page', await page.evaluate(() => navigator.serviceWorker.controller !== null));

  // 3. The engine: a mate on the analysis board, and the bot's reply
  await page.getByTestId('mode-tab-review').click();
  await page.getByTestId('analysis-layout').waitFor({ timeout: 30_000 });
  await page.evaluate(() => window.__wizardChessAnalysis.controller.loadFen('6k1/5ppp/8/8/8/8/8/3R2K1 w - - 0 1'));
  if ((await page.getByTestId('toggle-analysis-engine').getAttribute('aria-pressed')) !== 'true') {
    await page.getByTestId('toggle-analysis-engine').click();
  }
  const mate = await waitFor(
    async () => (await page.getByTestId('eval-bar').getAttribute('data-mate')) === 'true',
    60_000,
  );
  const depthOf = async () =>
    Number(/\d+/.exec((await page.getByTestId('analysis-depth').textContent()) ?? '')?.[0] ?? 0);
  const deepEnough = await waitFor(async () => (await depthOf()) >= 10, 60_000);
  const evalText = (await page.getByTestId('eval-bar').getAttribute('aria-label')) ?? '';
  check(
    'engine finds the back-rank mate',
    Boolean(mate && deepEnough),
    `depth ${await depthOf()}${evalText ? `, ${evalText}` : ''}`,
  );
  const caps = await page.evaluate(() => window.__wizardChessEngine?.detectEngineCapabilities() ?? null);
  const threading = (await page.getByTestId('stat-threading').textContent())?.trim();
  check(
    'engine can run multi-threaded',
    Boolean(caps?.multiThreadedSupported),
    `${caps?.recommendedThreads ?? '?'} threads recommended; About says "${threading}"`,
  );
  await page.screenshot({ path: path.join(OUT, `${browserName}-analysis.png`) });
  await page.getByTestId('mode-tab-play').click();
  check('bot answers a move', Boolean(await botAnswers(page)));

  // 4. Offline
  await context.setOffline(true);
  await page.reload({ waitUntil: 'load' });
  await page.getByTestId('play-layout').waitFor({ timeout: 60_000 });
  check('offline reload works', true);
  check('still isolated offline', await page.evaluate(() => window.crossOriginIsolated));
  // A reload ends the game in progress; start a fresh one
  check('bot answers offline', Boolean(await botAnswers(page)));
  await page.screenshot({ path: path.join(OUT, `${browserName}-offline-play.png`) });
  await context.setOffline(false);

  // 5. Install
  const manifest = await page.evaluate(async () => {
    const href = document.querySelector('link[rel="manifest"]')?.href;
    return href ? (await fetch(href)).json() : null;
  });
  check(
    'manifest is complete',
    Boolean(manifest && manifest.display === 'standalone' && manifest.icons?.some((i) => i.sizes === '512x512')),
    manifest ? `${manifest.name}, ${manifest.icons.length} icons` : 'no manifest',
  );
  if (browserName === 'chromium') {
    const cdp = await context.newCDPSession(page);
    const { installabilityErrors } = await cdp.send('Page.getInstallabilityErrors');
    const errors = installabilityErrors.map((e) => e.errorId).filter((id) => id !== 'in-incognito');
    check('Chrome finds it installable', errors.length === 0, errors.join(', ') || 'no errors');
  }

  // 6. Nothing but the hosted origin
  check('no request left the hosted origin', foreign.size === 0, [...foreign].slice(0, 5).join(' '));
} catch (err) {
  check('the run itself', false, err instanceof Error ? err.message : String(err));
} finally {
  clearTimeout(killTimer);
  await browser.close();
}

const failed = results.filter((r) => !r.ok);
fs.writeFileSync(
  path.join(OUT, `${browserName}-result.json`),
  JSON.stringify({ url, browser: browserName, at: new Date().toISOString(), results }, null, 2),
);
console.log(`\n${results.length - failed.length}/${results.length} checks passed on ${url} (${browserName})`);
process.exit(failed.length ? 1 : 0);
