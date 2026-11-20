import { expect, test, type Page } from '@playwright/test';

// The Library places a daily game (TimeControl 1/N) by the day it ended, in the viewer's time zone. The games below are
// made up for the test: one daily that started 2026-10-04 and ended 2026-11-08 03:15 UTC, one live game between the two
// dates, and one daily with no end. The browser's time zone is fixed to UTC-8, where that end is still 2026-11-07.
test.use({ timezoneId: 'America/Los_Angeles' });

const MOVES = '1. e4 c5 2. Nf3 d6 3. d4 cxd4 4. Nxd4 Nf6 5. Nc3 a6';
const fixture = (white: string, black: string, tags: string) =>
  `[Event "Fixture"]\n[White "${white}"]\n[Black "${black}"]\n[Result "1-0"]\n${tags}\n\n${MOVES} 1-0`;

const FIXTURES = [
  fixture(
    'Dana Daily',
    'Eli Fixture',
    '[Date "2026.10.04"]\n[UTCDate "2026.10.04"]\n[UTCTime "10:00:00"]\n[TimeControl "1/259200"]\n[EndDate "2026.11.08"]\n[EndTime "03:15:00"]',
  ),
  fixture(
    'Liv Live',
    'Max Fixture',
    '[Date "2026.10.20"]\n[UTCDate "2026.10.20"]\n[UTCTime "12:00:00"]\n[TimeControl "180+0"]',
  ),
  fixture(
    'Nia NoEnd',
    'Oz Fixture',
    '[Date "2026.10.28"]\n[UTCDate "2026.10.28"]\n[UTCTime "18:30:00"]\n[TimeControl "1/172800"]',
  ),
].join('\n\n');

async function openLibraryWithFixtures(page: Page, width: number, height: number): Promise<void> {
  await page.setViewportSize({ width, height });
  await page.goto('/#games');
  await page.evaluate(() => window.__wizardChessLibraryReady);
  await expect(page.getByTestId('games-list')).toBeVisible();
  await page.getByTestId('btn-games-import').click();
  await page.getByTestId('btn-games-paste').click();
  await page.getByTestId('games-paste-text').evaluate((el, value) => {
    (el as HTMLTextAreaElement).value = value;
  }, FIXTURES);
  await page.getByTestId('btn-games-paste-import').click();
  await expect(page.getByTestId('games-row')).toHaveCount(3);
}

const names = (page: Page) => page.getByTestId('games-row-opponent').locator('.wc-games-opp-name');

for (const [width, height] of [
  [375, 667],
  [390, 844],
  [1280, 720],
] as const) {
  test(`Library: a daily is placed and dated by its end at ${width}x${height}`, async ({ page }) => {
    await openLibraryWithFixtures(page, width, height);

    // Newest first: the daily that ended 11-07 (local) is first, though it started first of all
    await expect(names(page)).toHaveText([
      'Dana Daily vs Eli Fixture',
      'Nia NoEnd vs Oz Fixture',
      'Liv Live vs Max Fixture',
    ]);
    // The date cell: the end for the daily, the start for the daily with no end and for the live game
    // (the cell is not drawn on a phone; its text is still in the row)
    await expect(page.getByTestId('games-row-date')).toHaveText([
      '2026-11-07 19:15',
      '2026-10-28 11:30',
      '2026-10-20 05:00',
    ]);
    await expect(page.getByTestId('games-row-date').first().locator('.wc-games-date')).toHaveAttribute(
      'title',
      'Ended 2026-11-07 19:15 (America/Los_Angeles)',
    );

    // The date filters read the same day
    await page.getByTestId('games-filter-from').fill('2026-11-01');
    await expect(names(page)).toHaveText(['Dana Daily vs Eli Fixture']);
    await page.getByTestId('games-filter-from').fill('');
    await page.getByTestId('games-filter-to').fill('2026-10-05');
    await expect(page.getByTestId('games-row')).toHaveCount(0);
    await page.getByTestId('btn-games-clear-filters').click();

    // Oldest first reverses it
    await page.getByTestId('games-sort').selectOption('oldest');
    await expect(names(page)).toHaveText([
      'Liv Live vs Max Fixture',
      'Nia NoEnd vs Oz Fixture',
      'Dana Daily vs Eli Fixture',
    ]);
  });
}
