import fs from 'node:fs';
import { expect, test } from '@playwright/test';
import { SHARED_STREAM_SEED, buildBotGoldenCases } from '../helpers/bot-golden-cases';

const golden = JSON.parse(fs.readFileSync('tests/fixtures/bot-selection-golden.json', 'utf8')) as {
  independent: string[];
  sharedStream: string[];
};

test.describe('Phase 3 — bot move selection in a worker', () => {
  test('the worker picks the golden move for all 860 cases, with per-case seeds and one shared seeded stream', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await page.goto('/');
    await expect(page.getByTestId('chess-board')).toBeVisible();

    const cases = buildBotGoldenCases();
    const result = await page.evaluate(
      async ({ cases, sharedSeed }) => {
        // Same PRNG as tests/helpers/bot-golden-cases.ts
        const mulberry32 = (seed: number) => {
          let a = seed >>> 0;
          return () => {
            a = (a + 0x6d2b79f5) >>> 0;
            let t = a;
            t = Math.imul(t ^ (t >>> 15), t | 1);
            t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
          };
        };
        const client = new window.__wizardChessEngine!.BotSelectionClient();
        const req = (c: (typeof cases)[number]) => ({
          fen: c.fen,
          lines: c.lines,
          ratingOrTier: c.rating,
          style: c.style,
        });

        // Long tasks while 1,720 selections run: there must be none on the main thread
        let longTasks = 0;
        const obs = new PerformanceObserver((l) => {
          longTasks += l.getEntries().filter((e) => e.duration > 50).length;
        });
        obs.observe({ entryTypes: ['longtask'] });

        const t0 = performance.now();
        // Independent seeds, issued all at once: the client must still serve them in order
        const independent = (await Promise.all(cases.map((c) => client.select(req(c), mulberry32(c.seed))))).map(
          (d) => d.uci,
        );
        const shared = mulberry32(sharedSeed);
        const sharedStream: string[] = [];
        for (const c of cases) {
          sharedStream.push((await client.select(req(c), shared)).uci);
        }
        const elapsedMs = performance.now() - t0;
        obs.disconnect();
        const stats = client.getStats();
        client.terminate();
        return { independent, sharedStream, stats, longTasks, elapsedMs };
      },
      { cases, sharedSeed: SHARED_STREAM_SEED },
    );

    console.log(`[bot-worker] 1720 selections in ${result.elapsedMs.toFixed(0)} ms, long tasks: ${result.longTasks}`);
    expect(result.independent).toEqual(golden.independent);
    expect(result.sharedStream).toEqual(golden.sharedStream);
    expect(result.stats).toEqual({ worker: 1720, inline: 0, workerActive: true });
    expect(result.longTasks).toBe(0);
  });

  test('the play-mode bot chooses its moves in the worker', async ({ page }) => {
    test.setTimeout(60_000);
    await page.goto('/');
    await expect(page.getByTestId('chess-board')).toBeVisible();
    await page.evaluate(() => window.__wizardChessPlay!.controller.setBotMoveDelayMs(5));
    await page.getByTestId('square-e2').click();
    await page.getByTestId('square-e4').click();
    await expect(page.getByTestId('move-ply-2')).not.toHaveText('', { timeout: 20_000 });
    const stats = await page.evaluate(() => window.__wizardChessPlay!.controller.getBotSelection().getStats());
    expect(stats.worker).toBeGreaterThanOrEqual(1);
    expect(stats.inline).toBe(0);
    expect(stats.workerActive).toBe(true);
  });
});
