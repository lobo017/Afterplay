import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';

// Phase 8: the library. Games played here are kept, the list filters by result, colour, opening,
// date and accuracy, games can be deleted, my usernames are a setting, and a bulk PGN import is
// read in a worker (no long task on the page).
const SCREENSHOT_DIR = path.join('test-results', 'phase8-screens');
fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

const SICILIAN = '1. e4 c5 2. Nf3 d6 3. d4 cxd4 4. Nxd4 Nf6 5. Nc3 a6';
const SCHOLAR = '1. e4 e5 2. Qh5 Nc6 3. Bc4 Nf6 4. Qxf7#';
const game = (white: string, black: string, result: string, date: string, moves: string, extra = '') =>
  `[Event "T"]\n${extra}[White "${white}"]\n[Black "${black}"]\n[Result "${result}"]\n[Date "${date}"]\n\n${moves} ${result}`;

async function openGames(page: Page, width = 1440, height = 900): Promise<void> {
  await page.setViewportSize({ width, height });
  await page.goto('/#games');
  await expect(page.getByTestId('games-list')).toBeVisible();
}

async function paste(page: Page, text: string): Promise<void> {
  await page.getByTestId('btn-games-import').click();
  await page.getByTestId('btn-games-paste').click();
  // (Playwright's fill() of a large text takes seconds in the browser itself; set the value directly)
  await page.getByTestId('games-paste-text').evaluate((el, value) => {
    (el as HTMLTextAreaElement).value = value;
  }, text);
  await page.getByTestId('btn-games-paste-import').click();
}

test.describe('Phase 8 — library', () => {
  test('a game played here is kept in the library, as mine, with the side I played', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/');
    await expect(page.getByTestId('play-layout')).toBeVisible();
    await page.evaluate(() => window.__wizardChessPlay!.controller.setBotMoveDelayMs(5));
    await page.getByTestId('play-layout').getByTestId('square-e2').click();
    await page.getByTestId('play-layout').getByTestId('square-e4').click();
    await expect
      .poll(() => page.evaluate(() => window.__wizardChessPlay!.controller.getGameTree().getMainLine().length), { timeout: 30_000 })
      .toBe(2);
    await page.evaluate(() => window.__wizardChessPlay!.controller.resign());
    await page.getByTestId('mode-tab-games').click();
    await expect(page.getByTestId('games-row')).toHaveCount(1);
    const row = page.getByTestId('games-row');
    await expect(row).toHaveAttribute('data-source', 'play');
    await expect(row).toHaveAttribute('data-result', 'loss');
    await expect(page.getByTestId('games-row-color')).toHaveAttribute('data-color', 'w');
    await expect(page.getByTestId('games-row-opponent')).toContainText('Stockfish');
    // A game with no move is not kept
    await page.getByTestId('mode-tab-play').click();
    await page.evaluate(() => window.__wizardChessPlay!.controller.requestNewGame({}));
    await page.evaluate(() => window.__wizardChessPlay!.controller.resign());
    await page.getByTestId('mode-tab-games').click();
    await expect(page.getByTestId('games-row')).toHaveCount(1);
  });

  test('filters by result, colour, opening, date and accuracy; delete; usernames in Settings', async ({ page }) => {
    await openGames(page);
    // My username is a setting now
    await page.getByTestId('btn-settings').click();
    await page.getByTestId('input-lichess-username').fill('Me');
    await page.getByTestId('input-lichess-username').press('Tab');
    await page.keyboard.press('Escape');
    const text = [
      game('Me', 'Bob', '1-0', '2026.01.02', SICILIAN),
      game('Al', 'Me', '1-0', '2026.02.10', SCHOLAR),
      game('X', 'Y', '1/2-1/2', '2026.03.05', SICILIAN),
    ].join('\n\n');
    await paste(page, text);
    await expect(page.getByTestId('games-row')).toHaveCount(3);
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'library-desktop.png') });

    const rows = page.getByTestId('games-row');
    await page.getByTestId('games-filter-color').selectOption('w');
    await expect(rows).toHaveCount(1);
    await page.getByTestId('games-filter-color').selectOption('b');
    await expect(rows).toHaveCount(1);
    await expect(page.getByTestId('btn-games-clear-filters')).toBeVisible();
    await page.getByTestId('btn-games-clear-filters').click();
    await expect(rows).toHaveCount(3);
    await page.getByTestId('games-filter-result').selectOption('draw');
    await expect(rows).toHaveCount(1);
    await page.getByTestId('btn-games-clear-filters').click();
    await page.getByTestId('games-filter-opening').fill('sicilian');
    await expect(rows).toHaveCount(2);
    await page.getByTestId('games-filter-from').fill('2026-02-01');
    await expect(rows).toHaveCount(1);
    await expect(page.getByTestId('games-count')).toContainText('1 of 3');
    await page.getByTestId('btn-games-clear-filters').click();
    await page.getByTestId('games-filter-from').fill('2026-02-01');
    await page.getByTestId('games-filter-to').fill('2026-02-28');
    await expect(rows).toHaveCount(1);
    await page.getByTestId('btn-games-clear-filters').click();
    // Accuracy: only analyzed games have one
    await page.evaluate(async () => {
      const api = await window.__wizardChessLibraryReady!;
      const [first] = (await api.library.list()).filter((g) => g.white === 'Me');
      // (the list reads the summary on the game record)
      const storage = (api.library as unknown as { storage: { saveGame: (r: unknown) => Promise<unknown> } }).storage;
      await storage.saveGame({ ...first, analysis: { preset: 'quick', savedAt: 1, whiteAccuracy: 91, blackAccuracy: 60 } });
    });
    await page.reload();
    await expect(rows).toHaveCount(3);
    await page.getByTestId('games-filter-accuracy').fill('80');
    await expect(rows).toHaveCount(1);
    await page.getByTestId('games-filter-accuracy').fill('95');
    await expect(rows).toHaveCount(0);
    await page.getByTestId('btn-games-clear-filters').click();

    // Delete: asks first, Keep changes nothing, Delete removes the game
    await rows.first().getByRole('checkbox').check();
    await expect(page.getByTestId('games-selbar')).toBeVisible();
    await page.getByTestId('btn-games-delete').click();
    await expect(page.getByTestId('games-delete-question')).toHaveText('Delete 1 game and their reviews?');
    await page.getByTestId('btn-games-delete-no').click();
    await expect(rows).toHaveCount(3);
    await page.getByTestId('btn-games-delete').click();
    await page.getByTestId('btn-games-delete-yes').click();
    await expect(rows).toHaveCount(2);
    await expect(page.getByTestId('games-message')).toContainText('Deleted 1 game');
  });

  test('a bulk import is read in a worker: 400 games, progress, no long task on the page', async ({ page }) => {
    test.setTimeout(120_000);
    await openGames(page);
    await page.evaluate(() => {
      (window as unknown as { __longTasks: number[] }).__longTasks = [];
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) (window as unknown as { __longTasks: number[] }).__longTasks.push(e.duration);
      }).observe({ entryTypes: ['longtask'] });
    });
    const games = Array.from({ length: 400 }, (_, i) =>
      game(`Player${i}`, `Rival${i % 7}`, i % 3 === 0 ? '1/2-1/2' : '1-0', `2026.0${1 + (i % 9)}.1${i % 9}`, i % 2 ? SICILIAN : SCHOLAR),
    ).join('\n\n');
    const started = Date.now();
    await paste(page, games);
    await expect(page.getByTestId('games-message')).toContainText('Imported 400 games', { timeout: 60_000 });
    console.log(`[library] 400 games imported in ${Date.now() - started} ms`);
    await expect(page.getByTestId('games-summary')).toContainText('400 games');
    const longTasks = await page.evaluate(() => (window as unknown as { __longTasks: number[] }).__longTasks);
    console.log(`[library] bulk import of 400 games: long tasks ${JSON.stringify(longTasks.map((d) => Math.round(d)))}`);
    // The worker did the reading: the page never held the thread for long
    expect(Math.max(0, ...longTasks)).toBeLessThan(50);
    // Importing the same text again adds nothing
    await paste(page, games);
    await expect(page.getByTestId('games-message')).toContainText('400 already in the list');
  });

  test('phone: the filters fit and nothing scrolls sideways', async ({ page }) => {
    await openGames(page, 390, 844);
    await paste(page, game('Me', 'Bob', '1-0', '2026.01.02', SICILIAN));
    await expect(page.getByTestId('games-row')).toHaveCount(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'library-phone.png'), fullPage: true });
  });
});
