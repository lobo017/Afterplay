import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';

// Phase 6b stage 2: Play. The New game card (choices apply only on Play; a game in progress
// never ends without a yes), the in-game view (tabs, action bar, ⋯ menu), game over → Review,
// board and sound settings applying to every board, and the phone layout.
const SCREENSHOT_DIR = path.join('test-results', 'phase6b-screens');

async function openPlay(page: Page, width = 1440, height = 900): Promise<void> {
  await page.setViewportSize({ width, height });
  await page.goto('/');
  await expect(page.getByTestId('play-layout')).toBeVisible();
  // A quick bot, so tests don't wait on think time
  await page.evaluate(() => window.__wizardChessPlay!.controller.setBotMoveDelayMs(5));
}

const plies = (page: Page) =>
  page.evaluate(() => window.__wizardChessPlay!.controller.getGameTree().getMainLine().length);

async function clickMove(page: Page, from: string, to: string): Promise<void> {
  const layout = page.getByTestId('play-layout');
  await layout.getByTestId(`square-${from}`).click();
  await layout.getByTestId(`square-${to}`).click();
}

test.describe('Phase 6b — Play', () => {
  test('New game choices wait for Play, then all apply together', async ({ page }) => {
    await openPlay(page);
    const card = page.getByTestId('new-game-card');
    await expect(card).toBeVisible();
    await expect(page.getByTestId('game-view')).toBeHidden();
    await expect(page.getByTestId('btn-back-to-game')).toBeHidden();
    await expect(page.getByTestId('bot-rating-label')).toHaveText('1400 Elo (Club)');
    await expect(page.getByTestId('time-control-5+3')).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByTestId('play-as-w')).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByTestId('bot-tier-Club')).toHaveAttribute('aria-pressed', 'true');

    // Change everything: nothing on the board changes yet
    await page.getByTestId('bot-tier-Expert').click();
    await page.getByTestId('bot-style-aggressive').click();
    await page.getByTestId('time-control-10+0').click();
    await page.getByTestId('play-as-b').click();
    await expect(page.getByTestId('bot-rating-label')).toHaveText('1800 Elo (Expert)');
    await expect(page.getByTestId('top-player-name')).toHaveText('Stockfish Club (1400)');
    await expect(page.getByTestId('bottom-clock')).toHaveText('5:00');
    expect(await page.evaluate(() => window.__wizardChessPlay!.controller.getBoard().isFlipped())).toBe(false);
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'desktop-play-new-game.png') });

    // Arrow keys move along a choice group
    await page.getByTestId('play-as-b').focus();
    await page.keyboard.press('ArrowLeft');
    await expect(page.getByTestId('play-as-random')).toHaveAttribute('aria-checked', 'true');
    await page.keyboard.press('ArrowRight');
    await expect(page.getByTestId('play-as-b')).toHaveAttribute('aria-checked', 'true');

    await page.getByTestId('btn-new-game').click();
    await expect(page.getByTestId('game-view')).toBeVisible();
    await expect(card).toBeHidden();
    expect(await page.evaluate(() => window.__wizardChessPlay!.controller.getBoard().isFlipped())).toBe(true);
    await expect(page.getByTestId('top-player-name')).toHaveText('Stockfish Expert (1800)');
    await expect(page.getByTestId('bottom-player-name')).toHaveText('You (Black)');
    expect(await page.evaluate(() => window.__wizardChessPlay!.controller.getBot().getStyle())).toBe('aggressive');
    // The bot plays White's first move; the clocks are 10 minutes
    await expect.poll(() => plies(page), { timeout: 15_000 }).toBe(1);
    await expect(page.getByTestId('top-clock')).toHaveText(/^(10:00|9:5\d)$/);
  });

  test('a game in progress never ends from a change; Play asks first', async ({ page }) => {
    await openPlay(page);
    // The board is live on load: a first move starts the game and shows it
    await clickMove(page, 'e2', 'e4');
    await expect(page.getByTestId('game-view')).toBeVisible();
    await expect.poll(() => plies(page), { timeout: 15_000 }).toBe(2);

    // ⋯ › New game…: the card, with the game waiting behind it
    await page.getByTestId('play-menu').click();
    await expect(page.getByTestId('play-menu-list')).toBeVisible();
    await page.getByTestId('menu-new-game').click();
    await expect(page.getByTestId('new-game-card')).toBeVisible();
    await expect(page.getByTestId('btn-back-to-game')).toBeVisible();
    await page.getByTestId('time-control-1+0').click();
    await page.getByTestId('play-as-b').click();
    await page.getByTestId('bot-tier-Novice').click();
    expect(await plies(page)).toBe(2);
    expect(await page.evaluate(() => window.__wizardChessPlay!.controller.isGameInProgress())).toBe(true);
    await expect(page.getByTestId('top-player-name')).toHaveText('Stockfish Club (1400)');

    await page.getByTestId('btn-back-to-game').click();
    await expect(page.getByTestId('game-view')).toBeVisible();
    expect(await plies(page)).toBe(2);

    // Play while a game is in progress: a confirmation; Keep playing keeps it
    await page.getByTestId('play-menu').click();
    await page.getByTestId('menu-new-game').click();
    await page.getByTestId('btn-new-game').click();
    await expect(page.getByTestId('new-game-confirm')).toBeVisible();
    await expect(page.getByTestId('btn-new-game')).toBeHidden();
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'desktop-play-confirm-end.png') });
    await page.getByTestId('btn-new-game-keep').click();
    await expect(page.getByTestId('game-view')).toBeVisible();
    expect(await plies(page)).toBe(2);

    // …and End it and play starts the new one with the new choices
    await page.getByTestId('play-menu').click();
    await page.getByTestId('menu-new-game').click();
    await page.getByTestId('btn-new-game').click();
    await page.getByTestId('btn-new-game-end').click();
    await expect(page.getByTestId('game-view')).toBeVisible();
    await expect(page.getByTestId('bottom-player-name')).toHaveText('You (Black)');
    await expect(page.getByTestId('top-player-name')).toHaveText('Stockfish Novice (600)');
  });

  test('a new game from Review (Play vs bot here) also asks before ending a game in progress', async ({ page }) => {
    await openPlay(page);
    await clickMove(page, 'e2', 'e4');
    await expect.poll(() => plies(page), { timeout: 15_000 }).toBe(2);
    const fen = 'r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3';
    await page.evaluate((f) => window.__wizardChessPlay!.controller.requestNewGame({ fen: f, playerColor: 'w' }), fen);
    await expect(page.getByTestId('new-game-confirm')).toBeVisible();
    expect(await plies(page)).toBe(2);
    await page.getByTestId('btn-new-game-end').click();
    expect(await page.evaluate(() => window.__wizardChessPlay!.controller.getAdapter().fen())).toBe(fen);
  });

  test('in game: tabs, the action bar and the ⋯ menu; game over offers Review this game', async ({ page }) => {
    await openPlay(page);
    await page.getByTestId('btn-new-game').click();
    await expect(page.getByTestId('play-actions')).toBeVisible();
    for (const id of ['btn-hint', 'btn-takeback', 'btn-flip-board', 'play-menu']) {
      const box = (await page.getByTestId(id).boundingBox())!;
      expect(box.height, id).toBeGreaterThanOrEqual(44);
    }
    await expect(page.getByTestId('btn-hint')).toHaveText('Hint (3)');

    // Tabs: Moves / Analysis, with arrow keys
    await expect(page.getByTestId('play-panel-moves')).toBeVisible();
    await page.getByTestId('play-tab-analysis').click();
    await expect(page.getByTestId('play-panel-analysis')).toBeVisible();
    await expect(page.getByTestId('play-panel-moves')).toBeHidden();
    await page.keyboard.press('ArrowLeft');
    await expect(page.getByTestId('play-tab-moves')).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByTestId('play-tab-moves')).toBeFocused();

    // The menu: four items, Escape closes it and returns focus
    await page.getByTestId('play-menu').click();
    const list = page.getByTestId('play-menu-list');
    await expect(list.getByRole('menuitem')).toHaveText(['Offer draw', 'Analyze this position', 'New game…', 'Resign']);
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'desktop-play-menu.png') });
    await page.keyboard.press('ArrowDown');
    await expect(page.getByTestId('btn-analyze-game')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(list).toBeHidden();
    await expect(page.getByTestId('play-menu')).toBeFocused();

    // A click outside closes it too
    await page.getByTestId('play-menu').click();
    await page.getByTestId('game-status-banner').click();
    await expect(list).toBeHidden();

    // Play a move, then resign from the menu: game over
    await clickMove(page, 'e2', 'e4');
    await expect.poll(() => plies(page), { timeout: 15_000 }).toBe(2);
    await page.getByTestId('play-menu').click();
    await page.getByTestId('btn-resign').click();
    await expect(page.getByTestId('game-status-banner')).toContainText('White resigned');
    await expect(page.getByTestId('game-over-actions')).toBeVisible();
    await expect(page.getByTestId('play-actions')).toBeHidden();
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'desktop-play-game-over.png') });

    // Review this game: the game opens in Review and its review starts
    await page.getByTestId('btn-review-game').click();
    await expect(page.getByTestId('mode-tab-review')).toHaveAttribute('aria-current', 'page');
    expect(
      await page.evaluate(() => window.__wizardChessAnalysis!.controller.getGameTree().getMainLine().map((n) => n.san)),
    ).toHaveLength(2);
    await expect(page.getByTestId('review-panel')).toHaveAttribute('data-state', /running|done/);
  });

  test('"Analyze this position" opens the game in Review', async ({ page }) => {
    await openPlay(page);
    await clickMove(page, 'd2', 'd4');
    await expect.poll(() => plies(page), { timeout: 15_000 }).toBe(2);
    await page.getByTestId('play-menu').click();
    await page.getByTestId('btn-analyze-game').click();
    await expect(page.getByTestId('analysis-layout')).toBeVisible();
    expect(
      await page.evaluate(() => window.__wizardChessAnalysis!.controller.getGameTree().getMainLine()[0]!.san),
    ).toBe('d4');
  });

  test('Settings: board and sound settings apply to every board and stay in step', async ({ page }) => {
    await openPlay(page);
    await page.getByTestId('btn-settings').click();
    const sheet = page.getByTestId('settings-sheet');
    await expect(sheet.getByTestId('settings-board')).toBeVisible();
    await expect(sheet.getByTestId('settings-moves')).toBeVisible();
    await expect(sheet.getByTestId('settings-sound')).toBeVisible();
    // Sections in order, About last
    await expect(sheet.locator('.wc-settings-sec-title')).toHaveText([
      'Board',
      'Board feel',
      'Moves',
      'Sound & effects',
      'Your data',
      'About & diagnostics',
    ]);

    await page.getByTestId('select-board-theme').selectOption('imperial-walnut');
    await page.getByTestId('select-piece-set').selectOption('staunton');
    await page.getByTestId('toggle-audio-mute').uncheck();
    await page.getByTestId('slider-audio-volume').fill('40');
    await expect(page.getByTestId('audio-volume-label')).toHaveText('40%');
    await page.getByTestId('toggle-auto-queen').check();
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'desktop-settings-play.png') });
    await page.keyboard.press('Escape');

    const playFrame = page.getByTestId('play-layout').getByTestId('chess-board-frame');
    await expect(playFrame).toHaveAttribute('data-theme', 'imperial-walnut');
    await expect(playFrame).toHaveAttribute('data-piece-set', 'staunton');
    const audio = await page.evaluate(() => {
      const a = window.__wizardChessPlay!.controller.getAudio();
      return { enabled: a.isEnabled(), volume: a.getVolume() };
    });
    expect(audio).toEqual({ enabled: false, volume: 0.4 });
    expect(await page.evaluate(() => window.__wizardChessPlay!.controller.getBoard().isAutoQueen())).toBe(true);

    await page.getByTestId('mode-tab-review').click();
    const reviewFrame = page.getByTestId('analysis-layout').getByTestId('chess-board-frame');
    await expect(reviewFrame).toHaveAttribute('data-theme', 'imperial-walnut');
    await expect(reviewFrame).toHaveAttribute('data-piece-set', 'staunton');

    // A change made through the game API shows in Settings too
    await page.evaluate(() => window.__wizardChessPlay!.controller.setMaxPremoves(4));
    await page.getByTestId('btn-settings').click();
    await expect(page.getByTestId('input-max-premoves')).toHaveValue('4');
  });

  test('phone: board nearly edge to edge, touch-size actions, moves in one line, no sideways scroll', async ({ page }) => {
    await openPlay(page, 390, 844);
    const frame = (await page.getByTestId('play-layout').getByTestId('chess-board-frame').boundingBox())!;
    expect(frame.width).toBeGreaterThanOrEqual(370);
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'phone-play-new-game.png'), fullPage: true });
    await clickMove(page, 'e2', 'e4');
    await expect.poll(() => plies(page), { timeout: 15_000 }).toBe(2);
    await clickMove(page, 'g1', 'f3');
    await expect.poll(() => plies(page), { timeout: 15_000 }).toBe(4);
    // Moves in one horizontal line
    const rows = await page.getByTestId('move-history-list').locator('.wc-move-row').evaluateAll((els) =>
      els.map((el) => Math.round(el.getBoundingClientRect().top)),
    );
    expect(new Set(rows).size).toBe(1);
    for (const id of ['btn-hint', 'btn-takeback', 'btn-flip-board', 'play-menu']) {
      const box = (await page.getByTestId(id).boundingBox())!;
      expect(box.height, id).toBeGreaterThanOrEqual(44);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'phone-play-game.png'), fullPage: true });
  });
});
