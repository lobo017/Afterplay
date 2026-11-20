import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';

// The Library's Time filter: All, Bullet, Blitz, Rapid, Classical, Daily (the Story's own classes). The games are made
// up for the test (no personal data).
const SCREENSHOT_DIR = path.join('test-results', 'library-time-filter-screens');
fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

const MOVES = '1. e4 c5 2. Nf3 d6 3. d4 cxd4 4. Nxd4 Nf6 5. Nc3 a6';
const fixture = (white: string, date: string, timeControl: string | null) =>
  `[Event "Fixture"]\n[White "${white}"]\n[Black "Opp Fixture"]\n[Result "1-0"]\n[Date "${date}"]\n${
    timeControl === null ? '' : `[TimeControl "${timeControl}"]\n`
  }\n${MOVES} 1-0`;

const FIXTURES = [
  fixture('Bea Bullet', '2026.10.07', '60'),
  fixture('Bo Blitz', '2026.10.06', '300'),
  fixture('Bo Oldblitz', '2026.09.01', '180+2'),
  fixture('Ray Rapid', '2026.10.05', '900+10'),
  fixture('Cleo Classical', '2026.10.04', '1800'),
  fixture('Dana Daily', '2026.10.03', '1/86400'),
  fixture('Una Unknown', '2026.10.02', null),
].join('\n\n');

const NAMES = {
  all: ['Bea Bullet', 'Bo Blitz', 'Ray Rapid', 'Cleo Classical', 'Dana Daily', 'Una Unknown', 'Bo Oldblitz'],
  bullet: ['Bea Bullet'],
  blitz: ['Bo Blitz', 'Bo Oldblitz'],
  rapid: ['Ray Rapid'],
  classical: ['Cleo Classical'],
  daily: ['Dana Daily'],
} as const;

async function open(page: Page, width: number, height: number): Promise<void> {
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
  await expect(page.getByTestId('games-row')).toHaveCount(7);
}

const shown = (page: Page) => page.getByTestId('games-row-opponent').locator('.wc-games-opp-name');
const who = (names: readonly string[]) => names.map((n) => `${n} vs Opp Fixture`);

test.describe('Library — Time filter', () => {
  test('is a labelled select with the Story’s class names', async ({ page }) => {
    await open(page, 1280, 720);
    const time = page.getByRole('combobox', { name: /^Time\b/ });
    await expect(time).toHaveCount(1);
    await expect(time).toHaveAttribute('data-testid', 'games-filter-time');
    await expect(time.locator('option')).toHaveText(['All', 'Bullet', 'Blitz', 'Rapid', 'Classical', 'Daily']);
    await expect(time).toHaveValue('all');
  });

  test('picks each class, combines with another filter and the sort, then resets to All', async ({ page }) => {
    await open(page, 1280, 720);
    const time = page.getByTestId('games-filter-time');
    await expect(shown(page)).toHaveText(who(NAMES.all));
    await expect(page.getByTestId('games-count')).toHaveText('7 games');

    for (const [value, label] of [
      ['bullet', 'Bullet'],
      ['blitz', 'Blitz'],
      ['rapid', 'Rapid'],
      ['classical', 'Classical'],
      ['daily', 'Daily'],
    ] as const) {
      await time.selectOption(label);
      await expect(time).toHaveValue(value);
      await expect(shown(page)).toHaveText(who(NAMES[value]));
      await expect(page.getByTestId('btn-games-clear-filters')).toBeVisible();
      await expect(page.getByTestId('games-count')).toHaveText(`${NAMES[value].length} of 7 games`);
    }

    // The game with no readable time control is under All only
    await time.selectOption('All');
    await expect(shown(page)).toHaveText(who(NAMES.all));
    await expect(shown(page).filter({ hasText: 'Una Unknown' })).toHaveCount(1);
    await expect(page.getByTestId('btn-games-clear-filters')).toBeHidden();
    await expect(page.getByTestId('games-count')).toHaveText('7 games');

    // With another filter and with the sort
    await time.selectOption('Blitz');
    await page.getByTestId('games-filter-from').fill('2026-10-01');
    await expect(shown(page)).toHaveText(who(['Bo Blitz']));
    await expect(page.getByTestId('games-count')).toHaveText('1 of 7 games');
    await expect(page.getByTestId('games-filter-count')).toHaveText('(2)');
    await page.getByTestId('games-filter-from').fill('');
    await page.getByTestId('games-sort').selectOption('oldest');
    await expect(shown(page)).toHaveText(who(['Bo Oldblitz', 'Bo Blitz']));
    await page.getByTestId('games-sort').selectOption('opponent');
    await expect(shown(page)).toHaveText(who(['Bo Blitz', 'Bo Oldblitz']));

    // Clear filters puts the select back on All
    await page.getByTestId('btn-games-clear-filters').click();
    await expect(time).toHaveValue('all');
    await expect(shown(page)).toHaveCount(7);
  });

  test('the filter is not remembered after a reload (the other filters are not either)', async ({ page }) => {
    await open(page, 1280, 720);
    await page.getByTestId('games-filter-time').selectOption('Daily');
    await expect(page.getByTestId('games-row')).toHaveCount(1);
    await page.reload();
    await expect(page.getByTestId('games-row')).toHaveCount(7);
    await expect(page.getByTestId('games-filter-time')).toHaveValue('all');
  });

  for (const [width, height, phone] of [
    [375, 667, true],
    [390, 844, true],
    [1280, 720, false],
  ] as const) {
    test(`layout at ${width}x${height}: the control is whole, nothing is pushed off screen`, async ({ page }) => {
      await open(page, width, height);
      const time = page.getByTestId('games-filter-time');
      await time.scrollIntoViewIfNeeded();
      const box = (await time.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(width);
      if (phone) expect(box.height).toBeGreaterThanOrEqual(44);
      // The label, the select and the whole filter row sit inside the screen
      const label = page.locator('label.wc-games-time-filter');
      const labelBox = (await label.boundingBox())!;
      expect(labelBox.x).toBeGreaterThanOrEqual(0);
      expect(labelBox.x + labelBox.width).toBeLessThanOrEqual(width);
      const overflow = await page.evaluate(() => ({
        page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        row: (() => {
          const row = document.querySelector('.wc-games-filters') as HTMLElement;
          return row.scrollWidth - row.clientWidth;
        })(),
        outside: [...document.querySelectorAll<HTMLElement>('.wc-games-filters > label')].filter((l) => {
          const r = l.getBoundingClientRect();
          return r.left < 0 || r.right > window.innerWidth;
        }).length,
      }));
      expect(overflow.page).toBeLessThanOrEqual(0);
      expect(overflow.row).toBeLessThanOrEqual(0);
      expect(overflow.outside).toBe(0);
      // It works at this size too
      await time.selectOption('Daily');
      await expect(shown(page)).toHaveText(who(NAMES.daily));
      await time.selectOption('All');
      await expect(page.getByTestId('games-row')).toHaveCount(7);
      await page.locator('.wc-games-toolbar').scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(SCREENSHOT_DIR, `filters-${width}x${height}.png`) });
    });
  }
});
