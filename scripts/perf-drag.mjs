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
import { browserLaunchOptions, isHeadlessServer } from './lib/browser.mjs';
import { FRAME_FLOOR_P50_MAX_MS, floorFailureHint, measureFrameFloor } from './lib/frame-floor.mjs';

const PORT = Number(process.env.PERF_PORT || 4179);
const BASE_URL = `http://127.0.0.1:${PORT}`;
const SCENARIOS = (process.env.PERF_SCENARIOS || 'play,analysis')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// Experiment knobs for scenario 2: PERF_ENGINE_THREADS=n overrides the engine's auto
// thread count; PERF_GHOSTS=off skips the ghost-preview hovers during the drag sweep.
const ENGINE_THREADS = process.env.PERF_ENGINE_THREADS ? Number(process.env.PERF_ENGINE_THREADS) : null;
const GHOST_PREVIEWS = process.env.PERF_GHOSTS !== 'off';

// Frame budget: one 60 Hz vsync (16.7 ms) plus 0.5 ms for rAF timestamp jitter.
// A single dropped frame is a 33.3 ms interval, so this still fails on real jank.
const FRAME_BUDGET_MS = 16.7;
const FRAME_JITTER_ALLOWANCE_MS = 0.5;
const P95_LIMIT_MS = FRAME_BUDGET_MS + FRAME_JITTER_ALLOWANCE_MS;
// A blank page must itself run at (about) the display rate; above this median the run is not valid evidence.
const ENVIRONMENT_FLOOR_P50_MAX_MS = FRAME_FLOOR_P50_MAX_MS;
// PERF_RELATIVE=1 runs anyway and judges each window against the blank-page floor instead of the 60 Hz budget
// (to compare two commits under the same bad conditions). Such a run says nothing about the spec budget.
const RELATIVE_MODE = process.env.PERF_RELATIVE === '1';

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

// --- Run log: every run writes its own file, so nothing is ever overwritten ---------
const LOG_DIR = path.join('test-results', 'perf-logs');
const RUN_TAG = [
  new Date().toISOString().replace(/[:.]/g, '-'),
  SCENARIOS.join('+'),
  ENGINE_THREADS ? `threads${ENGINE_THREADS}` : 'threadsAuto',
  GHOST_PREVIEWS ? 'ghosts' : 'noGhosts',
  `pid${process.pid}`,
].join('_');
const LOG_PATH = path.join(LOG_DIR, `${RUN_TAG}.log`);
fs.mkdirSync(LOG_DIR, { recursive: true });

const formatLogPart = (part) => {
  if (typeof part === 'string') return part;
  if (part instanceof Error) {
    const cause = part.cause ? `\nCaused by: ${formatLogPart(part.cause)}` : '';
    return `${part.stack ?? part.message}${cause}`;
  }
  return inspect(part, { depth: 8, breakLength: 120 });
};
// appendFileSync: the line is on disk even if the process dies right after
const writeLog = (stream, parts) => {
  const text = `${parts.map(formatLogPart).join(' ')}\n`;
  stream.write(text);
  fs.appendFileSync(LOG_PATH, text);
};
const log = (...parts) => writeLog(process.stdout, parts);
const logError = (...parts) => writeLog(process.stderr, parts);

// --- Preflight: free memory and leftover processes --------------------------------
// Last-resort limit: a full run takes 1–3 minutes, so a run still going after this is
// stuck or orphaned and kills itself (and its browser and server).
const MAX_RUN_MS = Number(process.env.PERF_MAX_RUN_MS) || 15 * 60 * 1000;
const MIN_FREE_MEMORY_BYTES = 3 * 1024 ** 3;

/** A deliberate stop with a clear message (not a crash). */
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
      `Only ${formatGb(free)} of memory is free before ${stage}; perf:drag needs at least ` +
        `${formatGb(MIN_FREE_MEMORY_BYTES)} (each run starts headless Chrome and multi-threaded ` +
        'Stockfish). Close other applications and run it again.',
      3,
    );
  }
}

function requireNoLeftovers() {
  const leftovers = findLeftoverTestProcesses({ ports: [PORT] });
  if (leftovers.length > 0) {
    throw new PerfAbort(
      `Refusing to start: ${leftovers.length} process(es) from earlier perf or test runs ` +
        `are still running. They hold memory and skew frame timings:\n${formatProcesses(leftovers)}\n` +
        `Stop them first, for example:\n${killCommandHint(leftovers)}`,
      2,
    );
  }
  const others = findOtherRepoServers({ ports: [PORT] });
  if (others.length > 0) {
    log(
      `[note] other serve.mjs instances are running on other ports (not started by this ` +
        `script, left alone):\n${formatProcesses(others)}`,
    );
  }
}

function startStaticServer(port) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['scripts/serve.mjs', '--port', String(port)], {
      stdio: ['ignore', 'pipe', 'pipe'],
      // The server exits by itself if this script is force-killed
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
      log(`[server] ${text.trimEnd()}`);
      if (text.includes('http://')) {
        clearTimeout(timer);
        resolve(child);
      }
    });

    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      stderr += text;
      logError(`[server stderr] ${text.trimEnd()}`);
    });

    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`scripts/serve.mjs exited early with code ${code}\n${stderr}`));
      }
    });
  });
}

/**
 * Installs window.__perf helpers: a long-task counter and a frame-interval sampler.
 * Runs inside the page.
 */
function installPerfHelpers() {
  const perf = {
    longTasks: 0,
    longTaskMaxMs: 0,
    observer: null,
    startLongTasks() {
      perf.longTasks = 0;
      perf.longTaskMaxMs = 0;
      perf.observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (entry.duration > 50) {
            perf.longTasks++;
            perf.longTaskMaxMs = Math.max(perf.longTaskMaxMs, entry.duration);
          }
        }
      });
      perf.observer.observe({ entryTypes: ['longtask'] });
    },
    stopLongTasks() {
      perf.observer?.disconnect();
      perf.observer = null;
      return { longTaskCount: perf.longTasks, longTaskMaxMs: perf.longTaskMaxMs };
    },
    frame() {
      return new Promise((r) => requestAnimationFrame(r));
    },
    summarize(intervals) {
      const samples = [...intervals].sort((a, b) => a - b);
      const count = samples.length;
      const pick = (q) => (count > 0 ? samples[Math.min(count - 1, Math.floor(count * q))] : 0);
      const mean = count > 0 ? samples.reduce((a, v) => a + v, 0) / count : 0;
      const dropped = samples.filter((v) => v > 1.5 * 16.667).length;
      return {
        sampleCount: count,
        fps: mean > 0 ? Number((1000 / mean).toFixed(1)) : 0,
        meanFrameMs: Number(mean.toFixed(2)),
        p50FrameMs: Number(pick(0.5).toFixed(2)),
        p95FrameMs: Number(pick(0.95).toFixed(2)),
        p99FrameMs: Number(pick(0.99).toFixed(2)),
        maxFrameMs: Number((count > 0 ? samples[count - 1] : 0).toFixed(2)),
        droppedFrames: dropped,
        droppedFramePct: count > 0 ? Number(((dropped / count) * 100).toFixed(2)) : 0,
      };
    },
    squareCenter(boardEl, square, flipped) {
      const rect = boardEl.getBoundingClientRect();
      const file = 'abcdefgh'.indexOf(square[0]);
      const rank = Number(square[1]) - 1;
      const col = flipped ? 7 - file : file;
      const row = flipped ? rank : 7 - rank;
      return {
        x: rect.left + (col + 0.5) * (rect.width / 8),
        y: rect.top + (row + 0.5) * (rect.height / 8),
      };
    },
    pointer(type, target, pointerId, pt, button = 0) {
      target.dispatchEvent(
        new window.PointerEvent(type, {
          bubbles: true,
          pointerId,
          button,
          buttons: type === 'pointerup' ? 0 : 1,
          clientX: pt.x,
          clientY: pt.y,
        }),
      );
    },
    clickSquare(boardEl, square, flipped, pointerId) {
      const pt = perf.squareCenter(boardEl, square, flipped);
      perf.pointer('pointerdown', boardEl, pointerId, pt);
      perf.pointer('pointerup', window, pointerId, pt);
    },
  };
  window.__perf = perf;
}

/**
 * Sweeps pieces around the board with synthetic pointer events, one step per frame,
 * sampling rAF intervals. Optionally hovers engine-line moves every few frames so the
 * board renders ghost previews while the drag is in flight. Runs inside the page.
 */
async function runDragSweep({ ghostHoverEvery, readTelemetry }) {
  const perf = window.__perf;
  const boardEl = document.querySelector('[data-testid="chess-board"]');
  if (!boardEl) throw new Error('chess-board not found');
  const rect = boardEl.getBoundingClientRect();
  const sqCenter = (col, row) => ({
    x: rect.left + (col + 0.5) * (rect.width / 8),
    y: rect.top + (row + 0.5) * (rect.height / 8),
  });

  // Input-to-transform latency: pointerdown + pointermove, then read the dragged transform.
  const pieceE2 = document.querySelector('[data-testid="piece-e2"]');
  const startPt = sqCenter(4, 6);
  const tInput0 = performance.now();
  perf.pointer('pointerdown', boardEl, 1, startPt);
  perf.pointer('pointermove', window, 1, { x: startPt.x + 30, y: startPt.y - 60 });
  // The lift (a scale transform, whatever the board-feel setting) must be in the style by the time the
  // handlers return: the browser then paints it in the very next frame (one frame at most).
  const inputLifted = /scale\(/.test(pieceE2?.style.transform ?? '');
  const inputLatencyMs = Number((performance.now() - tInput0).toFixed(3));
  perf.pointer('pointerup', window, 1, startPt);

  const trajectories = [
    [sqCenter(4, 6), sqCenter(0, 2), sqCenter(7, 2), sqCenter(4, 6)],
    [sqCenter(6, 7), sqCenter(2, 3), sqCenter(5, 1), sqCenter(6, 7)],
    [sqCenter(3, 7), sqCenter(0, 4), sqCenter(7, 3), sqCenter(3, 7)],
    [sqCenter(0, 7), sqCenter(0, 1), sqCenter(7, 1), sqCenter(0, 7)],
    // b1 knight dropped on c3: a legal 1. Nc3
    [sqCenter(1, 7), sqCenter(4, 4), sqCenter(2, 5)],
  ];

  const frameIntervals = [];
  let peakDepth = 0;
  let peakNps = 0;
  let ghostHovers = 0;
  let ghostPreviewsShown = 0;
  let frameIndex = 0;
  perf.startLongTasks();

  for (let tIdx = 0; tIdx < trajectories.length; tIdx++) {
    const waypoints = trajectories[tIdx];
    const pointerId = 10 + tIdx;
    perf.pointer('pointerdown', boardEl, pointerId, waypoints[0]);
    let lastTime = await perf.frame();

    for (let w = 1; w < waypoints.length; w++) {
      const prev = waypoints[w - 1];
      const next = waypoints[w];
      const steps = 20;
      for (let s = 1; s <= steps; s++) {
        const now = await perf.frame();
        const dt = now - lastTime;
        lastTime = now;
        if (dt > 0 && dt < 250) frameIntervals.push(dt);

        const ratio = s / steps;
        perf.pointer('pointermove', window, pointerId, {
          x: prev.x + (next.x - prev.x) * ratio,
          y: prev.y + (next.y - prev.y) * ratio,
        });

        frameIndex++;
        if (ghostHoverEvery > 0 && frameIndex % ghostHoverEvery === 0) {
          const line = 1 + (Math.floor(frameIndex / ghostHoverEvery) % 5);
          const ply = Math.floor(frameIndex / (ghostHoverEvery * 5)) % 4;
          const token = document.querySelector(`[data-testid="engine-pv-move-${line}-${ply}"]`);
          if (token) {
            token.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true }));
            ghostHovers++;
            if (window.__wizardChessAnalysis.controller.getBoard().getGhostPreview()) {
              ghostPreviewsShown++;
            }
          }
        }

        const tel = readTelemetry ? window.__wizardChessPlay.engine.getTelemetry() : null;
        if (tel) {
          peakDepth = Math.max(peakDepth, tel.depth);
          peakNps = Math.max(peakNps, tel.nps);
        }
      }
    }

    perf.pointer('pointerup', window, pointerId, waypoints[waypoints.length - 1]);
  }

  const longTasks = perf.stopLongTasks();
  const linesList = document.querySelector('[data-testid="engine-lines-list"]');
  linesList?.dispatchEvent(new window.MouseEvent('mouseleave'));
  const tel = window.__wizardChessPlay.engine.getTelemetry();
  return {
    ...perf.summarize(frameIntervals),
    ...longTasks,
    inputLifted,
    inputLatencyMs,
    ghostHovers,
    ghostPreviewsShown,
    engineVariant: tel.variant,
    engineThreads: tel.threads,
    enginePeakDepth: Math.max(peakDepth, tel.depth),
    enginePeakNps: Math.max(peakNps, tel.nps),
  };
}

async function measureIdleRaf(page) {
  return page.evaluate(async () => {
    let rafCalls = 0;
    const origRaf = window.requestAnimationFrame;
    window.requestAnimationFrame = (cb) => {
      rafCalls++;
      return origRaf.call(window, cb);
    };
    try {
      await new Promise((r) => setTimeout(r, 500));
    } finally {
      window.requestAnimationFrame = origRaf;
    }
    return rafCalls;
  });
}

// Main-thread time per frame, from the browser's own counters (script, style, layout, and every task in all):
// a 120 Hz display gives a frame 8.3 ms, so the mean main-thread work per frame must fit in that.
let cdpSession = null;
const HIGH_REFRESH_FRAME_MS = 1000 / 120;
async function readMetrics() {
  const { metrics } = await cdpSession.send('Performance.getMetrics');
  return Object.fromEntries(metrics.map((m) => [m.name, m.value]));
}
/** Runs `fn` (a measured window) and returns its result with the main thread's busy time per frame. */
async function withMainThread(fn) {
  const t0 = performance.now();
  const before = await readMetrics();
  const result = await fn();
  const after = await readMetrics();
  const wallMs = performance.now() - t0;
  const ms = (name) => (after[name] - before[name]) * 1000;
  const frames = Math.max(1, wallMs / FRAME_BUDGET_MS);
  result.mainThread = {
    busyMsPerFrame: Number((ms('TaskDuration') / frames).toFixed(2)),
    busyPct: Number(((ms('TaskDuration') / wallMs) * 100).toFixed(1)),
    scriptMsPerFrame: Number((ms('ScriptDuration') / frames).toFixed(2)),
    layoutMsPerFrame: Number(((ms('LayoutDuration') + ms('RecalcStyleDuration')) / frames).toFixed(2)),
  };
  return result;
}

async function scenarioPlay(page) {
  // Infinite analysis on the shared engine while the user drags pieces in Play mode.
  await page.getByTestId('square-e2').click();
  await page.getByTestId('square-e2').click();
  // Live evaluation is a switch in the game view's Analysis tab (a game must be started)
  await page.getByTestId('btn-new-game').click();
  await page.getByTestId('play-tab-analysis').click();
  await page.getByTestId('toggle-infinite-analysis').check();
  await page.getByTestId('play-tab-moves').click();
  await page.waitForFunction(
    () => {
      const m = window.__wizardChessPlay?.devOverlay.getMetrics();
      return Boolean(m && m.engineDepth >= 8 && m.engineNps > 0);
    },
    undefined,
    { timeout: 15_000 },
  );

  // A hardware-mouse drag first confirms real pointer capture end to end.
  const boardBox = await page.locator('[data-testid="chess-board"]').boundingBox();
  const e2X = boardBox.x + 4.5 * (boardBox.width / 8);
  const e2Y = boardBox.y + 6.5 * (boardBox.height / 8);
  await page.mouse.move(e2X, e2Y);
  await page.mouse.down();
  await page.mouse.move(e2X, e2Y - 120, { steps: 10 });
  await page.mouse.move(e2X, e2Y, { steps: 10 });
  await page.mouse.up();

  const drag = await withMainThread(() =>
    page.evaluate(runDragSweep, {
      ghostHoverEvery: 0,
      readTelemetry: true,
    }),
  );

  // Premove burst: queue three premoves while the bot thinks and let all of them fire.
  const premoves = await withMainThread(() =>
    page.evaluate(async () => {
      const perf = window.__perf;
      const play = window.__wizardChessPlay;
      const controller = play.controller;
      const board = controller.getBoard();
      controller.setBotDelayRangeMs(350, 350);
      controller.startNewGame({ playerColor: 'w' });
      const boardEl = document.querySelector('[data-testid="chess-board"]');
      perf.clickSquare(boardEl, 'e2', false, 40);
      perf.clickSquare(boardEl, 'e4', false, 41);
      const queue = [
        ['d2', 'd4'],
        ['g1', 'f3'],
        ['b1', 'c3'],
      ];
      queue.forEach(([from, to], i) => {
        perf.clickSquare(boardEl, from, false, 50 + i * 2);
        perf.clickSquare(boardEl, to, false, 51 + i * 2);
      });
      const queued = board.getPremoves().length;

      const frameIntervals = [];
      let lastPly = controller.getGameTree().getMainLine().length;
      let lastTime = await perf.frame();
      const plyFrames = [];
      perf.startLongTasks();
      const deadline = performance.now() + 15_000;
      while (performance.now() < deadline) {
        const now = await perf.frame();
        const dt = now - lastTime;
        lastTime = now;
        if (dt > 0 && dt < 250) frameIntervals.push(dt);
        const ply = controller.getGameTree().getMainLine().length;
        if (ply !== lastPly) {
          plyFrames.push({ frame: frameIntervals.length, from: lastPly, to: ply });
          lastPly = ply;
        }
        if (ply >= 7) break;
      }
      const longTasks = perf.stopLongTasks();
      // Each bot reply and the premove it releases must land in the same frame (ply jumps by 2).
      const sameFrameExecutions = plyFrames.filter((p) => p.to - p.from === 2).length;
      controller.setBotDelayRangeMs(500, 3000);
      return {
        queued,
        finalPly: controller.getGameTree().getMainLine().length,
        sameFrameExecutions,
        plyFrames,
        ...perf.summarize(frameIntervals),
        ...longTasks,
      };
    }),
  );

  await page.evaluate(() => window.__wizardChessPlay.controller.setInfiniteAnalysis(false));
  return { drag, premoves };
}

async function scenarioAnalysis(page) {
  if (ENGINE_THREADS !== null) {
    // Same path the app uses: EngineClient.configure() restarts the worker with the new
    // thread count (it never sends setoption Threads to a live engine)
    await page.evaluate((threads) => window.__wizardChessPlay.engine.configure({ threads }), ENGINE_THREADS);
  }
  await page.getByTestId('mode-tab-review').click();
  await page.getByTestId('analysis-layout').waitFor({ state: 'visible' });
  // Engine lines live in Review's Analysis tab
  await page.getByTestId('review-shell-tab-analysis').click();
  await page.getByTestId('select-multipv').selectOption('5');
  await page.evaluate(() => {
    window.__wizardChessAnalysis.controller.setAnalysisDepth('infinite');
  });
  await page.locator('[data-testid="engine-pv-move-5-3"]').waitFor({
    state: 'visible',
    timeout: 20_000,
  });

  const panelRendersBefore = await page.evaluate(() =>
    window.__wizardChessAnalysis.controller.getLinesPanel().getRenderCount(),
  );
  const renderAudit = page.evaluate(async () => {
    // Count engine-line DOM updates per animation frame while the drag sweep runs.
    const panel = window.__wizardChessAnalysis.controller.getLinesPanel();
    let maxPerFrame = 0;
    let frames = 0;
    let last = panel.getRenderCount();
    window.__perfAuditStop = false;
    while (!window.__perfAuditStop) {
      await new Promise((r) => requestAnimationFrame(r));
      const now = panel.getRenderCount();
      maxPerFrame = Math.max(maxPerFrame, now - last);
      last = now;
      frames++;
    }
    return { frames, maxEngineLineDomUpdatesPerFrame: maxPerFrame };
  });

  const drag = await withMainThread(() =>
    page.evaluate(runDragSweep, {
      ghostHoverEvery: GHOST_PREVIEWS ? 3 : 0,
      readTelemetry: true,
    }),
  );
  await page.evaluate(() => {
    window.__perfAuditStop = true;
  });
  const audit = await renderAudit;
  const panelRendersAfter = await page.evaluate(() =>
    window.__wizardChessAnalysis.controller.getLinesPanel().getRenderCount(),
  );

  // Navigation sweep: rapid arrow-key stepping through a 40-move game, one key per frame.
  const navigation = await withMainThread(() =>
    page.evaluate(async (pgn) => {
      const perf = window.__perf;
      const controller = window.__wizardChessAnalysis.controller;
      controller.importPgn(pgn);
      controller.goToStart();
      const plies = controller.getGameTree().getMainLine().length;
      await perf.frame();
      const frameIntervals = [];
      let lastTime = await perf.frame();
      perf.startLongTasks();
      const press = (key) => window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
      for (let i = 0; i < plies; i++) {
        press('ArrowRight');
        const now = await perf.frame();
        if (now - lastTime < 250) frameIntervals.push(now - lastTime);
        lastTime = now;
      }
      const plyAtEnd = controller.getGameTree().currentNode.ply;
      // Back again at one key every second frame; every frame interval is sampled.
      for (let i = 0; i < plies; i++) {
        press('ArrowLeft');
        for (let f = 0; f < 2; f++) {
          const now = await perf.frame();
          if (now - lastTime < 250) frameIntervals.push(now - lastTime);
          lastTime = now;
        }
      }
      const longTasks = perf.stopLongTasks();
      return {
        plies,
        plyAtEnd,
        plyAfterReturn: controller.getGameTree().currentNode.ply,
        ...perf.summarize(frameIntervals),
        ...longTasks,
      };
    }, FORTY_MOVE_PGN),
  );

  return {
    drag: {
      ...drag,
      engineLineDomUpdates: panelRendersAfter - panelRendersBefore,
      auditFrames: audit.frames,
      maxEngineLineDomUpdatesPerFrame: audit.maxEngineLineDomUpdatesPerFrame,
    },
    navigation,
  };
}

async function closeBrowser(browser) {
  if (!browser) return;
  await Promise.race([
    browser.close().catch((err) => logError('[cleanup] browser.close failed:', err)),
    new Promise((r) => setTimeout(r, 10_000)),
  ]);
}

async function runPerfBenchmark() {
  log(`[run] ${RUN_TAG}`);
  log(`[run] log file: ${path.resolve(LOG_PATH)}`);
  log(
    `[run] node ${process.version}, ${process.platform}/${process.arch}, ${os.cpus().length} CPUs, ` +
      `scenarios=${SCENARIOS.join(',')}, engineThreads=${ENGINE_THREADS ?? 'auto'}, ` +
      `ghostPreviews=${GHOST_PREVIEWS ? 'on' : 'off'}, port=${PORT}`,
  );

  requireNoLeftovers();
  requireFreeMemory('start');

  // From here on, whatever ends the run (error, Ctrl+C, SIGTERM, parent gone) also
  // takes down the server and every browser process this script started.
  installCleanup({
    log: logError,
    maxRunMs: MAX_RUN_MS,
    cleanup: (reason) => {
      const killed = killAllChildTrees();
      if (killed.length === 0) {
        log(`[cleanup] ${reason}: no child processes left`);
      } else {
        logError(
          `[cleanup] ${reason}: killed ${killed.length} child process tree(s) still running:
${formatProcesses(killed)}`,
        );
      }
    },
  });

  let server = null;
  let browser = null;
  try {
    server = await startStaticServer(PORT);
    browser = await chromium.launch({
      ...browserLaunchOptions(),
      // This script owns signal handling, so cleanup covers the server too
      handleSIGINT: false,
      handleSIGTERM: false,
      handleSIGHUP: false,
    });

    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      // The app's service worker would cache the build in the background during a measurement
      serviceWorkers: 'block',
    });
    const environmentFloor = await measureFrameFloor(context);
    log(
      `[environment] blank page: p50 ${environmentFloor.p50FrameMs} ms, p95 ${environmentFloor.p95FrameMs} ms ` +
        `(a 60 Hz display gives ~16.7 ms)`,
    );
    let p95Limit = P95_LIMIT_MS;
    if (environmentFloor.p50FrameMs > ENVIRONMENT_FLOOR_P50_MAX_MS) {
      if (!RELATIVE_MODE) {
        throw new PerfAbort(
          `A blank page runs at p50 ${environmentFloor.p50FrameMs} ms here (limit ${ENVIRONMENT_FLOOR_P50_MAX_MS} ms), ` +
            'so no app could meet the 60 Hz budget and the numbers would be meaningless. ' +
            `${floorFailureHint(isHeadlessServer())} (PERF_RELATIVE=1 ` +
            'compares against this floor instead; that result is not a spec budget result.)',
          4,
        );
      }
      p95Limit = Math.max(P95_LIMIT_MS, environmentFloor.p95FrameMs + FRAME_JITTER_ALLOWANCE_MS);
      log(
        `[environment] PERF_RELATIVE=1: windows are judged against p95 <= ${p95Limit.toFixed(2)} ms (the floor + jitter), not the spec budget`,
      );
    }
    const page = await context.newPage();
    page.on('pageerror', (err) => logError('[page error]', err));
    page.on('console', (msg) => {
      if (msg.type() === 'error') logError(`[page console.error] ${msg.text()}`);
    });

    cdpSession = await context.newCDPSession(page);
    await cdpSession.send('Performance.enable');

    const navStart = performance.now();
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await page.locator('[data-testid="chess-board"]').waitFor({ state: 'visible' });
    await page.locator('[data-testid="piece-e2"]').waitFor({ state: 'visible' });
    const startupInteractiveMs = Number((performance.now() - navStart).toFixed(2));

    // The app builds the Review screen and the audio context in idle moments shortly after start-up (the
    // audio one is a 60-340 ms one-time browser cost). Let both finish so they land in no measured window.
    await page.waitForFunction(() => window.__wizardChessPlay?.controller.getAudio().isInitialized(), undefined, {
      timeout: 10_000,
    });
    await page.waitForTimeout(500);

    // No rAF work while nothing changes (clock not started, overlay hidden, no particles).
    const idleRafCallbacksIn500Ms = await measureIdleRaf(page);
    await page.evaluate(installPerfHelpers);

    const report = {
      environmentFloor,
      // A cluster node has no display: frames follow Chromium's own 60 Hz timer, and these numbers are
      // regression baselines for the code, not what a user's screen would show
      display: isHeadlessServer() ? 'none (headless server, software 60 Hz timer)' : 'display',
      mode:
        environmentFloor.p50FrameMs > ENVIRONMENT_FLOOR_P50_MAX_MS
          ? 'relative-to-floor (NOT a spec budget result)'
          : 'spec budget',
      startupInteractiveMs,
      idleRafCallbacksIn500Ms,
      p95LimitMs: Number(p95Limit.toFixed(2)),
      engineThreadsRequested: ENGINE_THREADS ?? 'auto',
      ghostPreviews: GHOST_PREVIEWS,
    };
    const failures = [];
    const checkMainThread = (label, stats) => {
      if (stats.mainThread && stats.mainThread.busyMsPerFrame > HIGH_REFRESH_FRAME_MS) {
        failures.push(
          `${label}: main thread busy ${stats.mainThread.busyMsPerFrame} ms per frame > ${HIGH_REFRESH_FRAME_MS.toFixed(1)} ms (120 Hz)`,
        );
      }
    };
    const checkFrames = (label, stats) => {
      checkMainThread(label, stats);
      if (stats.p95FrameMs > p95Limit) {
        failures.push(`${label}: p95 ${stats.p95FrameMs} ms > ${p95Limit.toFixed(2)} ms`);
      }
      if (stats.longTaskCount !== 0) {
        failures.push(`${label}: ${stats.longTaskCount} long task(s)`);
      }
    };

    // Input latency (spec: <= 1 frame): the pickup's lift is applied inside the pointerdown/move handlers
    const checkInput = (label, stats) => {
      if (!stats.inputLifted) failures.push(`${label} input: the piece was not lifted by the pointer events`);
      if (stats.inputLatencyMs > FRAME_BUDGET_MS) {
        failures.push(`${label} input latency: ${stats.inputLatencyMs} ms > ${FRAME_BUDGET_MS} ms`);
      }
    };

    if (SCENARIOS.includes('play')) {
      requireFreeMemory('scenario 1 (play)');
      const play = await scenarioPlay(page);
      report.scenario1_playDragInfinite = play.drag;
      report.scenario1_premoveExecution = play.premoves;
      checkFrames('scenario 1 drag', play.drag);
      checkInput('scenario 1', play.drag);
      checkFrames('scenario 1 premove execution', play.premoves);
      if (play.premoves.queued !== 3 || play.premoves.finalPly < 7) {
        failures.push(`scenario 1 premoves: queued ${play.premoves.queued}, final ply ${play.premoves.finalPly}`);
      }
      if (play.premoves.sameFrameExecutions !== 3) {
        failures.push(`scenario 1 premoves: only ${play.premoves.sameFrameExecutions}/3 executed in the bot's frame`);
      }
    }

    if (SCENARIOS.includes('analysis')) {
      requireFreeMemory('scenario 2 (analysis)');
      const analysis = await scenarioAnalysis(page);
      report.scenario2_analysisDragMultiPv5Ghosts = analysis.drag;
      report.scenario2_navigationSweep = analysis.navigation;
      checkFrames('scenario 2 drag', analysis.drag);
      checkInput('scenario 2', analysis.drag);
      checkFrames('scenario 2 navigation', analysis.navigation);
      if (analysis.drag.maxEngineLineDomUpdatesPerFrame > 1) {
        failures.push(
          `scenario 2: ${analysis.drag.maxEngineLineDomUpdatesPerFrame} engine-line DOM updates in one frame`,
        );
      }
      if (ENGINE_THREADS !== null && analysis.drag.engineThreads !== ENGINE_THREADS) {
        failures.push(
          `scenario 2: engine ran ${analysis.drag.engineThreads} threads, not the requested ${ENGINE_THREADS}`,
        );
      }
      if (GHOST_PREVIEWS && analysis.drag.ghostPreviewsShown === 0) {
        failures.push('scenario 2: no ghost previews were shown during the drag');
      }
      if (analysis.navigation.plyAtEnd !== analysis.navigation.plies || analysis.navigation.plyAfterReturn !== 0) {
        failures.push('scenario 2 navigation: did not land on the expected plies');
      }
    }

    if (idleRafCallbacksIn500Ms !== 0) {
      failures.push(`idle: ${idleRafCallbacksIn500Ms} rAF callbacks in 500 ms`);
    }
    if (startupInteractiveMs > 1500) {
      failures.push(`startup: ${startupInteractiveMs} ms > 1500 ms`);
    }

    report.failures = failures;
    report.budgetPassed = failures.length === 0;

    log('\n=== Afterplay Perf Report (perf:drag) ===');
    log(JSON.stringify(report, null, 2));

    if (!report.budgetPassed) {
      process.exitCode = 1;
    }
  } finally {
    await closeBrowser(browser);
    server?.kill();
  }
}

runPerfBenchmark()
  .catch((err) => {
    if (err instanceof PerfAbort) {
      logError(`[abort] ${err.message}`);
      process.exitCode = err.exitCode;
    } else {
      logError('Perf benchmark failed:', err);
      process.exitCode = 1;
    }
  })
  .finally(() => {
    log(`[run] finished with exit code ${process.exitCode ?? 0}; log: ${path.resolve(LOG_PATH)}`);
    // Exit explicitly: the 'exit' handler then confirms no child process is left behind
    process.exit(process.exitCode ?? 0);
  });
