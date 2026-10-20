import { expect, test } from '@playwright/test';

test.describe('Phase 2 — changing engine threads restarts the worker', () => {
  test('threads change mid-analysis: no crash, analysis resumes with the same position and MultiPV', async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const pageErrors: string[] = [];
    let crashed = false;
    page.on('pageerror', (err) => pageErrors.push(err.message));
    page.on('crash', () => {
      crashed = true;
    });

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/');
    await page.getByTestId('mode-tab-review').click();
    // Engine lines live in Review's Analysis tab
    await page.getByTestId('review-shell-tab-analysis').click();
    await page.getByTestId('select-multipv').selectOption('5');
    await page.evaluate(() =>
      window.__wizardChessAnalysis!.controller.setAnalysisDepth('infinite'),
    );
    await expect(page.getByTestId('engine-pv-move-5-0')).toBeVisible({ timeout: 20_000 });

    const before = await page.evaluate(() => window.__wizardChessPlay!.engine.getTelemetry());
    expect(before.variant).toBe('multi-threaded');
    expect(before.multipv).toBe(5);

    for (const threads of [2, before.threads]) {
      const elapsedMs = await page.evaluate(async (t) => {
        const t0 = performance.now();
        await window.__wizardChessPlay!.engine.configure({ threads: t });
        return performance.now() - t0;
      }, threads);
      expect(elapsedMs).toBeLessThan(10_000);

      // Analysis resumes on the new worker: the same 5 lines, for the same position, and
      // the search gets deep again
      const resumed = await page.waitForFunction(
        ({ fen }) => {
          const engine = window.__wizardChessPlay!.engine;
          const controller = window.__wizardChessAnalysis!.controller;
          const tel = engine.getTelemetry();
          const lines = controller.getLinesPanel().getFormattedLines();
          return tel.depth >= 10 && tel.multipv === 5 && lines.length === 5 &&
            controller.getAdapter().fen() === fen
            ? { threads: tel.threads, depth: tel.depth, multipv: tel.multipv, lines: lines.length }
            : null;
        },
        { fen: await page.evaluate(() => window.__wizardChessAnalysis!.controller.getAdapter().fen()) },
        { timeout: 30_000 },
      );
      const state = await resumed.jsonValue();
      expect(state!.threads).toBe(threads);
      expect(state!.multipv).toBe(5);
    }

    await expect(page.getByTestId('engine-pv-move-5-0')).toBeVisible();
    expect(crashed).toBe(false);
    expect(pageErrors).toEqual([]);
  });

  // The original failure: a second `setoption name Threads` sent to a worker that has just
  // booted (its thread pool still starting) hung the page and then crashed it. It happened
  // with an unchanged value too, and only before the engine had searched.
  for (const threads of [4, 2]) {
    test(`threads set to ${threads} right after the engine starts: no hang, analysis works`, async ({
      page,
    }) => {
      test.setTimeout(60_000);
      let crashed = false;
      page.on('crash', () => {
        crashed = true;
      });
      await page.goto('/');
      const result = await page.evaluate(async (t) => {
        const engine = window.__wizardChessPlay!.engine;
        const timeout = (label: string) =>
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error(`${label} hung for 20 s`)), 20_000),
          );
        await Promise.race([engine.configure({ threads: t }), timeout('configure')]);
        const analysis = await Promise.race([
          engine.analyze({ fen: 'startpos', depth: 10, multipv: 3, useCache: false }),
          timeout('analysis after configure'),
        ]);
        return {
          threads: engine.getThreads(),
          depth: analysis.depth,
          lines: analysis.lines.length,
        };
      }, threads);
      expect(result).toEqual({ threads, depth: 10, lines: 3 });
      expect(crashed).toBe(false);
    });
  }
});
