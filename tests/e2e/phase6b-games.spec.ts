import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';

// Phase 6b stage 5: Games. One Import menu, the capture card in words, the floating
// selection bar with the one action, phone layout.
const SCREENSHOT_DIR = path.join('test-results', 'phase6b-screens');

const TWO_GAMES = `[Event "Rated blitz game"]
[Site "https://lichess.org/Gm6bTst1"]
[Date "2026.10.18"]
[White "Opponent1"]
[Black "Lobo017"]
[Result "0-1"]
[TimeControl "180+0"]

1. e4 e5 2. Nf3 Nc6 3. Bc4 Nd4 4. Nxe5 Qg5 5. Nxf7 Qxg2 6. Rf1 Qxe4+ 7. Be2 Nf3# 0-1

[Event "Casual game"]
[Site "Chess.com"]
[Date "2026.10.17"]
[White "Someone"]
[Black "Another"]
[Result "1-0"]

1. e4 f5 2. exf5 g5 3. Qh5# 1-0`;

async function openGames(page: Page, width = 1440, height = 900): Promise<void> {
  await page.setViewportSize({ width, height });
  await page.goto('/#games');
  await page.evaluate(() => window.__wizardChessLibraryReady);
  await expect(page.getByTestId('games-list')).toBeVisible();
}

async function paste(page: Page, pgn: string): Promise<void> {
  await page.getByTestId('btn-games-import').click();
  await expect(page.getByTestId('btn-games-import-list').getByRole('menuitem')).toHaveText([
    'Paste PGN…',
    'Open PGN file…',
  ]);
  await page.getByTestId('btn-games-paste').click();
  await page.getByTestId('games-paste-text').fill(pgn);
  await page.getByTestId('btn-games-paste-import').click();
}

test.describe('Phase 6b — Games', () => {
  test('Import menu, the summary, and the capture card without the extension', async ({ page }) => {
    await openGames(page);
    await expect(page.getByTestId('games-summary')).toHaveText('');
    await expect(page.getByTestId('games-extension-status')).toHaveText('Capture extension not detected');
    await expect(page.getByTestId('games-capture-detail')).toContainText('npm run build:ext');
    await expect(page.getByTestId('games-auto-analyze')).not.toBeChecked();
    await paste(page, TWO_GAMES);
    await expect(page.getByTestId('games-row')).toHaveCount(2);
    await expect(page.getByTestId('games-paste-panel')).toBeHidden();
    await expect(page.getByTestId('games-summary')).toHaveText('2 games · 0 analyzed');

    // Open PGN file… opens the file picker (the hidden input)
    const chooser = page.waitForEvent('filechooser');
    await page.getByTestId('btn-games-import').click();
    await page.getByTestId('btn-games-file').click();
    await chooser;
  });

  test('the selection bar appears with a selection, analyzes it, and clears', async ({ page }) => {
    await openGames(page);
    await paste(page, TWO_GAMES);
    const bar = page.getByTestId('games-selbar');
    await expect(bar).toBeHidden();
    await page.getByTestId('games-row').first().locator('input[type="checkbox"]').check();
    await expect(bar).toBeVisible();
    await expect(page.getByTestId('games-selection')).toHaveText('1 selected');
    await expect(page.getByTestId('btn-games-analyze')).toHaveText('Analyze 1');
    await page.getByTestId('games-select-all').check();
    await expect(page.getByTestId('btn-games-analyze')).toHaveText('Analyze 2');
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'desktop-games-selected.png') });
    await page.getByTestId('btn-games-clear-selection').click();
    await expect(bar).toBeHidden();
    await expect(page.getByTestId('games-select-all')).not.toBeChecked();

    // Analyze from the bar queues the selected game
    await page.getByTestId('games-row').first().locator('input[type="checkbox"]').check();
    await page.getByTestId('games-analyze-preset').selectOption('quick');
    await page.getByTestId('btn-games-analyze').click();
    await expect(bar).toBeHidden();
    await expect
      .poll(() => page.evaluate(async () => (await window.__wizardChessLibraryReady!).queue.pending().length), {
        timeout: 5000,
      })
      .toBeGreaterThan(0);
  });

  test('phone: nothing sideways, the selection bar above the tab bar', async ({ page }) => {
    await openGames(page, 390, 844);
    await paste(page, TWO_GAMES);
    await expect(page.getByTestId('games-row')).toHaveCount(2);
    await page.getByTestId('games-select-all').check();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    const bar = (await page.getByTestId('games-selbar').boundingBox())!;
    const nav = (await page.getByTestId('main-nav').boundingBox())!;
    expect(bar.y + bar.height).toBeLessThanOrEqual(nav.y);
    expect(bar.x + bar.width).toBeLessThanOrEqual(390);
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'phone-games-selected.png') });
  });
});
