// Memory budget (spec): no growth across 50 consecutive games, checked with a heap snapshot.
//
// Plays N games against the bot in the page (a few moves each, then resign, so every game goes through
// the whole start → play → game over → save-to-library path; each saved game is then deleted again so the
// Games list stays at steady state: its rows are data, not a leak), and after every 5th game forces garbage
// collection and records the JS heap, DOM nodes, event listeners and workers. Heap snapshots taken after
// the 5th and the last game are compared object class by class, and detached DOM nodes are counted.
//
//   npm run perf:memory            (PERF_MEMORY_GAMES=50 by default, PERF_PORT=4181)
//
// Pass: after the first 10 games (caches and JIT settled) the post-GC heap grows by at most
// MAX_GROWTH_PER_GAME_KB per game on average; reachable DOM nodes (heap snapshots) and listeners by at most
// MAX_DOM_GROWTH; the worker count is constant and no detached DOM nodes accumulate (the hidden screens' roots are detached by design: a constant ~260).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { chromium } from '@playwright/test';
import { formatGb, formatProcesses, freeMemoryBytes, installCleanup, killAllChildTrees } from './lib/process-guard.mjs';
import { browserLaunchOptions } from './lib/browser.mjs';

const PORT = Number(process.env.PERF_PORT || 4181);
const BASE_URL = `http://127.0.0.1:${PORT}`;
const GAMES = Number(process.env.PERF_MEMORY_GAMES || 50);
const CHECK_EVERY = 5;
const SETTLE_GAMES = 10;
const MIN_FREE_MEMORY_BYTES = 2 * 1024 ** 3;
const MAX_RUN_MS = Number(process.env.PERF_MAX_RUN_MS) || 20 * 60 * 1000;
const MAX_GROWTH_PER_GAME_KB = 25;
const MAX_DOM_GROWTH = 60;

const LOG_DIR = path.join('test-results', 'perf-logs');
fs.mkdirSync(LOG_DIR, { recursive: true });
const LOG_PATH = path.join(LOG_DIR, `${new Date().toISOString().replace(/[:.]/g, '-')}_memory_pid${process.pid}.log`);
const log = (...parts) => {
  const text = `${parts.join(' ')}\n`;
  process.stdout.write(text);
  fs.appendFileSync(LOG_PATH, text);
};
const logError = (...parts) => {
  const text = `${parts.join(' ')}\n`;
  process.stderr.write(text);
  fs.appendFileSync(LOG_PATH, text);
};

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

/** Plays one game in the page: a few moves against the bot, then resigns. Returns the plies played. */
async function playGameInPage({ moves }) {
  const play = window.__wizardChessPlay;
  const controller = play.controller;
  controller.setBotMoveDelayMs(5);
  controller.startNewGame({ playerColor: 'w' });
  const boardEl = document.querySelector('[data-testid="play-layout"] [data-testid="chess-board"]');
  const center = (square) => {
    const rect = boardEl.getBoundingClientRect();
    const col = 'abcdefgh'.indexOf(square[0]);
    const row = 8 - Number(square[1]);
    return { x: rect.left + (col + 0.5) * (rect.width / 8), y: rect.top + (row + 0.5) * (rect.height / 8) };
  };
  const fire = (type, target, pt) =>
    target.dispatchEvent(
      new window.PointerEvent(type, {
        bubbles: true,
        pointerId: 1,
        button: 0,
        buttons: type === 'pointerup' ? 0 : 1,
        clientX: pt.x,
        clientY: pt.y,
      }),
    );
  const click = (square) => {
    const pt = center(square);
    fire('pointerdown', boardEl, pt);
    fire('pointerup', window, pt);
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let i = 0; i < moves; i++) {
    const adapter = controller.getAdapter();
    if (controller.isGameOver() || adapter.isGameOver()) break;
    // The player's move: a random legal one that does not promote (no picker in the way)
    const options = adapter.verboseMoves().filter((m) => !m.promotion);
    const pick = options[Math.floor(Math.random() * options.length)];
    const plyBefore = controller.getGameTree().getMainLine().length;
    click(pick.from);
    click(pick.to);
    const deadline = performance.now() + 15_000;
    // wait for my move and the bot's reply
    while (performance.now() < deadline) {
      const adapterNow = controller.getAdapter();
      if (controller.isGameOver() || adapterNow.isGameOver()) break;
      const plies = controller.getGameTree().getMainLine().length;
      if (plies >= plyBefore + 2 && adapterNow.turn() === 'w') break;
      await sleep(10);
    }
  }
  const plies = controller.getGameTree().getMainLine().length;
  controller.resign();
  return plies;
}

/** Waits until the finished game is in the library, deletes the library's games again and says how many it saw. */
async function settleLibrary() {
  const lib = window.__wizardChessLibrary.library;
  const deadline = performance.now() + 8000;
  let games = await lib.list();
  while (games.length === 0 && performance.now() < deadline) {
    await new Promise((r) => setTimeout(r, 20));
    games = await lib.list();
  }
  await lib.deleteGames(games.map((g) => g.id));
  return games.length;
}

async function collect(cdp, page) {
  for (let i = 0; i < 3; i++) {
    await cdp.send('HeapProfiler.collectGarbage');
    await new Promise((r) => setTimeout(r, 150));
  }
  const heap = await cdp.send('Runtime.getHeapUsage');
  const dom = await cdp.send('Memory.getDOMCounters');
  return {
    heapMB: Number((heap.usedSize / 1024 ** 2).toFixed(2)),
    domNodes: dom.nodes,
    listeners: dom.jsEventListeners,
    documents: dom.documents,
    workers: page.workers().length,
  };
}

/** Takes a heap snapshot and sums it up per object class (count and bytes), plus the detached DOM nodes. */
async function snapshotSummary(cdp) {
  const chunks = [];
  const onChunk = (e) => chunks.push(e.chunk);
  cdp.on('HeapProfiler.addHeapSnapshotChunk', onChunk);
  await cdp.send('HeapProfiler.collectGarbage');
  await cdp.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false, captureNumericValue: false });
  cdp.off('HeapProfiler.addHeapSnapshotChunk', onChunk);
  const snap = JSON.parse(chunks.join(''));
  chunks.length = 0;
  const { node_fields: fields, node_types: types } = snap.snapshot.meta;
  const stride = fields.length;
  const iType = fields.indexOf('type');
  const iName = fields.indexOf('name');
  const iSize = fields.indexOf('self_size');
  const iDetached = fields.indexOf('detachedness');
  const typeNames = types[0];
  const by = new Map();
  let detachedNodes = 0;
  let domReachable = 0;
  let total = 0;
  for (let i = 0; i < snap.nodes.length; i += stride) {
    const type = typeNames[snap.nodes[i + iType]];
    const rawName = snap.strings[snap.nodes[i + iName]];
    const name =
      type === 'string' || type === 'concatenated string' || type === 'number'
        ? '(strings)'
        : rawName.length > 60
          ? `${rawName.slice(0, 60)}…`
          : rawName;
    const size = snap.nodes[i + iSize];
    total += size;
    if (type === 'native' && (rawName.startsWith('<') || rawName === 'Text' || rawName === 'Comment')) domReachable++;
    const key = `${type}:${name}`;
    const row = by.get(key) ?? { count: 0, bytes: 0 };
    row.count++;
    row.bytes += size;
    by.set(key, row);
    if (iDetached >= 0 && snap.nodes[i + iDetached] === 2) detachedNodes++;
  }
  return {
    by,
    detachedNodes,
    domReachable,
    totalMB: Number((total / 1024 ** 2).toFixed(2)),
    nodeCount: snap.nodes.length / stride,
  };
}

function slopeKbPerGame(points) {
  // least squares over (game, heapMB)
  const n = points.length;
  const mx = points.reduce((a, p) => a + p.game, 0) / n;
  const my = points.reduce((a, p) => a + p.heapMB, 0) / n;
  let num = 0;
  let den = 0;
  for (const p of points) {
    num += (p.game - mx) * (p.heapMB - my);
    den += (p.game - mx) ** 2;
  }
  return den === 0 ? 0 : (num / den) * 1024;
}

async function run() {
  log(
    `[run] perf:memory, ${GAMES} games, node ${process.version}, ${os.cpus().length} CPUs, log ${path.resolve(LOG_PATH)}`,
  );
  const free = freeMemoryBytes();
  log(`[memory] start: ${formatGb(free)} free of ${formatGb(os.totalmem())}`);
  if (free < MIN_FREE_MEMORY_BYTES) {
    throw new PerfAbort(
      `Only ${formatGb(free)} of memory is free; perf:memory needs at least ${formatGb(MIN_FREE_MEMORY_BYTES)}.`,
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
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' });
    const page = await context.newPage();
    page.on('pageerror', (err) => logError('[page error]', err.message));
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await page.locator('[data-testid="chess-board"]').waitFor({ state: 'visible' });
    await page.waitForFunction(() => window.__wizardChessPlay?.controller.getAudio().isInitialized(), undefined, {
      timeout: 10_000,
    });
    const cdp = await context.newCDPSession(page);
    await cdp.send('HeapProfiler.enable');

    const points = [];
    let saved = 0;
    let snapA = null;
    let snapB = null;
    const started = Date.now();
    for (let game = 1; game <= GAMES; game++) {
      const plies = await page.evaluate(playGameInPage, { moves: 6 });
      if (plies < 2) throw new Error(`game ${game}: only ${plies} ply played`);
      // The finished game must reach the library (the save path is part of what is measured); then it is deleted
      // again, so the Games list stays at steady state and any growth below is a leak, not the library growing
      saved += await page.evaluate(settleLibrary);
      if (game % CHECK_EVERY === 0 || game === GAMES) {
        const m = await collect(cdp, page);
        points.push({ game, ...m });
        log(
          `[game ${String(game).padStart(2)}] heap ${m.heapMB} MB, DOM nodes ${m.domNodes}, listeners ${m.listeners}, documents ${m.documents}, workers ${m.workers}  (${((Date.now() - started) / 1000).toFixed(0)} s)`,
        );
        if (game === CHECK_EVERY) snapA = await snapshotSummary(cdp);
      }
    }
    snapB = await snapshotSummary(cdp);

    // ---- verdict
    const settled = points.filter((p) => p.game >= SETTLE_GAMES);
    const first = settled[0];
    const last = settled[settled.length - 1];
    const slope = slopeKbPerGame(settled);
    const heapGrowthMB = Number((last.heapMB - first.heapMB).toFixed(2));
    const domGrowth = last.domNodes - first.domNodes;
    // Reachable DOM nodes come from the heap snapshots (nothing waiting to be swept, unlike the DOM counter)
    const reachableGrowth = snapB.domReachable - snapA.domReachable;
    const listenerGrowth = last.listeners - first.listeners;
    const failures = [];
    if (slope > MAX_GROWTH_PER_GAME_KB)
      failures.push(`heap grows ${slope.toFixed(1)} KB per game (limit ${MAX_GROWTH_PER_GAME_KB})`);
    if (reachableGrowth > MAX_DOM_GROWTH)
      failures.push(`reachable DOM nodes grew by ${reachableGrowth} between the snapshots (limit ${MAX_DOM_GROWTH})`);
    if (listenerGrowth > MAX_DOM_GROWTH)
      failures.push(`event listeners grew by ${listenerGrowth} (limit ${MAX_DOM_GROWTH})`);
    if (new Set(points.map((p) => p.workers)).size !== 1)
      failures.push(`the number of workers changed: ${points.map((p) => p.workers).join(', ')}`);
    if (last.documents !== first.documents) failures.push(`documents ${first.documents} → ${last.documents}`);
    if (snapB.detachedNodes > snapA.detachedNodes + 20)
      failures.push(`detached DOM nodes ${snapA.detachedNodes} → ${snapB.detachedNodes}`);
    if (saved !== GAMES) failures.push(`only ${saved} of ${GAMES} games reached the library`);

    const growth = [...snapB.by.entries()]
      .map(([k, v]) => ({
        k,
        dCount: v.count - (snapA.by.get(k)?.count ?? 0),
        dKB: (v.bytes - (snapA.by.get(k)?.bytes ?? 0)) / 1024,
      }))
      .sort((a, b) => b.dKB - a.dKB)
      .slice(0, 10);
    log('\n=== Memory report (perf:memory) ===');
    log(
      JSON.stringify(
        {
          games: GAMES,
          savedToLibrary: saved,
          checkpoints: points,
          settledFromGame: SETTLE_GAMES,
          heapSlopeKbPerGame: Number(slope.toFixed(1)),
          heapGrowthMB,
          domCounterGrowth: domGrowth,
          reachableDomGrowth: reachableGrowth,
          listenerGrowth,
        },
        null,
        1,
      ),
    );
    log(
      `heap snapshot after game ${CHECK_EVERY}: ${snapA.totalMB} MB in ${snapA.nodeCount} objects, ${snapA.detachedNodes} detached DOM nodes`,
    );
    log(
      `heap snapshot after game ${GAMES}: ${snapB.totalMB} MB in ${snapB.nodeCount} objects, ${snapB.detachedNodes} detached DOM nodes`,
    );
    log('largest growth by object class between the two snapshots (count, KB):');
    for (const g of growth) log(`  ${String(g.dCount).padStart(7)} ${g.dKB.toFixed(0).padStart(7)} KB  ${g.k}`);
    log(`failures: ${JSON.stringify(failures)}`);
    log(failures.length === 0 ? 'budgetPassed: true' : 'budgetPassed: false');
    if (failures.length > 0) process.exitCode = 1;
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
      logError('perf:memory failed:', err?.stack ?? err);
      process.exitCode = 1;
    }
  })
  .finally(() => {
    log(`[run] finished with exit code ${process.exitCode ?? 0}`);
    process.exit(process.exitCode ?? 0);
  });
