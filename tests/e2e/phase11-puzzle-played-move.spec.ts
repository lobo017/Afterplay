import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type Locator, type Page, type Route } from '@playwright/test';
import { SITE_URL } from './helpers/site';

// Train › My mistakes. (1) The move I played in the game stays highlighted on the board, in the colors the Review gives a
// played move (the last move's amber squares): from the start, after a wrong try, with a hint, with the solution shown,
// after Try again. (2) Once a puzzle is solved or its solution shown, "Analyze the position" is in view and opens the
// position on the analysis board, where both sides move freely and Previous move takes a move back. The sample link's
// invented games get an invented puzzle file with moves that are legal in their positions; every expected square and
// position is worked out here from that fixture. Nothing reaches a real network.
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

async function look(page: Page, name: string): Promise<void> {
  if (LOOK_DIR === '') return;
  const dir = path.resolve(LOOK_DIR);
  if (!path.relative(process.cwd(), dir).startsWith('..'))
    throw new Error('PHASE_LOOK_DIR must be outside the repository');
  fs.mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: path.join(dir, `${test.info().project.name}-${name}.png`) });
}

interface SampleGame {
  id: string;
  playerColor: 'w' | 'b';
  [field: string]: unknown;
}
const sampleGames = (): SampleGame[] =>
  (JSON.parse(fs.readFileSync(SAMPLE_HISTORY, 'utf8')) as { games: SampleGame[] }).games;

/**
 * White mates with Qxf7# after Black's setup move g8f6. In the game White played Qxe5+ (Qh5 to e5) instead.
 * The puzzle position (White to move) is `WHITE.start`.
 */
const WHITE = {
  fen: 'r1bqkbnr/pppp1ppp/2n5/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR b KQkq - 3 3',
  moves: ['g8f6', 'h5f7'],
  bestLineSan: ['Qxf7#'],
  playedSan: 'Qxe5+',
  played: ['h5', 'e5'],
  start: 'r1bqkb1r/pppp1ppp/2n2n2/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR w KQkq - 4 4',
  wrong: ['a2', 'a3'],
  /** One move for each side on the free board, from the puzzle position. */
  free: [
    ['a2', 'a3'],
    ['a7', 'a6'],
  ],
};
/** Black mates with Qh4# after White's setup move g2g4. In the game Black played Nc6 (b8 to c6) instead. */
const BLACK = {
  fen: 'rnbqkbnr/pppp1ppp/8/4p3/8/5P2/PPPPP1PP/RNBQKBNR w KQkq - 0 2',
  moves: ['g2g4', 'd8h4'],
  bestLineSan: ['Qh4#'],
  playedSan: 'Nc6',
  played: ['b8', 'c6'],
  wrong: ['a7', 'a6'],
};

function fixtureEntries(games: SampleGame[]) {
  return games.flatMap((g) =>
    [0, 2, 4].map((k) => {
      const white = g.playerColor === 'w';
      const p = white ? WHITE : BLACK;
      return {
        id: g.id,
        ply: (white ? 21 : 22) + k,
        fen: p.fen,
        moves: p.moves,
        bestLineSan: p.bestLineSan,
        playedSan: p.playedSan,
        class: 'Blunder',
        loss: 40 + k,
        before: 70,
        after: 20,
        mateIn: 1,
      };
    }),
  );
}

const asJson = (route: Route, body: string) =>
  route.fulfill({
    status: 200,
    body,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-cache',
      'cross-origin-opener-policy': 'same-origin',
      'cross-origin-embedder-policy': 'require-corp',
      'cross-origin-resource-policy': 'same-origin',
      'x-robots-tag': 'noindex',
    },
  });

/** Opens the sample link with the invented puzzle file, then Train › My mistakes with one chosen puzzle loaded. */
async function openPuzzle(page: Page, color: 'w' | 'b'): Promise<{ trainer: Locator; id: string }> {
  const games = sampleGames();
  const base = fs.readFileSync(SAMPLE_HISTORY, 'utf8');
  const entries = fixtureEntries(games);
  await page.route('**/start/sample/history.json', (route) => asJson(route, base));
  await page.route('**/start/sample/puzzles.json', (route) =>
    asJson(
      route,
      JSON.stringify({
        format: 'afterplay-mistake-puzzles',
        version: 1,
        input: '0123456789ab',
        count: entries.length,
        entries,
      }),
    ),
  );
  await page.goto(SAMPLE);
  await expect(page.getByTestId('app-shell')).toHaveAttribute('data-first-run', 'applied', { timeout: 15_000 });
  const welcome = page.getByTestId('welcome-sheet');
  await welcome.waitFor({ state: 'visible', timeout: 8000 }).catch(() => undefined);
  if (await welcome.isVisible()) await page.getByTestId('welcome-done').click();
  await expect
    .poll(
      () =>
        page
          .evaluate(async () => (await window.__wizardChessPuzzlesReady!).store.listPuzzles('personal'))
          .then((l) => l.length)
          .catch(() => 0),
      { timeout: 25_000 },
    )
    .toBe(50);
  await page.getByTestId('mode-tab-train').click();
  await expect(page.getByTestId('today-screen')).toHaveAttribute('data-state', 'ready', { timeout: 20_000 });
  const id = await page.evaluate(async (c) => {
    const api = await window.__wizardChessPuzzlesReady!;
    const mine = (await api.store.listPuzzles('personal')).filter((p) => (p.ply! % 2 === 1) === (c === 'w'));
    const trainer = await api.open('mistakes');
    if (!(await trainer.openPuzzle(mine[0]!.id, 'personal'))) throw new Error('puzzle not found');
    return mine[0]!.id;
  }, color);
  const trainer = page.getByTestId('puzzle-trainer');
  await expect(trainer).toHaveAttribute('data-puzzle-id', id);
  await expect(trainer).toHaveAttribute('data-puzzle-state', 'playing', { timeout: 15_000 });
  return { trainer, id };
}

/** The squares marked as the move I played, or null when none is marked. */
async function playedSquares(trainer: Locator): Promise<[string, string] | null> {
  const from = trainer.getByTestId('overlay-played-from');
  const to = trainer.getByTestId('overlay-played-to');
  if ((await from.count()) === 0 || (await to.count()) === 0) return null;
  return [(await from.getAttribute('data-square'))!, (await to.getAttribute('data-square'))!];
}

async function click(trainer: Locator, page: Page, ...squares: string[]): Promise<void> {
  for (const square of squares) {
    const box = (await trainer.getByTestId(`square-${square}`).boundingBox())!;
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  }
}

test.describe('My mistakes: the move I played stays highlighted', () => {
  test('from the start, in the Review’s played-move colors, for White and for Black', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    const { trainer } = await openPuzzle(page, 'w');
    expect(await playedSquares(trainer)).toEqual(WHITE.played);
    // The same squares-style as the Review's last move: same fill and opacities
    const style = (id: string) =>
      trainer.getByTestId(id).evaluate((el) => [el.getAttribute('fill'), el.getAttribute('fill-opacity')]);
    expect(await style('overlay-played-from')).toEqual(await style('overlay-last-move-from'));
    expect(await style('overlay-played-to')).toEqual(await style('overlay-last-move-to'));
    await look(page, 'played-start-white');

    // A new puzzle (Black): its own played move, the old one gone
    await page.evaluate(async () => {
      const api = await window.__wizardChessPuzzlesReady!;
      const black = (await api.store.listPuzzles('personal')).find((p) => p.ply! % 2 === 0)!;
      await (await api.open('mistakes')).openPuzzle(black.id, 'personal');
    });
    await expect(trainer).toHaveAttribute('data-puzzle-state', 'playing', { timeout: 15_000 });
    expect(await playedSquares(trainer)).toEqual(BLACK.played);
    await look(page, 'played-start-black');
  });

  test('after a wrong try, with a hint, with the solution shown, and after Try again', async ({ page }) => {
    test.setTimeout(150_000);
    await page.setViewportSize({ width: 1280, height: 900 });
    const { trainer } = await openPuzzle(page, 'w');
    expect(await playedSquares(trainer)).toEqual(WHITE.played);

    // A wrong try: the move shows, is checked, is taken back; the mark never leaves
    await click(trainer, page, ...WHITE.wrong);
    await expect(trainer).toHaveAttribute('data-puzzle-state', /checking|wrong/);
    expect(await playedSquares(trainer)).toEqual(WHITE.played);
    await expect(trainer).toHaveAttribute('data-puzzle-state', 'wrong', { timeout: 30_000 });
    expect(await playedSquares(trainer)).toEqual(WHITE.played);
    await expect(trainer).toHaveAttribute('data-puzzle-state', 'playing', { timeout: 10_000 });
    expect(await playedSquares(trainer)).toEqual(WHITE.played);

    // A hint
    await page.getByTestId('btn-puzzle-hint').click();
    await expect(page.getByTestId('puzzle-status')).toHaveText('Hint: move the highlighted piece.');
    expect(await playedSquares(trainer)).toEqual(WHITE.played);

    // The solution shown: the best move is played on the board, the mark stays on the move from the game
    await page.getByTestId('btn-puzzle-solution').click();
    await expect(trainer).toHaveAttribute('data-puzzle-state', 'shown');
    await expect(trainer.getByTestId('overlay-last-move-to')).toHaveAttribute('data-square', 'f7');
    expect(await playedSquares(trainer)).toEqual(WHITE.played);

    // Try again: marked at once, and when the puzzle is back on the board
    await page.getByTestId('puzzle-menu').click();
    await page.getByTestId('btn-puzzle-retry').click();
    expect(await playedSquares(trainer)).toEqual(WHITE.played);
    await expect(trainer).toHaveAttribute('data-puzzle-state', 'playing', { timeout: 15_000 });
    expect(await playedSquares(trainer)).toEqual(WHITE.played);
    await expect(page.getByTestId('puzzle-status')).toHaveText('Find the best move for White');
  });

  test('a solved puzzle keeps it; a Lichess puzzle has none', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    const { trainer } = await openPuzzle(page, 'w');
    await click(trainer, page, 'h5', 'f7');
    await expect(trainer).toHaveAttribute('data-puzzle-state', 'solved');
    expect(await playedSquares(trainer)).toEqual(WHITE.played);

    await page.evaluate(async () => {
      const api = await window.__wizardChessPuzzlesReady!;
      await (await api.open('rated')).openPuzzle('1yy9U', 'lichess');
    });
    await expect(trainer).toHaveAttribute('data-puzzle-id', '1yy9U');
    await expect(trainer).toHaveAttribute('data-puzzle-state', 'playing', { timeout: 15_000 });
    expect(await playedSquares(trainer)).toBeNull();
    await expect(trainer.locator('[data-testid^="overlay-played-"]')).toHaveCount(0);
  });
});

test.describe('My mistakes: playing on after the puzzle', () => {
  test('"Analyze the position" is out of the way while playing and in view once solved or shown', async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 1280, height: 900 });
    const { trainer } = await openPuzzle(page, 'w');
    const playOn = page.getByTestId('btn-puzzle-play-on');
    await expect(playOn).toBeHidden();

    await click(trainer, page, 'h5', 'f7');
    await expect(trainer).toHaveAttribute('data-puzzle-state', 'solved');
    await expect(playOn).toBeVisible();
    await expect(playOn).toHaveText('Analyze the position');
    await expect(playOn).toBeEnabled();

    // Try again hides it until the puzzle is over again; the solution shown brings it back
    await page.getByTestId('puzzle-menu').click();
    await page.getByTestId('btn-puzzle-retry').click();
    await expect(playOn).toBeHidden();
    await expect(trainer).toHaveAttribute('data-puzzle-state', 'playing', { timeout: 15_000 });
    await page.getByTestId('btn-puzzle-solution').click();
    await expect(trainer).toHaveAttribute('data-puzzle-state', 'shown');
    await expect(playOn).toBeVisible();
  });

  test('it opens the puzzle position on the analysis board: free moves for both sides, a move taken back', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 1280, height: 900 });
    const { trainer } = await openPuzzle(page, 'w');
    await page.getByTestId('btn-puzzle-solution').click();
    await expect(trainer).toHaveAttribute('data-puzzle-state', 'shown');
    await page.getByTestId('btn-puzzle-play-on').click();

    const layout = page.getByTestId('analysis-layout');
    await expect(layout).toBeVisible();
    await expect.poll(() => page.evaluate(() => window.__wizardChessAnalysis!.controller.getTab())).toBe('analysis');
    const state = () =>
      page.evaluate(() => {
        const n = window.__wizardChessAnalysis!.controller.getGameTree().currentNode;
        return { ply: n.ply, fen: n.fen.split(' ').slice(0, 4).join(' '), san: n.san };
      });
    const startFen = WHITE.start.split(' ').slice(0, 4).join(' ');
    expect(await state()).toMatchObject({ ply: 1, fen: startFen });

    // Both sides move freely from there: White plays a3, then Black plays a6
    for (const [from, to] of WHITE.free) {
      for (const square of [from!, to!]) {
        const box = (await layout.getByTestId(`square-${square}`).boundingBox())!;
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      }
    }
    expect(await state()).toMatchObject({ ply: 3, san: 'a6' });
    // Previous move takes them back, one at a time, to the puzzle position
    await page.getByTestId('btn-nav-prev').click();
    expect(await state()).toMatchObject({ ply: 2, san: 'a3' });
    await page.getByTestId('btn-nav-prev').click();
    expect(await state()).toMatchObject({ ply: 1, fen: startFen });
    await look(page, 'play-on-analysis');
  });

  for (const size of [
    { width: 375, height: 667 },
    { width: 390, height: 844 },
  ]) {
    test(`phone ${size.width}x${size.height}: the button fits and is not behind the tab bar`, async ({ page }) => {
      test.setTimeout(120_000);
      await page.setViewportSize(size);
      const { trainer } = await openPuzzle(page, 'w');
      await click(trainer, page, 'h5', 'f7');
      await expect(trainer).toHaveAttribute('data-puzzle-state', 'solved');
      const playOn = page.getByTestId('btn-puzzle-play-on');
      await expect(playOn).toBeVisible();
      await playOn.scrollIntoViewIfNeeded();
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth),
      ).toBeLessThanOrEqual(0);
      const m = await playOn.evaluate((el) => {
        const r = el.getBoundingClientRect();
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return {
          left: r.left,
          right: r.right,
          height: r.height,
          clipped: el.scrollWidth > el.clientWidth + 1,
          onTop: hit !== null && (hit === el || el.contains(hit)),
        };
      });
      expect(m.left).toBeGreaterThanOrEqual(0);
      expect(m.right).toBeLessThanOrEqual(size.width);
      expect(m.height).toBeGreaterThanOrEqual(touch() ? 44 : 40);
      expect(m.clipped).toBe(false);
      expect(m.onTop, 'nothing covers the button').toBe(true);
      await look(page, `play-on-${size.width}x${size.height}`);
    });
  }
});
