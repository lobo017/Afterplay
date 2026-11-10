// Smoke test of the Linux harness, run by the setup job inside the Playwright container (and runnable anywhere):
//
//   node hpc/smoke.mjs [--extension-headed]
//
// 1. Chromium starts headless and a blank page's frame cadence is measured (the number perf:drag judges its run by).
// 2. The built-in static server (scripts/serve.mjs) starts on the job's port and a tiny page it serves is
//    cross-origin isolated (what the multi-threaded engine needs).
// 3. The capture extension builds and loads in Chromium through CDP `Extensions.loadUnpacked`, in new headless
//    mode, which is how tests/e2e/helpers/extension.ts loads it. `--extension-headed` does the same in a real
//    window (run it under xvfb-run); the e2e job's --headed option uses that way.
// Prints one JSON object; exit code 0 when everything passed.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { browserChannel, browserLaunchOptions, isHeadlessServer } from '../scripts/lib/browser.mjs';
import { measureFrameFloor } from '../scripts/lib/frame-floor.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.WC_PORT || 4190);
const EXTENSION_HEADED = process.argv.includes('--extension-headed');
const report = {
  node: process.version,
  platform: `${process.platform}/${process.arch}`,
  cpus: os.cpus().length,
  headlessServer: isHeadlessServer(),
  channel: browserChannel() ?? '(bundled chromium)',
  xvfbRun: spawnSync('sh', ['-c', 'command -v xvfb-run'], { encoding: 'utf8' }).stdout.trim() || null,
};

async function checkBrowser() {
  const browser = await chromium.launch(browserLaunchOptions());
  try {
    report.browserVersion = browser.version();
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' });
    report.blankPageFrames = await measureFrameFloor(context);
    const page = await context.newPage();
    // A one-page "build", so this works before (and without) any app build
    const dist = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-smoke-dist-'));
    fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><title>smoke</title><p>smoke</p>');
    const server = spawn(process.execPath, [path.join(root, 'scripts', 'serve.mjs'), '--port', String(PORT)], {
      stdio: 'ignore',
      env: { ...process.env, WC_DIST_DIR: dist, WC_EXIT_WITH_PARENT_PID: String(process.pid) },
    });
    try {
      let ok = false;
      for (let i = 0; i < 40 && !ok; i++) {
        await new Promise((r) => setTimeout(r, 250));
        ok = await fetch(`http://127.0.0.1:${PORT}/`).then(
          (r) => r.ok,
          () => false,
        );
      }
      if (!ok) throw new Error(`serve.mjs did not answer on port ${PORT}`);
      await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
      report.page = await page.evaluate(() => ({
        crossOriginIsolated: window.crossOriginIsolated,
        sharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined',
        hardwareConcurrency: navigator.hardwareConcurrency,
      }));
      if (!report.page.crossOriginIsolated) throw new Error('the served page is not cross-origin isolated');
    } finally {
      server.kill();
      fs.rmSync(dist, { recursive: true, force: true });
    }
  } finally {
    await browser.close();
  }
}

/** Loads dist-ext/ into a persistent context the way the e2e helper does; returns the extension id. */
async function loadExtension(headless) {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-smoke-ext-'));
  const channel = process.env.WC_BROWSER_CHANNEL || (process.platform === 'win32' ? 'chrome' : 'chromium');
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel,
    headless,
    args: ['--enable-unsafe-extension-debugging'],
    ignoreDefaultArgs: ['--disable-extensions'],
  });
  try {
    const cdp = await context.browser().newBrowserCDPSession();
    const { id } = await cdp.send('Extensions.loadUnpacked', { path: path.join(root, 'dist-ext') });
    const isOurs = (w) => w.url().startsWith(`chrome-extension://${id}/`);
    const worker =
      context.serviceWorkers().find(isOurs) ??
      (await context.waitForEvent('serviceworker', { predicate: isOurs, timeout: 15_000 }));
    return { id, worker: worker.url() };
  } finally {
    await context.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
}

async function checkExtension() {
  const built = spawnSync(process.execPath, [path.join(root, 'scripts', 'build-extension.mjs')], {
    cwd: root,
    encoding: 'utf8',
    env: process.env,
  });
  if (built.status !== 0) throw new Error(`build:ext failed: ${built.stderr || built.stdout}`);
  const mode = EXTENSION_HEADED ? 'headed' : 'newHeadless';
  report.extension = {};
  try {
    report.extension[mode] = await loadExtension(!EXTENSION_HEADED);
  } catch (err) {
    report.extension[mode] = { error: String(err?.message ?? err).split('\n')[0] };
  }
}

let failed = false;
try {
  await checkBrowser();
} catch (err) {
  report.browserError = String(err?.stack ?? err);
  failed = true;
}
try {
  await checkExtension();
} catch (err) {
  report.extensionError = String(err?.stack ?? err);
  failed = true;
}
if (report.extension && !Object.values(report.extension).some((r) => r.id)) {
  report.extensionNote = EXTENSION_HEADED
    ? 'the extension did not load in a real window either'
    : 'new headless Chromium could not load the extension; try the e2e job with --headed (xvfb-run)';
  failed = true;
}
console.log(JSON.stringify(report, null, 2));
if (process.env.WC_JOB_ID && fs.existsSync('/results')) {
  fs.writeFileSync(`/results/smoke${EXTENSION_HEADED ? '-headed' : ''}.json`, JSON.stringify(report, null, 2));
}
process.exit(failed ? 1 : 0);
