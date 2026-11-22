import { expect, test, type Page } from '@playwright/test';

// The engine lines panel writes a row's score text only when it differs from the text it last wrote. After the rows
// are cleared (the position changed) the text is empty, so the next score, even an identical one, has to be written.
//
// The panel here is the app's own class on a host of its own, so the live engine never feeds it: every update is sent
// by the test, and each step waits two animation frames (the panel flushes on the next frame).

const FEN_BLACK_TO_MOVE = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1';

interface TestLine {
  multipv: number;
  cp: number;
  pv: string[];
}

/** Black is ahead by about 6 pawns on line 1 and about 0.2 on line 2 (scores are from White's point of view). */
const BEST: TestLine = { multipv: 1, cp: -590, pv: ['e7e5', 'g1f3'] };
const SECOND: TestLine = { multipv: 2, cp: -20, pv: ['c7c5', 'g1f3'] };

async function openPanel(page: Page): Promise<void> {
  await page.goto('/');
  // The app's test hooks are set a moment after the page loads
  await page.waitForFunction(() => Boolean(window.__wizardChessAnalysis?.EngineLinesPanel));
  await page.evaluate(() => {
    const host = document.createElement('div');
    host.setAttribute('data-testid', 'cache-test-host');
    document.body.appendChild(host);
    const w = window as unknown as {
      __cachePanel: InstanceType<NonNullable<Window['__wizardChessAnalysis']>['EngineLinesPanel']>;
    };
    w.__cachePanel = new window.__wizardChessAnalysis!.EngineLinesPanel(host);
  });
}

/** Sends lines (or, with null, a clear) and waits until the panel has had its frame. */
async function send(page: Page, lines: TestLine[] | null): Promise<void> {
  await page.evaluate(
    async ({ lines: sent, fen }) => {
      const panel = (
        window as unknown as {
          __cachePanel: { updateLines: (...args: unknown[]) => void; clear: (fen: string) => void };
        }
      ).__cachePanel;
      if (sent === null) panel.clear(fen);
      else {
        panel.updateLines(
          fen,
          sent.map((l) => ({
            multipv: l.multipv,
            depth: 12,
            seldepth: 14,
            score: { type: 'cp', value: l.cp },
            scoreWhite: { type: 'cp', value: l.cp },
            evalCp: l.cp,
            nodes: 1000,
            nps: 1000,
            timeMs: 10,
            pv: l.pv,
          })),
        );
      }
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    },
    { lines, fen: FEN_BLACK_TO_MOVE },
  );
}

const evalOf = (page: Page, row: number) =>
  page.locator(`[data-testid="cache-test-host"] [data-testid="engine-line-eval-${row}"]`);
const rowOf = (page: Page, row: number) =>
  page.locator(`[data-testid="cache-test-host"] [data-testid="engine-line-row-${row}"]`);

test.describe('Phase 4 — engine lines: a score is written again after the rows were cleared', () => {
  test('a score sent again after the rows were cleared is shown again', async ({ page }) => {
    await openPanel(page);
    await send(page, [BEST]);
    await expect(evalOf(page, 1)).toHaveText('-5.90');
    await expect(evalOf(page, 1)).toHaveClass(/wc-engine-line-eval-black/);

    await send(page, null);
    await expect(evalOf(page, 1)).toHaveText('');
    await expect(rowOf(page, 1)).toHaveAttribute('data-empty', 'true');

    // The same line and the same score again: the text must come back
    await send(page, [BEST]);
    await expect(rowOf(page, 1)).toHaveAttribute('data-empty', 'false');
    await expect(evalOf(page, 1)).toHaveText('-5.90');
    await expect(evalOf(page, 1)).toHaveClass(/wc-engine-line-eval-black/);
  });

  test('a different score after a clear is shown', async ({ page }) => {
    await openPanel(page);
    await send(page, [BEST]);
    await expect(evalOf(page, 1)).toHaveText('-5.90');
    await send(page, null);
    await expect(evalOf(page, 1)).toHaveText('');
    await send(page, [{ ...BEST, cp: -480 }]);
    await expect(evalOf(page, 1)).toHaveText('-4.80');
    await expect(evalOf(page, 1)).toHaveClass(/wc-engine-line-eval-black/);
  });

  test('rows that disappear and come back with the same score show it again', async ({ page }) => {
    await openPanel(page);
    await send(page, [BEST, SECOND]);
    await expect(evalOf(page, 1)).toHaveText('-5.90');
    await expect(evalOf(page, 2)).toHaveText('-0.20');

    // An update with one line empties row 2 (the engine reported fewer lines)
    await send(page, [BEST]);
    await expect(rowOf(page, 2)).toHaveAttribute('data-empty', 'true');
    await expect(evalOf(page, 2)).toHaveText('');
    await expect(evalOf(page, 1)).toHaveText('-5.90');

    // Both lines again, row 2 with the score it had before
    await send(page, [BEST, SECOND]);
    await expect(rowOf(page, 2)).toHaveAttribute('data-empty', 'false');
    await expect(evalOf(page, 2)).toHaveText('-0.20');
    await expect(evalOf(page, 1)).toHaveText('-5.90');
  });
});
