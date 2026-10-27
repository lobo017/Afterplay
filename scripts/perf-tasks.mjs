// Main-thread task audit (spec: "no main-thread task over 50 ms"): a scripted tour of the app's flows with a
// PerformanceObserver on long tasks. Every flow is labelled, and every task of 50 ms or more is reported
// under the flow it happened in. Pass: none.
//
//   npm run perf:tasks            (PERF_PORT=4182, PERF_TASKS_GAMES=300 games in the library)
//
// Page load is reported apart and not counted: the browser's one-time audio start (the first AudioContext of a
// process: 60-340 ms, not avoidable, built by the app in an idle moment after start-up) and its one-time font
// start-up (~35-50 ms on the first layout of a cold process) happen there. What the tour covers: Play (a game with the bot, takeback), Review (opening it,
// a Quick review of the sample game, stepping through it), the Games list (a bulk import, filters, sort, a
// background review queue, Insights), Train (the hub, puzzles, the three other trainers), Settings (backup and
// restore of the whole library).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { chromium } from '@playwright/test';
import { formatGb, formatProcesses, freeMemoryBytes, installCleanup, killAllChildTrees } from './lib/process-guard.mjs';

const PORT = Number(process.env.PERF_PORT || 4182);
const BASE_URL = `http://127.0.0.1:${PORT}`;
const GAMES = Number(process.env.PERF_TASKS_GAMES || 300);
const REVIEWED_GAMES = Number(process.env.PERF_TASKS_REVIEWED || 12);
const MIN_FREE_MEMORY_BYTES = 2.5 * 1024 ** 3;
const MAX_RUN_MS = Number(process.env.PERF_MAX_RUN_MS) || 20 * 60 * 1000;
const LIMIT_MS = 50;

const LOG_DIR = path.join('test-results', 'perf-logs');
fs.mkdirSync(LOG_DIR, { recursive: true });
const LOG_PATH = path.join(LOG_DIR, `${new Date().toISOString().replace(/[:.]/g, '-')}_tasks_pid${process.pid}.log`);
const write = (stream, parts) => {
  const text = `${parts.join(' ')}\n`;
  stream.write(text);
  fs.appendFileSync(LOG_PATH, text);
};
const log = (...parts) => write(process.stdout, parts);
const logError = (...parts) => write(process.stderr, parts);

class PerfAbort extends Error {
  constructor(message, exitCode) {
    super(message);
    this.exitCode = exitCode;
  }
}

function startStaticServer(port) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['scripts/serve.mjs', '--port', String(port)], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, WC_EXIT_WITH_PARENT_PID: String(process.pid) },
      windowsHide: true,
    });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('Timed out waiting for scripts/serve.mjs to start'));
    }, 10_000);
    child.stdout.on('data', (chunk) => {
      if (chunk.toString().includes('http://')) {
        clearTimeout(timer);
        resolve(child);
      }
    });
    child.stderr.on('data', (chunk) => logError(`[server stderr] ${chunk.toString().trimEnd()}`));
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`scripts/serve.mjs exited early with code ${code}`));
    });
  });
}

const SICILIAN = '1. e4 c5 2. Nf3 d6 3. d4 cxd4 4. Nxd4 Nf6 5. Nc3 a6';
const SCHOLAR = '1. e4 e5 2. Qh5 Nc6 3. Bc4 Nf6 4. Qxf7#';
// (every game differs in its players, so none is dropped as a duplicate)
const gamePgn = (i) =>
  `[Event "Tour"]
[White "${i % 2 ? 'Lobo017' : `Player${i}`}"]
[Black "${i % 2 ? `Rival${i}` : 'Lobo017'}"]
[Result "${i % 3 === 0 ? '1/2-1/2' : '1-0'}"]
[Date "2026.0${1 + (i % 9)}.1${i % 9}"]

${i % 2 ? SICILIAN : SCHOLAR} ${i % 3 === 0 ? '1/2-1/2' : '1-0'}`;

async function run() {
  log(`[run] perf:tasks, ${GAMES} games, node ${process.version}, ${os.cpus().length} CPUs, log ${path.resolve(LOG_PATH)}`);
  const free = freeMemoryBytes();
  log(`[memory] start: ${formatGb(free)} free of ${formatGb(os.totalmem())}`);
  if (free < MIN_FREE_MEMORY_BYTES) {
    throw new PerfAbort(`Only ${formatGb(free)} of memory is free; perf:tasks needs at least ${formatGb(MIN_FREE_MEMORY_BYTES)}.`, 3);
  }
  installCleanup({
    log: logError,
    maxRunMs: MAX_RUN_MS,
    cleanup: (reason) => {
      const killed = killAllChildTrees();
      if (killed.length === 0) log(`[cleanup] ${reason}: no child processes left`);
      else logError(`[cleanup] ${reason}: killed ${killed.length} child process tree(s):\n${formatProcesses(killed)}`);
    },
  });

  let server = null;
  let browser = null;
  try {
    server = await startStaticServer(PORT);
    browser = await chromium.launch({ channel: 'chrome', headless: true, handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block', acceptDownloads: true });
    const page = await context.newPage();
    page.on('pageerror', (err) => logError('[page error]', err.message));
    await page.addInitScript(() => {
      window.__tour = { windows: [], tasks: [], open: null };
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) window.__tour.tasks.push({ start: e.startTime, dur: e.duration });
      }).observe({ entryTypes: ['longtask'] });
    });
    await page.goto(`${BASE_URL}/`, { waitUntil: 'domcontentloaded' });
    await page.locator('[data-testid="chess-board"]').waitFor({ state: 'visible' });
    // The one-time audio start happens now, before anything is measured (see the header)
    await page.mouse.move(30, 30);
    await page.waitForFunction(() => window.__wizardChessPlay?.controller.getAudio().isInitialized(), undefined, { timeout: 10_000 });
    await page.waitForTimeout(1500);
    await page.evaluate(() => {
      window.__tour.startupEnd = performance.now();
    });

    /** Runs the steps of one flow; tasks that start inside it are attributed to it. */
    const flow = async (label, steps) => {
      await page.evaluate((l) => {
        window.__tour.open = { label: l, start: performance.now() };
      }, label);
      try {
        await steps();
      } finally {
        await page.evaluate(() => {
          const t = window.__tour;
          t.windows.push({ ...t.open, end: performance.now() });
          t.open = null;
        });
      }
      log(`[flow] ${label}`);
    };
    const settle = (ms = 400) => page.waitForTimeout(ms);

    // ---- Play
    await flow('play: a game against the bot (6 moves), takeback, resign', async () => {
      await page.evaluate(async () => {
        const c = window.__wizardChessPlay.controller;
        c.setBotMoveDelayMs(5);
        c.startNewGame({ playerColor: 'w' });
        const boardEl = document.querySelector('[data-testid="play-layout"] [data-testid="chess-board"]');
        const center = (sq) => {
          const r = boardEl.getBoundingClientRect();
          return { x: r.left + ('abcdefgh'.indexOf(sq[0]) + 0.5) * (r.width / 8), y: r.top + (8 - Number(sq[1]) + 0.5) * (r.height / 8) };
        };
        const fire = (t, target, pt) =>
          target.dispatchEvent(new PointerEvent(t, { bubbles: true, pointerId: 1, button: 0, buttons: t === 'pointerup' ? 0 : 1, clientX: pt.x, clientY: pt.y }));
        const click = (sq) => {
          const pt = center(sq);
          fire('pointerdown', boardEl, pt);
          fire('pointerup', window, pt);
        };
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        for (let i = 0; i < 6; i++) {
          // (random play can end the game early: nothing more to do then)
          if (c.isGameOver() || c.getAdapter().isGameOver()) break;
          const opts = c.getAdapter().verboseMoves().filter((m) => !m.promotion);
          const pick = opts[Math.floor(Math.random() * opts.length)];
          const before = c.getGameTree().getMainLine().length;
          click(pick.from);
          click(pick.to);
          const deadline = performance.now() + 15_000;
          while (performance.now() < deadline && !(c.getGameTree().getMainLine().length >= before + 2 && c.getAdapter().turn() === 'w')) await sleep(15);
          if (i === 3) c.takeback();
        }
        c.resign();
      });
      await settle();
    });

    // ---- Review
    await flow('review: open the Review screen', async () => {
      await page.getByTestId('mode-tab-review').click();
      await page.getByTestId('analysis-layout').waitFor({ state: 'visible' });
      await settle();
    });
    await flow('review: the sample game, a Quick review to the end', async () => {
      await page.evaluate(() => {
        const rv = window.__wizardChessReview;
        window.__wizardChessAnalysis.controller.importPgn(rv.SAMPLE_GAME_PGN);
        rv.panel.setPreset('quick');
      });
      await page.getByTestId('btn-review-start').click();
      await page.getByTestId('review-progress-text').filter({ hasText: /^Reviewed/ }).waitFor({ timeout: 120_000 });
      await settle();
    });
    await flow('review: step through with the arrow keys and jump Home / End', async () => {
      await page.evaluate(async () => {
        const press = (key) => window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
        press('Home');
        for (let i = 0; i < 30; i++) {
          press('ArrowRight');
          await new Promise((r) => requestAnimationFrame(r));
        }
        press('End');
        press('Home');
      });
      await settle();
    });
    await flow('analysis: live infinite analysis for 3 s, then a depth-12 search', async () => {
      await page.evaluate(() => window.__wizardChessAnalysis.controller.setAnalysisDepth('infinite'));
      await page.waitForTimeout(3000);
      await page.evaluate(() => window.__wizardChessAnalysis.controller.setAnalysisDepth(12));
      await settle();
    });

    // ---- Games
    await flow('games: open the list', async () => {
      await page.getByTestId('mode-tab-games').click();
      await page.getByTestId('games-list').waitFor({ state: 'visible' });
      await settle();
    });
    await flow(`games: bulk import of ${GAMES} games`, async () => {
      const text = Array.from({ length: GAMES }, (_, i) => gamePgn(i)).join('\n\n');
      await page.getByTestId('btn-games-import').click();
      await page.getByTestId('btn-games-paste').click();
      await page.getByTestId('games-paste-text').evaluate((el, value) => {
        el.value = value;
      }, text);
      await page.getByTestId('btn-games-paste-import').click();
      await page.getByTestId('games-message').filter({ hasText: `Imported ${GAMES} games` }).waitFor({ timeout: 120_000 });
      await settle();
    });
    await flow('games: filters, sort, select all', async () => {
      await page.getByTestId('games-filter-result').selectOption({ index: 1 });
      await settle(200);
      await page.getByTestId('btn-games-clear-filters').click();
      await page.getByTestId('games-filter-opening').fill('Sicilian');
      await settle(300);
      await page.getByTestId('btn-games-clear-filters').click();
      await page.getByTestId('games-sort').selectOption({ index: 1 });
      await settle(200);
      await page.getByTestId('games-select-all').check();
      await settle(200);
      await page.getByTestId('btn-games-clear-selection').click();
    });
    await flow(`games: background review queue (${REVIEWED_GAMES} games on Quick)`, async () => {
      const ids = await page.evaluate(async (n) => {
        const api = await window.__wizardChessLibraryReady;
        const mine = (await api.library.list()).filter((g) => g.white === 'Lobo017' || g.black === 'Lobo017').slice(0, n);
        api.queue.enqueue(mine.map((g) => g.id), 'quick');
        return mine.map((g) => g.id);
      }, REVIEWED_GAMES);
      // (the list shows 100 rows at most, so the records themselves say when a game is reviewed)
      await page.waitForFunction(
        async (list) => {
          const api = await window.__wizardChessLibraryReady;
          const records = await Promise.all(list.map((id) => api.library.get(id)));
          return records.every((r) => r?.analysis);
        },
        ids,
        { timeout: 300_000, polling: 1000 },
      );
      await settle();
    });
    await flow('games: Insights with reviewed games', async () => {
      await page.getByTestId('games-tab-insights').click();
      await page.getByTestId('insights-summary').waitFor({ state: 'visible' });
      await settle();
      await page.getByTestId('games-tab-library').click();
    });

    // ---- Train
    await flow('train: the hub, a puzzle session', async () => {
      await page.getByTestId('mode-tab-train').click();
      await page.getByTestId('btn-train-start').click();
      await page.locator('[data-testid="chess-board"]:visible').first().waitFor({ state: 'visible', timeout: 30_000 });
      await settle(1500);
      await page.getByTestId('mode-tab-train').click();
    });
    for (const kind of ['repertoire', 'endgames', 'visualization']) {
      await flow(`train: the ${kind} trainer opens`, async () => {
        await page.getByTestId(`trainer-tile-${kind}`).click();
        await settle(1200);
        await page.getByTestId('mode-tab-train').click();
        await settle(200);
      });
    }

    // ---- Settings: the whole library in a backup, and back
    const backupFile = path.join('test-results', `perf-tasks-backup-${process.pid}.json`);
    await flow(`settings: backup of ${GAMES} games and settings`, async () => {
      await page.getByTestId('btn-settings').click();
      const download = page.waitForEvent('download');
      await page.getByTestId('btn-backup-download').click();
      await (await download).saveAs(backupFile);
      await page.getByTestId('backup-status').filter({ hasText: 'Backup saved' }).waitFor({ timeout: 60_000 });
    });
    await flow('settings: restore that backup', async () => {
      await page.getByTestId('backup-file-input').setInputFiles(backupFile);
      await page.getByTestId('btn-backup-confirm').click();
      await page.getByTestId('backup-status').filter({ hasText: /restored/i }).waitFor({ timeout: 120_000 });
      await settle(800);
    });
    fs.rmSync(backupFile, { force: true });

    // ---- report
    const tour = await page.evaluate(() => window.__tour);
    // Page load is reported apart: the browser's one-time audio and font start-up land there (see the header)
    const startup = tour.tasks.filter((t) => t.dur >= LIMIT_MS && t.start < tour.startupEnd);
    const over = tour.tasks.filter((t) => t.dur >= LIMIT_MS && t.start >= tour.startupEnd);
    const where = (t) => tour.windows.find((w) => t.start >= w.start - 1 && t.start <= w.end + 1)?.label ?? '(between flows)';
    log('\n=== Main-thread task audit (perf:tasks) ===');
    log(`${startup.length === 0 ? 'ok  ' : 'note'} page load, until the audio context exists${startup.length ? `  → ${startup.map((t) => `${Math.round(t.dur)} ms at ${Math.round(t.start)} ms`).join(', ')} (browser start-up, see the header)` : ''}`);
    for (const w of tour.windows) {
      const mine = tour.tasks.filter((t) => t.dur >= LIMIT_MS && t.start >= w.start - 1 && t.start <= w.end + 1);
      log(`${mine.length === 0 ? 'ok  ' : 'LONG'} ${w.label}${mine.length ? `  → ${mine.map((t) => `${Math.round(t.dur)} ms`).join(', ')}` : ''}`);
    }
    for (const t of over.filter((t) => where(t) === '(between flows)')) log(`LONG (between flows) ${Math.round(t.dur)} ms at ${Math.round(t.start)}`);
    log(`tasks of ${LIMIT_MS} ms or more after page load: ${over.length}`);
    log(over.length === 0 ? 'budgetPassed: true' : 'budgetPassed: false');
    if (over.length > 0) process.exitCode = 1;
  } finally {
    await Promise.race([browser?.close().catch(() => undefined), new Promise((r) => setTimeout(r, 10_000))]);
    server?.kill();
  }
}

run()
  .catch((err) => {
    if (err instanceof PerfAbort) {
      logError(`[abort] ${err.message}`);
      process.exitCode = err.exitCode;
    } else {
      logError('perf:tasks failed:', err?.stack ?? err);
      process.exitCode = 1;
    }
  })
  .finally(() => {
    log(`[run] finished with exit code ${process.exitCode ?? 0}`);
    process.exit(process.exitCode ?? 0);
  });
