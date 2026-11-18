import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';

// Review: "Show refutation" adds the stored line as a variation (as ever) and now plays it out on the board, one move at a
// time, ending on its last move. Any action of the user stops it and takes over; reduced motion jumps to the end; the
// transport buttons and arrow keys step back through the line afterwards. The game is the one phase5-review.spec.ts uses
// (White hangs the queen on move 3), reviewed live on Quick; every expected line is the review's own stored line.
const GAME = `[Event "Review sign check"]
[White "White"]
[Black "Black"]
[Result "0-1"]

1. e4 e5 2. Qh5 Nc6 3. Qxe5+ Nxe5 0-1`;
/** A folder OUTSIDE the repository for screenshots; with it unset nothing is saved. */
const LOOK_DIR = process.env.PHASE_LOOK_DIR ?? '';
/** A little under the app's step (600 ms), for timer jitter. */
const MIN_GAP_MS = 450;

async function look(page: Page, name: string): Promise<void> {
  if (LOOK_DIR === '') return;
  const dir = path.resolve(LOOK_DIR);
  if (!path.relative(process.cwd(), dir).startsWith('..'))
    throw new Error('PHASE_LOOK_DIR must be outside the repository');
  fs.mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: path.join(dir, `${test.info().project.name}-${name}.png`) });
}

interface Nav {
  id: string;
  uci: string;
  t: number;
}
type NavWindow = Window & { __navs?: Nav[] };

/** Opens Review, imports the game and reviews it; returns the blunder's id and its stored refutation. */
async function reviewed(page: Page): Promise<{ blunderId: string; refutation: string[] }> {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/');
  await page.getByTestId('mode-tab-review').click();
  await expect(page.getByTestId('review-panel')).toBeVisible();
  await page.evaluate((pgn) => window.__wizardChessAnalysis!.controller.importPgn(pgn), GAME);
  await page.getByTestId('btn-review-start').click();
  await expect(page.getByTestId('review-panel')).toHaveAttribute('data-state', 'done', { timeout: 60_000 });
  const blunder = await page.evaluate(() => {
    const m = window.__wizardChessReview!.panel.getReview()!.moves[4]!;
    return { blunderId: m.nodeId, refutation: m.refutationUci };
  });
  expect(blunder.refutation.length, 'the stored line has several moves').toBeGreaterThanOrEqual(3);
  return blunder;
}

/** Records every move the board is taken to, with the time. */
async function record(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as NavWindow;
    // One listener per page; each call starts a new list
    if (w.__navs === undefined) {
      window.__wizardChessAnalysis!.controller.onNavigate((n) =>
        w.__navs!.push({ id: n.id, uci: n.uci, t: performance.now() }),
      );
    }
    w.__navs = [];
  });
}
const navs = (page: Page) => page.evaluate(() => (window as NavWindow).__navs ?? []);
const current = (page: Page) =>
  page.evaluate(() => {
    const n = window.__wizardChessAnalysis!.controller.getGameTree().currentNode;
    return { id: n.id, uci: n.uci, parentId: n.parentId };
  });

/** The board marks the last move's squares: the move's target square. */
const lastTarget = (page: Page) => page.getByTestId('overlay-last-move-to').getAttribute('data-square');

async function select(page: Page, blunderId: string): Promise<void> {
  await page.evaluate((id) => window.__wizardChessAnalysis!.controller.goToNode(id), blunderId);
}

test.describe('Show refutation plays the line out', () => {
  test('the whole stored line plays on the board, one move at a time, ending on the last move', async ({ page }) => {
    test.setTimeout(150_000);
    const { blunderId, refutation } = await reviewed(page);
    const expected = refutation.slice(0, Math.min(8, refutation.length));
    await select(page, blunderId);
    await record(page);
    await page.getByTestId('btn-review-refutation').click();

    // The first move at once, as before
    expect((await navs(page)).map((n) => n.uci)).toEqual(expected.slice(0, 1));
    expect((await current(page)).parentId).toBe(blunderId);
    // Then the line grows by one move at a time until it is whole
    await expect.poll(async () => (await navs(page)).length, { timeout: 20_000 }).toBe(expected.length);
    const seen = await navs(page);
    expect(seen.map((n) => n.uci)).toEqual(expected);
    for (let i = 1; i < seen.length; i++) {
      expect(seen[i]!.t - seen[i - 1]!.t, `move ${i + 1} follows ${i}`).toBeGreaterThanOrEqual(MIN_GAP_MS);
    }
    // The board ends on the last move of the line, and stays there
    const last = expected[expected.length - 1]!;
    expect((await current(page)).id).toBe(seen[seen.length - 1]!.id);
    await expect.poll(() => lastTarget(page)).toBe(last.slice(2, 4));
    await page.waitForTimeout(1500);
    expect((await navs(page)).length).toBe(expected.length);
    await look(page, 'refutation-end');

    // The variation is in the tree whole, as ever
    const length = await page.evaluate((id) => {
      let n = window.__wizardChessAnalysis!.controller.getGameTree().getNode(id);
      let count = 0;
      while (n) {
        count++;
        n = n.children[0];
      }
      return count;
    }, seen[0]!.id);
    expect(length).toBe(expected.length);
  });

  test('the transport buttons and the arrow keys step back through the line afterwards', async ({ page }) => {
    test.setTimeout(150_000);
    const { blunderId, refutation } = await reviewed(page);
    const expected = refutation.slice(0, Math.min(8, refutation.length));
    await select(page, blunderId);
    await record(page);
    await page.getByTestId('btn-review-refutation').click();
    await expect.poll(async () => (await navs(page)).length, { timeout: 20_000 }).toBe(expected.length);
    const chain = (await navs(page)).map((n) => n.id);

    // Previous move (the button), back to the first move of the line
    for (let k = chain.length - 2; k >= 0; k--) {
      await page.getByTestId('btn-nav-prev').click();
      expect((await current(page)).id).toBe(chain[k]);
    }
    // Next move and the arrow keys go forward and back again along the same line
    await page.getByTestId('btn-nav-next').click();
    expect((await current(page)).id).toBe(chain[1]);
    await page.keyboard.press('ArrowLeft');
    expect((await current(page)).id).toBe(chain[0]);
    await page.keyboard.press('ArrowLeft');
    expect((await current(page)).id).toBe(blunderId);
  });

  test('any action of the user stops it, and no later move appears', async ({ page }) => {
    test.setTimeout(200_000);
    const { blunderId, refutation } = await reviewed(page);
    const expected = refutation.slice(0, Math.min(8, refutation.length));
    expect(expected.length).toBeGreaterThanOrEqual(3);

    const stopsAfter = async (act: () => Promise<void>, label: string, cleanup?: () => Promise<void>) => {
      await select(page, blunderId);
      await record(page);
      await page.getByTestId('btn-review-refutation').click();
      await expect.poll(async () => (await navs(page)).length, { timeout: 10_000 }).toBeGreaterThanOrEqual(2);
      await act();
      const count = (await navs(page)).length;
      // Longer than two steps of the line: a timer left behind would have shown a move by now
      await page.waitForTimeout(1600);
      expect((await navs(page)).length, `${label}: nothing more after the action`).toBe(count);
      expect(count, `${label}: stopped before the end`).toBeLessThan(expected.length + 2);
      await cleanup?.();
    };

    await stopsAfter(() => page.getByTestId('btn-nav-prev').click(), 'Previous move');
    await stopsAfter(() => page.keyboard.press('ArrowRight'), 'an arrow key');
    await stopsAfter(() => page.getByTestId('btn-coach-next').click(), 'another card button');
    await stopsAfter(() => page.getByTestId('btn-coach-prev').click(), 'the previous key moment');
    await stopsAfter(async () => {
      await page.getByTestId('mode-tab-play').click();
    }, 'leaving the screen');
    // Back on Review: still where the user left it, nothing played behind their back
    await page.getByTestId('mode-tab-review').click();
    const at = (await navs(page)).length;
    await page.waitForTimeout(1600);
    expect((await navs(page)).length).toBe(at);
  });

  test('a tapped move in the move list stops it too', async ({ page }) => {
    test.setTimeout(150_000);
    const { blunderId, refutation } = await reviewed(page);
    const expected = refutation.slice(0, Math.min(8, refutation.length));
    await select(page, blunderId);
    await record(page);
    await page.getByTestId('btn-review-refutation').click();
    await expect.poll(async () => (await navs(page)).length, { timeout: 10_000 }).toBeGreaterThanOrEqual(2);
    await page.getByTestId('review-shell-tab-moves').click();
    const move = page.locator('[data-testid^="tree-node-"]').first();
    await move.click();
    const count = (await navs(page)).length;
    await page.waitForTimeout(1600);
    expect((await navs(page)).length).toBe(count);
    expect(count).toBeLessThan(expected.length + 2);
  });

  test('with reduced motion it jumps to the end of the line', async ({ page }) => {
    test.setTimeout(150_000);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const { blunderId, refutation } = await reviewed(page);
    const expected = refutation.slice(0, Math.min(8, refutation.length));
    await select(page, blunderId);
    await record(page);
    await page.getByTestId('btn-review-refutation').click();
    const seen = await navs(page);
    expect(seen.map((n) => n.uci)).toEqual(expected.slice(-1));
    await expect.poll(() => lastTarget(page)).toBe(expected[expected.length - 1]!.slice(2, 4));
    await page.waitForTimeout(1500);
    expect((await navs(page)).length).toBe(1);
    // The line is in the tree whole, and the buttons step back through it
    await page.getByTestId('btn-nav-prev').click();
    expect((await current(page)).uci).toBe(expected[expected.length - 2]);
  });

  test('layout at 375x667, 390x844 and 1280x720: nothing cut off or covered while it plays and after', async ({
    page,
  }) => {
    test.setTimeout(200_000);
    const { blunderId, refutation } = await reviewed(page);
    const expected = refutation.slice(0, Math.min(8, refutation.length));
    for (const size of [
      { width: 375, height: 667 },
      { width: 390, height: 844 },
      { width: 1280, height: 720 },
    ]) {
      await page.setViewportSize(size);
      await select(page, blunderId);
      await record(page);
      await page.getByTestId('btn-review-refutation').click();
      await expect.poll(async () => (await navs(page)).length, { timeout: 10_000 }).toBeGreaterThanOrEqual(2);
      for (const phase of ['playing', 'done']) {
        if (phase === 'done')
          await expect.poll(async () => (await navs(page)).length, { timeout: 20_000 }).toBe(expected.length);
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth),
          `${size.width}x${size.height} ${phase}: no sideways scroll`,
        ).toBeLessThanOrEqual(0);
        const m = await page.evaluate(() => {
          const ids = ['btn-review-refutation', 'btn-review-retry', 'review-card-text', 'btn-nav-prev', 'btn-nav-next'];
          return ids.map((id) => {
            const el = document.querySelector<HTMLElement>(`[data-testid="${id}"]`)!;
            el.scrollIntoView({ block: 'center' });
            const r = el.getBoundingClientRect();
            const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
            return {
              id,
              left: r.left,
              right: r.right,
              clipped: el.scrollWidth > el.clientWidth + 1,
              onTop: hit !== null && (hit === el || el.contains(hit)),
            };
          });
        });
        for (const b of m) {
          expect(b.left, `${size.width} ${phase} ${b.id}`).toBeGreaterThanOrEqual(0);
          expect(b.right, `${size.width} ${phase} ${b.id}`).toBeLessThanOrEqual(size.width);
          expect(b.clipped, `${size.width} ${phase} ${b.id} cut off`).toBe(false);
          expect(b.onTop, `${size.width} ${phase} ${b.id} covered`).toBe(true);
        }
        if (phase === 'playing') await look(page, `refutation-${size.width}x${size.height}`);
      }
    }
  });
});
