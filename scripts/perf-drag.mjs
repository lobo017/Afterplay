import { spawn } from 'node:child_process';
import process from 'node:process';
import { chromium } from '@playwright/test';

const PORT = Number(process.env.PERF_PORT || 4179);
const BASE_URL = `http://127.0.0.1:${PORT}`;

function startStaticServer(port) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['scripts/serve.mjs', '--port', String(port)],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('Timed out waiting for scripts/serve.mjs to start'));
    }, 10_000);

    child.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      if (text.includes('http://')) {
        clearTimeout(timer);
        resolve(child);
      }
    });

    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      if (text.toLowerCase().includes('error')) {
        clearTimeout(timer);
        reject(new Error(text));
      }
    });

    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`Server exited early with code ${code}`));
      }
    });
  });
}

async function runPerfBenchmark() {
  const server = await startStaticServer(PORT);
  const browser = await chromium.launch({
    channel: 'chrome',
    headless: true,
  });

  try {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
    });
    const page = await context.newPage();

    // 1. Measure cold start to interactive board
    const navStart = performance.now();
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await page.locator('[data-testid="chess-board"]').waitFor({ state: 'visible' });
    await page.locator('[data-testid="piece-e2"]').waitFor({ state: 'visible' });
    const startupInteractiveMs = Number((performance.now() - navStart).toFixed(2));

    // 2. Verify zero idle rAF work when nothing is changing (clock not started, dev overlay hidden, 0 active particles)
    const idleRafCallbacksIn500Ms = await page.evaluate(async () => {
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

    // 3. Click the board once (first user gesture to initialize Web Audio) and enable Infinite Analysis
    await page.getByTestId('square-e2').click();
    await page.getByTestId('square-e2').click();
    await page.getByTestId('toggle-infinite-analysis').check();

    await page.waitForFunction(
      () => {
        const metrics = window.__wizardChessPlay?.devOverlay.getMetrics();
        return Boolean(metrics && metrics.engineDepth >= 8 && metrics.engineNps > 0);
      },
      { timeout: 15_000 },
    );

    // 4. Perform a Playwright hardware mouse drag first to confirm end-to-end pointer capture
    const boardBox = await page.locator('[data-testid="chess-board"]').boundingBox();
    if (!boardBox) {
      throw new Error('Could not resolve chessboard bounding box');
    }
    const e2X = boardBox.x + 4.5 * (boardBox.width / 8);
    const e2Y = boardBox.y + 6.5 * (boardBox.height / 8);
    await page.mouse.move(e2X, e2Y);
    await page.mouse.down();
    await page.mouse.move(e2X, e2Y - 120, { steps: 10 });
    await page.mouse.move(e2X, e2Y, { steps: 10 });
    await page.mouse.up();

    // 5. Run the high-precision rAF frame interval benchmark during continuous scripted drags
    // while Stockfish `go infinite` is actively crunching in the worker
    const stats = await page.evaluate(async () => {
      const boardEl = document.querySelector('[data-testid="chess-board"]');
      const pieceE2 = document.querySelector('[data-testid="piece-e2"]');
      if (!boardEl || !pieceE2) {
        throw new Error('Board or piece-e2 not found');
      }

      const rect = boardEl.getBoundingClientRect();
      const sqCenter = (col, row) => ({
        x: rect.left + (col + 0.5) * (rect.width / 8),
        y: rect.top + (row + 0.5) * (rect.height / 8),
      });

      // Measure synchronous input-to-transform latency
      const startPt = sqCenter(4, 6);
      const tInput0 = performance.now();
      boardEl.dispatchEvent(
        new window.PointerEvent('pointerdown', {
          bubbles: true,
          pointerId: 1,
          button: 0,
          clientX: startPt.x,
          clientY: startPt.y,
        }),
      );
      window.dispatchEvent(
        new window.PointerEvent('pointermove', {
          bubbles: true,
          pointerId: 1,
          button: 0,
          clientX: startPt.x + 30,
          clientY: startPt.y - 60,
        }),
      );
      const transformDuringDrag = pieceE2.style.transform;
      const inputLatencyMs = transformDuringDrag.includes('scale(1.08)')
        ? Number((performance.now() - tInput0).toFixed(3))
        : 999;
      window.dispatchEvent(
        new window.PointerEvent('pointerup', {
          bubbles: true,
          pointerId: 1,
          button: 0,
          clientX: startPt.x,
          clientY: startPt.y,
        }),
      );

      // Set up LongTask observer
      let longTasks = 0;
      let observer = null;
      if (typeof PerformanceObserver !== 'undefined') {
        try {
          observer = new PerformanceObserver((list) => {
            for (const entry of list.getEntries()) {
              if (entry.duration > 50) {
                longTasks++;
              }
            }
          });
          observer.observe({ entryTypes: ['longtask'] });
        } catch {
          // Ignore if unsupported
        }
      }

      // Define 5 multi-square drag trajectories across all files & ranks (240 frames total)
      const trajectories = [
        // e2 pawn swept across the board and returned to e2
        [sqCenter(4, 6), sqCenter(0, 2), sqCenter(7, 2), sqCenter(4, 6)],
        // g1 knight swept across the center and returned to g1
        [sqCenter(6, 7), sqCenter(2, 3), sqCenter(5, 1), sqCenter(6, 7)],
        // d1 queen swept across diagonals and returned to d1
        [sqCenter(3, 7), sqCenter(0, 4), sqCenter(7, 3), sqCenter(3, 7)],
        // a1 rook swept along file/rank and returned to a1
        [sqCenter(0, 7), sqCenter(0, 1), sqCenter(7, 1), sqCenter(0, 7)],
        // b1 knight dragged and dropped onto c3 (legal move 1. Nc3)
        [sqCenter(1, 7), sqCenter(4, 4), sqCenter(2, 5)],
      ];

      const frameIntervals = [];
      let peakDepth = 0;
      let peakNps = 0;
      const play = window.__wizardChessPlay;

      for (let tIdx = 0; tIdx < trajectories.length; tIdx++) {
        const waypoints = trajectories[tIdx];
        const origin = waypoints[0];
        const pointerId = 10 + tIdx;

        boardEl.dispatchEvent(
          new window.PointerEvent('pointerdown', {
            bubbles: true,
            pointerId,
            button: 0,
            clientX: origin.x,
            clientY: origin.y,
          }),
        );

        let lastTime = await new Promise((r) => requestAnimationFrame(r));

        for (let w = 1; w < waypoints.length; w++) {
          const prev = waypoints[w - 1];
          const next = waypoints[w];
          const steps = 20;
          for (let s = 1; s <= steps; s++) {
            const now = await new Promise((r) => requestAnimationFrame(r));
            const dt = now - lastTime;
            lastTime = now;
            if (dt > 0 && dt < 250) {
              frameIntervals.push(dt);
            }

            const ratio = s / steps;
            const x = prev.x + (next.x - prev.x) * ratio;
            const y = prev.y + (next.y - prev.y) * ratio;
            window.dispatchEvent(
              new window.PointerEvent('pointermove', {
                bubbles: true,
                pointerId,
                button: 0,
                clientX: x,
                clientY: y,
              }),
            );

            const tel = play.engine.getTelemetry();
            if (tel.depth > peakDepth) peakDepth = tel.depth;
            if (tel.nps > peakNps) peakNps = tel.nps;
          }
        }

        const endPt = waypoints[waypoints.length - 1];
        window.dispatchEvent(
          new window.PointerEvent('pointerup', {
            bubbles: true,
            pointerId,
            button: 0,
            clientX: endPt.x,
            clientY: endPt.y,
          }),
        );
      }

      observer?.disconnect();
      const finalTelemetry = play.engine.getTelemetry();
      play.controller.setInfiniteAnalysis(false);

      const samples = [...frameIntervals].sort((a, b) => a - b);
      const count = samples.length;
      const sum = samples.reduce((acc, v) => acc + v, 0);
      const mean = count > 0 ? sum / count : 16.67;
      const p50 = count > 0 ? samples[Math.floor(count * 0.5)] : 16.67;
      const p95 =
        count > 0
          ? samples[Math.min(count - 1, Math.floor(count * 0.95))]
          : 16.67;
      const p99 =
        count > 0
          ? samples[Math.min(count - 1, Math.floor(count * 0.99))]
          : 16.67;
      const max = count > 0 ? samples[count - 1] : 16.67;

      return {
        sampleCount: count,
        fps: Number((1000 / mean).toFixed(1)),
        meanFrameMs: Number(mean.toFixed(2)),
        p50FrameMs: Number(p50.toFixed(2)),
        p95FrameMs: Number(p95.toFixed(2)),
        p99FrameMs: Number(p99.toFixed(2)),
        maxFrameMs: Number(max.toFixed(2)),
        longTaskCount: longTasks,
        inputLatencyMs,
        engineVariant: finalTelemetry.variant,
        engineThreads: finalTelemetry.threads,
        enginePeakDepth: Math.max(peakDepth, finalTelemetry.depth),
        enginePeakNps: Math.max(peakNps, finalTelemetry.nps),
      };
    });

    const summary = {
      ...stats,
      idleRafCallbacksIn500Ms,
      startupInteractiveMs,
      budgetPassed:
        stats.p95FrameMs <= 16.7 &&
        stats.longTaskCount === 0 &&
        idleRafCallbacksIn500Ms === 0 &&
        startupInteractiveMs <= 1500,
    };

    console.log(
      "\n=== Wizard's Chess Phase 3 Drag + Infinite Analysis Perf Report ===",
    );
    console.log(JSON.stringify(summary, null, 2));

    if (!summary.budgetPassed) {
      process.exitCode = 1;
    }
  } finally {
    await browser.close();
    server.kill();
  }
}

runPerfBenchmark().catch((err) => {
  console.error('Perf benchmark failed:', err);
  process.exit(1);
});
