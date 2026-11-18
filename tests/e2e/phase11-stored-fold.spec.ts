import fs from 'node:fs';
import path from 'node:path';
import { Chess } from 'chess.js';
import { expect, test, type Page, type Route } from '@playwright/test';
import { saveMyAccounts } from './helpers/accounts';
import { SITE_URL } from './helpers/site';

// A game with a summary made in advance, opened with no review on this device, shows everything the summary holds at
// once and with no tap: the accuracy and its tiles, "How you played" (the classes the summary counts), accuracy by game
// phase and the one key moment the summary names (my move with the largest loss, a button that goes to it). What needs
// every move stays out: the review's body (accuracy cards, win chart, error stepper) is hidden, "Review this game" and
// its line stay. Nothing runs the engine. The sample link's invented games get invented summaries; every expected number
// and move is worked out here from the fixture, the move from the game's own PGN with chess.js.
test.use({
  storageState: {
    cookies: [],
    origins: [{ origin: SITE_URL, localStorage: [{ name: 'wc-install-guide-seen', value: '1' }] }],
  },
});

const SAMPLE = '/start/sample/';
const SAMPLE_HISTORY = path.join('public', 'start', 'sample', 'history.json');
/** A folder OUTSIDE the repository for screenshots; with it unset nothing is saved. */
const LOOK_DIR = process.env.PHASE_LOOK_DIR ?? '';
const touch = () => test.info().project.name === 'webkit-iphone';
const tap = () => (touch() ? 'Tap' : 'Click');

async function look(page: Page, name: string, testId?: string): Promise<void> {
  if (LOOK_DIR === '') return;
  const dir = path.resolve(LOOK_DIR);
  if (!path.relative(process.cwd(), dir).startsWith('..'))
    throw new Error('PHASE_LOOK_DIR must be outside the repository');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${test.info().project.name}-${name}.png`);
  if (testId) await page.getByTestId(testId).screenshot({ path: file });
  else await page.screenshot({ path: file });
}

interface SampleGame {
  id: string;
  playerColor: 'w' | 'b';
  pgn: string;
  [field: string]: unknown;
}
type Tuple = [number, number, number, number, number];
type Phases = [Tuple, Tuple, Tuple];

const PHASES: Phases = [
  [5, 95.2, 0, 1, 0],
  [3, 70.44, 1, 1, 0],
  [2, 88, 0, 0, 0],
];
/** Game 0: every class has its own count, and a worst move of 23.4 points. Game 1: a worst move of only 3 points. */
const COUNTS = { brilliant: 1, great: 4, inaccuracy: 3, mistake: 2, miss: 5, blunder: 1 };

function summary(g: SampleGame, drop: number, dropPly: number | null) {
  return {
    preset: null,
    savedAt: 1,
    depth: 18,
    summaryOnly: true,
    plies: 20,
    whiteAccuracy: g.playerColor === 'w' ? 84.56 : null,
    blackAccuracy: g.playerColor === 'b' ? 84.56 : null,
    sides: {
      [g.playerColor]: { moves: 10, acpl: 40, ...COUNTS, low: 20, drop, dropPly, phases: PHASES },
    },
  };
}

/** My move at the ply (mine: odd plies for White, even for Black), as the game's PGN gives it. */
const myPly = (g: SampleGame, k: number) => (g.playerColor === 'w' ? 2 * k - 1 : 2 * k);

function history(): SampleGame[] {
  const games = (JSON.parse(fs.readFileSync(SAMPLE_HISTORY, 'utf8')) as { games: SampleGame[] }).games;
  return games.map((g, i) => {
    if (i === 0) return { ...g, accuracy: 84.56, analysis: summary(g, 23.4, myPly(g, 6)) };
    if (i === 1) return { ...g, accuracy: 84.56, analysis: summary(g, 3, myPly(g, 4)) };
    if (i === 2) return { ...g, accuracy: 84.56, analysis: summary(g, 30, null) };
    if (i === 3) return { ...g, accuracy: null, analysis: null };
    return g;
  });
}

const fulfilJson = (route: Route, body: unknown) =>
  route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

async function openWith(page: Page): Promise<SampleGame[]> {
  const games = history();
  const base = JSON.parse(fs.readFileSync(SAMPLE_HISTORY, 'utf8')) as object;
  await page.route('**/start/sample/history.json', (route) => fulfilJson(route, { ...base, games }));
  await page.goto(SAMPLE);
  await expect(page.getByTestId('app-shell')).toHaveAttribute('data-first-run', 'applied', { timeout: 15_000 });
  const welcome = page.getByTestId('welcome-sheet');
  await welcome.waitFor({ state: 'visible', timeout: 8000 }).catch(() => undefined);
  if (await welcome.isVisible()) await page.getByTestId('welcome-done').click();
  await expect
    .poll(
      () =>
        page
          .evaluate(() => window.__wizardChessLibrary?.library.listIds().then((ids) => ids.length) ?? -1)
          .catch(() => -1),
      { timeout: 15_000 },
    )
    .toBe(games.length);
  await expect(page.getByTestId('story-value-totals')).toHaveText(String(games.length), { timeout: 20_000 });
  await expect(page.getByTestId('story-load-status')).toHaveCount(0, { timeout: 20_000 });
  await saveMyAccounts(page, { lichess: 'ada-sample', chesscom: 'ada-sample' });
  return games;
}

async function openFromList(page: Page, id: string): Promise<void> {
  await page.getByTestId('mode-tab-games').click();
  await page.getByTestId('games-tab-library').click();
  await page.locator(`[data-testid="games-row"][data-game-id="${id}"]`).click();
  await expect(page.getByTestId('review-panel')).toBeVisible();
}

const panel = (page: Page) => page.getByTestId('review-panel');
const classCount = (page: Page, slug: string) => page.getByTestId(`review-stored-class-${slug}`);

/** The key moment's label and text, worked out from the game's PGN. */
function expectedMoment(g: SampleGame, ply: number, drop: number) {
  const chess = new Chess();
  chess.loadPgn(g.pgn);
  const san = chess.history()[ply - 1]!;
  const label = `${Math.ceil(ply / 2)}${ply % 2 === 1 ? '.' : '...'} ${san}`;
  return { label, text: `-${drop.toFixed(0)}% for ${g.playerColor === 'w' ? 'White' : 'Black'}` };
}

/** Nothing is cut off, nothing sticks out sideways, and the block's last control is not behind the tab bar. */
async function expectFits(page: Page): Promise<void> {
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth),
  ).toBeLessThanOrEqual(0);
  const clipped = await page.evaluate(() => {
    const box = document.querySelector('[data-testid="review-panel"]')!.getBoundingClientRect();
    const out: string[] = [];
    for (const el of document.querySelectorAll<HTMLElement>(
      '[data-testid="review-stored"] *, [data-testid="btn-review-start"]',
    )) {
      if (el.offsetParent === null) continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0) continue;
      if (el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflowX !== 'visible')
        out.push(`${el.className || el.tagName}: scroll ${el.scrollWidth} > ${el.clientWidth}`);
      if (r.left < box.left - 1 || r.right > box.right + 1) out.push(`${el.className || el.tagName} sticks out`);
    }
    return out;
  });
  expect(clipped).toEqual([]);
  const button = page.getByTestId('btn-review-start');
  await button.scrollIntoViewIfNeeded();
  const covered = await button.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return top !== null && !el.contains(top) && top !== el;
  });
  expect(covered, 'the button is not behind the banner or the tab bar').toBe(false);
}

test.describe('Open a game: what the summary can supply shows at once', () => {
  test('"How you played", the accuracy, the phases and the key moment are there with no tap and no engine', async ({
    page,
  }) => {
    await page.setViewportSize(touch() ? { width: 390, height: 844 } : { width: 1280, height: 900 });
    const games = await openWith(page);
    const g = games[0]!;
    await openFromList(page, g.id);

    await expect(panel(page)).toHaveAttribute('data-library', 'true');
    await expect(panel(page)).toHaveAttribute('data-state', 'idle');
    await expect(page.getByTestId('review-stored-accuracy')).toHaveText('84.6%');

    // "How you played": open, the six classes the summary counts, my counts, in the review's order
    const fold = page.getByTestId('review-stored-classes');
    await expect(fold).toBeVisible();
    await expect(fold).toHaveAttribute('open', '');
    await expect(fold.locator('summary')).toHaveText('How you played');
    for (const [slug, count] of [
      ['brilliant', COUNTS.brilliant],
      ['great', COUNTS.great],
      ['inaccuracy', COUNTS.inaccuracy],
      ['mistake', COUNTS.mistake],
      ['miss', COUNTS.miss],
      ['blunder', COUNTS.blunder],
    ] as const) {
      await expect(classCount(page, slug)).toBeVisible();
      await expect(classCount(page, slug).locator('dd')).toHaveText(String(count));
    }
    // What the summary does not count is not invented
    for (const slug of ['best', 'excellent', 'good', 'book']) await expect(classCount(page, slug)).toHaveCount(0);
    expect(
      await page
        .locator('[data-testid="review-stored-class-rows"] > div')
        .evaluateAll((rows) => rows.map((r) => r.getAttribute('data-testid'))),
    ).toEqual(
      ['brilliant', 'great', 'inaccuracy', 'mistake', 'miss', 'blunder'].map((s) => `review-stored-class-${s}`),
    );

    // Accuracy by game phase, as before
    for (const [phase, acc] of [
      ['opening', '95.2%'],
      ['middlegame', '70.4%'],
      ['endgame', '88.0%'],
    ] as const)
      await expect(page.getByTestId(`review-stored-phase-${phase}`)).toContainText(acc);

    // The key moment: my biggest loss, from the stored ply and size
    const ply = myPly(g, 6);
    const { label, text } = expectedMoment(g, ply, 23.4);
    const chip = page.getByTestId(`review-stored-moment-${ply}`);
    await expect(page.getByTestId('review-stored-moments')).toBeVisible();
    await expect(page.getByTestId('review-stored-moments').getByRole('heading', { name: 'Key moments' })).toBeVisible();
    await expect(chip).toBeVisible();
    await expect(chip).toContainText(label);
    await expect(chip).toContainText(text);

    // What needs every move stays out, with the existing line and button; nothing ran
    await expect(page.getByTestId('review-body')).toBeHidden();
    await expect(page.getByTestId('review-key-moments')).toBeHidden();
    await expect(page.getByTestId('review-classes')).toBeHidden();
    await expect(page.getByTestId('btn-review-start')).toHaveText('Review this game');
    await expect(page.getByTestId('review-progress-text')).toHaveText(`${tap()} Review this game to see every move.`);
    expect(await page.evaluate(() => window.__wizardChessReview!.panel.getRunResult())).toBeNull();
    expect(
      await page.evaluate(
        () =>
          window
            .__wizardChessAnalysis!.controller.getGameTree()
            .getMainLine()
            .filter((n) => n.classification).length,
      ),
    ).toBe(0);
    await look(page, 'fold', 'review-panel');
  });

  test('the key moment goes to the move on the board', async ({ page }) => {
    await page.setViewportSize(touch() ? { width: 390, height: 844 } : { width: 1280, height: 900 });
    const games = await openWith(page);
    const g = games[0]!;
    await openFromList(page, g.id);
    const ply = myPly(g, 6);
    const chip = page.getByTestId(`review-stored-moment-${ply}`);
    await chip.scrollIntoViewIfNeeded();
    await chip.click();
    const node = await page.evaluate(() => {
      const n = window.__wizardChessAnalysis!.controller.getGameTree().currentNode;
      return { ply: n.ply, san: n.san };
    });
    expect(node.ply).toBe(ply);
    expect(node.san).toBe(expectedMoment(g, ply, 23.4).label.split(' ')[1]);
    // Still no review: the numbers and the button stay
    await expect(panel(page)).toHaveAttribute('data-library', 'true');
    await expect(page.getByTestId('review-stored')).toBeVisible();
  });

  test('every way in shows the same: the Games list, the page API and the Story’s "Open this game"', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 390, height: 844 });
    const games = await openWith(page);
    const g = games[0]!;
    const ply = myPly(g, 6);
    const shown = async () => {
      await expect(panel(page)).toHaveAttribute('data-library', 'true');
      await expect(page.getByTestId('review-stored-accuracy')).toHaveText('84.6%');
      await expect(page.getByTestId('review-stored-classes')).toHaveAttribute('open', '');
      await expect(classCount(page, 'great').locator('dd')).toHaveText('4');
      await expect(page.getByTestId(`review-stored-moment-${ply}`)).toBeVisible();
      await expect(page.getByTestId('review-body')).toBeHidden();
    };
    await openFromList(page, g.id);
    await shown();

    // The page API, from another screen
    await page.getByTestId('mode-tab-play').click();
    await page.evaluate((id) => window.__wizardChessLibrary!.openGame(id), g.id);
    await expect(page.getByTestId('review-panel')).toBeVisible();
    await shown();

    // The Story: a card's "Open this game" button for a game with stored numbers
    await page.getByTestId('mode-tab-games').click();
    await page.getByTestId('games-tab-story').click();
    const open = page.locator('[data-testid^="story-open-"]').first();
    await expect(open).toBeAttached({ timeout: 20_000 });
    await open.scrollIntoViewIfNeeded();
    await open.click();
    await expect(panel(page)).toHaveAttribute('data-library', 'true');
    await expect(page.getByTestId('review-stored-classes')).toHaveAttribute('open', '');
    await expect(page.getByTestId('review-stored-class-rows').locator('> div')).toHaveCount(6);
    await expect(page.getByTestId('review-body')).toBeHidden();
  });

  test('a worst move under 5 points, or none named, gives no key moment; the rest still shows', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const games = await openWith(page);
    for (const g of [games[1]!, games[2]!]) {
      await openFromList(page, g.id);
      await expect(page.getByTestId('review-stored-classes')).toBeVisible();
      await expect(classCount(page, 'great').locator('dd')).toHaveText('4');
      await expect(page.getByTestId('review-stored-moments')).toBeHidden();
      await expect(page.locator('button[data-testid^="review-stored-moment-"]')).toHaveCount(0);
      await expect(page.getByTestId('btn-review-start')).toHaveText('Review this game');
    }
  });

  test('a game with no summary still shows only the button and its line', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const games = await openWith(page);
    await openFromList(page, games[3]!.id);
    await expect(panel(page)).toHaveAttribute('data-library', 'true');
    await expect(page.getByTestId('review-stored')).toBeHidden();
    await expect(page.getByTestId('review-stored-classes')).toBeHidden();
    await expect(page.getByTestId('review-stored-moments')).toBeHidden();
    await expect(page.getByTestId('btn-review-start')).toHaveText('Review this game');
  });

  test('the next game opened replaces the fold and the moment', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const games = await openWith(page);
    await openFromList(page, games[0]!.id);
    await expect(page.locator('button[data-testid^="review-stored-moment-"]')).toHaveCount(1);
    await openFromList(page, games[1]!.id);
    await expect(page.locator('button[data-testid^="review-stored-moment-"]')).toHaveCount(0);
    await openFromList(page, games[0]!.id);
    await expect(page.locator('button[data-testid^="review-stored-moment-"]')).toHaveCount(1);
  });

  for (const size of [
    { width: 375, height: 667 },
    { width: 390, height: 844 },
    { width: 1280, height: 720 },
  ]) {
    test(`layout at ${size.width}x${size.height}: nothing cut off, the button reachable`, async ({ page }) => {
      await page.setViewportSize(size);
      const games = await openWith(page);
      await openFromList(page, games[0]!.id);
      await expect(page.getByTestId(`review-stored-moment-${myPly(games[0]!, 6)}`)).toBeVisible();
      await expectFits(page);
      await look(page, `fold-${size.width}x${size.height}`);
    });
  }
});
