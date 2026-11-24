// Main-thread task audit (spec: "no main-thread task over 50 ms"): a scripted tour of the app's flows with a
// PerformanceObserver on long tasks. Every flow is labelled, and every task of 50 ms or more is reported
// under the flow it happened in. Pass: none.
//
//   npm run perf:tasks            (PERF_PORT=4182, PERF_TASKS_GAMES=300 games in the library)
//
// The last flow restores an invented 16 MB backup (4,640 games with summaries, puzzle progress, some records newer on
// this device) through the real Settings dialog, in three windows: (1) choosing the file, until the dialog is shown, and
// (2) pressing Restore until the restore's report is in: both HARD (no task of 50 ms or more); and (3) the page's refresh
// of its screens after the restore (afterRestore: the library is read back, the games list and Train are rebuilt), a NOTE:
// measured and printed with the same fields, never failing the run (the library's load is its own item, see PROGRESS).
// It prints the elapsed time, the longest task, the tasks of 50 ms or more and the time they blocked per window, and,
// where the page can see them, the cost of the steps (reading the file, parsing it, the one write transaction).
//   PERF_TASKS_ONLY=restore       runs only that flow (a fresh browser profile, an empty library)
//   PERF_CPU_THROTTLE=4           slows the page's CPU 4x (Chrome DevTools Protocol) for that flow, as a phone would be
//   PERF_TASKS_DIAG=1             prints the diagnostics line and writes the diagnostics JSON even when no task is long
// Diagnostics (measurement only): when a task of 50 ms or more happens, a JSON file beside the log lists it with its window,
// its offset from the window's start event, its duration, the scripts of its long animation frame (URL, function, invoker,
// character position) where the browser provides them, and the time from the chosen file to the worker's reply; one line
// "[diag] ..." is printed only when a window fails.
//
// Page load is reported apart and not counted: the browser's one-time audio start (the first AudioContext of a
// process: 60-340 ms, not avoidable, built by the app in an idle moment after start-up) and its one-time font
// start-up (~35-50 ms on the first layout of a cold process) happen there. What the tour covers: Play (a game with the bot, takeback), Review (opening it,
// a Quick review of the sample game, stepping through it), the Games list (a bulk import, filters, sort, a
// background review queue, Insights), Train (the hub, puzzles, the three other trainers), Settings (backup and
// restore of the whole library, and a Chess.com sync whose API is answered by this script: nothing here reaches the
// real network).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { chromium } from '@playwright/test';
import { formatGb, formatProcesses, freeMemoryBytes, installCleanup, killAllChildTrees } from './lib/process-guard.mjs';
import { browserLaunchOptions, skipStoryLanding } from './lib/browser.mjs';
import { asBackupText, buildInventedBackups } from './lib/invented-backup.mjs';
import { diagnoseTasks, restoreTimes } from './lib/task-diagnostics.mjs';

const PORT = Number(process.env.PERF_PORT || 4182);
const BASE_URL = `http://127.0.0.1:${PORT}`;
const GAMES = Number(process.env.PERF_TASKS_GAMES || 300);
const REVIEWED_GAMES = Number(process.env.PERF_TASKS_REVIEWED || 12);
const MIN_FREE_MEMORY_BYTES = 2.5 * 1024 ** 3;
const MAX_RUN_MS = Number(process.env.PERF_MAX_RUN_MS) || 20 * 60 * 1000;
const LIMIT_MS = 50;
const ONLY = process.env.PERF_TASKS_ONLY || '';
const CPU_THROTTLE = Number(process.env.PERF_CPU_THROTTLE || 1);

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

// The Chess.com sync's flow: an invented player with two finished months of games, served by route interception.
const SYNC_PLAYER = 'Perf_Player1';
const SYNC_GAMES_PER_MONTH = 60;
const SYNC_MONTHS = ['2024-05', '2024-06'];
const syncBase = `https://api.chess.com/pub/player/${SYNC_PLAYER.toLowerCase()}/games`;
const syncMonthUrl = (month) => `${syncBase}/${month.slice(0, 4)}/${month.slice(5, 7)}`;
const syncGame = (month, i) => {
  const id = Number(month.replace('-', '')) * 1000 + i;
  const url = `https://www.chess.com/game/live/${id}`;
  const date = `${month.replace('-', '.')}.${String(1 + (i % 28)).padStart(2, '0')}`;
  const mine = i % 2 === 0;
  const pgn = `[Event "Live Chess"]
[Site "Chess.com"]
[Date "${date}"]
[White "${mine ? SYNC_PLAYER : `Rival${i}`}"]
[Black "${mine ? `Rival${i}` : SYNC_PLAYER}"]
[Result "1-0"]
[UTCDate "${date}"]
[UTCTime "18:02:11"]
[TimeControl "600"]
[Link "${url}"]

${i % 2 ? SICILIAN : SCHOLAR} 1-0`;
  return { url, pgn };
};

async function run() {
  log(
    `[run] perf:tasks, ${GAMES} games, node ${process.version}, ${os.cpus().length} CPUs, log ${path.resolve(LOG_PATH)}`,
  );
  const free = freeMemoryBytes();
  log(`[memory] start: ${formatGb(free)} free of ${formatGb(os.totalmem())}`);
  if (free < MIN_FREE_MEMORY_BYTES) {
    throw new PerfAbort(
      `Only ${formatGb(free)} of memory is free; perf:tasks needs at least ${formatGb(MIN_FREE_MEMORY_BYTES)}.`,
      3,
    );
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
    browser = await chromium.launch({
      ...browserLaunchOptions(),
      handleSIGINT: false,
      handleSIGTERM: false,
      handleSIGHUP: false,
    });
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      serviceWorkers: 'block',
      acceptDownloads: true,
    });
    await skipStoryLanding(context);
    const page = await context.newPage();
    page.on('pageerror', (err) => logError('[page error]', err.message));
    await page.addInitScript(() => {
      window.__tour = { windows: [], tasks: [], open: null, marks: [] };
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) window.__tour.tasks.push({ start: e.startTime, dur: e.duration });
      }).observe({ entryTypes: ['longtask'] });
      // Diagnostics only (nothing is counted from it): the scripts of every long animation frame (50 ms or more), where the
      // browser provides them; an entry exists only when a frame is long, so a run with none costs nothing
      window.__tour.frames = [];
      try {
        new PerformanceObserver((list) => {
          for (const e of list.getEntries()) {
            window.__tour.frames.push({
              start: e.startTime,
              dur: e.duration,
              scripts: (e.scripts ?? []).map((s) => ({
                url: s.sourceURL,
                fn: s.sourceFunctionName,
                invoker: s.invoker,
                type: s.invokerType,
                pos: s.sourceCharPosition,
                dur: s.duration,
                start: s.startTime,
              })),
            });
          }
        }).observe({ type: 'long-animation-frame', buffered: true });
      } catch {
        // a browser without the entry type: the tasks are reported without their scripts
      }
    });
    await page.goto(`${BASE_URL}/`, { waitUntil: 'domcontentloaded' });
    await page.locator('[data-testid="chess-board"]').waitFor({ state: 'visible' });
    // The one-time audio start happens now, before anything is measured (see the header)
    await page.mouse.move(30, 30);
    await page.waitForFunction(() => window.__wizardChessPlay?.controller.getAudio().isInitialized(), undefined, {
      timeout: 10_000,
    });
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

    // The restore of an invented 16 MB backup (scripts/lib/invented-backup.mjs): a second page of this browser first
    // restores what "this device" already holds (the same library, records only it has, newer progress), then the
    // measured page chooses the file and presses Restore. Two windows, so a long task says which step it was in.
    const restoreLines = [];
    const bigRestore = async () => {
      const { file, local, expect } = buildInventedBackups();
      const fileText = asBackupText(file);
      const fileName = path.join('test-results', `perf-tasks-big-${process.pid}-file.json`);
      const localName = path.join('test-results', `perf-tasks-big-${process.pid}-local.json`);
      fs.writeFileSync(fileName, fileText);
      fs.writeFileSync(localName, asBackupText(local));
      const fileMb = (Buffer.byteLength(fileText) / 1024 ** 2).toFixed(1);
      try {
        // The seeding is set-up, not a flow: another tab of the same browser restores "this device's" library. Page 1's tasks
        // in that time are printed as a note and not counted
        const setupStart = await page.evaluate(() => performance.now());
        const seed = await context.newPage();
        seed.on('pageerror', (err) => logError('[page error, seeding page]', err.message));
        await seed.goto(`${BASE_URL}/`, { waitUntil: 'domcontentloaded' });
        await seed.getByTestId('btn-settings').click();
        await seed.getByTestId('backup-file-input').setInputFiles(localName);
        await seed.getByTestId('btn-backup-confirm').click();
        await seed
          .getByTestId('backup-status')
          .filter({ hasText: /^Restored/ })
          .waitFor({ timeout: 600_000 });
        await seed.close();
        await page.evaluate(
          ([start, label]) => window.__tour.windows.push({ label, start, end: performance.now(), kind: 'setup' }),
          [setupStart, 'setup: a second tab restores the library of this device (not a flow; not counted)'],
        );
        log(
          `[restore] this device holds ${local.games.length} games, ${local.puzzles.length} puzzles, ${local.reviews.length} reviews`,
        );

        if (CPU_THROTTLE > 1) {
          const cdp = await context.newCDPSession(page);
          await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU_THROTTLE });
        }
        if (!(await page.getByTestId('btn-backup-restore').isVisible())) await page.getByTestId('btn-settings').click();
        await page.getByTestId('btn-backup-restore').waitFor({ state: 'visible' });
        await page.evaluate(() => {
          const input = document.querySelector('[data-testid="backup-file-input"]');
          const confirmButton = document.querySelector('[data-testid="btn-backup-confirm"]');
          const status = document.querySelector('[data-testid="backup-status"]');
          const stamps = (window.__restore = { pickStart: 0, pickDone: 0, confirmStart: 0, done: 0, text: '' });
          input.addEventListener('change', () => (stamps.pickStart = performance.now()), true);
          // The dialog is shown when the button's box appears (its container loses `hidden`)
          new window.MutationObserver(() => {
            if (!stamps.pickDone && stamps.pickStart && confirmButton.offsetParent !== null) {
              stamps.pickDone = performance.now();
            }
          }).observe(document.body, { attributes: true, subtree: true, attributeFilter: ['hidden'] });
          confirmButton.addEventListener('click', () => (stamps.confirmStart = performance.now()), true);
          new window.MutationObserver(() => {
            const text = status.textContent ?? '';
            if (stamps.confirmStart && !stamps.done && /^(Restored|Nothing to restore|The restore failed)/.test(text)) {
              stamps.done = performance.now();
              stamps.text = text;
            }
          }).observe(status, { childList: true, characterData: true, subtree: true });
        });

        // Installed now, so no other flow is touched. Also: when the restore's report reaches the page (the boundary between the restore and the page's refresh)
        await page.evaluate(() => {
          // Marks for the restore flow's steps, as far as the page itself can see them: a parse of more than 1 MB of text,
          // reading a file, and a readwrite transaction over five stores or more (a restore). Work in a worker is not seen.
          const mark = (name, start, end, extra) => window.__tour.marks.push({ name, start, end, ...extra });
          const jsonParse = JSON.parse;
          JSON.parse = function (text, reviver) {
            if (typeof text !== 'string' || text.length < 1_000_000) return jsonParse.call(this, text, reviver);
            const start = performance.now();
            try {
              return jsonParse.call(this, text, reviver);
            } finally {
              mark('JSON.parse', start, performance.now(), { chars: text.length });
            }
          };
          const blobText = window.Blob.prototype.text;
          window.Blob.prototype.text = function () {
            const start = performance.now();
            const promise = blobText.call(this);
            void promise.then((text) => {
              if (text.length >= 1_000_000)
                mark('file.text() (async read)', start, performance.now(), { chars: text.length });
            });
            return promise;
          };
          const transaction = window.IDBDatabase.prototype.transaction;
          window.IDBDatabase.prototype.transaction = function (stores, mode, options) {
            const tx = transaction.call(this, stores, mode, options);
            if (mode === 'readwrite' && Array.isArray(stores) && stores.length >= 5) {
              const start = performance.now();
              const end = (outcome) => mark(`one readwrite transaction (${outcome})`, start, performance.now());
              tx.addEventListener('complete', () => end('committed'));
              tx.addEventListener('abort', () => end('aborted'));
            }
            return tx;
          };
          const NativeWorker = window.Worker;
          window.Worker = class extends NativeWorker {
            constructor(...args) {
              super(...args);
              this.addEventListener('message', (e) => {
                if (e.data?.kind === 'restored' && !window.__restore.reportAt)
                  window.__restore.reportAt = performance.now();
                // diagnostics: when the worker's answer to the chosen file reaches the page
                if (e.data?.kind === 'inspected' && !window.__restore.inspectedAt)
                  window.__restore.inspectedAt = performance.now();
              });
            }
          };
        });
        await flow(`settings: choose a ${fileMb} MB backup file (until the dialog is shown)`, async () => {
          await page.getByTestId('backup-file-input').setInputFiles(fileName);
          await page.getByTestId('btn-backup-confirm').waitFor({ state: 'visible', timeout: 300_000 });
          await settle();
        });
        await flow(`settings: restore a ${fileMb} MB backup (Restore pressed until the result is shown)`, async () => {
          await page.getByTestId('btn-backup-confirm').click();
          await page.waitForFunction(() => window.__restore.done > 0, undefined, { timeout: 600_000, polling: 250 });
          await settle(800);
        });

        // Split the confirm window at the boundary: with the worker, when its report reaches the page; without one (the
        // layer-2 build, for a before/after), the end of the last parse of the file's text after the commit
        const FLOW_PICK = `settings: choose a ${fileMb} MB backup file, until the dialog is shown [HARD: no task of ${LIMIT_MS} ms or more]`;
        const FLOW_RESTORE = `settings: restore a ${fileMb} MB backup, Restore pressed until the restore's report is in [HARD: no task of ${LIMIT_MS} ms or more]`;
        const FLOW_REFRESH = `settings: after the restore the page refreshes its screens (afterRestore) [NOTE: measured, never fails]`;
        const boundary = await page.evaluate(
          ([pickLabel, restoreLabel, refreshLabel]) => {
            const t = window.__tour;
            const r = window.__restore;
            const w = t.windows.find((x) => x.label.startsWith('settings: restore a'));
            const pick = t.windows.find((x) => x.label.startsWith('settings: choose a'));
            let at = r.reportAt;
            if (!at) {
              const commit = t.marks.find((m) => m.name.startsWith('one readwrite transaction'));
              const parses = t.marks.filter((m) => m.name === 'JSON.parse' && commit && m.start >= commit.end);
              at = parses.length ? Math.max(...parses.map((m) => m.end)) : commit?.end;
            }
            if (!at) return null;
            pick.label = pickLabel;
            pick.kind = 'hard';
            // (diagnostics: the event each window's offsets are measured from)
            pick.eventAt = r.pickStart;
            t.windows.splice(
              t.windows.indexOf(w),
              1,
              { label: restoreLabel, start: w.start, end: at, kind: 'hard', eventAt: r.confirmStart },
              { label: refreshLabel, start: at, end: w.end, kind: 'note', eventAt: at },
            );
            return at;
          },
          [FLOW_PICK, FLOW_RESTORE, FLOW_REFRESH],
        );
        if (boundary === null) throw new Error('the restore flow could not tell when the restore ended');
        const stamps = await page.evaluate(() => window.__restore);
        if (/could not refresh|failed/.test(stamps.text) || !/^Restored 40 games/.test(stamps.text)) {
          throw new Error(`the big restore did not say what was expected: "${stamps.text}"`);
        }
        if (!stamps.text.includes('Kept what was newer here')) {
          throw new Error(`the big restore did not report what it kept: "${stamps.text}"`);
        }
        const kept = await page.evaluate(
          (id) =>
            new Promise((resolve, reject) => {
              const open = window.indexedDB.open('wizards-chess-db');
              open.onerror = () => reject(open.error);
              open.onsuccess = () => {
                const get = open.result.transaction('puzzles', 'readonly').objectStore('puzzles').get(id);
                get.onsuccess = () => {
                  open.result.close();
                  resolve(get.result?.attempts ?? null);
                };
                get.onerror = () => reject(get.error);
              };
            }),
          expect.keptPuzzleId,
        );
        if (kept !== expect.keptPuzzleAttempts) {
          throw new Error(
            `a puzzle that was newer on this device was replaced (attempts ${kept}, expected ${expect.keptPuzzleAttempts})`,
          );
        }
        log(`[restore] result line: ${stamps.text}`);
        log('[restore] a puzzle with newer progress on this device kept it');

        const tour = await page.evaluate(() => window.__tour);
        const marks = tour.marks.slice().sort((x, y) => x.start - y.start);
        const rate = `${CPU_THROTTLE}x`;
        const describe = (label, from, to, windowLabel, verdict) => {
          const w = tour.windows.find((x) => x.label.startsWith(windowLabel));
          const tasks = tour.tasks.filter((t) => t.start >= w.start - 1 && t.start <= w.end + 1);
          const longest = tasks.reduce((m, t) => Math.max(m, t.dur), 0);
          const blocked = tasks.reduce((sum, t) => sum + t.dur, 0);
          restoreLines.push(
            `[restore] ${label} (${verdict}): elapsed ${Math.round(to - from)} ms, longest task ${tasks.length ? `${Math.round(longest)} ms` : `none of ${LIMIT_MS} ms or more`}, tasks of ${LIMIT_MS} ms or more ${tasks.length}, blocked ${Math.round(blocked)} ms (cpu ${rate})`,
          );
          restoreLines.push(
            `RESTORE_TABLE cpu=${rate} step=${label} verdict=${verdict} elapsedMs=${Math.round(to - from)} longestMs=${Math.round(longest)} over50=${tasks.length} blockedMs=${Math.round(blocked)}`,
          );
          for (const t of tasks) {
            const inside = marks.filter(
              (m) => m.start - 5 <= t.start + t.dur && m.end + 5 >= t.start && !m.name.startsWith('file.text'),
            );
            restoreLines.push(
              `[restore]   task ${Math.round(t.dur)} ms at +${Math.round(t.start - from)} ms${inside.length ? ` during: ${inside.map((m) => m.name).join(', ')}` : ' (no marked step)'}`,
            );
          }
        };
        describe('pick', stamps.pickStart, stamps.pickDone, 'settings: choose a', 'HARD');
        describe('restore', stamps.confirmStart, boundary, 'settings: restore a', 'HARD');
        describe('refresh', boundary, stamps.done, 'settings: after the restore', 'NOTE');
        for (const m of marks) {
          restoreLines.push(
            `[restore] step ${m.name}: ${Math.round(m.end - m.start)} ms${m.chars ? ` (${(m.chars / 1e6).toFixed(1)} M chars)` : ''}, from ${Math.round(m.start - stamps.pickStart)} ms after choosing the file`,
          );
        }
        const commit = marks.find((m) => m.name.startsWith('one readwrite transaction'));
        restoreLines.push(
          commit
            ? `[restore] step after the commit until the result is shown (settings parse, apply, screens refreshed): ${Math.round(stamps.done - commit.end)} ms`
            : '[restore] steps inside a worker are not visible to the page: only the page-side tasks above are counted',
        );
      } finally {
        fs.rmSync(fileName, { force: true });
        fs.rmSync(localName, { force: true });
      }
    };

    /** The audit: every window's tasks of 50 ms or more, the restore flow's detail, the verdict. */
    const report = async () => {
      const tour = await page.evaluate(() => window.__tour);
      // Page load is reported apart: the browser's one-time audio and font start-up land there (see the header)
      const startup = tour.tasks.filter((t) => t.dur >= LIMIT_MS && t.start < tour.startupEnd);
      // A NOTE window is measured and printed, never counted; the HARD restore windows are counted at 1x only (a slowed
      // CPU, PERF_CPU_THROTTLE, is a diagnostic run, not the budget)
      const inWindow = (t, w) => t.start >= w.start - 1 && t.start <= w.end + 1;
      const informational = (t) =>
        tour.windows.some(
          (w) => (w.kind === 'note' || w.kind === 'setup' || (w.kind === 'hard' && CPU_THROTTLE > 1)) && inWindow(t, w),
        );
      const over = tour.tasks.filter((t) => t.dur >= LIMIT_MS && t.start >= tour.startupEnd && !informational(t));
      const where = (t) =>
        tour.windows.find((w) => t.start >= w.start - 1 && t.start <= w.end + 1)?.label ?? '(between flows)';
      log('\n=== Main-thread task audit (perf:tasks) ===');
      log(
        `${startup.length === 0 ? 'ok  ' : 'note'} page load, until the audio context exists${startup.length ? `  → ${startup.map((t) => `${Math.round(t.dur)} ms at ${Math.round(t.start)} ms`).join(', ')} (browser start-up, see the header)` : ''}`,
      );
      for (const w of tour.windows) {
        const mine = tour.tasks.filter((t) => t.dur >= LIMIT_MS && t.start >= w.start - 1 && t.start <= w.end + 1);
        const informationalWindow = w.kind === 'note' || w.kind === 'setup' || (w.kind === 'hard' && CPU_THROTTLE > 1);
        const mark = mine.length === 0 ? 'ok  ' : informationalWindow ? 'note' : 'LONG';
        log(
          `${mark} ${w.label}${w.kind === 'hard' && CPU_THROTTLE > 1 ? ` (cpu ${CPU_THROTTLE}x: informational)` : ''}${mine.length ? `  → ${mine.map((t) => `${Math.round(t.dur)} ms`).join(', ')}` : ''}`,
        );
      }
      for (const t of over.filter((t) => where(t) === '(between flows)'))
        log(`LONG (between flows) ${Math.round(t.dur)} ms at ${Math.round(t.start)}`);
      // Diagnostics, measurement only (nothing here changes a limit or a verdict): every task of 50 ms or more with the window
      // it fell in, its offset from the window's start event, and the scripts of its frame where the browser says. A JSON
      // file beside the log carries all of them; the one line printed below carries the tasks of the windows that FAILED.
      // Nothing is computed or written when no task is long (PERF_TASKS_DIAG=1 asks for it anyway, for the restore timings)
      const longTasks = diagnoseTasks({
        tasks: tour.tasks.filter((t) => t.start >= tour.startupEnd),
        windows: tour.windows,
        frames: tour.frames ?? [],
        limitMs: LIMIT_MS,
      });
      if (longTasks.length > 0 || process.env.PERF_TASKS_DIAG === '1') {
        const restoreStamps = await page.evaluate(() => window.__restore ?? null);
        const diag = { cpu: CPU_THROTTLE, longTasks, restoreTimes: restoreTimes(restoreStamps) };
        fs.writeFileSync(LOG_PATH.replace(/\.log$/, '.json'), JSON.stringify(diag, null, 2));
        const failed = longTasks.filter((lt) => over.some((o) => Math.round(o.start) === lt.startMs));
        if (failed.length > 0 || process.env.PERF_TASKS_DIAG === '1') {
          log(`[diag] ${JSON.stringify({ cpu: CPU_THROTTLE, failedTasks: failed, restoreTimes: diag.restoreTimes })}`);
        }
      }
      log(`tasks of ${LIMIT_MS} ms or more after page load: ${over.length}`);
      log(over.length === 0 ? 'budgetPassed: true' : 'budgetPassed: false');
      if (over.length > 0) process.exitCode = 1;
      for (const line of restoreLines) log(line);
    };

    if (ONLY === 'restore') {
      await bigRestore();
      await report();
      return;
    }

    // ---- Play
    await flow('play: a game against the bot (6 moves), takeback, resign', async () => {
      await page.evaluate(async () => {
        const c = window.__wizardChessPlay.controller;
        c.setBotMoveDelayMs(5);
        c.startNewGame({ playerColor: 'w' });
        const boardEl = document.querySelector('[data-testid="play-layout"] [data-testid="chess-board"]');
        const center = (sq) => {
          const r = boardEl.getBoundingClientRect();
          return {
            x: r.left + ('abcdefgh'.indexOf(sq[0]) + 0.5) * (r.width / 8),
            y: r.top + (8 - Number(sq[1]) + 0.5) * (r.height / 8),
          };
        };
        const fire = (t, target, pt) =>
          target.dispatchEvent(
            new window.PointerEvent(t, {
              bubbles: true,
              pointerId: 1,
              button: 0,
              buttons: t === 'pointerup' ? 0 : 1,
              clientX: pt.x,
              clientY: pt.y,
            }),
          );
        const click = (sq) => {
          const pt = center(sq);
          fire('pointerdown', boardEl, pt);
          fire('pointerup', window, pt);
        };
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        for (let i = 0; i < 6; i++) {
          // (random play can end the game early: nothing more to do then)
          if (c.isGameOver() || c.getAdapter().isGameOver()) break;
          const opts = c
            .getAdapter()
            .verboseMoves()
            .filter((m) => !m.promotion);
          const pick = opts[Math.floor(Math.random() * opts.length)];
          const before = c.getGameTree().getMainLine().length;
          click(pick.from);
          click(pick.to);
          const deadline = performance.now() + 15_000;
          while (
            performance.now() < deadline &&
            !(c.getGameTree().getMainLine().length >= before + 2 && c.getAdapter().turn() === 'w')
          )
            await sleep(15);
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
      await page
        .getByTestId('review-progress-text')
        .filter({ hasText: /^Reviewed/ })
        .waitFor({ timeout: 120_000 });
      await settle();
    });
    await flow('review: step through with the arrow keys and jump Home / End', async () => {
      await page.evaluate(async () => {
        const press = (key) => window.dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true }));
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
    // The tour's games are "mine" by this Lichess name (gamePgn above): the app has no built-in account, so the
    // name is saved first, as Settings › Your games saves it. Insights and "my color" then have something to show.
    // (Outside the flows; a long task here would still be reported, as "between flows".)
    await page.evaluate(async () => {
      const api = await window.__wizardChessLibraryReady;
      await api.library.setMyAccounts({ lichess: 'Lobo017', chesscom: '' });
    });
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
      await page
        .getByTestId('games-message')
        .filter({ hasText: `Imported ${GAMES} games` })
        .waitFor({ timeout: 120_000 });
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
        const mine = (await api.library.list())
          .filter((g) => g.white === 'Lobo017' || g.black === 'Lobo017')
          .slice(0, n);
        api.queue.enqueue(
          mine.map((g) => g.id),
          'quick',
        );
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
      await page
        .getByTestId('backup-status')
        .filter({ hasText: /restored/i })
        .waitFor({ timeout: 120_000 });
      await settle(800);
    });
    fs.rmSync(backupFile, { force: true });

    // ---- Settings: a Chess.com sync (two months of new games, then a second sync that finds nothing new)
    const syncRequests = [];
    await context.route('https://api.chess.com/**', async (route) => {
      const url = route.request().url();
      syncRequests.push(url);
      const headers = { 'access-control-allow-origin': '*' };
      if (url === `${syncBase}/archives`) {
        return route.fulfill({ status: 200, headers, json: { archives: SYNC_MONTHS.map(syncMonthUrl) } });
      }
      const month = SYNC_MONTHS.find((m) => syncMonthUrl(m) === url);
      if (!month) return route.fulfill({ status: 404, headers, json: { message: 'not found' } });
      const games = Array.from({ length: SYNC_GAMES_PER_MONTH }, (_, i) => syncGame(month, i));
      return route.fulfill({ status: 200, headers, json: { games } });
    });
    const syncTotal = SYNC_MONTHS.length * SYNC_GAMES_PER_MONTH;
    await flow(
      `settings: Chess.com sync of ${syncTotal} games (API mocked), then a sync with nothing new`,
      async () => {
        const name = page.getByTestId('input-chesscom-username');
        await name.fill(SYNC_PLAYER);
        await name.blur();
        const button = page.getByTestId('btn-chesscom-sync');
        const status = page.getByTestId('sync-status');
        await button.click();
        await status.filter({ hasText: `Added ${syncTotal} games.` }).waitFor({ timeout: 120_000 });
        await settle();
        await button.click();
        await status.filter({ hasText: 'No new games.' }).waitFor({ timeout: 60_000 });
        await settle(800);
      },
    );
    if (syncRequests.length !== SYNC_MONTHS.length + 2) {
      throw new Error(`the sync flow made ${syncRequests.length} API requests, expected ${SYNC_MONTHS.length + 2}`);
    }

    // ---- A restore of 16 MB, the last flow (it leaves 4,600 games in the library, so it comes after the others)
    await bigRestore();

    await report();
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
