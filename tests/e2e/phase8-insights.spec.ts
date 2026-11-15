import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type Page, type Route } from '@playwright/test';
import { saveMyAccounts } from './helpers/accounts';
import { SITE_URL } from './helpers/site';

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

// ---------------------------------------------------------------------------------------------------------------------
// Insights from games reviewed in advance: accuracy, and blunders and mistakes per 10 moves, by calendar quarter. The
// games are the sample link's invented games, repeated, each with an invented batch summary written here. They sit on
// mid-month days at 12:00 UTC, so a game is in the same quarter and on the same listed day in any time zone from
// UTC-12 to UTC+11. Nothing here comes from gift.local/, and no real name, game or number appears.
// ---------------------------------------------------------------------------------------------------------------------
type QuarterId = [year: number, quarter: 1 | 2 | 3 | 4];
interface SampleGame {
  id: string;
  playerColor: 'w' | 'b';
  pgn: string;
  [field: string]: unknown;
}

const SAMPLE_HISTORY = path.join('public', 'start', 'sample', 'history.json');
const sampleFile = (): { games: SampleGame[]; [field: string]: unknown } =>
  JSON.parse(fs.readFileSync(SAMPLE_HISTORY, 'utf8'));
const fulfilJson = (route: Route, body: unknown) =>
  route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

/** `count` quarters in a row from `from`. */
const quartersFrom = (from: QuarterId, count: number): QuarterId[] =>
  Array.from({ length: count }, (_, k) => {
    const index = from[0] * 4 + (from[1] - 1) + k;
    return [Math.floor(index / 4), ((index % 4) + 1) as 1 | 2 | 3 | 4];
  });
const SIX = quartersFrom([2025, 1], 6); // 2025 Q1 to 2026 Q2
const TWENTY_ONE = quartersFrom([2021, 4], 21); // 2021 Q4 to 2026 Q4: the number of quarters of the real history
// Five quarters with holes: one missing quarter after 2025 Q2, then three missing after 2026 Q1
const WITH_GAPS: QuarterId[] = [
  [2025, 1],
  [2025, 2],
  [2025, 4],
  [2026, 1],
  [2026, 4],
];

/** The invented review numbers of game `i` in the `k`-th quarter. Integers, so a mean never depends on the order of a sum. */
const invented = (k: number, i: number) => ({
  accuracy: 60 + k + ((i * 7) % 15),
  moves: 20 + (i % 5),
  blunder: i % 3,
  mistake: 1 + (i % 2),
});

const two = (n: number): string => String(n).padStart(2, '0');

/**
 * `per` invented games in each quarter, the first `reviewed` of them with a batch summary. The PGN's date headers are
 * rewritten to the same day, because the Games list filters by them.
 */
function quarterHistory(quarters: QuarterId[], per = 12, reviewed = per): SampleGame[] {
  const base = sampleFile().games;
  const games: SampleGame[] = [];
  quarters.forEach(([year, quarter], k) => {
    for (let i = 0; i < per; i++) {
      const g = base[(k * per + i) % base.length]!;
      const month = (quarter - 1) * 3 + (i % 3);
      const dayOfMonth = 10 + (i % 10);
      const playedAt = Date.UTC(year, month, dayOfMonth, 12);
      const pgnDate = `${year}.${two(month + 1)}.${two(dayOfMonth)}`;
      const pgn = g.pgn
        .replace(/\[Date "[^"]*"\]/, `[Date "${pgnDate}"]`)
        .replace(/\[UTCDate "[^"]*"\]/, `[UTCDate "${pgnDate}"]`)
        .replace(/\[UTCTime "[^"]*"\]/, '[UTCTime "12:00:00"]');
      const n = invented(k, i);
      const side = {
        moves: n.moves,
        acpl: 40,
        inaccuracy: 2,
        mistake: n.mistake,
        blunder: n.blunder,
        miss: 0,
        brilliant: 0,
        great: 0,
        low: 40,
        drop: 20,
        dropPly: 11,
      };
      games.push({
        ...g,
        id: `${g.id}-q${k}-${i}`,
        pgn,
        date: pgnDate,
        playedAt,
        ...(i < reviewed
          ? {
              accuracy: n.accuracy,
              analysis: {
                preset: null,
                savedAt: 1,
                depth: 18,
                summaryOnly: true,
                plies: n.moves * 2,
                whiteAccuracy: g.playerColor === 'w' ? n.accuracy : null,
                blackAccuracy: g.playerColor === 'b' ? n.accuracy : null,
                sides: { [g.playerColor]: side },
              },
            }
          : {}),
      });
    }
  });
  return games;
}

/** What the page must show for the `k`-th quarter, from the same invented numbers (own arithmetic, not the app's). */
function expectedQuarter(quarters: QuarterId[], k: number, reviewed: number) {
  let accuracy = 0;
  let blunders = 0;
  let mistakes = 0;
  let moves = 0;
  for (let i = 0; i < reviewed; i++) {
    const n = invented(k, i);
    accuracy += n.accuracy;
    blunders += n.blunder;
    mistakes += n.mistake;
    moves += n.moves;
  }
  const [year, quarter] = quarters[k]!;
  const label = `${year} Q${quarter}`;
  const first = `${year}-${two((quarter - 1) * 3 + 1)}-01`;
  const lastMonth = quarter * 3;
  const last = `${year}-${two(lastMonth)}-${lastMonth === 6 || lastMonth === 9 ? '30' : '31'}`;
  const blundersPer10 = (blunders / moves) * 10;
  const mistakesPer10 = (mistakes / moves) * 10;
  return {
    label,
    from: first,
    to: last,
    accuracy: (accuracy / reviewed).toFixed(1),
    blundersPer10: blundersPer10.toFixed(1),
    mistakesPer10: mistakesPer10.toFixed(1),
    accuracyLabel: `${label}: ${(accuracy / reviewed).toFixed(1)}% over ${reviewed} games`,
    errorsLabel: `${label}: ${blundersPer10.toFixed(1)} blunders and ${mistakesPer10.toFixed(1)} mistakes per 10 moves over ${reviewed} games`,
  };
}

/** A folder OUTSIDE the repository for look-at screenshots; with it unset nothing is saved. */
const INSIGHTS_LOOK_DIR = process.env.INSIGHTS_LOOK_DIR ?? '';
function insightsLookDir(): string | null {
  if (INSIGHTS_LOOK_DIR === '') return null;
  const dir = path.resolve(INSIGHTS_LOOK_DIR);
  const rel = path.relative(process.cwd(), dir);
  if (!rel.startsWith('..') && !path.isAbsolute(rel))
    throw new Error('INSIGHTS_LOOK_DIR must be outside the repository');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
/** The two new cards, as a whole page view and one picture each. */
async function lookAtQuarterCards(page: Page, name: string): Promise<void> {
  const dir = insightsLookDir();
  if (!dir) return;
  const project = test.info().project.name;
  const accuracy = page.locator('section[aria-labelledby="ins-acc-time"]');
  const errors = page.locator('section[aria-labelledby="ins-err-time"]');
  await accuracy.scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(dir, `${project}-${name}-view.png`) });
  await accuracy.screenshot({ path: path.join(dir, `${project}-${name}-accuracy.png`) });
  await errors.screenshot({ path: path.join(dir, `${project}-${name}-errors.png`) });
}

async function closeWelcomeIfShown(page: Page): Promise<void> {
  const welcome = page.getByTestId('welcome-sheet');
  await welcome.waitFor({ state: 'visible', timeout: 8000 }).catch(() => undefined);
  if (await welcome.isVisible()) {
    await page.getByTestId('welcome-done').click();
    await expect(welcome).toBeHidden();
  }
}

const storedGameCount = (page: Page) =>
  page.evaluate(() => window.__wizardChessLibrary?.library.listIds().then((ids) => ids.length) ?? -1).catch(() => -1);

/** Opens the sample link with `games` as its history, waits for them to be stored, and opens Games › Insights. */
async function openInsights(page: Page, games: SampleGame[], width: number, height = 844): Promise<void> {
  await page.setViewportSize({ width, height });
  await page.route('**/start/sample/history.json', (route) => fulfilJson(route, { ...sampleFile(), games }));
  await page.goto('/start/sample/');
  await expect(page.getByTestId('app-shell')).toHaveAttribute('data-first-run', 'applied', { timeout: 15_000 });
  await closeWelcomeIfShown(page);
  await expect.poll(() => storedGameCount(page), { timeout: 20_000 }).toBe(games.length);
  await page.getByTestId('mode-tab-games').click();
  await page.getByTestId('games-tab-insights').click();
  await expect(page.getByTestId('insights-summary')).toBeVisible();
}

const points = (page: Page, chart: 'chart-accuracy-time' | 'chart-errors-time') =>
  page.getByTestId(chart).locator('[role="button"]');

/** The Games list's filter, as the click on a quarter set it. */
async function expectQuarterList(page: Page, from: string, to: string, rows: number): Promise<void> {
  await expect(page.getByTestId('games-tab-library')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('games-filter-from')).toHaveValue(from);
  await expect(page.getByTestId('games-filter-to')).toHaveValue(to);
  await expect(page.getByTestId('games-filter-accuracy')).toHaveValue('0');
  await expect(page.getByTestId('games-row')).toHaveCount(rows);
}

test.describe('Insights: quarters from games reviewed in advance', () => {
  test.use({
    storageState: {
      cookies: [],
      origins: [
        {
          origin: SITE_URL,
          localStorage: [
            { name: 'wc-install-guide-seen', value: '1' },
            { name: 'wc.story.v1', value: 'skipped' },
          ],
        },
      ],
    },
  });

  test('wide: the header, the old cards, the numbers the test computes, and a click opens that quarter’s games', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await openInsights(page, quarterHistory(SIX), 1280, 800);
    // 72 games reviewed in advance, none reviewed here
    await expect(page.getByTestId('insights-summary')).toHaveText(
      '0 reviewed games of yours · 72 reviewed in advance · 72 of yours in all',
    );
    // The cards that need a review made here say so, and that the numbers of the games reviewed in advance are below
    const needs = page.locator('[data-empty="true"]', {
      hasText:
        'These need a game reviewed on this device (Games › Analyze). 72 games were reviewed in advance; their numbers are below.',
    });
    await expect(needs).toHaveCount(3); // accuracy by phase, blunders per 10 moves, the motifs
    await expect(page.getByTestId('chart-phase')).toHaveCount(0);

    for (const chart of ['chart-accuracy-time', 'chart-errors-time'] as const) {
      await expect(points(page, chart)).toHaveCount(6);
    }
    for (let k = 0; k < SIX.length; k++) {
      const want = expectedQuarter(SIX, k, 12);
      await expect(points(page, 'chart-accuracy-time').nth(k)).toHaveAttribute('aria-label', want.accuracyLabel);
      await expect(points(page, 'chart-errors-time').nth(k)).toHaveAttribute('aria-label', want.errorsLabel);
    }
    const first = expectedQuarter(SIX, 0, 12);
    const last = expectedQuarter(SIX, 5, 12);
    await expect(page.getByTestId('insight-ends-accuracy')).toHaveText(
      `From ${first.label} (${first.accuracy}%) to ${last.label} (${last.accuracy}%).`,
    );
    await expect(page.getByTestId('insight-ends-errors')).toHaveText(
      `From ${first.label} (${first.blundersPer10} blunders, ${first.mistakesPer10} mistakes) to ${last.label} (${last.blundersPer10} blunders, ${last.mistakesPer10} mistakes), per 10 moves.`,
    );
    await expect(page.getByTestId('chart-accuracy-time')).toHaveAttribute('viewBox', '0 0 640 220');
    // The errors chart has a second, dashed line with hollow dots, which are not in the tab order; the card says so
    await expect(page.locator('section[aria-labelledby="ins-err-time"] .wc-insight-hint').first()).toHaveText(
      "Per 10 of your moves, by quarter: blunders as the solid line with filled dots, mistakes as the dashed line with hollow dots. Click a point for that quarter's games.",
    );
    await expect(page.getByTestId('chart-errors-time').locator('path.wc-chart-line-2')).toHaveCount(1);
    await expect(page.getByTestId('chart-errors-time').locator('.wc-chart-point-2')).toHaveCount(6);
    // On a wide screen there is no readout
    await expect(page.getByTestId('insight-readout-accuracy')).toBeHidden();
    await lookAtQuarterCards(page, '1280-six-quarters');

    // A click opens that quarter's games straight away: 2025 Q2, 12 games
    const q2 = expectedQuarter(SIX, 1, 12);
    await points(page, 'chart-accuracy-time').nth(1).click();
    await expectQuarterList(page, q2.from, q2.to, 12);

    // From the keyboard: Enter on a point of the other chart opens its quarter (2025 Q4)
    await page.getByTestId('games-tab-insights').click();
    const q4 = expectedQuarter(SIX, 3, 12);
    await points(page, 'chart-errors-time').nth(3).focus();
    await page.keyboard.press('Enter');
    await expectQuarterList(page, q4.from, q4.to, 12);
  });

  test('narrow: a tap picks the quarter and shows it; the button opens the list', async ({ page }) => {
    test.setTimeout(120_000);
    await openInsights(page, quarterHistory(SIX), 390);
    const accuracy = points(page, 'chart-accuracy-time');
    const errors = points(page, 'chart-errors-time');
    await expect(page.getByTestId('chart-accuracy-time')).toHaveAttribute('viewBox', '0 0 360 220');
    await expect(page.getByTestId('insight-readout-accuracy')).toBeHidden();

    // A tap picks: nothing is opened, the readout shows the full label, the point is marked
    await accuracy.nth(1).click();
    await expect(page.getByTestId('games-tab-insights')).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByTestId('insight-readout-accuracy')).toBeVisible();
    await expect(page.getByTestId('insight-readout-text-accuracy')).toHaveText(
      expectedQuarter(SIX, 1, 12).accuracyLabel,
    );
    await expect(accuracy.nth(1)).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('chart-accuracy-time').locator('[data-selected="true"]')).toHaveCount(1);
    // Each chart has its own pick
    await expect(page.getByTestId('insight-readout-errors')).toBeHidden();
    await lookAtQuarterCards(page, '390-picked');

    // Another tap moves the pick
    await accuracy.nth(3).click();
    await expect(page.getByTestId('insight-readout-text-accuracy')).toHaveText(
      expectedQuarter(SIX, 3, 12).accuracyLabel,
    );
    await expect(accuracy.nth(1)).toHaveAttribute('aria-pressed', 'false');
    await expect(accuracy.nth(3)).toHaveAttribute('aria-pressed', 'true');

    // The keyboard: Enter on a focused point picks it, and the focus stays on the point
    await accuracy.nth(2).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('insight-readout-text-accuracy')).toHaveText(
      expectedQuarter(SIX, 2, 12).accuracyLabel,
    );
    await expect(accuracy.nth(2)).toBeFocused();

    // The other chart: its readout has the blunders and mistakes label; the first chart's pick stays
    await errors.nth(4).click();
    await expect(page.getByTestId('insight-readout-text-errors')).toHaveText(expectedQuarter(SIX, 4, 12).errorsLabel);
    await expect(page.getByTestId('insight-readout-text-accuracy')).toHaveText(
      expectedQuarter(SIX, 2, 12).accuracyLabel,
    );

    // "Show these games" opens the list with that quarter's days (2025 Q3), and it is a touch-sized button
    const button = page.getByTestId('insight-readout-open-accuracy');
    expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    const q3 = expectedQuarter(SIX, 2, 12);
    await button.click();
    await expectQuarterList(page, q3.from, q3.to, 12);

    // Back in Insights the pick is still there
    await page.getByTestId('games-tab-insights').click();
    await expect(page.getByTestId('insight-readout-text-accuracy')).toHaveText(q3.accuracyLabel);
    await expect(page.getByTestId('insight-readout-text-errors')).toHaveText(expectedQuarter(SIX, 4, 12).errorsLabel);
  });

  test('turning the screen across 760 px keeps the pick and changes what a click does', async ({ page }) => {
    test.setTimeout(120_000);
    await openInsights(page, quarterHistory(SIX), 390);
    await points(page, 'chart-accuracy-time').nth(1).click();
    await expect(page.getByTestId('insight-readout-accuracy')).toBeVisible();

    // Wide: drawn 640 units wide, no readout, no marker
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(page.getByTestId('chart-accuracy-time')).toHaveAttribute('viewBox', '0 0 640 220');
    await expect(page.getByTestId('insight-readout-accuracy')).toBeHidden();
    await expect(page.locator('[data-selected="true"]')).toHaveCount(0);
    await expect(points(page, 'chart-accuracy-time').nth(1)).toHaveAttribute('aria-pressed', 'false');

    // Narrow again: the pick comes back
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByTestId('chart-accuracy-time')).toHaveAttribute('viewBox', '0 0 360 220');
    await expect(page.getByTestId('insight-readout-text-accuracy')).toHaveText(
      expectedQuarter(SIX, 1, 12).accuracyLabel,
    );
    await expect(points(page, 'chart-accuracy-time').nth(1)).toHaveAttribute('aria-pressed', 'true');

    // Wide once more: a click now opens the list directly, for the quarter clicked
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(page.getByTestId('insight-readout-accuracy')).toBeHidden();
    const q1 = expectedQuarter(SIX, 0, 12);
    await points(page, 'chart-accuracy-time').nth(0).click();
    await expectQuarterList(page, q1.from, q1.to, 12);
  });

  test('the real history has 21 quarters: at 390 px both charts stay usable', async ({ page }) => {
    test.setTimeout(180_000);
    await openInsights(page, quarterHistory(TWENTY_ONE), 390);
    for (const chart of ['chart-accuracy-time', 'chart-errors-time'] as const) {
      await expect(points(page, chart)).toHaveCount(21);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    await expect(page.getByTestId('insight-ends-accuracy')).toBeVisible();
    await expect(page.getByTestId('insight-ends-errors')).toBeVisible();

    // The axis text is drawn at a readable size (360 units wide, scaled to the card)
    const axis = await page.getByTestId('chart-accuracy-time').locator('text.wc-chart-axis').first().boundingBox();
    expect(axis!.height).toBeGreaterThanOrEqual(8);

    // The tap strips tile the plot: none overlaps its neighbour, each is wide enough to hit, each is as tall as the plot
    const strips = await page
      .getByTestId('chart-accuracy-time')
      .locator('rect.wc-chart-hit')
      .evaluateAll((rects) =>
        rects.map((r) => {
          const b = r.getBoundingClientRect();
          return { left: b.left, right: b.right, width: b.width, height: b.height };
        }),
      );
    expect(strips).toHaveLength(21);
    for (let i = 1; i < strips.length; i++) expect(strips[i]!.left).toBeGreaterThanOrEqual(strips[i - 1]!.right - 0.6);
    expect(Math.min(...strips.slice(1, -1).map((s) => s.width))).toBeGreaterThanOrEqual(12);
    expect(Math.min(...strips.map((s) => s.height))).toBeGreaterThanOrEqual(100);
    // The first and the last strip reach out into the margin: each is as wide as the strips between them (a full step),
    // and neither goes past the drawing's own edge
    const drawing = (await page.getByTestId('chart-accuracy-time').boundingBox())!;
    const step = strips[1]!.width;
    expect(strips[0]!.width).toBeGreaterThanOrEqual(step - 0.6);
    expect(strips[20]!.width).toBeGreaterThanOrEqual(step - 0.6);
    expect(strips[0]!.left).toBeGreaterThanOrEqual(drawing.x - 0.6);
    expect(strips[20]!.right).toBeLessThanOrEqual(drawing.x + drawing.width + 0.6);
    await lookAtQuarterCards(page, '390-21-quarters');

    // A tap low in the 11th column, away from its dot, picks the 11th quarter; the first and the last column pick theirs
    await page.locator('section[aria-labelledby="ins-acc-time"]').scrollIntoViewIfNeeded();
    for (const k of [10, 0, 20]) {
      const box = (await page.getByTestId('chart-accuracy-time').locator('rect.wc-chart-hit').nth(k).boundingBox())!;
      await page.mouse.click(box.x + box.width / 2, box.y + box.height - 6);
      await expect(page.getByTestId('insight-readout-text-accuracy')).toHaveText(
        expectedQuarter(TWENTY_ONE, k, 12).accuracyLabel,
      );
    }
    // And the button opens the last of them (2026 Q4)
    const last = expectedQuarter(TWENTY_ONE, 20, 12);
    await page.getByTestId('insight-readout-open-accuracy').click();
    await expectQuarterList(page, last.from, last.to, 12);
  });

  test('with a quarter missing, the points keep their place on the time axis and the strips tile the plot', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await openInsights(page, quarterHistory(WITH_GAPS), 390);
    await expect(points(page, 'chart-accuracy-time')).toHaveCount(5);
    const strips = await page
      .getByTestId('chart-accuracy-time')
      .locator('rect.wc-chart-hit')
      .evaluateAll((rects) =>
        rects.map((r) => {
          const b = r.getBoundingClientRect();
          return { left: b.left, right: b.right, width: b.width };
        }),
      );
    for (let i = 1; i < strips.length; i++) expect(strips[i]!.left).toBeGreaterThanOrEqual(strips[i - 1]!.right - 0.6);
    // The dots stand where their quarters are: 2025 Q1, Q2, Q4, 2026 Q1, 2026 Q4 are 0, 1, 3, 4 and 7 quarters from the first
    const x = await page
      .getByTestId('chart-accuracy-time')
      .locator('circle.wc-chart-dot')
      .evaluateAll((dots) => dots.map((d) => d.getBoundingClientRect().left + d.getBoundingClientRect().width / 2));
    const unit = x[1]! - x[0]!;
    expect((x[2]! - x[0]!) / unit).toBeCloseTo(3, 1);
    expect((x[3]! - x[0]!) / unit).toBeCloseTo(4, 1);
    expect((x[4]! - x[0]!) / unit).toBeCloseTo(7, 1);
    // A strip reaches half the way to each neighbour, so a point next to a gap has a wider strip than one between near neighbours
    expect(strips[1]!.width).toBeGreaterThan(strips[0]!.width);
    await lookAtQuarterCards(page, '390-gaps');
  });

  test('the mistakes dots are hollow rings; the blunders and the accuracy dots are filled', async ({ page }) => {
    test.setTimeout(120_000);
    await openInsights(page, quarterHistory(SIX), 390);
    const dots = await page.evaluate(() => {
      const look = (selector: string) => {
        const dot = document.querySelector(selector)!;
        const s = getComputedStyle(dot);
        return { fill: s.fill, stroke: s.stroke, r: s.r };
      };
      return {
        card: getComputedStyle(document.querySelector('section[aria-labelledby="ins-err-time"]')!).backgroundColor,
        accuracy: look(
          '[data-testid="chart-accuracy-time"] .wc-chart-point:not(.wc-chart-point-2) circle.wc-chart-dot',
        ),
        blunders: look('[data-testid="chart-errors-time"] .wc-chart-point:not(.wc-chart-point-2) circle.wc-chart-dot'),
        mistakes: look('[data-testid="chart-errors-time"] .wc-chart-point-2 circle.wc-chart-dot'),
      };
    });
    // Filled: the dot is painted in the series colour, not in the card's
    expect(dots.accuracy.fill).not.toBe(dots.card);
    expect(dots.blunders.fill).toBe(dots.accuracy.fill);
    expect(dots.blunders.stroke).toBe(dots.accuracy.stroke);
    // Hollow: the inside is the card's own colour and the ring is in the other series colour
    expect(dots.mistakes.fill).toBe(dots.card);
    expect(dots.mistakes.stroke).not.toBe(dots.mistakes.fill);
    expect(dots.mistakes.stroke).not.toBe(dots.blunders.fill);
    expect(dots.mistakes.stroke).not.toBe(dots.blunders.stroke);
    // The same size, so the strip and the picked-point marker line up for both
    expect(dots.mistakes.r).toBe(dots.blunders.r);
    expect(dots.mistakes.r).toBe(dots.accuracy.r);
  });

  test('under 20 reviewed games both cards say what they need', async ({ page }) => {
    test.setTimeout(120_000);
    // 72 games, 12 of them reviewed in advance
    await openInsights(page, quarterHistory(quartersFrom([2025, 1], 2), 36, 6), 390);
    await expect(page.getByTestId('insights-summary')).toHaveText(
      '0 reviewed games of yours · 12 reviewed in advance · 72 of yours in all',
    );
    for (const kind of ['accuracy', 'errors']) {
      const box = page.getByTestId(`insight-time-${kind}`);
      await expect(box).toContainText('Needs 20 reviewed games (12 so far).');
      await expect(box.locator('svg')).toHaveCount(0);
    }
    await lookAtQuarterCards(page, '390-not-enough');
  });

  test('20 reviewed games with no quarter of 10 say so', async ({ page }) => {
    test.setTimeout(120_000);
    // Four games in each of five quarters
    await openInsights(page, quarterHistory(quartersFrom([2025, 1], 5), 4), 390);
    for (const kind of ['accuracy', 'errors']) {
      const box = page.getByTestId(`insight-time-${kind}`);
      await expect(box).toContainText('No quarter has 10 reviewed games yet.');
      await expect(box.locator('svg')).toHaveCount(0);
    }
    await lookAtQuarterCards(page, '390-no-quarter');
  });
});
