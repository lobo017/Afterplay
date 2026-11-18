import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type Locator, type Page, type Route } from '@playwright/test';
import { SITE_URL } from './helpers/site';

// Train: once a puzzle is solved or its solution is shown, Previous move and Next move step the board through the printed
// line, from the puzzle position (step 0) to the end of the line, and the arrow keys do the same. Stepping is only looking:
// it grades, rates, schedules and counts nothing, and it leaves Try again, Next puzzle, Analyze the position and the mark
// on the move I played in the game working. The bundled puzzle 1yy9U (Black to move) has a three-move solution; the
// personal puzzles are the sample link's invented ones (as in phase11-puzzle-played-move.spec.ts).
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

async function look(page: Page, name: string): Promise<void> {
  if (LOOK_DIR === '') return;
  const dir = path.resolve(LOOK_DIR);
  if (!path.relative(process.cwd(), dir).startsWith('..'))
    throw new Error('PHASE_LOOK_DIR must be outside the repository');
  fs.mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: path.join(dir, `${test.info().project.name}-${name}.png`) });
}

const prev = (page: Page) => page.getByTestId('btn-puzzle-step-prev');
const next = (page: Page) => page.getByTestId('btn-puzzle-step-next');
const trainerOf = (page: Page) => page.getByTestId('puzzle-trainer');

async function click(trainer: Locator, page: Page, ...squares: string[]): Promise<void> {
  for (const square of squares) {
    const box = (await trainer.getByTestId(`square-${square}`).boundingBox())!;
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  }
}

/** The last move marked on the board: [from, to]. */
async function lastMove(trainer: Locator): Promise<[string, string]> {
  return [
    (await trainer.getByTestId('overlay-last-move-from').getAttribute('data-square'))!,
    (await trainer.getByTestId('overlay-last-move-to').getAttribute('data-square'))!,
  ];
}

// ---------------------------------------------------------------------------------------------------- bundled puzzle

/** 1yy9U: White's setup move b1c1; Black plays c8c1, White answers e6e1, Black mates with c1e1. */
const BUNDLED = {
  id: '1yy9U',
  /** The moves as the board marks them, step 0 (the setup move) to step 3. */
  steps: [
    ['b1', 'c1'],
    ['c8', 'c1'],
    ['e6', 'e1'],
    ['c1', 'e1'],
  ],
  line: 'Solution: 36… Rxc1+ 37. Qe1 Rxe1#.',
};

async function openBundled(page: Page): Promise<Locator> {
  await page.goto('/#train');
  await page.evaluate(() => window.__wizardChessPuzzlesReady);
  await expect(page.getByTestId('today-screen')).toHaveAttribute('data-state', 'ready');
  await page.evaluate(async (id) => {
    const api = await window.__wizardChessPuzzlesReady!;
    const trainer = await api.open('rated');
    if (!(await trainer.openPuzzle(id, 'lichess'))) throw new Error('no puzzle');
  }, BUNDLED.id);
  const trainer = trainerOf(page);
  await expect(trainer).toHaveAttribute('data-puzzle-id', BUNDLED.id);
  await expect(trainer).toHaveAttribute('data-puzzle-state', 'playing', { timeout: 15_000 });
  return trainer;
}

async function solveBundled(page: Page, trainer: Locator): Promise<void> {
  await click(trainer, page, 'c8', 'c1');
  await expect(trainer).toHaveAttribute('data-puzzle-state', 'playing', { timeout: 10_000 });
  await expect(trainer.getByTestId('overlay-last-move-from')).toHaveAttribute('data-square', 'e6');
  await click(trainer, page, 'c1', 'e1');
  await expect(trainer).toHaveAttribute('data-puzzle-state', 'solved');
  await expect(trainer).toHaveAttribute('data-recorded', 'rated');
}

/** Everything a step must leave alone: the rating, the cards, the puzzle's record, the rated count. */
const snapshot = (page: Page) =>
  page.evaluate(async (id) => {
    const store = (await window.__wizardChessPuzzlesReady!).store;
    return JSON.stringify({
      rating: await store.getRating(),
      cards: await store.listCards(),
      puzzle: await store.getPuzzle(id),
      rated: (await store.todaySummary()).ratedToday,
    });
  }, BUNDLED.id);

test.describe('Step through the solution: a bundled puzzle', () => {
  test('appears only once the puzzle is solved or its solution is shown', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    const trainer = await openBundled(page);
    await expect(prev(page)).toBeHidden();
    await expect(next(page)).toBeHidden();
    // Arrow keys do nothing while the puzzle is being solved
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowRight');
    await expect(trainer).not.toHaveAttribute('data-puzzle-step', /.*/);
    expect(await lastMove(trainer)).toEqual(BUNDLED.steps[0]);

    await solveBundled(page, trainer);
    await expect(prev(page)).toBeVisible();
    await expect(next(page)).toBeVisible();
    await expect(page.getByTestId('btn-puzzle-play-on')).toBeVisible();
    await expect(page.getByTestId('puzzle-line')).toHaveText(BUNDLED.line);
    await look(page, 'stepper-solved');

    // Try again: hidden again until the puzzle is over
    await page.getByTestId('puzzle-menu').click();
    await page.getByTestId('btn-puzzle-retry').click();
    await expect(prev(page)).toBeHidden();
    await expect(next(page)).toBeHidden();
    await expect(trainer).toHaveAttribute('data-puzzle-state', 'playing', { timeout: 15_000 });
    await page.getByTestId('btn-puzzle-solution').click();
    await expect(trainer).toHaveAttribute('data-puzzle-state', 'shown');
    await expect(prev(page)).toBeVisible();
    await expect(next(page)).toBeVisible();
  });

  test('Previous move and Next move walk the line; disabled at the ends; the move shown is marked', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    const trainer = await openBundled(page);
    await solveBundled(page, trainer);

    // At the end of the line to begin with
    await expect(next(page)).toBeDisabled();
    await expect(prev(page)).toBeEnabled();
    await expect(page.locator('.wc-puzzle-line-move[aria-current="step"]')).toHaveCount(0);

    const moveShown = (k: number) => page.locator(`.wc-puzzle-line-move[data-step="${k}"]`);
    for (const k of [2, 1, 0]) {
      await prev(page).click();
      await expect(trainer).toHaveAttribute('data-puzzle-step', String(k));
      await expect.poll(() => lastMove(trainer)).toEqual(BUNDLED.steps[k]);
      await expect(next(page)).toBeEnabled();
      if (k > 0) {
        await expect(moveShown(k)).toHaveAttribute('aria-current', 'step');
        await expect(page.locator('.wc-puzzle-line-move[aria-current="step"]')).toHaveCount(1);
      } else {
        await expect(page.locator('.wc-puzzle-line-move[aria-current="step"]')).toHaveCount(0);
      }
    }
    // The puzzle position: Previous is out, the setup move is the last move
    await expect(prev(page)).toBeDisabled();
    await expect(page.getByTestId('puzzle-line')).toHaveText(BUNDLED.line);

    for (const k of [1, 2, 3]) {
      await next(page).click();
      await expect(trainer).toHaveAttribute('data-puzzle-step', String(k));
      await expect.poll(() => lastMove(trainer)).toEqual(BUNDLED.steps[k]);
      await expect(moveShown(k)).toHaveAttribute('aria-current', 'step');
    }
    await expect(next(page)).toBeDisabled();
    await expect(prev(page)).toBeEnabled();
    await look(page, 'stepper-end');
  });

  test('the arrow keys step like the buttons, and stop at the ends', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    const trainer = await openBundled(page);
    await solveBundled(page, trainer);
    await page.keyboard.press('ArrowRight'); // already at the end: nothing
    await expect(trainer).not.toHaveAttribute('data-puzzle-step', /.*/);
    await page.keyboard.press('ArrowLeft');
    await expect(trainer).toHaveAttribute('data-puzzle-step', '2');
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowLeft');
    await expect(trainer).toHaveAttribute('data-puzzle-step', '0');
    await page.keyboard.press('ArrowLeft'); // before the puzzle position: nothing
    await expect(trainer).toHaveAttribute('data-puzzle-step', '0');
    await expect(prev(page)).toBeDisabled();
    await page.keyboard.press('ArrowRight');
    await expect(trainer).toHaveAttribute('data-puzzle-step', '1');
    expect(await lastMove(trainer)).toEqual(BUNDLED.steps[1]);
  });

  test('after the solution is shown the same buttons work, and they take over from the animation', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    const trainer = await openBundled(page);
    await page.getByTestId('btn-puzzle-solution').click();
    await expect(trainer).toHaveAttribute('data-puzzle-state', 'shown');
    // The board is walked to the end by the app; wait for it, then step back
    await expect.poll(() => lastMove(trainer), { timeout: 10_000 }).toEqual(BUNDLED.steps[3]);
    await prev(page).click();
    await expect(trainer).toHaveAttribute('data-puzzle-step', '2');
    await expect.poll(() => lastMove(trainer)).toEqual(BUNDLED.steps[2]);
    await next(page).click();
    await expect.poll(() => lastMove(trainer)).toEqual(BUNDLED.steps[3]);
  });

  test('stepping grades, rates, schedules and counts nothing', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    const trainer = await openBundled(page);
    await solveBundled(page, trainer);
    await expect(page.getByTestId('puzzle-today-rated')).toHaveText('1/1');
    const ratingText = await page.getByTestId('puzzle-stat-rating').textContent();
    const before = await snapshot(page);

    for (const press of ['ArrowLeft', 'ArrowLeft', 'ArrowLeft', 'ArrowRight', 'ArrowRight'])
      await page.keyboard.press(press);
    await prev(page).click();
    await next(page).click();
    await expect(trainer).toHaveAttribute('data-puzzle-step', /\d/);

    expect(await snapshot(page)).toBe(before);
    await expect(page.getByTestId('puzzle-today-rated')).toHaveText('1/1');
    await expect(page.getByTestId('puzzle-stat-rating')).toHaveText(ratingText!);
    await expect(trainer).toHaveAttribute('data-recorded', 'rated');
    await expect(trainer).toHaveAttribute('data-puzzle-state', 'solved');
    await expect(page.getByTestId('puzzle-status')).toHaveText('Solved!');
  });

  test('Try again, Next puzzle and Analyze the position still work after stepping', async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 1280, height: 900 });
    const trainer = await openBundled(page);
    await solveBundled(page, trainer);
    await prev(page).click();
    await prev(page).click();

    // Analyze the position opens the puzzle position on the analysis board
    await page.getByTestId('btn-puzzle-play-on').click();
    await expect(page.getByTestId('analysis-layout')).toBeVisible();
    expect(await page.evaluate(() => window.__wizardChessAnalysis!.controller.getGameTree().getMainLine().length)).toBe(
      4,
    );
    await page.getByTestId('mode-tab-train').click();
    await expect(trainer).toBeVisible();

    // Try again: back at the start, nothing of the step left, solvable again
    await page.getByTestId('puzzle-menu').click();
    await page.getByTestId('btn-puzzle-retry').click();
    await expect(trainer).toHaveAttribute('data-puzzle-state', 'playing', { timeout: 15_000 });
    await expect(trainer).not.toHaveAttribute('data-puzzle-step', /.*/);
    await expect(prev(page)).toBeHidden();
    expect(await lastMove(trainer)).toEqual(BUNDLED.steps[0]);
    await click(trainer, page, 'c8', 'c1');
    await expect(trainer).toHaveAttribute('data-puzzle-state', 'playing', { timeout: 10_000 });
    await click(trainer, page, 'c1', 'e1');
    await expect(trainer).toHaveAttribute('data-puzzle-state', 'solved');
    await prev(page).click();

    // Next puzzle: a different puzzle, no step buttons until it is over
    await page.getByTestId('btn-puzzle-next').click();
    await expect(trainer).not.toHaveAttribute('data-puzzle-id', BUNDLED.id);
    await expect(trainer).toHaveAttribute('data-puzzle-state', 'playing', { timeout: 15_000 });
    await expect(prev(page)).toBeHidden();
    await expect(next(page)).toBeHidden();
    await expect(trainer).not.toHaveAttribute('data-puzzle-step', /.*/);
  });
});

// ---------------------------------------------------------------------------------------------------- my mistakes

const WHITE = {
  fen: 'r1bqkbnr/pppp1ppp/2n5/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR b KQkq - 3 3',
  moves: ['g8f6', 'h5f7'],
  bestLineSan: ['Qxf7#'],
  playedSan: 'Qxe5+',
  played: ['h5', 'e5'],
  /** The marked last move at step 0 (Black's setup move) and step 1 (the best move). */
  steps: [
    ['g8', 'f6'],
    ['h5', 'f7'],
  ],
};
const BLACK = {
  fen: 'rnbqkbnr/pppp1ppp/8/4p3/8/5P2/PPPPP1PP/RNBQKBNR w KQkq - 0 2',
  moves: ['g2g4', 'd8h4'],
  bestLineSan: ['Qh4#'],
  playedSan: 'Nc6',
};

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

async function openPersonal(page: Page): Promise<Locator> {
  const games = (
    JSON.parse(fs.readFileSync(SAMPLE_HISTORY, 'utf8')) as { games: Array<{ id: string; playerColor: 'w' | 'b' }> }
  ).games;
  const base = fs.readFileSync(SAMPLE_HISTORY, 'utf8');
  const entries = games.flatMap((g) =>
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
  const id = await page.evaluate(async () => {
    const api = await window.__wizardChessPuzzlesReady!;
    const white = (await api.store.listPuzzles('personal')).find((p) => p.ply! % 2 === 1)!;
    const trainer = await api.open('mistakes');
    if (!(await trainer.openPuzzle(white.id, 'personal'))) throw new Error('puzzle not found');
    return white.id;
  });
  const trainer = trainerOf(page);
  await expect(trainer).toHaveAttribute('data-puzzle-id', id);
  await expect(trainer).toHaveAttribute('data-puzzle-state', 'playing', { timeout: 15_000 });
  return trainer;
}

async function playedMark(trainer: Locator): Promise<[string, string] | null> {
  const from = trainer.getByTestId('overlay-played-from');
  if ((await from.count()) === 0) return null;
  return [
    (await from.getAttribute('data-square'))!,
    (await trainer.getByTestId('overlay-played-to').getAttribute('data-square'))!,
  ];
}

test.describe('Step through the solution: My mistakes', () => {
  test('the move I played stays marked at every step, from the puzzle position to the end of the line', async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width: 1280, height: 900 });
    const trainer = await openPersonal(page);
    await click(trainer, page, 'h5', 'f7');
    await expect(trainer).toHaveAttribute('data-puzzle-state', 'solved');
    await expect(page.getByTestId('puzzle-line')).toContainText('Best line: 4. Qxf7#.');
    expect(await playedMark(trainer)).toEqual(WHITE.played);

    await prev(page).click();
    await expect(trainer).toHaveAttribute('data-puzzle-step', '0');
    await expect.poll(() => lastMove(trainer)).toEqual(WHITE.steps[0]);
    expect(await playedMark(trainer)).toEqual(WHITE.played);
    await expect(prev(page)).toBeDisabled();
    await expect(next(page)).toBeEnabled();

    await next(page).click();
    await expect(trainer).toHaveAttribute('data-puzzle-step', '1');
    await expect.poll(() => lastMove(trainer)).toEqual(WHITE.steps[1]);
    expect(await playedMark(trainer)).toEqual(WHITE.played);
    await expect(next(page)).toBeDisabled();
    await expect(page.locator('.wc-puzzle-line-move[aria-current="step"]')).toHaveText('4. Qxf7#');
    await look(page, 'stepper-personal');

    // The unrated note and the solved state are as they were
    await expect(page.getByTestId('puzzle-unrated-note')).toBeVisible();
    await expect(trainer).toHaveAttribute('data-recorded', 'unrated');
  });

  for (const size of [
    { width: 375, height: 667 },
    { width: 390, height: 844 },
    { width: 1280, height: 720 },
  ]) {
    test(`layout at ${size.width}x${size.height}: the three buttons fit, nothing cut off or covered`, async ({
      page,
    }) => {
      test.setTimeout(90_000);
      await page.setViewportSize(size);
      const trainer = await openPersonal(page);
      await click(trainer, page, 'h5', 'f7');
      await expect(trainer).toHaveAttribute('data-puzzle-state', 'solved');
      await next(page).scrollIntoViewIfNeeded();
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth),
      ).toBeLessThanOrEqual(0);
      const boxes = await page.evaluate(() => {
        const ids = ['btn-puzzle-step-prev', 'btn-puzzle-step-next', 'btn-puzzle-play-on', 'puzzle-unrated-note'];
        return ids.map((id) => {
          const el = document.querySelector<HTMLElement>(`[data-testid="${id}"]`)!;
          const r = el.getBoundingClientRect();
          const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
          return {
            id,
            left: r.left,
            right: r.right,
            width: r.width,
            height: r.height,
            clipped: el.scrollWidth > el.clientWidth + 1,
            onTop: hit !== null && (hit === el || el.contains(hit)),
          };
        });
      });
      for (const b of boxes) {
        expect(b.left, b.id).toBeGreaterThanOrEqual(0);
        expect(b.right, b.id).toBeLessThanOrEqual(size.width);
        expect(b.clipped, `${b.id} cut off`).toBe(false);
        expect(b.onTop, `${b.id} covered`).toBe(true);
      }
      for (const b of boxes.slice(0, 3)) expect(b.height, b.id).toBeGreaterThanOrEqual(44);
      // The two step buttons and Analyze share a row
      const [p, n, a] = boxes;
      expect(Math.abs(p!.left - n!.left)).toBeGreaterThan(0);
      expect(a!.left).toBeGreaterThanOrEqual(n!.right - 1);
      await look(page, `stepper-${size.width}x${size.height}`);
    });
  }
});
