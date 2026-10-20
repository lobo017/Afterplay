import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import {
  startLayoutShiftRecorder,
  stopLayoutShiftRecorder,
  summarizeShiftSources,
} from './helpers/layout-shift';

// Phase 6b stage 3: Review. The analysis board and the game review in one place: free
// analysis one click away (New board, Edit position, Load FEN / PGN), the Review / Analysis /
// Moves tabs, and the coach card that walks through the key moments.
const SCREENSHOT_DIR = path.join('test-results', 'phase6b-screens');
const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const ENDGAME_FEN = '8/8/4k3/8/8/4K3/4P3/8 w - - 0 1';
const SHORT_PGN = `[Event "Study"]
[White "A"]
[Black "B"]

1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 *`;

async function openReview(page: Page, width = 1440, height = 900): Promise<void> {
  await page.setViewportSize({ width, height });
  await page.goto('/');
  await page.getByTestId('mode-tab-review').click();
  await expect(page.getByTestId('analysis-layout')).toBeVisible();
}

const fen = (page: Page) => page.evaluate(() => window.__wizardChessAnalysis!.controller.getAdapter().fen());
const tab = (page: Page) => page.evaluate(() => window.__wizardChessAnalysis!.controller.getTab());
const node = (page: Page) =>
  page.evaluate(() => {
    const n = window.__wizardChessAnalysis!.controller.getGameTree().currentNode;
    return { id: n.id, ply: n.ply, san: n.san };
  });

async function reviewSample(page: Page): Promise<Array<{ ply: number; nodeId: string }>> {
  await page.getByTestId('select-review-preset').selectOption('quick');
  await page.getByTestId('btn-review-sample').click();
  await expect(page.getByTestId('review-panel')).toHaveAttribute('data-state', 'done', { timeout: 120_000 });
  return page.evaluate(() =>
    [...window.__wizardChessReview!.panel.getReview()!.keyMoments]
      .map((k) => ({ ply: k.ply, nodeId: k.nodeId }))
      .sort((a, b) => a.ply - b.ply),
  );
}

test.describe('Phase 6b — Review', () => {
  test('Review opens on its Review tab; the tabs switch by click and arrow keys', async ({ page }) => {
    await openReview(page);
    await expect(page.getByTestId('review-shell-tab-review')).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByTestId('review-panel')).toBeVisible();
    await expect(page.getByTestId('review-intro')).toBeVisible();
    await expect(page.getByTestId('btn-review-start')).toHaveText('Start review');

    await page.getByTestId('review-shell-tab-analysis').click();
    await expect(page.getByTestId('engine-lines-panel')).toBeVisible();
    await expect(page.getByTestId('review-panel')).toBeHidden();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByTestId('review-shell-tab-moves')).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByTestId('analysis-move-tree')).toBeVisible();
    // Arrow keys on a tab move between tabs, not through the game
    expect((await node(page)).ply).toBe(0);
    await page.keyboard.press('ArrowRight');
    await expect(page.getByTestId('review-shell-tab-review')).toHaveAttribute('aria-selected', 'true');
  });

  test('free analysis is one click away: New board, Edit position, Load FEN / PGN', async ({ page }) => {
    await openReview(page);
    // A game on the board first
    await page.evaluate((pgn) => window.__wizardChessAnalysis!.controller.importPgn(pgn), SHORT_PGN);
    expect(await page.evaluate(() => window.__wizardChessAnalysis!.controller.getGameTree().getMainLine().length)).toBe(6);

    // New board: the start position, no moves, the engine lines in view
    await page.getByTestId('btn-reset-analysis').click();
    expect(await fen(page)).toBe(START_FEN);
    expect(await page.evaluate(() => window.__wizardChessAnalysis!.controller.getGameTree().getMainLine().length)).toBe(0);
    expect(await tab(page)).toBe('analysis');
    await expect(page.getByTestId('engine-lines-panel')).toBeVisible();

    // Edit position: the editor takes the panel's place; Done brings the tabs back
    await page.getByTestId('btn-toggle-editor').click();
    await expect(page.getByTestId('review-editor-view')).toBeVisible();
    await expect(page.getByTestId('review-tabs-view')).toBeHidden();
    await expect(page.getByTestId('position-editor-mount')).toBeVisible();
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'desktop-review-editor.png') });
    await page.getByTestId('btn-editor-done').click();
    await expect(page.getByTestId('review-tabs-view')).toBeVisible();
    await expect(page.getByTestId('review-editor-view')).toBeHidden();

    // Load: a FEN is a position (Analysis tab)…
    await page.getByTestId('btn-load-pgn').click();
    const sheet = page.getByTestId('pgn-sheet');
    await expect(sheet).toBeVisible();
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'desktop-review-load.png') });
    await page.getByTestId('textarea-pgn').fill(ENDGAME_FEN);
    await page.getByTestId('btn-import-pgn').click();
    await expect(sheet).toBeHidden();
    expect(await fen(page)).toBe(ENDGAME_FEN);
    expect(await tab(page)).toBe('analysis');

    // …a PGN is a game (Review tab)
    await page.getByTestId('btn-load-pgn').click();
    await page.getByTestId('textarea-pgn').fill(SHORT_PGN);
    await page.getByTestId('btn-import-pgn').click();
    await expect(sheet).toBeHidden();
    expect(await page.evaluate(() => window.__wizardChessAnalysis!.controller.getGameTree().getMainLine().length)).toBe(6);
    expect(await tab(page)).toBe('review');

    // Nonsense: an error, and the sheet stays open with the text
    await page.getByTestId('btn-load-pgn').click();
    await page.getByTestId('textarea-pgn').fill('1. e4 e5 2. Qxx9 ???');
    await page.getByTestId('btn-import-pgn').click();
    await expect(sheet).toBeVisible();
    await expect(page.getByTestId('pgn-status')).toHaveAttribute('data-status', 'error');
    await page.keyboard.press('Escape');
    await expect(sheet).toBeHidden();
    await expect(page.getByTestId('btn-load-pgn')).toBeFocused();
  });

  test('the coach card walks through the key moments, one at a time, with no layout shift', async ({ page }) => {
    test.setTimeout(150_000);
    await openReview(page);
    const moments = await reviewSample(page);
    expect(moments.length).toBeGreaterThanOrEqual(3);
    await expect(page.getByTestId('review-intro')).toBeHidden();
    await expect(page.getByTestId('btn-review-start')).toHaveText('Review again');

    await page.evaluate(() => window.__wizardChessAnalysis!.controller.goToStart());
    const label = page.getByTestId('review-coach-label');
    await expect(label).toHaveText(`${moments.length} key moments`);
    await expect(page.getByTestId('coach-next-label')).toHaveText('First moment');

    await startLayoutShiftRecorder(page);
    for (let i = 0; i < moments.length; i++) {
      await page.getByTestId('btn-coach-next').click();
      expect((await node(page)).id).toBe(moments[i]!.nodeId);
      await expect(label).toHaveText(`Key moment ${i + 1} of ${moments.length}`);
      await expect(page.getByTestId(`review-moment-${moments[i]!.ply}`)).toHaveAttribute('aria-current', 'step');
      await expect(page.getByTestId('coach-next-label')).toHaveText('Next moment');
      // The board shows the move's class on its square
      await expect(page.getByTestId('analysis-layout').getByTestId('board-badge')).toBeVisible();
    }
    // Past the last: back to the first; Previous wraps the other way
    await page.getByTestId('btn-coach-next').click();
    expect((await node(page)).id).toBe(moments[0]!.nodeId);
    await page.getByTestId('btn-coach-prev').click();
    expect((await node(page)).id).toBe(moments[moments.length - 1]!.nodeId);
    const shifts = await stopLayoutShiftRecorder(page);
    const summary = summarizeShiftSources(shifts);
    for (const s of summary) console.log(`[layout-shift] ${s.count}× ${s.node}`);
    expect(summary).toEqual([]);

    // Try it on a mistake: the board goes back one move and waits for a better move
    await page.getByTestId(`review-moment-${moments[0]!.ply}`).click();
    const before = await node(page);
    await expect(page.getByTestId('btn-review-retry')).toHaveText('Try it');
    await page.getByTestId('btn-review-retry').click();
    await expect(page.getByTestId('btn-review-retry')).toHaveText('Stop trying');
    expect((await node(page)).ply).toBe(before.ply - 1);
    await expect(label).toHaveText(`Key moment 1 of ${moments.length}`);
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'desktop-review-try-it.png') });
    // Next moment leaves the retry and moves on
    await page.getByTestId('btn-coach-next').click();
    expect((await node(page)).id).toBe(moments[1]!.nodeId);
    await expect(page.getByTestId('btn-review-retry')).toHaveText('Try it');
  });

  test('the ⋯ menu holds Play vs bot and the export; Review as stays in the footer', async ({ page }) => {
    test.setTimeout(150_000);
    await openReview(page);
    await reviewSample(page);
    await expect(page.getByTestId('review-perspective')).toBeVisible();
    await page.getByTestId('review-menu').click();
    await expect(page.getByTestId('review-menu-list').getByRole('menuitem')).toHaveText([
      'Play vs bot from here',
      'Export annotated PGN',
    ]);
    await page.getByTestId('btn-review-export').click();
    await expect(page.getByTestId('pgn-sheet')).toBeVisible();
    expect(await page.getByTestId('textarea-pgn').inputValue()).toContain('[Annotator "Wizard\'s Chess review');
    await page.keyboard.press('Escape');
  });

  test('Settings: the move animation applies to Review; board keys stay quiet while Settings is open', async ({ page }) => {
    await openReview(page);
    await page.evaluate((pgn) => window.__wizardChessAnalysis!.controller.importPgn(pgn), SHORT_PGN);
    await page.evaluate(() => window.__wizardChessAnalysis!.controller.goToStart());
    await page.getByTestId('btn-settings').click();
    await page.getByTestId('select-nav-animation').selectOption('fast');
    expect(await page.evaluate(() => window.__wizardChessAnalysis!.controller.getNavAnimation())).toBe('fast');
    // Arrow keys inside Settings don't step through the game underneath
    await page.getByTestId('select-nav-animation').focus();
    await page.getByTestId('settings-sheet-close').focus();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('End');
    expect((await node(page)).ply).toBe(0);
    await page.keyboard.press('Escape');
    await page.keyboard.press('ArrowRight');
    await expect.poll(async () => (await node(page)).ply).toBe(1);
  });

  test('Analyze this position (from Play) opens the Analysis tab', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/');
    await page.evaluate(() => window.__wizardChessPlay!.controller.setBotMoveDelayMs(5));
    await page.getByTestId('play-layout').getByTestId('square-e2').click();
    await page.getByTestId('play-layout').getByTestId('square-e4').click();
    await page.getByTestId('play-menu').click();
    await page.getByTestId('btn-analyze-game').click();
    expect(await tab(page)).toBe('analysis');
    await expect(page.getByTestId('engine-lines-panel')).toBeVisible();
  });

  test('phone: the toolbar fits, the coach card and footer fit, no sideways scroll', async ({ page }) => {
    test.setTimeout(150_000);
    await openReview(page, 390, 844);
    for (const id of ['btn-reset-analysis', 'btn-toggle-editor', 'btn-load-pgn']) {
      const box = (await page.getByTestId(id).boundingBox())!;
      expect(box.x + box.width, id).toBeLessThanOrEqual(390);
      expect(box.height, id).toBeGreaterThanOrEqual(40);
      expect(await page.getByTestId(id).evaluate((n) => n.scrollWidth <= n.clientWidth), `${id} fits`).toBe(true);
    }
    await reviewSample(page);
    await page.getByTestId('btn-coach-next').click();
    for (const id of ['btn-review-retry', 'btn-review-refutation', 'btn-coach-prev', 'btn-coach-next', 'review-menu']) {
      const box = (await page.getByTestId(id).boundingBox())!;
      expect(box.x + box.width, id).toBeLessThanOrEqual(390);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    await page.getByTestId('review-coach').scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'phone-review-coach.png') });
  });
});
