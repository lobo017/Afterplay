import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type Locator, type Page, type Request, type Route } from '@playwright/test';
import { SITE_URL } from './helpers/site';

// Puzzles from my mistakes, made offline and shipped beside a first-run link (/start/<slug>/puzzles.json): fetched once for
// a device whose link has its games stored, then released 50 at first and 20 a local day, newest game first, as ordinary
// personal puzzles. The sample link's 30 invented games get an invented puzzle file (3 puzzles a game, 90 in all) that is
// served the way the build serves the real one (JSON, no-cache, the isolation headers). Every expected number is worked
// out here from the fixture, not by the app. Nothing reaches a real network.
test.use({
  storageState: {
    cookies: [],
    origins: [{ origin: SITE_URL, localStorage: [{ name: 'wc-install-guide-seen', value: '1' }] }],
  },
});

const SAMPLE = '/start/sample/';
const SAMPLE_HISTORY = path.join('public', 'start', 'sample', 'history.json');
const HISTORY_URL = '**/start/sample/history.json';
const PUZZLES_URL = '**/start/sample/puzzles.json';
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

interface SampleGame {
  id: string;
  playerColor: 'w' | 'b';
  playedAt: number;
  white: string;
  black: string;
  [field: string]: unknown;
}
const sampleGames = (): SampleGame[] =>
  (JSON.parse(fs.readFileSync(SAMPLE_HISTORY, 'utf8')) as { games: SampleGame[] }).games;

// Two positions with a legal setup move and a legal best move: White mates with Qxf7# (odd plies), Black with Qh4# (even)
const WHITE_PUZZLE = {
  fen: 'r1bqkbnr/pppp1ppp/2n5/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR b KQkq - 3 3',
  moves: ['g8f6', 'h5f7'],
  bestLineSan: ['Qxf7#'],
  playedSan: 'Nxe4',
};
const BLACK_PUZZLE = {
  fen: 'rnbqkbnr/pppp1ppp/8/4p3/8/5P2/PPPPP1PP/RNBQKBNR w KQkq - 0 2',
  moves: ['g2g4', 'd8h4'],
  bestLineSan: ['Qh4#'],
  playedSan: 'Nc6',
};

interface FixtureEntry {
  id: string;
  ply: number;
  [field: string]: unknown;
}

/** Three puzzles for each sample game, at plies of the player's color, with the fields of the offline script's output. */
function fixtureEntries(games: SampleGame[]): FixtureEntry[] {
  return games.flatMap((g) =>
    [0, 2, 4].map((k) => ({
      id: g.id,
      ply: (g.playerColor === 'w' ? 21 : 22) + k,
      ...(g.playerColor === 'w' ? WHITE_PUZZLE : BLACK_PUZZLE),
      class: 'Blunder',
      loss: 40 + k,
      before: 70,
      after: 20,
      mateIn: 1,
    })),
  );
}

const fixtureText = (entries: unknown[], over: Record<string, unknown> = {}): string =>
  JSON.stringify({
    format: 'afterplay-mistake-puzzles',
    version: 1,
    input: '0123456789ab',
    count: entries.length,
    entries,
    ...over,
  });

/** The puzzle ids in release order: the newest game first, then by ply. */
function releaseOrder(games: SampleGame[]): string[] {
  const sorted = [...games].sort((a, b) => b.playedAt - a.playedAt);
  return sorted.flatMap((g) => fixtureEntries([g]).map((e) => `personal:${e.id}:${e.ply}`));
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

interface Served {
  /** How many times each file was asked for. */
  history: number;
  puzzles: number;
  external: string[];
}

/** Serves the sample history and, unless `puzzles` is null, an answer for the puzzle file. */
async function serve(page: Page, puzzles: ((route: Route) => Promise<void>) | null): Promise<Served> {
  const served: Served = { history: 0, puzzles: 0, external: [] };
  const base = JSON.parse(fs.readFileSync(SAMPLE_HISTORY, 'utf8')) as object;
  await page.route(HISTORY_URL, (route) => {
    served.history++;
    return asJson(route, JSON.stringify(base));
  });
  if (puzzles) {
    await page.route(PUZZLES_URL, (route) => {
      served.puzzles++;
      return puzzles(route);
    });
  }
  page.on('request', (r: Request) => {
    const url = new URL(r.url());
    if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') served.external.push(r.url());
  });
  return served;
}

const good = (games: SampleGame[]) => (route: Route) => asJson(route, fixtureText(fixtureEntries(games)));

async function closeWelcomeIfShown(page: Page): Promise<void> {
  const welcome = page.getByTestId('welcome-sheet');
  await welcome.waitFor({ state: 'visible', timeout: 8000 }).catch(() => undefined);
  if (await welcome.isVisible()) {
    await page.getByTestId('welcome-done').click();
    await expect(welcome).toBeHidden();
  }
}

const personalIds = (page: Page): Promise<string[]> =>
  page
    .evaluate(async () =>
      (await window.__wizardChessPuzzlesReady!).store.listPuzzles('personal').then((l) => l.map((p) => p.id)),
    )
    .catch(() => []);

/** Opens the sample link (the first visit applies the preset and stores the 30 games) and waits for the games. */
async function openLink(page: Page): Promise<void> {
  await page.goto(SAMPLE);
  await expect(page.getByTestId('app-shell')).toHaveAttribute('data-first-run', 'applied', { timeout: 15_000 });
  await closeWelcomeIfShown(page);
  await waitForGames(page);
}

async function waitForGames(page: Page): Promise<void> {
  await expect
    .poll(
      () =>
        page
          .evaluate(() => window.__wizardChessLibrary?.library.listIds().then((ids) => ids.length) ?? -1)
          .catch(() => -1),
      { timeout: 20_000 },
    )
    .toBe(30);
}

/** A later visit: the page is loaded again on the same device, with the clock at `at`. */
async function reopenAt(page: Page, at: Date): Promise<void> {
  await page.clock.setFixedTime(at);
  await page.goto(SAMPLE);
  await expect(page.getByTestId('app-shell')).toHaveAttribute('data-first-run', 'already', { timeout: 15_000 });
  await waitForGames(page);
}

const openTrain = async (page: Page): Promise<void> => {
  await page.getByTestId('mode-tab-train').click();
  await expect(page.getByTestId('today-screen')).toHaveAttribute('data-state', 'ready', { timeout: 20_000 });
};

const DAY_1 = new Date(2026, 10, 17, 10, 0);
const at = (day: number, hour = 10) => new Date(2026, 10, day, hour, 0);

test.describe('puzzles from my mistakes (the link’s puzzle file)', () => {
  test('Train shows the released count, the puzzles are ordinary personal ones, and one is solvable end to end', async ({
    page,
  }) => {
    const games = sampleGames();
    const order = releaseOrder(games);
    expect(order).toHaveLength(90);
    await page.clock.setFixedTime(DAY_1);
    const served = await serve(page, good(games));
    await openLink(page);
    await expect.poll(() => personalIds(page), { timeout: 20_000 }).toHaveLength(50);
    expect((await personalIds(page)).sort()).toEqual(order.slice(0, 50).sort());
    expect(served.puzzles).toBe(1);
    expect(served.external).toEqual([]);

    await openTrain(page);
    await expect(page.getByTestId('today-mistakes-count')).toHaveText('50');
    await expect(page.getByTestId('today-mistakes-detail')).toHaveText('50 puzzles from my reviewed games in all.');
    await expect(page.getByTestId('btn-today-mistakes')).toBeEnabled();
    await expect(page.getByTestId('today-status')).toHaveText('');
    await look(page, 'train-50');

    // Ordinary personal puzzles with a card each; the label has the color and the date, never an opponent
    const records = await page.evaluate(async () => {
      const store = (await window.__wizardChessPuzzlesReady!).store;
      const [puzzles, cards] = await Promise.all([store.listPuzzles('personal'), store.listCards()]);
      return { puzzles, cards };
    });
    expect(records.cards.map((c) => c.targetId).sort()).toEqual(records.puzzles.map((p) => p.id).sort());
    expect(records.cards.every((c) => c.state === 'new')).toBe(true);
    const names = new Set(games.flatMap((g) => [g.white, g.black]).filter((n) => n !== 'ada-sample'));
    expect(names.size).toBeGreaterThan(0);
    const dump = JSON.stringify(records);
    for (const name of names) expect(dump).not.toContain(name);
    for (const p of records.puzzles) {
      expect(p).toMatchObject({ source: 'personal', rating: 0, attempts: 0, classification: 'Blunder' });
      expect(p.themes).toEqual(['blunder', 'mate']);
      expect(p.gameLabel).toMatch(new RegExp(`^as ${p.ply! % 2 === 1 ? 'White' : 'Black'} · 2026-\\d\\d-\\d\\d$`));
      expect(p.explanation).toBe(`Instead of ${p.playedSan}, there was a forced mate in 1.`);
    }

    // Solve one, end to end, through the Today card
    await page.getByTestId('btn-today-mistakes').click();
    const trainer = page.getByTestId('puzzle-trainer');
    await expect(page.getByTestId('puzzle-mode-mistakes')).toHaveAttribute('aria-selected', 'true');
    await expect(trainer).toHaveAttribute('data-puzzle-state', 'playing', { timeout: 15_000 });
    const id = (await trainer.getAttribute('data-puzzle-id'))!;
    const p = records.puzzles.find((x) => x.id === id)!;
    expect(p).toBeTruthy();
    await expect(page.getByTestId('puzzle-prompt')).toHaveText(
      `In the game I played ${p.playedSan} (Blunder). What was better?`,
    );
    await expect(page.getByTestId('puzzle-source')).toHaveText(
      `From my game ${p.gameLabel} · move ${Math.ceil(p.ply! / 2)}${p.ply! % 2 === 0 ? '…' : '.'}`,
    );
    const best = p.moves[1]!;
    for (const square of [best.slice(0, 2), best.slice(2, 4)]) {
      const box = (await trainer.getByTestId(`square-${square}`).boundingBox())!;
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    }
    await expect(trainer).toHaveAttribute('data-puzzle-state', 'solved');
    await expect(trainer).toHaveAttribute('data-recorded', 'unrated');
    await expect(page.getByTestId('puzzle-line')).toContainText(p.bestLineSan![0]!);
    await expect(page.getByTestId('puzzle-line')).toContainText(p.explanation!);
    await look(page, 'solved');

    // Back on the hub: one fewer new puzzle, the others unchanged
    await page.getByTestId('mode-tab-train').click();
    await expect(page.getByTestId('today-mistakes-count')).toHaveText('49');
    expect(await personalIds(page)).toHaveLength(50);
  });

  test('releases 20 more on each later day and never more than 20 a day, catching up after days away', async ({
    page,
  }) => {
    const games = sampleGames();
    const order = releaseOrder(games);
    await page.clock.setFixedTime(DAY_1);
    const served = await serve(page, good(games));
    await openLink(page);
    await expect.poll(() => personalIds(page), { timeout: 20_000 }).toHaveLength(50);

    // The same day, later: nothing more, and no second request for the file
    await reopenAt(page, new Date(2026, 10, 17, 23, 30));
    await openTrain(page);
    await expect(page.getByTestId('today-mistakes-count')).toHaveText('50');
    expect(await personalIds(page)).toHaveLength(50);

    // The next day: 20 more, the next ones in the order
    await reopenAt(page, at(18, 0));
    await expect.poll(() => personalIds(page), { timeout: 20_000 }).toHaveLength(70);
    expect((await personalIds(page)).sort()).toEqual(order.slice(0, 70).sort());
    await openTrain(page);
    await expect(page.getByTestId('today-mistakes-count')).toHaveText('70');
    await look(page, 'train-70');

    // Opened again that day: still 70
    await reopenAt(page, at(18, 15));
    await openTrain(page);
    await expect(page.getByTestId('today-mistakes-count')).toHaveText('70');
    expect(await personalIds(page)).toHaveLength(70);

    // Away until the 23rd: 20 are due, and 20 are all that is left (90 in the file)
    await reopenAt(page, at(23));
    await expect.poll(() => personalIds(page), { timeout: 20_000 }).toHaveLength(90);
    expect((await personalIds(page)).sort()).toEqual([...order].sort());
    expect(served.puzzles).toBe(1);
    expect(served.external).toEqual([]);
  });

  test('does not duplicate anything when the history is imported again or the app is opened many times', async ({
    page,
  }) => {
    const games = sampleGames();
    await page.clock.setFixedTime(DAY_1);
    await serve(page, good(games));
    await openLink(page);
    await expect.poll(() => personalIds(page), { timeout: 20_000 }).toHaveLength(50);
    const before = (await personalIds(page)).sort();
    for (let i = 0; i < 3; i++) await reopenAt(page, new Date(2026, 10, 17, 11 + i));
    expect((await personalIds(page)).sort()).toEqual(before);
    const cards = await page.evaluate(async () => (await window.__wizardChessPuzzlesReady!).store.listCards());
    expect(cards).toHaveLength(50);
  });

  test('two pages of the same profile opened at once release the day’s puzzles once: no duplicate, consistent counts', async ({
    page,
    context,
  }) => {
    const games = sampleGames();
    const order = releaseOrder(games);
    await page.clock.setFixedTime(DAY_1);
    const served = await serve(page, good(games));
    await openLink(page);
    await expect.poll(() => personalIds(page), { timeout: 20_000 }).toHaveLength(50);

    // The next day: two pages (two tabs, or a reload and a resume) open at the same moment
    const second = await context.newPage();
    const next = at(18, 0);
    await page.clock.setFixedTime(next);
    await second.clock.setFixedTime(next);
    await Promise.all([page.goto(SAMPLE), second.goto(SAMPLE)]);
    await waitForGames(page);
    await waitForGames(second);
    await expect.poll(() => personalIds(page), { timeout: 20_000 }).toHaveLength(70);
    // Give a late second run the time it would need to add more
    await page.waitForTimeout(1500);
    const ids = await personalIds(second);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual(order.slice(0, 70).sort());
    const saved = await page.evaluate(async () => {
      const store = (await window.__wizardChessPuzzlesReady!).store;
      const lib = (await window.__wizardChessLibraryReady!).library;
      const pending = (await lib.readSetting('puzzles.fromHistory.pending')) as { entries: unknown[] };
      return {
        state: await store.historyPuzzleState(),
        pending: pending.entries.length,
        cards: (await store.listCards()).length,
      };
    });
    expect(saved.state).toMatchObject({ total: 90, released: 70, lastDay: '2026-11-18', lastDayCount: 20 });
    expect(saved.pending).toBe(20);
    expect(saved.cards).toBe(70);
    expect(served.puzzles).toBe(1);
    await second.close();
  });

  for (const variant of ['404', 'html', 'broken', 'illegal-move', 'version'] as const) {
    test(`a missing or broken file (${variant}) changes nothing and shows nothing`, async ({ page }) => {
      const games = sampleGames();
      const entries = fixtureEntries(games);
      const answer: Record<typeof variant, (route: Route) => Promise<void>> = {
        '404': (route) => route.fulfill({ status: 404, body: 'Not found' }),
        html: (route) =>
          route.fulfill({
            status: 200,
            contentType: 'text/html',
            body: '<!doctype html><html><head><title>Afterplay</title></head><body><div id="app"></div></body></html>',
          }),
        broken: (route) => asJson(route, fixtureText(entries).slice(0, 4000)),
        'illegal-move': (route) =>
          asJson(route, fixtureText(entries.map((e, i) => (i === 7 ? { ...e, moves: ['a8a6', 'h5f7'] } : e)))),
        version: (route) => asJson(route, fixtureText(entries, { version: 2 })),
      };
      await page.clock.setFixedTime(DAY_1);
      const served = await serve(page, answer[variant]);
      await openLink(page);
      await expect.poll(() => served.puzzles, { timeout: 20_000 }).toBe(1);
      // The answer has been read: wait until the app wrote down that it found nothing
      await expect
        .poll(
          () =>
            page
              .evaluate(() => window.__wizardChessLibrary!.library.readSetting('puzzles.fromHistory.miss'))
              .catch(() => undefined),
          { timeout: 15_000 },
        )
        .toBeTruthy();
      expect(await personalIds(page)).toEqual([]);
      expect(
        await page.evaluate(async () => (await window.__wizardChessPuzzlesReady!).store.historyPuzzleState()),
      ).toBeUndefined();

      await openTrain(page);
      await expect(page.getByTestId('today-mistakes-count')).toHaveText('0');
      await expect(page.getByTestId('btn-today-mistakes')).toBeDisabled();
      await expect(page.getByTestId('today-status')).toHaveText('');
      await expect(page.getByTestId('today-mistakes-detail')).toHaveText(
        'None yet: Mistakes, Blunders and Misses in my reviewed games become puzzles.',
      );
      // No notice, no banner, no error anywhere on the page
      await expect(page.getByTestId('app-notice')).toBeHidden();
      expect(await page.locator('body').innerText()).not.toMatch(/puzzle file|could not be read|could not be loaded/i);
      // The games and the Story are as they were
      expect(await page.evaluate(() => window.__wizardChessLibrary!.library.listIds().then((i) => i.length))).toBe(30);

      // The same day it is not asked again; the next day it is, once
      await reopenAt(page, new Date(2026, 10, 17, 20));
      await openTrain(page);
      expect(served.puzzles).toBe(1);
      await reopenAt(page, at(18));
      await expect.poll(() => served.puzzles, { timeout: 15_000 }).toBe(2);
      expect(await personalIds(page)).toEqual([]);
      expect(served.external).toEqual([]);
    });
  }

  test('a file that appears later (a new build) is loaded on the next day', async ({ page }) => {
    const games = sampleGames();
    let present = false;
    await page.clock.setFixedTime(DAY_1);
    const served = await serve(page, (route) =>
      present ? good(games)(route) : route.fulfill({ status: 404, body: 'Not found' }),
    );
    await openLink(page);
    await expect.poll(() => served.puzzles, { timeout: 20_000 }).toBe(1);
    expect(await personalIds(page)).toEqual([]);
    present = true;
    await reopenAt(page, at(18));
    await expect.poll(() => personalIds(page), { timeout: 20_000 }).toHaveLength(50);
    expect(served.puzzles).toBe(2);
  });

  test('asks for nothing when the visitor has no link, or the link has no games stored', async ({ page }) => {
    const requests: string[] = [];
    page.on('request', (r) => {
      if (r.url().includes('puzzles.json')) requests.push(r.url());
    });
    await page.route('**/puzzles.json', (route) => route.fulfill({ status: 404, body: 'x' }));

    // A visitor with no link
    await page.goto('/');
    await expect(page.getByTestId('app-shell')).toBeVisible();
    await openTrain(page);
    await page.reload();
    await openTrain(page);
    expect(requests).toEqual([]);

    // A link whose history file is missing: the games are never stored, so the puzzle file is not asked for either
    await page.route(HISTORY_URL, (route) => route.fulfill({ status: 404, body: 'none' }));
    await page.goto(SAMPLE);
    await expect(page.getByTestId('app-shell')).toHaveAttribute('data-first-run', 'applied', { timeout: 15_000 });
    await closeWelcomeIfShown(page);
    await openTrain(page);
    await expect(page.getByTestId('today-mistakes-count')).toHaveText('0');
    expect(requests).toEqual([]);
  });

  test('a puzzle whose game is not on this device stays pending while the others are released', async ({ page }) => {
    const games = sampleGames();
    // The file lists a game this device does not have: its puzzle stays pending and the others are released
    const extra = fixtureEntries([{ ...games[0]!, id: 'chesscom:9999', playedAt: games[0]!.playedAt + 1e9 }]);
    await page.clock.setFixedTime(DAY_1);
    await serve(page, (route) => asJson(route, fixtureText([...fixtureEntries(games), ...extra])));
    await openLink(page);
    await expect.poll(() => personalIds(page), { timeout: 20_000 }).toHaveLength(50);
    expect((await personalIds(page)).some((id) => id.includes('9999'))).toBe(false);
    // The run writes its counts after the last puzzle
    await expect
      .poll(() => page.evaluate(async () => (await window.__wizardChessPuzzlesReady!).store.historyPuzzleState()), {
        timeout: 10_000,
      })
      .toMatchObject({ total: 93, released: 50 });
  });

  for (const size of [
    { width: 375, height: 667 },
    { width: 390, height: 844 },
  ]) {
    test(`the Train hub with released puzzles has no sideways overflow at ${size.width}x${size.height}`, async ({
      page,
    }) => {
      const games = sampleGames();
      await page.setViewportSize(size);
      await page.clock.setFixedTime(DAY_1);
      await serve(page, good(games));
      await openLink(page);
      await expect.poll(() => personalIds(page), { timeout: 20_000 }).toHaveLength(50);
      await openTrain(page);
      const card = page.getByTestId('today-mistakes');
      await expect(page.getByTestId('today-mistakes-count')).toHaveText('50');
      await look(page, `hub-${size.width}`);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow).toBeLessThanOrEqual(0);
      await expectNoClippedText(card);
    });
  }
});

/** No text of the card is cut off sideways. */
async function expectNoClippedText(card: Locator): Promise<void> {
  const clipped = await card.evaluate(
    (el) => [...el.querySelectorAll('*')].filter((n) => n.scrollWidth > n.clientWidth + 1 && n.clientWidth > 0).length,
  );
  expect(clipped).toBe(0);
}
