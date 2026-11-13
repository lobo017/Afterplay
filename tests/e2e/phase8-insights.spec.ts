import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { saveMyAccounts } from './helpers/accounts';

// Phase 8: Insights (a tab in Games). Charts of accuracy by phase, blunders per 10 moves,
// common motifs, results by opening and the puzzle rating; every data point opens what is
// behind it. Desktop and phone screenshots go to test-results/phase8-screens/.
const SCREENSHOT_DIR = path.join('test-results', 'phase8-screens');
fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

// Lobo017 is my account (prepare() saves it): White here, and the queen is given away on move 3
const BLUNDER = `[Event "Casual"]
[White "Lobo017"]
[Black "Opp"]
[Result "0-1"]
[Date "2026.10.01"]

1. e4 e5 2. Qh5 Nc6 3. Qxe5+ Nxe5 0-1`;
const SICILIAN = `[Event "Casual"]
[White "Opp2"]
[Black "Lobo017"]
[Result "0-1"]
[Date "2026.10.02"]

1. e4 c5 2. Nf3 d6 3. d4 cxd4 4. Nxd4 Nf6 5. Nc3 a6 0-1`;

async function paste(page: Page, text: string): Promise<void> {
  await page.getByTestId('btn-games-import').click();
  await page.getByTestId('btn-games-paste').click();
  await page.getByTestId('games-paste-text').evaluate((el, value) => {
    (el as HTMLTextAreaElement).value = value;
  }, text);
  await page.getByTestId('btn-games-paste-import').click();
}

async function prepare(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/#games');
  await expect(page.getByTestId('games-list')).toBeVisible();
  // My Lichess name, as Settings › Your games saves it (the app has no built-in account): Insights count my games
  await saveMyAccounts(page);
  await paste(page, `${BLUNDER}\n\n${SICILIAN}`);
  await expect(page.getByTestId('games-row')).toHaveCount(2);
  // Review both on Quick, through the Games list's own queue
  await page.evaluate(async () => {
    const api = await window.__wizardChessLibraryReady!;
    api.queue.enqueue(
      (await api.library.list()).map((g) => g.id),
      'quick',
    );
  });
  await expect(page.locator('[data-analysis="analyzed"]')).toHaveCount(2, { timeout: 120_000 });
  // A puzzle rating history (as solving rated puzzles would have written it)
  await page.evaluate(async () => {
    const api = await window.__wizardChessLibraryReady!;
    const storage = (api.library as unknown as { storage: { setSetting: (k: string, v: unknown) => Promise<void> } })
      .storage;
    const base = Date.UTC(2026, 9, 1);
    await storage.setSetting('puzzles.rating', {
      rating: 1540,
      rd: 80,
      volatility: 0.06,
      games: 3,
      history: [
        { at: base, rating: 1500, puzzleId: '0ND4A', solved: false },
        { at: base + 1000, rating: 1520, puzzleId: '1yy9U', solved: true },
        { at: base + 2000, rating: 1540, puzzleId: '064LL', solved: true },
      ],
    });
  });
}

test.describe('Phase 8 — insights', () => {
  test('charts of my reviewed games, and every point opens the positions behind it', async ({ page }) => {
    test.setTimeout(240_000);
    await prepare(page);
    await page.getByTestId('games-tab-insights').click();
    await expect(page.getByTestId('insights-summary')).toContainText('2 reviewed games of yours');
    await expect(page.getByTestId('chart-phase')).toBeVisible();
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'insights-desktop.png'), fullPage: true });

    // Accuracy by phase: the opening bar lists my opening moves, worst first
    await page.getByTestId('phase-opening').click();
    const detail = page.getByTestId('insights-detail');
    await expect(detail).toBeVisible();
    await expect(page.getByTestId('insights-detail-count')).toContainText('positions');
    expect(await page.getByTestId('insight-position').count()).toBeGreaterThanOrEqual(5);
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'insights-detail.png'), fullPage: true });

    // Blunders: the game with the queen blunder is a point; its position is the blunder
    await expect(page.getByTestId('chart-blunders').locator('[data-point]')).toHaveCount(2);
    const points = page.getByTestId('chart-blunders').locator('[data-point]');
    let found = false;
    for (let i = 0; i < 2 && !found; i++) {
      await points.nth(i).focus();
      await page.keyboard.press('Enter'); // a data point works from the keyboard
      if ((await page.getByTestId('insights-detail-count').textContent())?.startsWith('1 position')) found = true;
    }
    expect(found).toBe(true);
    await expect(page.getByTestId('insight-position').first()).toContainText('Blunder');
    await expect(page.getByTestId('insight-position').first()).toContainText('3. Qxe5+');

    // Open it: the game is on the Review board at that move
    await page.getByTestId('insight-position').first().getByRole('button').click();
    await expect(page.getByTestId('analysis-layout')).toBeVisible();
    await expect
      .poll(() => page.evaluate(() => window.__wizardChessAnalysis!.controller.getGameTree().currentNode.san))
      .toBe('Qxe5+');
    await page.getByTestId('mode-tab-games').click();
    await expect(page.getByTestId('games-tab-insights')).toHaveAttribute('aria-selected', 'true');

    // Motifs: the queen hung to a pawn... whichever motifs the review named are rows that open positions
    const motifRows = page.getByTestId('chart-motifs').locator('[data-point]');
    if ((await motifRows.count()) > 0) {
      await motifRows.first().click();
      await expect(page.getByTestId('insight-position').first()).toBeVisible();
    }

    // Results by opening: a segment shows those games in the Library, filtered
    const seg = page.getByTestId('chart-openings').locator('[data-point]').first();
    await seg.click();
    await expect(page.getByTestId('games-tab-library')).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByTestId('btn-games-clear-filters')).toBeVisible();
    expect(await page.getByTestId('games-row').count()).toBeGreaterThanOrEqual(1);
    await page.getByTestId('btn-games-clear-filters').click();
    await page.getByTestId('games-tab-insights').click();

    // Puzzle rating: three points; one opens its puzzle in Train
    const ratingPoints = page.getByTestId('chart-rating').locator('[data-point]');
    await expect(ratingPoints).toHaveCount(3);
    await ratingPoints.nth(1).click();
    await expect(page.getByTestId('puzzle-trainer')).toHaveAttribute('data-puzzle-id', '1yy9U', { timeout: 30_000 });
  });

  test('with nothing reviewed the charts say so; phone width fits', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/#games');
    await page.getByTestId('games-tab-insights').click();
    await expect(page.getByTestId('insights-summary')).toContainText('0 reviewed games');
    await expect(page.locator('[data-empty="true"]').first()).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'insights-phone-empty.png'), fullPage: true });
  });

  test('phone: charts with data fit the screen', async ({ page }) => {
    test.setTimeout(240_000);
    await prepare(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByTestId('games-tab-insights').click();
    await expect(page.getByTestId('chart-phase')).toBeVisible();
    await page.getByTestId('phase-opening').click();
    await expect(page.getByTestId('insights-detail')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'insights-phone.png'), fullPage: true });
  });
});
