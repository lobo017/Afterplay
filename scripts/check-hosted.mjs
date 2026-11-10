// Checks a hosted copy of the app (a Cloudflare Pages preview or production URL) the way a first visitor meets it:
//
//   node scripts/check-hosted.mjs <url> [--browser chromium|webkit|webkit-iphone]
//
// (`webkit-iphone`: Playwright's WebKit as an iPhone 13, which also checks the first-run Add to Home Screen guide and
// the phone engine profile. It is still not Safari on a real iPhone.)
//
// 1. The page arrives with the isolation headers and is cross-origin isolated (the engine gets its threads).
// 2. The service worker caches the whole build.
// 3. The engine analyses a position (a mate is found) and the bot answers a move.
// 4. Offline: the browser is cut off from the network, the page reloads from the cache, still isolated, and the bot
//    still answers.
// 5. Install (Chromium): a full manifest, and Chrome's own installability check finds nothing wrong.
// 6. The sample first-run link (/start/sample/), as a first visitor: the host serves the link's own page and
//    manifest, the preset is applied (look, names, welcome), and an unknown link says so.
// 7. Every request the pages made went to the hosted origin itself.
//
// Screenshots go to test-results/hosted/. Exit code 0 when every check passes. A dev-time script: it is the only
// thing here that talks to the hosted site, and it sends nothing but ordinary page requests.
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { chromium, devices, webkit } from '@playwright/test';
import { browserLaunchOptions } from './lib/browser.mjs';

const args = process.argv.slice(2);
const url = args.find((a) => /^https?:\/\//.test(a));
const browserName = args.includes('--browser') ? args[args.indexOf('--browser') + 1] : 'chromium';
const iphone = browserName === 'webkit-iphone';
if (!url || !['chromium', 'webkit', 'webkit-iphone'].includes(browserName)) {
  console.error('usage: node scripts/check-hosted.mjs <url> [--browser chromium|webkit|webkit-iphone]');
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

const launcher = browserName === 'chromium' ? chromium : webkit;
const browser = await launcher.launch(browserName === 'chromium' ? browserLaunchOptions() : { headless: true });
const killTimer = setTimeout(() => {
  console.error('check-hosted: over 10 minutes, giving up');
  void browser.close().finally(() => process.exit(3));
}, 10 * 60_000);

try {
  const context = await browser.newContext(
    iphone
      ? { ...devices['iPhone 13'], serviceWorkers: 'allow' }
      : { serviceWorkers: 'allow', viewport: { width: 1280, height: 800 } },
  );
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
  if (iphone) {
    // A first visit on an iPhone: the Add to Home Screen guide, then out of the way
    const guide = await waitFor(() => page.getByTestId('install-guide').isVisible(), 10_000);
    check('Add to Home Screen guide opens on the first visit', Boolean(guide));
    if (guide) {
      await page.screenshot({ path: path.join(OUT, `${browserName}-install-guide.png`) });
      await page.getByTestId('install-guide-done').click();
    }
    const profile = (await page.getByTestId('stat-engine-profile').textContent())?.trim() ?? '';
    const oneEngine = await page.evaluate(
      () => window.__wizardChessPlay?.botEngine === window.__wizardChessPlay?.engine,
    );
    check('phone engine profile (one engine)', oneEngine && profile.startsWith('Phone:'), profile);
  }
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

  // 6. The sample first-run link, in a browser that has never seen the site
  const linkContext = await browser.newContext(
    iphone
      ? { ...devices['iPhone 13'], serviceWorkers: 'allow' }
      : { serviceWorkers: 'allow', viewport: { width: 1280, height: 800 } },
  );
  const link = await linkContext.newPage();
  link.on('request', (r) => {
    const u = r.url();
    if (/^https?:/.test(u) && new URL(u).origin !== origin) foreign.add(u);
  });
  const linkUrl = new URL('/start/sample/', origin).href;
  const linkResponse = await link.goto(linkUrl, { waitUntil: 'load', timeout: 60_000 });
  const lh = linkResponse?.headers() ?? {};
  const linkHtml = (await linkResponse?.text()) ?? '';
  check(
    "first-run link: the host serves the link's own page",
    linkHtml.includes('href="/start/sample/manifest.webmanifest"') && /<title>Ada's Chess<\/title>/.test(linkHtml),
    new URL(link.url()).pathname,
  );
  check(
    'first-run link: isolated, re-checked by browsers, not for search engines',
    lh['cross-origin-opener-policy'] === 'same-origin' &&
      lh['cross-origin-embedder-policy'] === 'require-corp' &&
      /no-cache/.test(lh['cache-control'] ?? '') &&
      /noindex/.test(lh['x-robots-tag'] ?? ''),
    `cache-control ${lh['cache-control']}, x-robots-tag ${lh['x-robots-tag']}`,
  );
  const shell = link.getByTestId('app-shell');
  const applied = await waitFor(async () => (await shell.getAttribute('data-first-run')) === 'applied', 30_000);
  check('first-run link: the preset is applied', Boolean(applied), (await shell.getAttribute('data-first-run')) ?? '');
  const welcome = await waitFor(() => link.getByTestId('welcome-sheet').isVisible(), 10_000);
  check('first-run link: the welcome message opens', Boolean(welcome));
  if (welcome) {
    await link.screenshot({ path: path.join(OUT, `${browserName}-first-run-welcome.png`) });
    await link.getByTestId('welcome-done').click();
  }
  if (iphone) {
    const guide = await waitFor(() => link.getByTestId('install-guide').isVisible(), 10_000);
    check('first-run link: the Add to Home Screen guide follows the welcome', Boolean(guide));
    if (guide) await link.getByTestId('install-guide-done').click();
  }
  const look = await link.evaluate(() => {
    const frame = document.querySelector('[data-testid="play-layout"] [data-testid="chess-board-frame"]');
    return {
      theme: frame?.getAttribute('data-theme'),
      pieces: frame?.getAttribute('data-piece-set'),
      me: document.querySelector('[data-testid="bottom-player-name"]')?.textContent,
      bot: document.querySelector('[data-testid="top-player-name"]')?.textContent,
      title: document.title,
    };
  });
  check(
    'first-run link: look and names are the preset’s',
    look.theme === 'green' &&
      look.pieces === 'classic' &&
      look.me === 'Ada (White)' &&
      look.bot === 'Professor Rook (800)' &&
      look.title === "Ada's Chess",
    JSON.stringify(look),
  );
  await link.screenshot({ path: path.join(OUT, `${browserName}-first-run-play.png`) });
  const linkManifest = await link.evaluate(async () => {
    const href = document.querySelector('link[rel="manifest"]')?.href;
    return href ? (await fetch(href)).json() : null;
  });
  check(
    'first-run link: its manifest starts the installed app at the link',
    Boolean(linkManifest && linkManifest.start_url === '/start/sample/' && linkManifest.name === "Ada's Chess"),
    linkManifest ? `${linkManifest.name}, start_url ${linkManifest.start_url}` : 'no manifest',
  );
  if (browserName === 'chromium') {
    const cdp = await linkContext.newCDPSession(link);
    const { installabilityErrors } = await cdp.send('Page.getInstallabilityErrors');
    const errors = installabilityErrors.map((e) => e.errorId).filter((id) => id !== 'in-incognito');
    check('first-run link: Chrome finds it installable', errors.length === 0, errors.join(', ') || 'no errors');
  }
  // An unknown link: the app opens as usual and says the link is not known
  await link.goto(new URL('/start/no-such-link/', origin).href, { waitUntil: 'load', timeout: 60_000 });
  const unknown = await waitFor(async () => (await shell.getAttribute('data-first-run')) === 'failed', 30_000);
  const notice = unknown ? ((await link.getByTestId('app-notice-text').textContent()) ?? '') : '';
  check('an unknown first-run link says so', Boolean(unknown) && /not known here/.test(notice), notice);
  await linkContext.close();

  // 7. Nothing but the hosted origin
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
