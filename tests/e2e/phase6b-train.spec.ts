import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';

// Phase 6b stage 4: Train. The hub (one Start training, the Today cards, the count on the
// tab) and the puzzle session in the shared panel (Today strip, session switch, the puzzle
// card, Hint / Show solution / ⋯, Next puzzle as the primary once a puzzle is over).
const SCREENSHOT_DIR = path.join('test-results', 'phase6b-screens');

async function openTrain(page: Page, width = 1440, height = 900): Promise<void> {
  await page.setViewportSize({ width, height });
  await page.goto('/#train');
  await page.evaluate(() => window.__wizardChessPuzzlesReady);
  await expect(page.getByTestId('today-screen')).toHaveAttribute('data-state', 'ready');
}

async function openPuzzle(page: Page, id: string): Promise<void> {
  await page.evaluate(async (puzzleId) => {
    const api = await window.__wizardChessPuzzlesReady!;
    const trainer = await api.open('rated');
    if (!(await trainer.openPuzzle(puzzleId, 'lichess'))) throw new Error(`no puzzle ${puzzleId}`);
  }, id);
  await expect(page.getByTestId('puzzle-trainer')).toHaveAttribute('data-puzzle-id', id);
  await expect(page.getByTestId('puzzle-trainer')).toHaveAttribute('data-puzzle-state', 'playing');
}

test.describe('Phase 6b — Train', () => {
  test('the hub: one primary Start training saying what it starts; Today cards as the other ways in', async ({
    page,
  }) => {
    await openTrain(page);
    const hub = page.getByTestId('train-hub');
    await expect(hub.locator('.wc-btn-primary:visible')).toHaveCount(1);
    await expect(page.getByTestId('btn-train-start')).toBeVisible();
    await expect(page.getByTestId('train-start-detail')).toHaveText('Rated puzzles near 1500');
    for (const id of ['btn-today-reviews', 'btn-today-mistakes', 'btn-today-rated', 'btn-today-games']) {
      await expect(page.getByTestId(id)).toHaveClass(/wc-btn-secondary/);
    }
    await expect(page.getByTestId('nav-train-count')).toBeHidden();
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'desktop-train-hub.png') });
  });

  test('a review coming due shows on the Train tab and in Start training, live', async ({ page }) => {
    await openTrain(page);
    // A failed attempt 11 minutes ago: the card is due again now (Again → 10 min)
    await page.evaluate(async () => {
      const api = await window.__wizardChessPuzzlesReady!;
      const entry = {
        id: 'TstDue1',
        fen: '7k/6pp/8/8/8/8/6PP/R6K w - - 0 1',
        moves: ['h8g8', 'a1a8'],
        rating: 900,
        themes: ['mateIn1'],
        popularity: 0,
        plays: 0,
      };
      await api.store.recordAttempt(
        entry as never,
        'lichess',
        { solved: false, hintUsed: false, mistakes: 1, timeMs: 5000, grade: 1 },
        Date.now() - 11 * 60_000,
      );
    });
    await expect(page.getByTestId('nav-train-count')).toBeVisible();
    await expect(page.getByTestId('nav-train-count')).toHaveText('1');
    await page.getByTestId('mode-tab-play').click();
    await page.getByTestId('mode-tab-train').click();
    await expect(page.getByTestId('train-start-detail')).toHaveText('Your 1 due review');
  });

  test('the session panel: Today strip, the puzzle card, ⋯ actions, Next puzzle once it is over', async ({ page }) => {
    await openTrain(page);
    await page.getByTestId('btn-train-start').click();
    await expect(page.getByTestId('puzzle-trainer')).toHaveAttribute('data-puzzle-state', 'playing', {
      timeout: 15_000,
    });
    await expect(page.getByTestId('puzzle-mode-rated')).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByTestId('puzzle-today-due')).toHaveText('0');
    await expect(page.getByTestId('puzzle-today-new')).toHaveText('0');
    await expect(page.getByTestId('puzzle-today-rated')).toHaveText('0/0');

    await openPuzzle(page, '1yy9U');
    const next = page.getByTestId('btn-puzzle-next');
    // While solving: a plain skip button
    await expect(next).toHaveAttribute('data-ready', 'false');
    await expect(next).toHaveClass(/wc-btn-secondary/);

    // ⋯: Retry (not yet), Analyze, Flip
    await page.getByTestId('puzzle-menu').click();
    await expect(page.getByTestId('puzzle-menu-list').getByRole('menuitem')).toHaveText([
      'Retry this puzzle',
      'Analyze the position',
      'Flip board',
    ]);
    await expect(page.getByTestId('btn-puzzle-retry')).toBeDisabled();
    const flippedBefore = await page.evaluate(() => window.__wizardChessPuzzles!.getTrainer()!.getBoard().isFlipped());
    await page.getByTestId('btn-puzzle-flip').click();
    expect(await page.evaluate(() => window.__wizardChessPuzzles!.getTrainer()!.getBoard().isFlipped())).toBe(
      !flippedBefore,
    );

    // Show solution: the puzzle is over, Next puzzle becomes the primary, Retry opens up
    await page.getByTestId('btn-puzzle-solution').click();
    await expect(next).toHaveAttribute('data-ready', 'true', { timeout: 10_000 });
    await expect(next).toHaveClass(/wc-btn-primary/);
    await expect(page.getByTestId('puzzle-today-rated')).toHaveText('0/1');
    await page.getByTestId('puzzle-menu').click();
    await expect(page.getByTestId('btn-puzzle-retry')).toBeEnabled();
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'desktop-train-session.png') });
    await page.keyboard.press('Escape');

    // Analyze opens Review on its Analysis tab
    await page.getByTestId('puzzle-menu').click();
    await page.getByTestId('btn-puzzle-analyze').click();
    await expect(page.getByTestId('analysis-layout')).toBeVisible();
    expect(await page.evaluate(() => window.__wizardChessAnalysis!.controller.getTab())).toBe('analysis');
  });

  test('phone: hub and session fit, nothing sideways', async ({ page }) => {
    await openTrain(page, 390, 844);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    const start = (await page.getByTestId('btn-train-start').boundingBox())!;
    expect(start.width).toBeGreaterThan(300);
    await page.getByTestId('btn-train-start').click();
    await expect(page.getByTestId('puzzle-trainer')).toHaveAttribute('data-puzzle-state', 'playing', {
      timeout: 15_000,
    });
    const frame = (await page.getByTestId('puzzle-trainer').getByTestId('chess-board-frame').boundingBox())!;
    expect(frame.width).toBeGreaterThanOrEqual(370);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'phone-train-session.png'), fullPage: true });
  });
});
