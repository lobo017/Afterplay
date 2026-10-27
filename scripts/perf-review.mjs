// Measures game review against its budget and picks the review engine's thread count.
//
//   npm run perf:review
//
// For each review thread count (PERF_REVIEW_THREADS, default 1,2,4) and each scenario
// (PERF_REVIEW_SCENARIOS, default alone,live), round-robin over PERF_REVIEW_ROUNDS rounds
// (default 2), a fresh page reviews the 40-move Fischer–Spassky game on the Quick preset
// (PERF_REVIEW_PRESET=standard|deep for the others):
//   - alone: the analysis board's engine is off; only the review engine runs
//   - live:  the analysis board runs MultiPV 5 `go infinite` on its own engine (auto
//            threads) for the whole review, as when someone keeps analysing meanwhile
// Recorded per run: review wall time, mean / min depth, verified positions, live-analysis
// speed before and during the review, rAF frame intervals and long tasks on the main
// thread during the review, and free system memory (a rough view of what a second
// multi-threaded engine costs). Every run writes its own log under test-results/perf-logs.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { inspect } from 'node:util';
import { chromium } from '@playwright/test';
import {
  findLeftoverTestProcesses,
  findOtherRepoServers,
  formatGb,
  formatProcesses,
  freeMemoryBytes,
  installCleanup,
  killAllChildTrees,
  killCommandHint,
} from './lib/process-guard.mjs';
import { FRAME_FLOOR_P50_MAX_MS, measureFrameFloor } from './lib/frame-floor.mjs';

const PORT = Number(process.env.PERF_PORT || 4180);
const BASE_URL = `http://127.0.0.1:${PORT}`;
const THREADS = (process.env.PERF_REVIEW_THREADS || '1,2,4')
  .split(',')
  .map(Number)
  .filter((n) => n > 0);
const SCENARIOS = (process.env.PERF_REVIEW_SCENARIOS || 'alone,live')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const ROUNDS = Number(process.env.PERF_REVIEW_ROUNDS || 2);
const PRESET = process.env.PERF_REVIEW_PRESET || 'quick';
const MAX_RUN_MS = Number(process.env.PERF_MAX_RUN_MS) || 30 * 60 * 1000;
const MIN_FREE_MEMORY_BYTES = 3 * 1024 ** 3;
// Spec: a 40-move game on Quick in about 30 s or less with a single thread
const REVIEW_TIME_BUDGET_MS = 30_000;

const FORTY_MOVE_PGN = `[Event "World Championship"]
[White "Fischer, Robert James"]
[Black "Spassky, Boris V"]
[Result "1-0"]

1. c4 e6 2. Nf3 d5 3. d4 Nf6 4. Nc3 Be7 5. Bg5 O-O 6. e3 h6 7. Bh4 b6 8. cxd5
Nxd5 9. Bxe7 Qxe7 10. Nxd5 exd5 11. Rc1 Be6 12. Qa4 c5 13. Qa3 Rc8 14. Bb5 a6
15. dxc5 bxc5 16. O-O Ra7 17. Be2 Nd7 18. Nd4 Qf8 19. Nxe6 fxe6 20. e4 d4 21. f4
Qe7 22. e5 Rb8 23. Bc4 Kh8 24. Qh3 Nf8 25. b3 a5 26. f5 exf5 27. Rxf5 Nh7 28.
Rcf1 Qd8 29. Qg3 Re7 30. h4 Rbb7 31. e6 Rbc7 32. Qe5 Qe8 33. a4 Qd8 34. R1f2
Qe8 35. R2f3 Qd8 36. Bd3 Qe8 37. Qe4 Nf6 38. Rxf6 gxf6 39. Rxf6 Kg8 40. Bc4 Kh8
41. Qf4 1-0`;

// --- Run log ------------------------------------------------------------------------
const LOG_DIR = path.join('test-results', 'perf-logs');
const RUN_TAG = [
  new Date().toISOString().replace(/[:.]/g, '-'),
  'review',
  `threads${THREADS.join('-')}`,
  PRESET,
  SCENARIOS.join('+'),
  `pid${process.pid}`,
].join('_');
const LOG_PATH = path.join(LOG_DIR, `${RUN_TAG}.log`);
fs.mkdirSync(LOG_DIR, { recursive: true });
const formatLogPart = (part) =>
  typeof part === 'string'
    ? part
    : part instanceof Error
      ? (part.stack ?? part.message)
      : inspect(part, { depth: 8, breakLength: 120 });
const writeLog = (stream, parts) => {
  const text = `${parts.map(formatLogPart).join(' ')}\n`;
  stream.write(text);
  fs.appendFileSync(LOG_PATH, text);
};
const log = (...parts) => writeLog(process.stdout, parts);
const logError = (...parts) => writeLog(process.stderr, parts);

class PerfAbort extends Error {
  constructor(message, exitCode) {
    super(message);
    this.exitCode = exitCode;
  }
}

function requireFreeMemory(stage) {
  const free = freeMemoryBytes();
  log(`[memory] ${stage}: ${formatGb(free)} free of ${formatGb(os.totalmem())}`);
  if (free < MIN_FREE_MEMORY_BYTES) {
    throw new PerfAbort(
      `Only ${formatGb(free)} free before ${stage}; perf:review needs ${formatGb(MIN_FREE_MEMORY_BYTES)} ` +
        '(headless Chrome with two multi-threaded Stockfish engines). Close other applications and run it again.',
      3,
    );
  }
}

function requireNoLeftovers() {
  const leftovers = findLeftoverTestProcesses({ ports: [PORT] });
  if (leftovers.length > 0) {
    throw new PerfAbort(
      `Refusing to start: ${leftovers.length} process(es) from earlier perf or test runs are still running:\n` +
        `${formatProcesses(leftovers)}\nStop them first, for example:\n${killCommandHint(leftovers)}`,
      2,
    );
  }
  const others = findOtherRepoServers({ ports: [PORT] });
  if (others.length > 0) {
    log(`[note] other serve.mjs instances on other ports (left alone):\n${formatProcesses(others)}`);
  }
}

function startStaticServer(port) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['scripts/serve.mjs', '--port', String(port)], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, WC_EXIT_WITH_PARENT_PID: String(process.pid) },
      windowsHide: true,
    });
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Timed out waiting for scripts/serve.mjs to start\n${stderr}`));
    }, 10_000);
    child.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      if (text.includes('http://')) {
        clearTimeout(timer);
        resolve(child);
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
      logError(`[server stderr] ${chunk.toString().trimEnd()}`);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`scripts/serve.mjs exited early with code ${code}\n${stderr}`));
    });
  });
}

/** In the page: frame-interval sampler, long-task observer, live-engine speed sampler. */
function installSamplers() {
  const s = {
    frames: [],
    longTasks: [],
    nps: [],
    running: false,
    start() {
      s.frames = [];
      s.longTasks = [];
      s.nps = [];
      s.running = true;
      s.observer = new PerformanceObserver((list) => {
        for (const e of list.getEntries()) s.longTasks.push(Math.round(e.duration));
      });
      s.observer.observe({ entryTypes: ['longtask'] });
      let last = performance.now();
      const tick = (now) => {
        if (!s.running) return;
        const dt = now - last;
        last = now;
        if (dt > 0 && dt < 1000) s.frames.push(dt);
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      s.npsTimer = setInterval(() => {
        const t = window.__wizardChessPlay.engine.getTelemetry();
        s.nps.push({ nps: t.nps, depth: t.depth });
      }, 500);
    },
    stop() {
      s.running = false;
      s.observer?.disconnect();
      clearInterval(s.npsTimer);
      const sorted = [...s.frames].sort((a, b) => a - b);
      const pick = (q) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] : 0);
      return {
        frameSamples: sorted.length,
        p95FrameMs: Number(pick(0.95).toFixed(2)),
        p99FrameMs: Number(pick(0.99).toFixed(2)),
        maxFrameMs: Number((sorted[sorted.length - 1] ?? 0).toFixed(2)),
        droppedFrames: sorted.filter((v) => v > 1.5 * 16.667).length,
        longTasks: s.longTasks,
        nps: s.nps,
      };
    },
  };
  window.__perfReview = s;
}

async function runOne(browser, threads, scenario) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' });
  const page = await context.newPage();
  page.on('pageerror', (err) => logError('[page error]', err));
  try {
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await page.locator('[data-testid="mode-tab-review"]').click();
    await page.locator('[data-testid="review-panel"]').waitFor({ state: 'visible' });
    await page.evaluate(installSamplers);
    await page.evaluate(
      async ({ pgn, threads, live }) => {
        const analysis = window.__wizardChessAnalysis;
        if (!analysis.controller.importPgn(pgn)) throw new Error('PGN import failed');
        analysis.controller.goToStart();
        await window.__wizardChessReview.setThreads(threads);
        if (live) {
          analysis.controller.setMultiPv(5);
          analysis.controller.setAnalysisDepth('infinite');
          analysis.controller.setEngineEnabled(true);
        } else {
          analysis.controller.setEngineEnabled(false);
        }
      },
      { pgn: FORTY_MOVE_PGN, threads, live: scenario === 'live' },
    );

    let liveBefore = null;
    if (scenario === 'live') {
      // Let live analysis settle, then measure its speed without a review running
      await page.waitForFunction(() => window.__wizardChessPlay.engine.getTelemetry().depth >= 14, null, {
        timeout: 60_000,
      });
      liveBefore = await page.evaluate(async () => {
        const samples = [];
        for (let i = 0; i < 6; i++) {
          await new Promise((r) => setTimeout(r, 500));
          samples.push(window.__wizardChessPlay.engine.getTelemetry().nps);
        }
        return samples;
      });
    }

    const freeBefore = freeMemoryBytes();
    let minFree = freeBefore;
    const memTimer = setInterval(() => {
      minFree = Math.min(minFree, freeMemoryBytes());
    }, 250);
    const t0 = Date.now();
    await page.evaluate((preset) => {
      window.__perfReview.start();
      window.__wizardChessReview.panel.setPreset(preset);
      void window.__wizardChessReview.panel.start();
    }, PRESET);
    await page.waitForFunction(() => window.__wizardChessReview.panel.getState() !== 'running', null, {
      timeout: 600_000,
      polling: 250,
    });
    const wallMs = Date.now() - t0;
    clearInterval(memTimer);
    const result = await page.evaluate(() => {
      const sampled = window.__perfReview.stop();
      const panel = window.__wizardChessReview.panel;
      const run = panel.getRunResult();
      const engine = window.__wizardChessReview.getEngine();
      const searched = (run?.positions ?? []).filter((p) => p && !p.terminal);
      const nodes = searched.reduce((acc, p) => acc + (p.nodes ?? 0), 0);
      const searchMs = searched.reduce((acc, p) => acc + (p.timeMs ?? 0), 0);
      return {
        reviewKnps: searchMs > 0 ? Math.round(nodes / searchMs) : 0,
        meanKnodes: searched.length > 0 ? Math.round(nodes / searched.length / 1000) : 0,
        state: panel.getState(),
        stats: run?.stats ?? null,
        moves: run?.review.moves.length ?? 0,
        reviewThreads: engine.getThreads(),
        reviewVariant: engine.getVariant(),
        liveThreads: window.__wizardChessPlay.engine.getThreads(),
        ...sampled,
      };
    });
    const mean = (xs) => (xs.length ? xs.reduce((a, v) => a + v, 0) / xs.length : null);
    const liveDuring = result.nps.map((x) => x.nps).filter((n) => n > 0);
    return {
      threads,
      scenario,
      state: result.state,
      moves: result.moves,
      reviewVariant: result.reviewVariant,
      reviewThreads: result.reviewThreads,
      liveThreads: scenario === 'live' ? result.liveThreads : null,
      reviewMs: Math.round(result.stats?.timeMs ?? wallMs),
      meanDepth: Number((result.stats?.meanDepth ?? 0).toFixed(1)),
      minDepth: result.stats?.minDepth ?? 0,
      reviewKnps: result.reviewKnps,
      meanKnodesPerPosition: result.meanKnodes,
      verifiedPositions: result.stats?.verifiedPositions ?? 0,
      liveKnpsBefore: liveBefore ? Math.round(mean(liveBefore) / 1000) : null,
      liveKnpsDuring: scenario === 'live' ? Math.round((mean(liveDuring) ?? 0) / 1000) : null,
      liveDepthAtEnd: scenario === 'live' ? (result.nps.at(-1)?.depth ?? null) : null,
      p95FrameMs: result.p95FrameMs,
      p99FrameMs: result.p99FrameMs,
      maxFrameMs: result.maxFrameMs,
      droppedFrames: `${result.droppedFrames}/${result.frameSamples}`,
      longTasks: result.longTasks,
      freeBeforeGb: Number((freeBefore / 1024 ** 3).toFixed(2)),
      minFreeDuringGb: Number((minFree / 1024 ** 3).toFixed(2)),
    };
  } finally {
    await context.close();
  }
}

async function closeBrowser(browser) {
  if (!browser) return;
  await Promise.race([
    browser.close().catch((err) => logError('[cleanup] browser.close failed:', err)),
    new Promise((r) => setTimeout(r, 10_000)),
  ]);
}

async function main() {
  log(`[run] ${RUN_TAG}`);
  log(`[run] log file: ${path.resolve(LOG_PATH)}`);
  log(
    `[run] node ${process.version}, ${os.cpus().length} CPUs, threads=${THREADS.join(',')}, ` +
      `scenarios=${SCENARIOS.join(',')}, rounds=${ROUNDS}, preset=${PRESET}, port=${PORT}`,
  );
  requireNoLeftovers();
  requireFreeMemory('start');
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
  const runs = [];
  try {
    server = await startStaticServer(PORT);
    browser = await chromium.launch({
      channel: 'chrome',
      headless: true,
      handleSIGINT: false,
      handleSIGTERM: false,
      handleSIGHUP: false,
    });
    for (let round = 1; round <= ROUNDS; round++) {
      for (const scenario of SCENARIOS) {
        for (const threads of THREADS) {
          requireFreeMemory(`round ${round} ${scenario} ${threads} thread(s)`);
          // The frame numbers below only mean something while a blank page runs at the display rate
          const probe = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' });
          const floor = await measureFrameFloor(probe).finally(() => probe.close());
          const r = await runOne(browser, threads, scenario);
          r.floorP50FrameMs = floor.p50FrameMs;
          r.framesValid = floor.p50FrameMs <= FRAME_FLOOR_P50_MAX_MS;
          r.round = round;
          runs.push(r);
          log(`[result] ${JSON.stringify(r)}`);
        }
      }
    }
  } finally {
    await closeBrowser(browser);
    server?.kill();
  }

  log(
    '\n| Scenario | Threads | Review time | Mean / min depth | Review kN/s (kN per position) | Verified | Live kN/s before → during | Blank-page floor | p95 / p99 frame | Dropped | Long tasks | Free mem before → min |',
  );
  log('|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const r of runs) {
    const live = r.liveKnpsBefore !== null ? `${r.liveKnpsBefore} → ${r.liveKnpsDuring}` : '—';
    log(
      `| ${r.scenario} (round ${r.round}) | ${r.reviewThreads} (${r.reviewVariant}) | ${(r.reviewMs / 1000).toFixed(1)} s | ${r.meanDepth} / ${r.minDepth} | ${r.reviewKnps} (${r.meanKnodesPerPosition}) | ${r.verifiedPositions} | ${live} | ${r.floorP50FrameMs} ms${r.framesValid ? '' : ' (display not at 60 Hz: frame numbers NOT valid)'} | ${r.p95FrameMs} / ${r.p99FrameMs} ms | ${r.droppedFrames} | ${r.longTasks.length ? r.longTasks.join(', ') + ' ms' : '0'} | ${r.freeBeforeGb} → ${r.minFreeDuringGb} GB |`,
    );
  }
  const failures = runs.filter(
    (r) =>
      r.state !== 'done' ||
      r.moves !== 81 ||
      r.longTasks.length > 0 ||
      (PRESET === 'quick' && r.reviewThreads === 1 && r.reviewMs > REVIEW_TIME_BUDGET_MS),
  );
  if (failures.length > 0) {
    logError(
      `[fail] ${failures.length} run(s) missed the budget (state, 81 moves, no long tasks, 1-thread review ≤ 30 s)`,
    );
    process.exitCode = 1;
  }
}

main()
  .catch((err) => {
    if (err instanceof PerfAbort) {
      logError(`[abort] ${err.message}`);
      process.exitCode = err.exitCode;
    } else {
      logError('perf:review failed:', err);
      process.exitCode = 1;
    }
  })
  .finally(() => {
    log(`[run] finished with exit code ${process.exitCode ?? 0}; log: ${path.resolve(LOG_PATH)}`);
    process.exit(process.exitCode ?? 0);
  });
