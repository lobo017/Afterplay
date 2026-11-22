import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';

// The bots-only update: a device that applied a link under an older build takes the link's newer bot list when a NEW
// build of the app runs, and nothing else changes. Everything here is invented: made-up bots and ratings, and four
// one-move books.
//
// The "new build" needs no hook in the app. The app reads its build from the file name of its entry script
// (src/preset/build-id.ts), so the test serves the same built page with that script under another name: the page of the
// link is fetched and its entry script's name replaced, and the script's bytes are served under the new name. The preset
// file is answered from the test, so each build can be given its own list.

const SAMPLE = '/start/sample/';
const DIST = path.resolve('dist');
const REAL_ENTRY = /\/assets\/(index-[A-Za-z0-9_-]+)\.js/.exec(
  fs.readFileSync(path.join(DIST, 'start', 'sample', 'index.html'), 'utf8'),
)![1]!;
const NEW_ENTRY = 'index-NewBuild2';

function replyBook(uci: string): string {
  const entries: Record<string, [string, number][]> = {};
  const placement = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR';
  for (const key of [`${placement} b KQkq -`, `${placement} b KQkq e3`]) entries[key] = [[uci, 3]];
  const sorted: typeof entries = {};
  for (const key of Object.keys(entries).sort()) sorted[key] = entries[key]!;
  return JSON.stringify({ v: 1, pliesCap: 36, entries: sorted });
}

/** The old list: six bots, the Student one bot at 1345 (as a device that applied the link under an older build has it). */
const OLD_PRESET = {
  version: 1,
  profile: { displayName: 'Test Player' },
  settings: { newGame: { botRating: 1345, botStyle: 'solid', color: 'w', timeControlId: '5+0' } },
  bots: [
    { name: 'Ada One', rating: 600, style: 'solid' },
    { name: 'Ada Two', rating: 800, style: 'solid' },
    { name: 'Ada Three', rating: 1000, style: 'solid' },
    { name: 'Ada Four', rating: 1200, style: 'solid' },
    { name: 'Ada Five', rating: 1600, style: 'solid' },
    { name: 'Your Student', rating: 1345, style: 'solid' },
  ],
};

/** The new list: one Student with classes, revision 1. The profile and settings in this file must never be applied again. */
const NEW_PRESET = {
  version: 1,
  botsRevision: 1,
  profile: { displayName: 'Someone Else' },
  settings: { boardTheme: 'high-contrast', newGame: { botRating: 400, timeControlId: '1+0' } },
  bots: [
    {
      name: 'Your Student',
      rating: 1489,
      style: 'solid',
      bookRefs: ['student-rapid', 'student'],
      classes: {
        bullet: { rating: 1300, bookRefs: ['student-bullet', 'student'] },
        blitz: { rating: 1425, bookRefs: ['student-blitz', 'student'] },
        rapid: { rating: 1489, bookRefs: ['student-rapid', 'student'] },
      },
    },
  ],
  books: {
    student: replyBook('b7b5'),
    'student-bullet': replyBook('h7h5'),
    'student-blitz': replyBook('a7a5'),
    'student-rapid': replyBook('g7g5'),
  },
};

const touch = () => test.info().project.name === 'webkit-iphone';
async function press(page: Page, testId: string): Promise<void> {
  const el = page.getByTestId(testId);
  if (touch()) await el.tap();
  else await el.click();
}

const boardFrame = (page: Page) => page.getByTestId('play-layout').getByTestId('chess-board-frame');
const mainLine = (page: Page) =>
  page.evaluate(() =>
    window
      .__wizardChessPlay!.controller.getGameTree()
      .getMainLine()
      .map((n) => n.san),
  );
const storedGames = (page: Page) =>
  page.evaluate(async () => (await (await window.__wizardChessLibraryReady!).library.list()).map((g) => g.pgn));
const firstRunState = (page: Page) =>
  page.evaluate(
    () => JSON.parse(localStorage.getItem('wc.first-run.v1') ?? '{}') as { slug?: string; botsBuild?: string },
  );
const profileState = (page: Page) =>
  page.evaluate(
    () =>
      JSON.parse(localStorage.getItem('wc.profile.v1') ?? '{}') as {
        displayName?: string;
        botsRevision?: number;
        bots?: { name: string }[];
      },
  );

interface Served {
  answer: { current: unknown };
  /** What the preset file is answered with: the preset (default), 'abort' (offline) or a status code. */
  mode: { current: 'preset' | 'abort' | number };
  requests: string[];
}

/** Serves the link's preset from the test and counts the requests for it. */
async function servePreset(page: Page, first: unknown): Promise<Served> {
  const served: Served = { answer: { current: first }, mode: { current: 'preset' }, requests: [] };
  await page.route('**/start/sample/preset.json', (route) => {
    served.requests.push(route.request().url());
    if (served.mode.current === 'abort') return route.abort('failed');
    if (typeof served.mode.current === 'number') return route.fulfill({ status: served.mode.current, body: 'no' });
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(served.answer.current) });
  });
  await page.route('**/start/sample/history.json', (route) => route.fulfill({ status: 404, body: 'none' }));
  return served;
}

/** From now on the link's page names its entry script `NEW_ENTRY`, and that name serves the same script: a new build. */
async function serveNewBuild(page: Page): Promise<void> {
  const script = fs.readFileSync(path.join(DIST, 'assets', `${REAL_ENTRY}.js`));
  await page.route(`**/assets/${NEW_ENTRY}.js`, (route) =>
    route.fulfill({ status: 200, contentType: 'text/javascript; charset=utf-8', body: script }),
  );
  await page.route(`**${SAMPLE}`, async (route) => {
    const response = await route.fetch();
    const html = (await response.text()).split(REAL_ENTRY).join(NEW_ENTRY);
    await route.fulfill({ response, body: html });
  });
}

async function open(page: Page): Promise<void> {
  await page.goto(SAMPLE);
  await expect(page.getByTestId('play-layout').getByTestId('chess-board')).toBeVisible();
}

async function openApplied(page: Page): Promise<void> {
  await open(page);
  await expect(page.getByTestId('app-shell')).toHaveAttribute('data-first-run', 'applied', { timeout: 15_000 });
}

async function openAgain(page: Page): Promise<void> {
  await page.reload();
  await expect(page.getByTestId('play-layout').getByTestId('chess-board')).toBeVisible();
  await expect(page.getByTestId('app-shell')).toHaveAttribute('data-first-run', 'already', { timeout: 15_000 });
}

/** Past the update's start (2.5 s after start-up, then an idle moment of at most 3 s). */
const SETTLE_MS = 7000;

test.describe('Phase 11 — the bots-only update', () => {
  test('a new build takes the new list; the game, theme and name stay; a second reload asks for nothing', async ({
    page,
  }) => {
    const served = await servePreset(page, OLD_PRESET);

    // The old build: six bots, the Student at 1345, the chip on 5 + 0
    await openApplied(page);
    await expect(page.getByTestId('custom-bots').locator('button')).toHaveCount(6);
    await expect(page.getByTestId('bot-rating-label')).toHaveText('Your Student · Solid · 1345 Elo');
    expect((await firstRunState(page)).botsBuild).toBe(REAL_ENTRY);
    expect(served.requests).toHaveLength(1);

    // Play a game against the Student and finish it; set a theme and a display name
    await press(page, 'btn-new-game');
    await expect(page.getByTestId('top-player-name')).toHaveText('Your Student · Solid (1345)');
    await page.evaluate(() => window.__wizardChessPlay!.controller.setBotMoveDelayMs(5));
    await page.getByTestId('play-layout').getByTestId('square-e2').click();
    await page.getByTestId('play-layout').getByTestId('square-e4').click();
    await expect.poll(async () => (await mainLine(page)).length, { timeout: 30_000 }).toBe(2);
    await page.evaluate(() => window.__wizardChessPlay!.controller.resign());
    await expect.poll(async () => (await storedGames(page)).length).toBe(1);
    const gameBefore = (await storedGames(page))[0]!;
    expect(gameBefore).toContain('[Event "Casual game vs Your Student (1345)"]');
    await press(page, 'btn-settings');
    await page.getByTestId('select-board-theme').selectOption('imperial-walnut');
    await page.getByTestId('input-display-name').fill('Ada L.');
    await page.getByTestId('input-display-name').blur();
    await press(page, 'settings-sheet-close');
    await expect(boardFrame(page)).toHaveAttribute('data-theme', 'imperial-walnut');
    expect(served.requests).toHaveLength(1);

    // A new build, with a new list (revision 1): reload
    served.answer.current = NEW_PRESET;
    await serveNewBuild(page);
    await openAgain(page);
    await expect(page.getByTestId('custom-bots').locator('button')).toHaveCount(1, { timeout: 20_000 });
    await expect(page.getByTestId('custom-bot-0')).toContainText('Your Student');
    expect(served.requests).toHaveLength(2);

    // One Student with classes; the saved rating 1345 became the rating of the chip's class (5 + 0, Blitz)
    await expect(page.getByTestId('bot-rating-label')).toHaveText('Blitz · Solid · 1425 Elo');
    await expect(page.getByTestId('custom-bot-0')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('top-player-name')).toHaveText('Your Student · Solid (1425)');
    await expect(page.getByTestId('custom-bot-0').locator('.wc-custom-bot-rating')).toHaveText('1425');
    for (const [chip, rating, cls] of [
      ['1+0', 1300, 'Bullet'],
      ['10+0', 1489, 'Rapid'],
      ['3+2', 1425, 'Blitz'],
    ] as const) {
      await press(page, `time-control-${chip}`);
      await expect(page.getByTestId('bot-rating-label')).toHaveText(`${cls} · Solid · ${rating} Elo`);
      await expect(page.getByTestId('custom-bot-0').locator('.wc-custom-bot-rating')).toHaveText(String(rating));
    }

    // Everything else is as it was: the game, the theme, the name; nothing of the new file's other fields was applied
    expect(await storedGames(page)).toEqual([gameBefore]);
    await expect(boardFrame(page)).toHaveAttribute('data-theme', 'imperial-walnut');
    await expect(page.getByTestId('bottom-player-name')).toHaveText('Ada L. (White)');
    const profile = await profileState(page);
    expect(profile.displayName).toBe('Ada L.');
    expect(profile.botsRevision).toBe(1);
    expect(profile.bots).toHaveLength(1);
    expect((await firstRunState(page)).botsBuild).toBe(NEW_ENTRY);

    // The new bot's books arrived: a Student game on 1 + 0 answers 1. e4 from the Bullet book
    await press(page, 'time-control-1+0');
    await press(page, 'btn-new-game');
    await page.evaluate(() => window.__wizardChessPlay!.controller.setBotMoveDelayMs(5));
    await page.getByTestId('play-layout').getByTestId('square-e2').click();
    await page.getByTestId('play-layout').getByTestId('square-e4').click();
    await expect.poll(async () => (await mainLine(page)).length, { timeout: 30_000 }).toBe(2);
    expect(await mainLine(page)).toEqual(['e4', 'h5']);
    await page.evaluate(() => window.__wizardChessPlay!.controller.resign());
    await expect.poll(async () => (await storedGames(page)).length).toBe(2);

    // A second reload on the same build asks for nothing
    const before = served.requests.length;
    await openAgain(page);
    await page.waitForTimeout(SETTLE_MS);
    expect(served.requests).toHaveLength(before);
    await expect(page.getByTestId('custom-bots').locator('button')).toHaveCount(1);
    expect((await firstRunState(page)).botsBuild).toBe(NEW_ENTRY);
  });

  test('a fresh install of the new build applies the list and does not ask again', async ({ page }) => {
    const served = await servePreset(page, NEW_PRESET);
    await serveNewBuild(page);
    await openApplied(page);
    await expect(page.getByTestId('custom-bots').locator('button')).toHaveCount(1);
    const state = await firstRunState(page);
    expect(state.botsBuild).toBe(NEW_ENTRY);
    expect((await profileState(page)).botsRevision).toBe(1);
    await page.waitForTimeout(SETTLE_MS);
    expect(served.requests).toHaveLength(1);
    await openAgain(page);
    await page.waitForTimeout(SETTLE_MS);
    expect(served.requests).toHaveLength(1);
  });

  test('a failed request changes nothing and is tried again at the next start', async ({ page }) => {
    const served = await servePreset(page, OLD_PRESET);
    await openApplied(page);
    await expect(page.getByTestId('custom-bots').locator('button')).toHaveCount(6);
    served.answer.current = NEW_PRESET;
    await serveNewBuild(page);

    // Offline: the list stays, the build stays unrecorded
    served.mode.current = 'abort';
    await openAgain(page);
    await page.waitForTimeout(SETTLE_MS);
    expect(served.requests).toHaveLength(2);
    await expect(page.getByTestId('custom-bots').locator('button')).toHaveCount(6);
    expect((await firstRunState(page)).botsBuild).toBe(REAL_ENTRY);
    expect((await profileState(page)).botsRevision).toBeUndefined();

    // A 404 (the file is gone): the same
    served.mode.current = 404;
    await openAgain(page);
    await page.waitForTimeout(SETTLE_MS);
    expect(served.requests).toHaveLength(3);
    await expect(page.getByTestId('custom-bots').locator('button')).toHaveCount(6);
    expect((await firstRunState(page)).botsBuild).toBe(REAL_ENTRY);

    // Back online: the next start takes the list
    served.mode.current = 'preset';
    await openAgain(page);
    await expect(page.getByTestId('custom-bots').locator('button')).toHaveCount(1, { timeout: 20_000 });
    expect(served.requests).toHaveLength(4);
    expect((await firstRunState(page)).botsBuild).toBe(NEW_ENTRY);
  });
});
