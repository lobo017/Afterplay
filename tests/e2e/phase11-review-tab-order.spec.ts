import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';

// The Review tab of a reviewed game reads like a story: the banner, "How you played" (open by default), the accuracy
// cards, the key moments, the flow of the game, the repertoire note, then the "Review as" bar. On wide screens the
// scrollbars are thin and themed, the key moments wrap instead of scrolling, and the "Review as" bar has its own height
// with no blank space under it. A game under 10 plies shows "Too short to review" and is not counted as waiting.
// Every game and name here is invented.
const SCREENSHOT_DIR = path.join('test-results', 'phase11-screens');

const FIRST = `[White "Ann"]
[Black "Ben"]
[Result "*"]

1. e4 e5 2. Qh5 Nc6 3. Qxe5+ Nxe5 4. d4 Nc6 5. d5 Nb4 6. a3 Nxd5 7. exd5 Qe7+ 8. Be2 Qxe2+ 9. Nxe2 d6 10. Nbc3 Bg4 11. Nf4 Nf6 12. Nb5 a6 13. Nxc7+ Kd7 14. Nxa8 *`;
const SECOND = `[White "Cy"]
[Black "Dee"]
[Result "*"]

1. d4 d5 2. c4 e6 3. Nc3 Nf6 4. Bg5 Be7 5. e3 O-O 6. Nf3 h6 7. Bh4 b6 8. cxd5 exd5 9. Bd3 Bb7 10. O-O Nbd7 *`;

const touch = () => test.info().project.name === 'webkit-iphone';
const SIZES = [
  { width: 375, height: 667 },
  { width: 390, height: 844 },
  { width: 900, height: 800 },
  { width: 1280, height: 720 },
  { width: 1366, height: 768 },
  { width: 1536, height: 864 },
  { width: 1920, height: 1080 },
] as const;

async function press(page: Page, testId: string): Promise<void> {
  const el = page.getByTestId(testId);
  if (touch()) await el.tap();
  else await el.click();
}

async function review(page: Page, pgn: string): Promise<void> {
  await page.evaluate((text) => window.__wizardChessAnalysis!.controller.importPgn(text), pgn);
  await page.getByTestId('btn-review-start').click();
  await expect(page.getByTestId('review-panel')).toHaveAttribute('data-state', 'done', { timeout: 150_000 });
}

test.describe('Phase 11 — the Review tab of a reviewed game', () => {
  test('sections in story order, "How you played" open by default, no link, nothing clipped', async ({ page }) => {
    test.setTimeout(300_000);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto('/#review');
    await expect(page.getByTestId('analysis-layout')).toBeVisible();
    await page.getByTestId('select-review-preset').selectOption('quick');
    await review(page, FIRST);

    const fold = page.getByTestId('review-classes');
    await expect(fold.locator('summary')).toHaveText('How you played');
    await expect(fold).toHaveJSProperty('open', true);
    await expect(page.getByTestId('review-counts')).toBeVisible();
    // The link to browse moments is gone
    await expect(page.getByTestId('btn-review-see-all')).toHaveCount(0);

    for (const size of SIZES) {
      await page.setViewportSize(size);
      await page.waitForTimeout(250);
      const r = await page.evaluate(() => {
        const q = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`)!;
        // Positions are read with the panel scrolled to its top; the "Review as" bar sticks to the bottom of the screen on
        // wide layouts, so it is compared by its place in the page instead
        for (const sc of document.querySelectorAll<HTMLElement>('.wc-panel-body')) sc.scrollTop = 0;
        window.scrollTo(0, 0);
        const top = (el: HTMLElement) => el.getBoundingClientRect().top;
        const ids = [
          'review-progress',
          'review-classes',
          'review-side-w',
          'review-coach',
          'review-chart',
          'btn-review-prev-mistake',
          'review-foot',
        ];
        const order = ids.slice(0, -1).map((id) => [id, Math.round(top(q(id)))] as const);
        const domOrdered = ids.every(
          (id, i) =>
            i === 0 || Boolean(q(ids[i - 1]!).compareDocumentPosition(q(id)) & Node.DOCUMENT_POSITION_FOLLOWING),
        );
        const summary = q('review-classes').querySelector('summary')!;
        return {
          order,
          domOrdered,
          docOverflow: document.documentElement.scrollWidth - window.innerWidth,
          // The scrolling area has no horizontal scroll
          panelOverflow: Math.max(
            0,
            ...[...document.querySelectorAll<HTMLElement>('.wc-panel-body')].map(
              (el) => el.scrollWidth - el.clientWidth,
            ),
          ),
          summaryClipped: summary.scrollWidth - summary.clientWidth,
          // Every row of the table fits its column
          tableOverflow: q('review-counts').scrollWidth - q('review-counts').clientWidth,
        };
      });
      const ys = r.order.map(([, y]) => y);
      expect(ys, `${size.width}x${size.height}: ${r.order.map(([id]) => id).join(' < ')}`).toEqual(
        [...ys].sort((a, b) => a - b),
      );
      expect(new Set(ys).size, 'every section has its own place').toBe(ys.length);
      expect(r.domOrdered, 'the page order is the reading order, ending with the Review as bar').toBe(true);
      expect(r.docOverflow, `${size.width}: no horizontal scroll`).toBeLessThanOrEqual(0);
      expect(r.panelOverflow).toBeLessThanOrEqual(1);
      expect(r.summaryClipped).toBeLessThanOrEqual(0);
      expect(r.tableOverflow).toBeLessThanOrEqual(1);
    }

    // Collapsible, and each new review opens it again
    await fold.locator('summary').click();
    await expect(fold).toHaveJSProperty('open', false);
    await expect(page.getByTestId('review-counts')).toBeHidden();
    // Everything stays reachable with it closed
    for (const id of [
      'review-side-w',
      'review-coach',
      'review-chart',
      'btn-review-next-mistake',
      'review-perspective',
    ]) {
      await page.getByTestId(id).scrollIntoViewIfNeeded();
      await expect(page.getByTestId(id)).toBeVisible();
    }
    await review(page, SECOND);
    await expect(fold).toHaveJSProperty('open', true);
    await expect(page.getByTestId('review-counts')).toBeVisible();
  });

  test('wide screens: thin themed scrollbars, wrapping key moments, and a "Review as" bar with no blank gap', async ({
    page,
  }) => {
    test.setTimeout(400_000);
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto('/#review');
    await expect(page.getByTestId('analysis-layout')).toBeVisible();
    await page.getByTestId('select-review-preset').selectOption('quick');

    for (const [i, pgn] of [FIRST, SECOND].entries()) {
      await review(page, pgn);
      for (const size of SIZES) {
        await page.setViewportSize(size);
        await page.waitForTimeout(250);
        const label = `game ${i + 1} at ${size.width}x${size.height}`;
        const m = await page.evaluate(async () => {
          const q = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`)!;
          const row = q('review-key-moments');
          const foot = q('review-foot');
          const scroller = foot.closest<HTMLElement>('.wc-panel-body')!;
          const inner = getComputedStyle(scroller).overflowY === 'auto';
          const chips = [...row.querySelectorAll<HTMLElement>('.wc-review-moment')];
          const rowBox = row.getBoundingClientRect();
          const outside = chips.filter((c) => {
            const b = c.getBoundingClientRect();
            return b.left < rowBox.left - 1 || b.right > rowBox.right + 1 || b.bottom > rowBox.bottom + 1;
          }).length;
          // Scroll to the very end and measure the bar
          scroller.scrollTop = 1e6;
          window.scrollTo(0, 1e6);
          await new Promise((r) => setTimeout(r, 150));
          const f = foot.getBoundingClientRect();
          const end = inner
            ? scroller.getBoundingClientRect().bottom
            : q('review-panel').getBoundingClientRect().bottom;
          const tip = q('review-formulas-tooltip');
          return {
            inner,
            chips: chips.length,
            outside,
            rowOverflowX: row.scrollWidth - row.clientWidth,
            rowH: rowBox.height,
            rowOverflow: getComputedStyle(row).overflowX,
            scrollbarWidth: getComputedStyle(scroller, '::-webkit-scrollbar').width,
            thumb: getComputedStyle(scroller, '::-webkit-scrollbar-thumb').backgroundColor,
            footH: f.height,
            gapBelow: end - f.bottom,
            tipDisplay: getComputedStyle(tip).display,
            docOverflow: document.documentElement.scrollWidth - window.innerWidth,
          };
        });
        expect(m.docOverflow, label).toBeLessThanOrEqual(0);
        // The key moments: all inside the row, nothing to scroll (so no bar), the reserved height by width
        expect(m.chips, label).toBeGreaterThan(0);
        expect(m.outside, `${label}: every chip is inside its row`).toBe(0);
        expect(m.rowOverflowX, label).toBeLessThanOrEqual(0);
        expect(m.rowOverflow, label).toBe('hidden');
        if (size.width > 760) expect(m.rowH, label).toBeLessThan(7.3 * 16 + 1);
        // The "Review as" bar has its normal height and nothing under it
        expect(m.footH, label).toBeGreaterThan(40);
        expect(m.footH, label).toBeLessThan(80);
        expect(m.gapBelow, `${label}: blank space under the bar`).toBeLessThanOrEqual(size.width > 960 ? 4 : 20);
        expect(m.gapBelow, label).toBeGreaterThanOrEqual(-2);
        // A closed info popup takes no room
        expect(m.tipDisplay, label).toBe('none');
        if (m.inner && test.info().project.name === 'chromium') {
          // Thin, with the app's gold thumb (the browser's own light bar would be 15px wide and grey)
          expect(m.scrollbarWidth, label).toBe('8px');
          expect(m.thumb, label).toMatch(/^rgba\(212, 175, 55, 0\.(5|75)\)$/);
        }
      }
      if (i === 0) {
        await page.setViewportSize({ width: 1280, height: 720 });
        fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
        await page.screenshot({ path: path.join(SCREENSHOT_DIR, `${test.info().project.name}-review-order.png`) });
      }
    }
    // The popup still opens
    await page.setViewportSize({ width: 1280, height: 720 });
    await press(page, 'btn-review-formulas');
    await expect(page.getByTestId('review-formulas-tooltip')).toBeVisible();
  });
});

// A game under 10 plies is too short to review: its row says so, it is not waiting, and its Review tab still offers the
// review.
const SHORT_GAME = (id: string) => ({
  id: `chesscom:${id}`,
  white: 'Ada',
  black: 'Opponent',
  playerColor: 'w',
  result: '1-0',
  date: '2026.10.01',
  openingEco: '',
  openingName: '',
  accuracy: null,
  pgn: `[Event "Live Chess"]\n[Site "Chess.com"]\n[Date "2026.10.01"]\n[White "Ada"]\n[Black "Opponent"]\n[Result "1-0"]\n\n1. e4 e5 2. Qh5 Nc6 3. Bc4 Nf6 4. Qxf7# 1-0`,
  tags: [],
  source: 'chesscom',
  analysis: null,
});
const LONG_GAME = (id: string) => ({
  ...SHORT_GAME(id),
  pgn: `[Event "Live Chess"]\n[Site "Chess.com"]\n[Date "2026.10.02"]\n[White "Ada"]\n[Black "Opponent"]\n[Result "1-0"]\n\n1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7 6. Re1 b5 7. Bb3 d6 1-0`,
});

test.describe('Phase 11 — too short to review', () => {
  test('the row says so, it is not counted as waiting, and its Review tab still offers the review', async ({
    page,
  }) => {
    await page.goto('/');
    await expect(page.getByTestId('play-layout')).toBeVisible();
    await page.evaluate(
      async (records) => {
        const api = await window.__wizardChessLibraryReady!;
        await api.library.saveSyncedGames(records as never);
      },
      [SHORT_GAME('short1'), LONG_GAME('long1')],
    );

    // Train: only the longer game waits
    await press(page, 'mode-tab-train');
    await expect(page.getByTestId('today-games-count')).toHaveText('1');

    await press(page, 'mode-tab-games');
    await press(page, 'games-tab-library');
    const shortRow = page.locator('[data-game-id="chesscom:short1"]');
    const longRow = page.locator('[data-game-id="chesscom:long1"]');
    await expect(shortRow.getByTestId('games-row-analysis')).toHaveText('Too short to review');
    await expect(longRow.getByTestId('games-row-analysis')).toHaveText('Not reviewed');
    await expect(page.getByTestId('games-summary')).toHaveText('2 games · 0 reviewed');
    await page.getByTestId('games-filter-analyzed').selectOption('not-analyzed');
    await expect(page.getByTestId('games-row')).toHaveCount(1);
    await expect(page.getByTestId('games-count')).toHaveText('1 of 2 games');
    await page.getByTestId('games-filter-analyzed').selectOption('all');

    // Open it: the Review tab still offers "Review this game"
    await shortRow.click();
    await expect(page.getByTestId('analysis-layout')).toBeVisible();
    await expect(page.getByTestId('review-start-label')).toHaveText('Review this game');
    await expect(page.getByTestId('btn-review-start')).toBeEnabled();
  });
});
