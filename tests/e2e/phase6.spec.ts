import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type Page, type Request } from '@playwright/test';
import { SITE_URL, SITE_URL_LOCALHOST } from './helpers/site';

// Phase 6: puzzles (bundled Lichess set loaded lazily in a worker, puzzles from my own
// mistakes), Glicko-2 rating, FSRS reviews and the Today screen.
const SCREENSHOT_DIR = path.join('test-results', 'phase6-screens');

/**
 * A captured Lichess game: Lobo017 (Black, me) misses 2…Bxg4 winning the queen White just
 * hung (2.Qg4??). White's blunder is the opponent's and must not become a puzzle.
 */
const MY_GAME = `[Event "Casual blitz"]
[Site "https://lichess.org/Pz6Test1"]
[Date "2026.10.18"]
[UTCDate "2026.10.18"]
[UTCTime "18:00:00"]
[White "Opponent1"]
[Black "Lobo017"]
[Result "1/2-1/2"]
[TimeControl "180+0"]

1. e4 d5 2. Qg4 e6 3. Qd1 dxe4 4. Nc3 Nf6 1/2-1/2`;

/** The same moves on Chess.com, where none of my usernames is set: not my game, no puzzles. */
const NOT_MINE = MY_GAME.replace('https://lichess.org/Pz6Test1', 'Chess.com').replace(
  '[Event "Casual blitz"]',
  '[Event "Live Chess"]',
);

interface Tracked {
  external: string[];
  requests: string[];
}

function track(page: Page): Tracked {
  const t: Tracked = { external: [], requests: [] };
  page.on('request', (r: Request) => {
    const url = new URL(r.url());
    if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') t.external.push(r.url());
    t.requests.push(url.pathname);
  });
  return t;
}

async function squareCenter(page: Page, sq: string) {
  const box = await page.getByTestId('puzzle-trainer').getByTestId(`square-${sq}`).boundingBox();
  if (!box) throw new Error(`square-${sq} has no box`);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/** Plays a move by clicking its two squares. */
async function clickMove(page: Page, from: string, to: string): Promise<void> {
  const a = await squareCenter(page, from);
  await page.mouse.click(a.x, a.y);
  const b = await squareCenter(page, to);
  await page.mouse.click(b.x, b.y);
}

async function openPuzzle(page: Page, id: string, source: 'lichess' | 'personal' = 'lichess'): Promise<void> {
  await page.evaluate(
    async ({ id, source }) => {
      const api = await window.__wizardChessPuzzlesReady!;
      const trainer = await api.open('rated');
      if (!(await trainer.openPuzzle(id, source))) throw new Error(`no puzzle ${id}`);
    },
    { id, source },
  );
  const trainer = page.getByTestId('puzzle-trainer');
  await expect(trainer).toHaveAttribute('data-puzzle-id', id);
  await expect(trainer).toHaveAttribute('data-puzzle-state', 'playing');
}

test.describe('Phase 6 — puzzles', () => {
  test('the main bundle has no puzzle data; the dataset chunk loads only when Puzzles opens', async ({ page }) => {
    const distAssets = path.join('dist', 'assets');
    const files = fs.readdirSync(distAssets);
    const main = files.find((f) => /^index-.*\.js$/.test(f))!;
    const worker = files.find((f) => /^puzzle-dataset\.worker-.*\.js$/.test(f))!;
    expect(main).toBeTruthy();
    expect(worker).toBeTruthy();
    const mainText = fs.readFileSync(path.join(distAssets, main), 'utf8');
    // Ids of bundled puzzles: in the worker's chunk, not in the main bundle
    for (const id of ['0ND4A', '1yy9U', '064LL']) expect(mainText).not.toContain(`"${id}"`);
    expect(fs.readFileSync(path.join(distAssets, worker), 'utf8')).toContain('0ND4A');

    const t = track(page);
    await page.goto('/');
    await page.evaluate(() => window.__wizardChessPuzzlesReady);
    await page.getByTestId('mode-tab-train').click();
    await expect(page.getByTestId('today-screen')).toHaveAttribute('data-state', 'ready');
    await page.waitForTimeout(300);
    expect(t.requests.some((p) => p.includes('puzzle-dataset.worker'))).toBe(false);
    expect(t.requests.some((p) => p.includes('puzzle-trainer'))).toBe(false);

    // A session starts from Train's hub ("Start training" picks the one with the most to do)
    await page.getByTestId('btn-train-start').click();
    await expect(page.getByTestId('puzzle-trainer')).toHaveAttribute('data-puzzle-state', 'playing', {
      timeout: 15_000,
    });
    expect(t.requests.some((p) => p.includes('puzzle-dataset.worker'))).toBe(true);
    expect(t.requests.some((p) => p.includes('puzzle-trainer'))).toBe(true);
    // A fresh profile has nothing due: the first open goes to rated puzzles, with themes
    await expect(page.getByTestId('puzzle-mode-rated')).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByTestId('puzzle-theme').locator('option')).not.toHaveCount(1);
    expect(t.external).toEqual([]);
  });

  test('solves a multi-move bundled puzzle by clicking: the opponent moves first, the rating goes up', async ({
    page,
  }) => {
    const t = track(page);
    await page.goto('/');
    // 1yy9U: White plays Rxc1 (the setup move); I am Black: Rxc1+ Qe1 Rxe1#
    await openPuzzle(page, '1yy9U');
    const trainer = page.getByTestId('puzzle-trainer');
    await expect(page.getByTestId('puzzle-status')).toHaveText('Find the best move for Black');
    // Black at the bottom: the board is flipped for the player
    expect(await page.evaluate(() => window.__wizardChessPuzzles!.getTrainer()!.getBoard().isFlipped())).toBe(true);
    await expect(page.getByTestId('puzzle-rating')).toHaveText('1500');
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'puzzle-desktop-start.png') });

    await clickMove(page, 'c8', 'c1');
    await expect(page.getByTestId('puzzle-status')).toHaveText('Best move! Keep going.');
    await expect(trainer).toHaveAttribute('data-puzzle-state', 'playing'); // after White's reply Qe1
    await clickMove(page, 'c1', 'e1');
    await expect(trainer).toHaveAttribute('data-puzzle-state', 'solved');
    await expect(page.getByTestId('puzzle-status')).toHaveText('Solved!');
    await expect(trainer).toHaveAttribute('data-recorded', 'rated');
    await expect(page.getByTestId('puzzle-line')).toContainText('Rxc1+');
    const rating = Number(await page.getByTestId('puzzle-rating').textContent());
    expect(rating).toBeGreaterThan(1500);
    await expect(page.getByTestId('puzzle-stat-rating')).toContainText('(+');
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'puzzle-desktop-solved.png') });

    const stored = await page.evaluate(async () => {
      const api = window.__wizardChessPuzzles!;
      return {
        puzzle: await api.store.getPuzzle('1yy9U'),
        card: await api.store.getCard('1yy9U'),
        rating: await api.store.getRating(),
      };
    });
    expect(stored.puzzle).toMatchObject({ attempts: 1, solvedCount: 1, source: 'lichess' });
    expect(stored.card).toBeUndefined(); // a clean solve of a bundled puzzle needs no review
    expect(stored.rating.games).toBe(1);

    // Next: a new rated puzzle, never the one just solved
    await page.getByTestId('btn-puzzle-next').click();
    await expect(trainer).toHaveAttribute('data-puzzle-state', 'playing', { timeout: 15_000 });
    expect(await trainer.getAttribute('data-puzzle-id')).not.toBe('1yy9U');
    expect(t.external).toEqual([]);
  });

  test('another mating move also solves a mate-in-1', async ({ page }) => {
    await page.goto('/');
    // 064LL: Black plays Qxg5; the solution is Qxg5#, but Qh7# mates too
    await openPuzzle(page, '064LL');
    await clickMove(page, 'h6', 'h7');
    await expect(page.getByTestId('puzzle-trainer')).toHaveAttribute('data-puzzle-state', 'solved');
    await expect(page.getByTestId('puzzle-status')).toHaveText('Solved! That also wins.');
    await expect(page.getByTestId('puzzle-trainer')).toHaveAttribute('data-recorded', 'rated');
  });

  test('a wrong move is checked by the engine, fails the puzzle and schedules it for review', async ({ page }) => {
    await page.goto('/');
    await openPuzzle(page, '0ND4A');
    const trainer = page.getByTestId('puzzle-trainer');
    await clickMove(page, 'b7', 'b6');
    await expect(trainer).toHaveAttribute('data-puzzle-state', 'wrong', { timeout: 20_000 });
    await expect(page.getByTestId('puzzle-status')).toHaveText('That’s not it. Try again.');
    await expect(trainer).toHaveAttribute('data-recorded', 'rated');
    expect(Number(await page.getByTestId('puzzle-rating').textContent())).toBeLessThan(1500);
    // The wrong move is taken back and the puzzle can still be finished (unrated now)
    await expect(trainer).toHaveAttribute('data-puzzle-state', 'playing');
    await clickMove(page, 'f8', 'f1');
    await expect(page.getByTestId('puzzle-status')).toHaveText('Solved on a later try.');

    const card = await page.evaluate(() => window.__wizardChessPuzzles!.store.getCard('0ND4A'));
    expect(card).toMatchObject({ deck: 'puzzle', state: 'learning', lapses: 0 });
    const inMinutes = (card!.dueDate - Date.now()) / 60_000;
    expect(inMinutes).toBeGreaterThan(8);
    expect(inMinutes).toBeLessThanOrEqual(10);

    await page.getByTestId('mode-tab-train').click();
    await expect(page.getByTestId('today-screen')).toHaveAttribute('data-state', 'ready');
    await expect(page.getByTestId('today-reviews-detail')).toHaveText('All caught up. Next review in 10 min.');
    await expect(page.getByTestId('today-rated-count')).toHaveText('1');
    // Ten minutes later it is due
    const later = await page.evaluate(
      async () => (await window.__wizardChessPuzzles!.store.todaySummary(Date.now() + 11 * 60_000)).dueReviews,
    );
    expect(later).toEqual({ personal: 0, lichess: 1 });
  });

  test('puzzles from my mistakes: a captured game reviewed on Quick, my side only, solved from Today', async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const t = track(page);
    await page.goto('/');
    await page.evaluate(
      async ({ mine, notMine }) => {
        const lib = (await window.__wizardChessLibraryReady)!;
        await lib.library.setMyAccounts({ lichess: 'Lobo017', chesscom: '' });
        // As the capture extension delivers them
        const outcome = await lib.library.saveBridgeGames([
          {
            key: 'lichess:Pz6Test1',
            source: 'lichess',
            pgn: mine,
            capturedAt: Date.now(),
            method: 'lichess-page-data',
          },
          {
            key: 'chesscom:live-424242',
            source: 'chesscom',
            pgn: notMine,
            capturedAt: Date.now(),
            method: 'chesscom-callback',
          },
        ]);
        if (outcome.saved.length !== 2) throw new Error(JSON.stringify(outcome));
        lib.queue.enqueue(['lichess:Pz6Test1', 'chesscom:live-424242'], 'quick');
        await lib.queue.idle();
      },
      { mine: MY_GAME, notMine: NOT_MINE },
    );

    await page.getByTestId('mode-tab-train').click();
    await expect(page.getByTestId('today-screen')).toHaveAttribute('data-state', 'ready');
    const personal = await page.evaluate(() => window.__wizardChessPuzzles!.store.listPuzzles('personal'));
    expect(personal.length).toBeGreaterThan(0);
    // Only from the Lichess game where Lobo017 is me, only Black's (my) moves
    expect(personal.every((p) => p.sourceGameId === 'lichess:Pz6Test1')).toBe(true);
    expect(personal.every((p) => p.ply! % 2 === 0)).toBe(true);
    const missed = personal.find((p) => p.ply === 4)!;
    expect(missed).toBeTruthy();
    expect(missed.moves).toEqual(['d1g4', 'c8g4']);
    expect(missed.playedSan).toBe('e6');
    await expect(page.getByTestId('today-mistakes-count')).toHaveText(String(personal.length));
    await expect(page.getByTestId('today-games-count')).toHaveText('0');
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'today-desktop.png') });

    await page.getByTestId('btn-today-mistakes').click();
    const trainer = page.getByTestId('puzzle-trainer');
    await expect(page.getByTestId('puzzle-mode-mistakes')).toHaveAttribute('aria-selected', 'true');
    await expect(trainer).toHaveAttribute('data-puzzle-state', 'playing', { timeout: 15_000 });
    // Solve them all (each is my best move from the review)
    for (let i = 0; i < personal.length; i++) {
      const id = await trainer.getAttribute('data-puzzle-id');
      const p = personal.find((x) => x.id === id)!;
      if (p.id === missed.id) {
        await expect(page.getByTestId('puzzle-prompt')).toHaveText(
          `In the game I played e6 (${p.classification}). What was better?`,
        );
        await expect(page.getByTestId('puzzle-source')).toContainText('From my game Lobo017 vs Opponent1 · 2026-10-18');
      }
      await clickMove(page, p.moves[1]!.slice(0, 2), p.moves[1]!.slice(2, 4));
      await expect(trainer).toHaveAttribute('data-puzzle-state', 'solved');
      await expect(trainer).toHaveAttribute('data-recorded', 'unrated');
      if (p.id === missed.id) await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'puzzle-personal-solved.png') });
      await page.getByTestId('btn-puzzle-next').click();
    }
    await expect(trainer).toHaveAttribute('data-puzzle-state', 'empty');
    await expect(page.getByTestId('puzzle-empty-text')).toContainText('No puzzles from my games are due');
    // Personal puzzles don't touch the rating; each is now scheduled (Good/Easy → days ahead)
    const after = await page.evaluate(async () => {
      const store = window.__wizardChessPuzzles!.store;
      return { rating: await store.getRating(), cards: await store.listCards(), today: await store.todaySummary() };
    });
    expect(after.rating.games).toBe(0);
    expect(after.cards.every((c) => c.state === 'review' && c.dueDate > Date.now() + 23 * 3600_000)).toBe(true);
    expect(after.today.newPersonal).toBe(0);
    expect(t.external).toEqual([]);
  });

  test('phone width: Puzzles and Today fit without horizontal scrolling', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');
    await openPuzzle(page, '1yy9U');
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'puzzle-phone.png'), fullPage: true });
    const overflow = () =>
      page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(await overflow()).toBeLessThanOrEqual(0);
    await page.getByTestId('mode-tab-train').click();
    await expect(page.getByTestId('today-screen')).toHaveAttribute('data-state', 'ready');
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'today-phone.png'), fullPage: true });
    expect(await overflow()).toBeLessThanOrEqual(0);
  });
});

test.describe('npm run serve — one origin', () => {
  test('localhost redirects to 127.0.0.1 with the path and query', async ({ request }) => {
    const res = await request.get(`${SITE_URL_LOCALHOST}/?mode=games`, { maxRedirects: 0 });
    expect(res.status()).toBe(307);
    expect(res.headers()['location']).toBe(`${SITE_URL}/?mode=games`);
    expect(res.headers()['cache-control']).toBe('no-store');
  });

  test('a page opened at localhost ends up on 127.0.0.1 with its #fragment', async ({ page }) => {
    await page.goto(`${SITE_URL_LOCALHOST}/#today`);
    expect(page.url()).toBe(`${SITE_URL}/#today`);
    await expect(page.getByTestId('mode-tab-train')).toHaveAttribute('aria-current', 'page');
  });
});
