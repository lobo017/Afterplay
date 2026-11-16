import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type Page, type Route } from '@playwright/test';
import { saveMyAccounts } from './helpers/accounts';
import { SITE_URL } from './helpers/site';

// Opening a Games list game that has no review on this device. The sample link's history (30 invented games for
// "ada-sample") gets invented summaries made in advance: game 0 with all three phases, game 1 with no endgame, game 2
// with no review at all. "Review this game" runs the usual live review (Quick, on a 20-ply game). Every expected number
// is worked out here from the fixture, not by the app. Nothing reaches a real network.
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
  [field: string]: unknown;
}
type Tuple = [number, number, number, number, number];
type Phases = [Tuple, Tuple, Tuple];

/** Game 0's invented numbers (the sample games have 20 plies: 10 moves of mine). */
const GAME0 = {
  accuracy: 84.56,
  mistake: 2,
  blunder: 1,
  brilliant: 0,
  great: 1,
  phases: [
    [5, 95.2, 0, 1, 0],
    [3, 70.44, 1, 1, 0],
    [2, 88, 0, 0, 0],
  ] as Phases,
};
/** Game 1: no endgame. */
const GAME1_PHASES: Phases = [
  [6, 91, 0, 0, 0],
  [4, 77.77, 1, 0, 0],
  [0, 0, 0, 0, 0],
];

function summary(
  g: SampleGame,
  n: { accuracy: number; mistake: number; blunder: number; brilliant: number; great: number; phases: Phases },
) {
  return {
    preset: null,
    savedAt: 1,
    depth: 18,
    summaryOnly: true,
    plies: 20,
    whiteAccuracy: g.playerColor === 'w' ? n.accuracy : null,
    blackAccuracy: g.playerColor === 'b' ? n.accuracy : null,
    sides: {
      [g.playerColor]: {
        moves: 10,
        acpl: 40,
        inaccuracy: 2,
        mistake: n.mistake,
        blunder: n.blunder,
        miss: 0,
        brilliant: n.brilliant,
        great: n.great,
        low: 20,
        drop: 20,
        dropPly: 11,
        phases: n.phases,
      },
    },
  };
}

function history(): SampleGame[] {
  const games = (JSON.parse(fs.readFileSync(SAMPLE_HISTORY, 'utf8')) as { games: SampleGame[] }).games;
  return games.map((g, i) => {
    if (i === 2) return { ...g, accuracy: null, analysis: null };
    const n =
      i === 0
        ? GAME0
        : {
            accuracy: 62 + ((i * 7) % 31),
            mistake: i % 3,
            blunder: i % 2,
            brilliant: 0,
            great: i % 4 === 0 ? 1 : 0,
            phases:
              i === 1
                ? GAME1_PHASES
                : ([
                    [5, 90, 0, 0, 0],
                    [3, 80, i % 2, i % 3, 0],
                    [2, 85, 0, 0, 0],
                  ] as Phases),
          };
    return { ...g, accuracy: n.accuracy, analysis: summary(g, n) };
  });
}

const fulfilJson = (route: Route, body: unknown) =>
  route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

async function closeWelcomeIfShown(page: Page): Promise<void> {
  const welcome = page.getByTestId('welcome-sheet');
  await welcome.waitFor({ state: 'visible', timeout: 8000 }).catch(() => undefined);
  if (await welcome.isVisible()) {
    await page.getByTestId('welcome-done').click();
    await expect(welcome).toBeHidden();
  }
}

/** Opens the sample link with the fixture history; returns the games. */
async function openWith(page: Page): Promise<SampleGame[]> {
  const games = history();
  const base = JSON.parse(fs.readFileSync(SAMPLE_HISTORY, 'utf8')) as object;
  await page.route('**/start/sample/history.json', (route) => fulfilJson(route, { ...base, games }));
  await page.goto(SAMPLE);
  await expect(page.getByTestId('app-shell')).toHaveAttribute('data-first-run', 'applied', { timeout: 15_000 });
  await closeWelcomeIfShown(page);
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

/** Games › Library, then a click on the game's row. */
async function openFromList(page: Page, id: string): Promise<void> {
  await page.getByTestId('mode-tab-games').click();
  await page.getByTestId('games-tab-library').click();
  await page.locator(`[data-testid="games-row"][data-game-id="${id}"]`).click();
  await expect(page.getByTestId('analysis-layout')).toBeVisible();
  await expect(page.getByTestId('review-panel')).toBeVisible();
}

const panel = (page: Page) => page.getByTestId('review-panel');
const startBtn = (page: Page) => page.getByTestId('btn-review-start');
const HELP_QUICK =
  'Checks every move and shows where the game turned. Takes about 10 to 20 seconds on a phone (longer for very long games).';
/** Standard and Deep: no time given. */
const HELP_SLOWER = 'Checks every move and shows where the game turned. Takes longer at this speed.';

/** The test ids of the action row's children, in page order. */
const actionOrder = (page: Page) =>
  page
    .locator('[data-testid="review-panel"] .wc-review-actions > *')
    .evaluateAll((els) => els.map((e) => e.getAttribute('data-testid') ?? ''));

/** The record as stored (its analysis only). */
const storedAnalysis = (page: Page, id: string) =>
  page.evaluate(async (gameId) => (await window.__wizardChessLibrary!.library.get(gameId))?.analysis ?? null, id);

/** Classes the review wrote on the board's main line. */
const classedMoves = (page: Page) =>
  page.evaluate(
    () =>
      window
        .__wizardChessAnalysis!.controller.getGameTree()
        .getMainLine()
        .filter((n) => n.classification).length,
  );

/** Starts "Review this game" and waits until the review has written a class on at least one move. */
async function startAndWaitForProgress(page: Page): Promise<void> {
  await startBtn(page).click();
  await expect(panel(page)).toHaveAttribute('data-state', 'running');
  await expect.poll(() => classedMoves(page), { timeout: 30_000 }).toBeGreaterThan(0);
}

/** No page-wide horizontal scroll, and no text in the block cut off. */
async function expectFits(page: Page): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
  const clipped = await page.evaluate(() => {
    const panelEl = document.querySelector('[data-testid="review-panel"]')!;
    const box = panelEl.getBoundingClientRect();
    const out: string[] = [];
    const els = panelEl.querySelectorAll<HTMLElement>(
      '[data-testid="review-stored"] *, [data-testid="review-stored-help"], [data-testid="review-stored-error"], [data-testid="btn-review-start"], [data-testid="btn-review-start"] *',
    );
    for (const el of els) {
      if (el.offsetParent === null && getComputedStyle(el).position !== 'fixed') continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0) continue;
      if (el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflowX !== 'visible')
        out.push(`${el.className || el.tagName}: scroll ${el.scrollWidth} > ${el.clientWidth}`);
      if (r.left < box.left - 1 || r.right > box.right + 1)
        out.push(
          `${el.className || el.tagName}: ${Math.round(r.left)}–${Math.round(r.right)} outside ${Math.round(box.left)}–${Math.round(box.right)}`,
        );
    }
    return out;
  });
  expect(clipped).toEqual([]);
}

test.describe('Open a game: numbers made in advance', () => {
  test('shows them at once, with no engine run: accuracy, the counts, accuracy by game phase, then the button', async ({
    page,
  }) => {
    await page.setViewportSize(touch() ? { width: 390, height: 844 } : { width: 1280, height: 900 });
    const games = await openWith(page);
    await openFromList(page, games[0]!.id);

    const stored = page.getByTestId('review-stored');
    await expect(stored).toBeVisible();
    await expect(panel(page)).toHaveAttribute('data-library', 'true');
    await expect(panel(page)).toHaveAttribute('data-state', 'idle');
    await expect(stored.getByRole('heading', { name: 'Your numbers from this game' })).toBeVisible();
    await expect(page.getByTestId('review-stored-accuracy')).toHaveText('84.6%');
    const tile = (key: string) => page.getByTestId(`review-stored-${key}`);
    await expect(tile('mistake')).toHaveText(/^mistakes\s*2$/);
    await expect(tile('blunder')).toHaveText(/^blunder\s*1$/);
    await expect(tile('brilliant')).toHaveText(/^brilliant moves\s*0$/);
    await expect(tile('great')).toHaveText(/^great move\s*1$/);
    await expect(page.getByTestId('review-stored-phases')).toContainText('Accuracy by game phase');
    for (const [phase, label, acc] of [
      ['opening', 'Opening', '95.2%'],
      ['middlegame', 'Middlegame', '70.4%'],
      ['endgame', 'Endgame', '88.0%'],
    ] as const) {
      await expect(page.getByTestId(`review-stored-phase-${phase}`)).toHaveText(
        new RegExp(`^${label}\\s*${acc.replace('.', '\\.')}$`),
      );
    }

    // The button, below the numbers, and its line; nothing of a review yet
    await expect(startBtn(page)).toBeEnabled();
    await expect(startBtn(page)).toHaveText('Review this game');
    const btnBox = (await startBtn(page).boundingBox())!;
    const storedBox = (await stored.boundingBox())!;
    expect(btnBox.y).toBeGreaterThanOrEqual(storedBox.y + storedBox.height - 1);
    await expect(page.getByTestId('review-stored-help')).toHaveText(HELP_QUICK);
    await expect(page.getByTestId('review-progress-text')).toHaveText(`${tap()} Review this game to see every move.`);
    // The page order is the screen order: the button, its line, then the setting, Cancel and Sample game
    expect(await actionOrder(page)).toEqual([
      'btn-review-start',
      'review-stored-help',
      'review-stored-error',
      'select-review-preset',
      'btn-review-cancel',
      'btn-review-sample',
    ]);
    if (!touch()) {
      // Tab reaches the button before the setting
      await startBtn(page).focus();
      await page.keyboard.press('Tab');
      await expect(page.getByTestId('select-review-preset')).toBeFocused();
      await page.keyboard.press('Shift+Tab');
      await expect(startBtn(page)).toBeFocused();
    }
    await expect(page.getByTestId('review-intro')).toBeHidden();
    await expect(page.getByTestId('review-body')).toBeHidden();
    await expect(page.getByTestId('review-stored-error')).toBeHidden();
    expect(await page.evaluate(() => window.__wizardChessReview!.panel.getRunResult())).toBeNull();
    expect(await classedMoves(page)).toBe(0);
    await look(page, 'stored', 'review-panel');
  });

  test('a phase with none of my moves is left out', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const games = await openWith(page);
    await openFromList(page, games[1]!.id);
    await expect(page.getByTestId('review-stored-phase-opening')).toBeVisible();
    await expect(page.getByTestId('review-stored-phase-middlegame')).toContainText('77.8%');
    await expect(page.getByTestId('review-stored-phase-endgame')).toHaveCount(0);
  });

  test('a game with no stored review shows only the button and the same line', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const games = await openWith(page);
    await openFromList(page, games[2]!.id);
    await expect(panel(page)).toHaveAttribute('data-library', 'true');
    await expect(page.getByTestId('review-stored')).toBeHidden();
    await expect(startBtn(page)).toBeEnabled();
    await expect(startBtn(page)).toHaveText('Review this game');
    await expect(page.getByTestId('review-stored-help')).toHaveText(HELP_QUICK);
    await expect(page.getByTestId('review-progress-text')).toHaveText(`Not reviewed yet. ${tap()} Review this game.`);
    await look(page, 'no-review', 'review-panel');
  });

  test('the line under the button follows the review setting', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    const games = await openWith(page);
    await openFromList(page, games[0]!.id);
    for (const slower of ['standard', 'deep']) {
      await page.getByTestId('select-review-preset').selectOption(slower);
      await expect(page.getByTestId('review-stored-help')).toHaveText(HELP_SLOWER);
    }
    await page.getByTestId('select-review-preset').selectOption('quick');
    await expect(page.getByTestId('review-stored-help')).toHaveText(HELP_QUICK);
  });
});

test.describe('Open a game: Review this game', () => {
  test('runs the usual review with progress on the button, shows it in full, saves it; the counts stay the same', async ({
    page,
  }) => {
    test.setTimeout(180_000);
    await page.setViewportSize(touch() ? { width: 390, height: 844 } : { width: 1280, height: 900 });
    const games = await openWith(page);
    const id = games[0]!.id;
    await page.getByTestId('games-tab-library').click();
    await expect(page.getByTestId('games-summary')).toHaveText('30 games · 29 reviewed');
    await openFromList(page, id);
    await page.getByTestId('select-review-preset').selectOption('quick');

    await startBtn(page).click();
    await expect(panel(page)).toHaveAttribute('data-state', 'running');
    await expect(startBtn(page)).toBeDisabled();
    await expect(startBtn(page)).toHaveText(/^Reviewing… move \d+ of (\d+|…)$/);
    await expect(page.getByTestId('btn-review-cancel')).toBeEnabled();
    await expect(page.getByTestId('review-stored')).toBeVisible();
    await expect(page.getByTestId('review-progress-text')).toHaveText(/^Reviewing… move \d+ of/);
    await look(page, 'running', 'review-panel');

    await expect(panel(page)).toHaveAttribute('data-state', 'done', { timeout: 120_000 });
    // The full review, as for any reviewed game; the block is gone
    await expect(panel(page)).toHaveAttribute('data-library', 'false');
    await expect(page.getByTestId('review-stored')).toBeHidden();
    await expect(page.getByTestId('review-stored-help')).toBeHidden();
    await expect(page.getByTestId('review-body')).toBeVisible();
    await expect(startBtn(page)).toHaveText('Review again');
    await expect(page.getByTestId('review-progress-text')).toHaveText(/^Reviewed · Quick · /);
    // The usual row again: setting, Start, Cancel, Sample game
    expect((await actionOrder(page)).slice(0, 4)).toEqual([
      'select-review-preset',
      'btn-review-start',
      'btn-review-cancel',
      'btn-review-sample',
    ]);
    // Every move of the review has its class on the board, as after any review
    const reviewed = await page.evaluate(() => window.__wizardChessReview!.panel.getReview()!.moves.length);
    expect(reviewed).toBeGreaterThan(0);
    expect(await classedMoves(page)).toBe(reviewed);

    // Saved on the device, with its phases, in place of the summary made in advance
    await expect
      .poll(async () => (await storedAnalysis(page, id))?.summaryOnly ?? null, { timeout: 10_000 })
      .toBeNull();
    const saved = (await storedAnalysis(page, id))!;
    expect(saved.preset).toBe('quick');
    expect(saved.sides?.[games[0]!.playerColor]?.phases).toHaveLength(3);
    expect(
      await page.evaluate((gameId) => window.__wizardChessLibrary!.library.getReview(gameId).then(Boolean), id),
    ).toBe(true);

    // The list says Reviewed; the library-wide counts stay the same
    await page.getByTestId('mode-tab-games').click();
    await expect(page.locator(`[data-game-id="${id}"] [data-analysis="analyzed"]`)).toContainText('Reviewed');
    await expect(page.getByTestId('games-summary')).toHaveText('30 games · 29 reviewed');
    await page.getByTestId('games-tab-insights').click();
    await expect(page.getByTestId('insights-summary')).toHaveText('30 games · 29 reviewed');

    // Opened again: the saved review, as today
    await openFromList(page, id);
    await expect(panel(page)).toHaveAttribute('data-state', 'done');
    await expect(panel(page)).toHaveAttribute('data-library', 'false');
    await expect(page.getByTestId('review-stored')).toBeHidden();
    await expect(page.getByTestId('review-body')).toBeVisible();
  });

  test('the Story counts the new review when Games opens on it again, without a tab change', async ({ page }) => {
    test.setTimeout(180_000);
    await page.setViewportSize(touch() ? { width: 390, height: 844 } : { width: 1280, height: 900 });
    const games = await openWith(page);
    const id = games[0]!.id;
    const accuracyCard = page.getByTestId('story-card-accuracy');
    await page.getByTestId('games-tab-story').click();
    await expect(accuracyCard).toContainText('over 29 reviewed games.');
    const before = await accuracyCard.textContent();

    // Opened while Games shows the Story (as any other screen's link would), reviewed, back to Games
    await page.evaluate((gameId) => window.__wizardChessLibrary!.openGame(gameId), id);
    await expect(page.getByTestId('review-stored')).toBeVisible();
    await page.getByTestId('select-review-preset').selectOption('quick');
    await startBtn(page).click();
    await expect(panel(page)).toHaveAttribute('data-state', 'done', { timeout: 120_000 });
    await expect
      .poll(async () => (await storedAnalysis(page, id))?.summaryOnly ?? null, { timeout: 10_000 })
      .toBeNull();

    const mean = await page.evaluate(async () => {
      const list = await window.__wizardChessLibrary!.library.list();
      const acc = list.flatMap((r) => {
        const a = r.analysis;
        if (!a) return [];
        const v = r.playerColor === 'b' ? a.blackAccuracy : a.whiteAccuracy;
        return typeof v === 'number' ? [v] : [];
      });
      return { n: acc.length, mean: acc.reduce((s, v) => s + v, 0) / acc.length };
    });
    expect(mean.n).toBe(29);
    await page.getByTestId('mode-tab-games').click();
    await expect(page.getByTestId('games-tab-story')).toHaveAttribute('aria-selected', 'true');
    await expect(accuracyCard).toContainText(
      `Your average accuracy is ${mean.mean.toFixed(1)}% over 29 reviewed games.`,
    );
    expect(await accuracyCard.textContent()).not.toBe(before);
  });

  test('Cancel brings back the numbers and the button, with nothing half-shown and nothing saved', async ({ page }) => {
    test.setTimeout(180_000);
    await page.setViewportSize({ width: 390, height: 844 });
    const games = await openWith(page);
    const id = games[0]!.id;
    await openFromList(page, id);
    await page.getByTestId('select-review-preset').selectOption('quick');
    await startAndWaitForProgress(page);
    await page.getByTestId('btn-review-cancel').click();

    await expect(panel(page)).toHaveAttribute('data-state', 'idle');
    await expect(panel(page)).toHaveAttribute('data-library', 'true');
    await expect(page.getByTestId('review-stored')).toBeVisible();
    await expect(page.getByTestId('review-stored-accuracy')).toHaveText('84.6%');
    await expect(startBtn(page)).toBeEnabled();
    await expect(startBtn(page)).toHaveText('Review this game');
    await expect(page.getByTestId('btn-review-cancel')).toBeDisabled();
    await expect(page.getByTestId('review-progress-text')).toHaveText('Review canceled. Nothing was changed.');
    await expect(page.getByTestId('review-body')).toBeHidden();
    await expect(page.getByTestId('review-stored-error')).toBeHidden();
    expect(await classedMoves(page)).toBe(0);
    expect(await page.evaluate(() => window.__wizardChessReview!.panel.getReview())).toBeNull();
    expect((await storedAnalysis(page, id))?.summaryOnly).toBe(true);
    await look(page, 'canceled', 'review-panel');
  });

  test('leaving the game while it runs stops the review: the next game opens clean and nothing is saved', async ({
    page,
  }) => {
    test.setTimeout(180_000);
    await page.setViewportSize(touch() ? { width: 390, height: 844 } : { width: 1280, height: 900 });
    const games = await openWith(page);
    const [first, , third] = games;
    await openFromList(page, first!.id);
    await page.getByTestId('select-review-preset').selectOption('quick');
    await startAndWaitForProgress(page);

    await openFromList(page, third!.id);
    await expect(panel(page)).toHaveAttribute('data-state', 'idle');
    await expect(panel(page)).toHaveAttribute('data-library', 'true');
    await expect(page.getByTestId('review-stored')).toBeHidden();
    await expect(startBtn(page)).toBeEnabled();
    await expect(startBtn(page)).toHaveText('Review this game');
    await expect(page.getByTestId('review-progress-text')).toHaveText(`Not reviewed yet. ${tap()} Review this game.`);
    // Longer than the rest of the first game's review would have taken: it never comes back, and nothing was saved
    await page.waitForTimeout(6000);
    await expect(panel(page)).toHaveAttribute('data-state', 'idle');
    await expect(startBtn(page)).toHaveText('Review this game');
    expect(await classedMoves(page)).toBe(0);
    expect((await storedAnalysis(page, first!.id))?.summaryOnly).toBe(true);
    expect(await storedAnalysis(page, third!.id)).toBeNull();

    // The first game opens with its numbers again
    await openFromList(page, first!.id);
    await expect(page.getByTestId('review-stored-accuracy')).toHaveText('84.6%');
    await expect(startBtn(page)).toBeEnabled();
  });

  test('a failed review says so plainly, keeps the numbers, and can be tried again', async ({ page }) => {
    test.setTimeout(180_000);
    await page.setViewportSize({ width: 375, height: 667 });
    const games = await openWith(page);
    const id = games[0]!.id;
    await openFromList(page, id);
    await page.getByTestId('select-review-preset').selectOption('quick');
    // The review engine stops answering after three positions
    // (an own property in front of the class method; deleting it brings the method back)
    await page.evaluate(() => {
      const engine = window.__wizardChessReview!.getEngine();
      const stubbed = engine as unknown as Record<string, unknown>;
      const original = engine.analyze.bind(engine);
      let calls = 0;
      (window as unknown as { __restoreReviewEngine: () => void }).__restoreReviewEngine = () => {
        delete stubbed.analyze;
      };
      stubbed.analyze = (...args: Parameters<typeof original>) => {
        calls++;
        if (calls > 3) return Promise.reject(new Error('The engine stopped (test)'));
        return original(...args);
      };
    });
    await startBtn(page).click();

    await expect(panel(page)).toHaveAttribute('data-state', 'error', { timeout: 60_000 });
    await expect(page.getByTestId('review-stored-error')).toBeVisible();
    await expect(page.getByTestId('review-stored-error')).toHaveText(
      'The review could not finish. Your numbers above are unchanged. You can try again.',
    );
    await expect(page.getByTestId('review-progress-text')).toHaveText('Review not finished');
    await expect(page.getByTestId('review-stored')).toBeVisible();
    await expect(page.getByTestId('review-stored-accuracy')).toHaveText('84.6%');
    await expect(startBtn(page)).toBeEnabled();
    await expect(startBtn(page)).toHaveText('Review this game');
    await expect(page.getByTestId('review-body')).toBeHidden();
    expect(await classedMoves(page)).toBe(0);
    expect((await storedAnalysis(page, id))?.summaryOnly).toBe(true);
    await expectFits(page);
    await page.getByTestId('review-stored-error').scrollIntoViewIfNeeded();
    await look(page, 'failed-375x667', 'review-panel');

    // With the engine back, the same button finishes the review
    await page.evaluate(() => (window as unknown as { __restoreReviewEngine: () => void }).__restoreReviewEngine());
    await startBtn(page).click();
    await expect(page.getByTestId('review-stored-error')).toBeHidden();
    await expect(panel(page)).toHaveAttribute('data-state', 'done', { timeout: 120_000 });
    await expect(page.getByTestId('review-stored')).toBeHidden();
  });
});

test.describe('Open a game: layout', () => {
  for (const size of [
    { width: 375, height: 667 },
    { width: 390, height: 844 },
    { width: 768, height: 1024 },
    { width: 1280, height: 800 },
  ]) {
    test(`fits at ${size.width}x${size.height}: no horizontal scroll, no text cut off`, async ({ page }) => {
      await page.setViewportSize(size);
      const games = await openWith(page);
      for (const [index, name] of [
        [0, 'stored'],
        [2, 'no-review'],
      ] as const) {
        await openFromList(page, games[index]!.id);
        await expect(startBtn(page)).toHaveText('Review this game');
        await expect(page.getByTestId('review-stored-help')).toBeVisible();
        await expectFits(page);
        await page.getByTestId('review-panel').scrollIntoViewIfNeeded();
        await look(page, `${name}-${size.width}x${size.height}`);
      }
    });
  }
});
