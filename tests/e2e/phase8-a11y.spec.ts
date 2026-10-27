import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';

// Phase 8: accessibility. Moves are announced through one live region, every board can be played
// from the keyboard, nothing traps focus, and classifications carry an icon and a label.
const SCREENSHOT_DIR = path.join('test-results', 'phase8-screens');
fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

const announced = (page: Page) => page.getByTestId('announcer').getAttribute('data-last');

async function openPlay(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await expect(page.getByTestId('play-layout')).toBeVisible();
  await page.evaluate(() => window.__wizardChessPlay!.controller.setBotMoveDelayMs(5));
}

const mainLine = (page: Page) =>
  page.evaluate(() =>
    window
      .__wizardChessPlay!.controller.getGameTree()
      .getMainLine()
      .map((n) => n.san),
  );

test.describe('Phase 8 — accessibility', () => {
  test('a game is played from the keyboard, and every move is announced', async ({ page }) => {
    await openPlay(page);
    const board = page.getByTestId('play-layout').getByTestId('chess-board');
    await expect(board).toHaveAttribute('role', 'application');
    await expect(board).toHaveAttribute('aria-label', /Arrow keys/);
    await board.focus();
    // The cursor starts on e2: pick the pawn up
    await page.keyboard.press('Enter');
    await expect.poll(() => announced(page)).toBe('e2, white pawn, picked up, 2 moves');
    await expect(page.getByTestId('play-layout').getByTestId('square-e2')).toHaveClass(/wc-kb-focus/);
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'a11y-keyboard-board.png') });
    // Up twice: e4 is a legal move
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('ArrowUp');
    await expect.poll(() => announced(page)).toBe('e4, empty, legal move');
    await page.keyboard.press('Enter');
    await expect.poll(() => mainLine(page), { timeout: 30_000 }).toHaveLength(2);
    expect((await mainLine(page))[0]).toBe('e4');
    // The bot's reply is announced too
    await expect.poll(() => announced(page)).toMatch(/^Black plays /);

    // Escape puts a picked-up piece down; Enter on an empty square does nothing
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Escape');
    expect(await mainLine(page)).toHaveLength(2);
  });

  test('promotion from the keyboard: the piece letter chooses', async ({ page }) => {
    await openPlay(page);
    await page.evaluate(() => window.__wizardChessPlay!.controller.loadPosition('8/P6k/8/8/8/8/8/K7 w - - 0 1', 'w'));
    const board = page.getByTestId('play-layout').getByTestId('chess-board');
    await board.focus();
    // From the start cursor (e2) to a7: four files left, five ranks up
    for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowLeft');
    for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowUp');
    await page.keyboard.press('Enter');
    await expect.poll(() => announced(page)).toMatch(/^a7, white pawn, picked up/);
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('promotion-picker')).toBeVisible();
    await page.keyboard.press('n');
    await expect.poll(() => mainLine(page), { timeout: 15_000 }).toContain('a8=N');
  });

  test('analysis: stepping through moves is announced; the board works from the keyboard there too', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/');
    await page.getByTestId('mode-tab-review').click();
    await page.evaluate(() => window.__wizardChessAnalysis!.controller.importPgn('1. e4 e5 2. Nf3 Nc6 *'));
    await page.evaluate(() =>
      window.__wizardChessAnalysis!.controller.goToNode(window.__wizardChessAnalysis!.controller.getGameTree().root.id),
    );
    await page.keyboard.press('Home');
    await page.keyboard.press('ArrowRight');
    await expect.poll(() => announced(page)).toBe('Move 1, White: e4');
    await page.keyboard.press('ArrowRight');
    await expect.poll(() => announced(page)).toBe('Move 1, Black: e5');
    await page.keyboard.press('Home');
    await expect.poll(() => announced(page)).toBe('Start position');
  });

  test('keyboard only: the four destinations, Settings and the Games list open and close without a trap', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/');
    await expect(page.getByTestId('play-layout')).toBeVisible();
    // Tab through the Play screen: focus always moves on, and comes back round
    const seen = new Set<string>();
    for (let i = 0; i < 60; i++) {
      await page.keyboard.press('Tab');
      const id = await page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        return el ? `${el.tagName}:${el.getAttribute('data-testid') ?? el.id ?? el.textContent?.slice(0, 20)}` : 'none';
      });
      seen.add(id);
    }
    expect(seen.size).toBeGreaterThan(12);
    // Navigation by keyboard
    await page.getByTestId('mode-tab-games').focus();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('games-list')).toBeVisible();
    await page.getByTestId('games-tab-insights').focus();
    await page.keyboard.press('ArrowLeft');
    await expect(page.getByTestId('games-tab-library')).toHaveAttribute('aria-selected', 'true');
    // Settings: Enter opens, Escape closes and returns focus to the button
    await page.getByTestId('btn-settings').focus();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('settings-sheet')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('settings-sheet')).toBeHidden();
    await expect(page.getByTestId('btn-settings')).toBeFocused();
  });

  test('classifications are icons with names, never colour alone; the live region exists once', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/');
    await page.getByTestId('mode-tab-review').click();
    // The review's own legend: every class in the summary table has a glyph and a label
    await page.evaluate(
      (pgn) => window.__wizardChessAnalysis!.controller.importPgn(pgn),
      '[White "Me"]\n[Black "Them"]\n\n1. e4 e5 2. Qh5 Nc6 3. Qxe5+ Nxe5 0-1',
    );
    await page.getByTestId('btn-review-start').click();
    await expect(page.getByTestId('review-panel')).toHaveAttribute('data-state', 'done', { timeout: 90_000 });
    const classBadges = page.locator('.wc-class-badge[data-class]');
    expect(await classBadges.count()).toBeGreaterThan(3);
    for (const badge of await classBadges.all()) {
      const label = await badge.getAttribute('aria-label');
      const glyph = ((await badge.textContent()) ?? '').trim();
      expect(label, 'every class badge is named').toBeTruthy();
      expect(glyph, `${label} has an icon`).not.toBe('');
    }
    expect(await page.getByTestId('announcer').count()).toBe(1);
    await expect(page.getByTestId('announcer')).toHaveAttribute('aria-live', 'polite');
  });
});
