import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';

// The Play tab's New game card and the board beside it: every choice shows on the waiting board at once (the
// opponent's name, style and rating, both clocks, my side and the board's direction), and a bot keeps its name when the
// style changes. `/start/sample/` is the committed sample link (invented names: Ada; Professor Rook 800 Solid,
// The Gambit Goblin 1200 Gambiteer, Lady Zugzwang 1800 Aggressive).
const SCREENSHOT_DIR = path.join('test-results', 'phase11-screens');

const touch = () => test.info().project.name === 'webkit-iphone';

async function press(page: Page, testId: string): Promise<void> {
  const el = page.getByTestId(testId);
  if (touch()) await el.tap();
  else await el.click();
}

async function openSample(page: Page): Promise<void> {
  await page.goto('/start/sample/');
  await expect(page.getByTestId('app-shell')).toHaveAttribute('data-first-run', 'applied', { timeout: 15_000 });
  await page.getByTestId('welcome-done').click();
  await expect(page.getByTestId('welcome-sheet')).toBeHidden();
  await expect(page.getByTestId('play-layout').getByTestId('chess-board')).toBeVisible();
}

const board = (page: Page) => page.getByTestId('play-layout').getByTestId('chess-board');

test.describe('Phase 11 — the New game card and the board beside it', () => {
  test('the waiting board follows the opponent, the style, the clocks and my side', async ({ page }) => {
    await openSample(page);
    const top = page.getByTestId('top-player-name');
    const bottom = page.getByTestId('bottom-player-name');

    // The preset's choices are on the board before anything is pressed
    await expect(top).toHaveText('Professor Rook · Solid (800)');
    await expect(bottom).toHaveText('Ada (White)');
    await expect(page.getByTestId('top-clock')).toHaveText('10:00');
    await expect(page.getByTestId('bottom-clock')).toHaveText('10:00');
    await expect(board(page)).toHaveAttribute('data-flipped', 'false');

    // Another opponent: the bot's own style comes with it
    await press(page, 'custom-bot-1');
    await expect(top).toHaveText('The Gambit Goblin · Gambiteer (1200)');
    await expect(page.getByTestId('custom-bot-1')).toHaveAttribute('aria-pressed', 'true');

    // A style change keeps the bot: same name, same highlight, only the suffix changes
    await press(page, 'bot-style-solid');
    await expect(top).toHaveText('The Gambit Goblin · Solid (1200)');
    await expect(page.getByTestId('custom-bot-1')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('custom-bot-0')).toHaveAttribute('aria-pressed', 'false');
    await expect(page.getByTestId('bot-rating-label')).toHaveText('The Gambit Goblin · Solid · 1200 Elo');
    await press(page, 'bot-style-aggressive');
    await expect(top).toHaveText('The Gambit Goblin · Aggressive (1200)');
    await expect(page.getByTestId('custom-bot-1')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('bot-rating-label')).toHaveText('The Gambit Goblin · Aggressive · 1200 Elo');

    // A rating no bot has: the usual name plus the style
    await press(page, 'bot-tier-Club');
    await expect(top).toHaveText('Stockfish Club · Aggressive (1400)');
    await expect(page.getByTestId('bot-rating-label')).toHaveText('1400 Elo (Club) · Aggressive');
    await expect(page.getByTestId('custom-bot-1')).toHaveAttribute('aria-pressed', 'false');

    // Both clocks follow the time control
    await press(page, 'time-control-3+2');
    await expect(page.getByTestId('top-clock')).toHaveText('3:00');
    await expect(page.getByTestId('bottom-clock')).toHaveText('3:00');

    // My side: Black flips the board, Random names no side and does not flip, White flips back
    await press(page, 'play-as-b');
    await expect(bottom).toHaveText('Ada (Black)');
    await expect(board(page)).toHaveAttribute('data-flipped', 'true');
    await press(page, 'play-as-random');
    await expect(bottom).toHaveText('Ada (random side)');
    await expect(board(page)).toHaveAttribute('data-flipped', 'false');
    await press(page, 'play-as-w');
    await expect(bottom).toHaveText('Ada (White)');
    await expect(board(page)).toHaveAttribute('data-flipped', 'false');

    // The game starts as it was shown
    await press(page, 'play-as-b');
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, `${test.info().project.name}-new-game-preview.png`) });
    await press(page, 'custom-bot-0');
    await press(page, 'btn-new-game');
    await expect(top).toHaveText('Professor Rook · Solid (800)');
    await expect(bottom).toHaveText('Ada (Black)');
    await expect(board(page)).toHaveAttribute('data-flipped', 'true');
    await expect(page.getByTestId('bottom-clock')).toHaveText(/^(3:0\d|2:5\d)$/);
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, `${test.info().project.name}-new-game-started.png`) });
  });

  test('a game in progress is not changed by the card', async ({ page }) => {
    await openSample(page);
    await page.evaluate(() => window.__wizardChessPlay!.controller.setBotMoveDelayMs(5));
    await press(page, 'play-as-w');
    await press(page, 'btn-new-game');
    await page.getByTestId('play-layout').getByTestId('square-e2').click();
    await page.getByTestId('play-layout').getByTestId('square-e4').click();
    await expect(page.getByTestId('top-player-name')).toHaveText('Professor Rook · Solid (800)');
    // Open the card from the menu and choose something else: the game on the board stays as it was
    await page.evaluate(() => window.__wizardChessPlay!.controller.requestNewGame());
    await press(page, 'play-as-b');
    await press(page, 'time-control-3+2');
    await expect(page.getByTestId('bottom-player-name')).toHaveText('Ada (White)');
    await expect(board(page)).toHaveAttribute('data-flipped', 'false');
    await expect(page.getByTestId('bottom-clock')).not.toHaveText('3:00');
  });
});
