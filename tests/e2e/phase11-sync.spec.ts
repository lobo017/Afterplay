import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { SITE_URL } from './helpers/site';

// Phase 11 stage 6: "Sync my Chess.com games" (Settings › Your data). The API is answered here, by route
// interception: no test reaches the real network. The player and the games are invented. Runs in every project; the
// one that matters most is `webkit-iphone`.
const SCREENSHOT_DIR = path.join('test-results', 'phase11-screens');
const PLAYER = 'Mock_Player42';
const API = 'https://api.chess.com';
const BASE = `${API}/pub/player/${PLAYER.toLowerCase()}/games`;
const LIST = `${BASE}/archives`;

const pad = (n: number) => String(n).padStart(2, '0');
const today = new Date();
/** The month that can still change (it is asked for on every sync), and two that are long over. */
const THIS_MONTH = `${today.getUTCFullYear()}-${pad(today.getUTCMonth() + 1)}`;
const monthUrl = (month: string) => `${BASE}/${month.slice(0, 4)}/${month.slice(5, 7)}`;

function game(o: {
  id: number;
  type?: 'live' | 'daily';
  white: string;
  black: string;
  result: string;
  date: string;
  moves: string;
  variant?: string;
}): { url: string; pgn: string } {
  const url = `https://www.chess.com/game/${o.type ?? 'live'}/${o.id}`;
  const tags = [
    ['Event', 'Live Chess'],
    ['Site', 'Chess.com'],
    ['Date', o.date],
    ['White', o.white],
    ['Black', o.black],
    ['Result', o.result],
    ...(o.variant ? [['Variant', o.variant]] : []),
    ['UTCDate', o.date],
    ['UTCTime', '18:02:11'],
    ['WhiteElo', '905'],
    ['BlackElo', '890'],
    ['TimeControl', '600'],
    ['Link', url],
  ];
  return { url, pgn: `${tags.map(([k, v]) => `[${k} "${v}"]`).join('\n')}\n\n${o.moves} ${o.result}\n` };
}

const MONTHS: Record<string, unknown[]> = {
  '2024-05': [
    game({
      id: 9101,
      white: PLAYER,
      black: 'mock_rival_a',
      result: '1-0',
      date: '2024.05.04',
      moves: '1. e4 e5 2. Qh5 Nc6 3. Bc4 Nf6 4. Qxf7#',
    }),
    game({
      id: 9102,
      white: 'mock_rival_a',
      black: PLAYER,
      result: '0-1',
      date: '2024.05.19',
      moves: '1. f3 e5 2. g4 Qh4#',
    }),
  ],
  '2024-06': [
    game({
      id: 9103,
      type: 'daily',
      white: PLAYER,
      black: 'MockRivalB',
      result: '1-0',
      date: '2024.06.02',
      moves: '1. d4 d5 2. c4',
    }),
    // A variant the app does not play, and an entry with no moves: both skipped, with their reason
    game({
      id: 9104,
      white: PLAYER,
      black: 'MockRivalB',
      result: '1-0',
      date: '2024.06.03',
      moves: '1. e4 e5 2. Ke2',
      variant: 'King of the Hill',
    }),
    game({ id: 9105, white: 'MockRivalB', black: PLAYER, result: '1-0', date: '2024.06.09', moves: '' }),
  ],
  [THIS_MONTH]: [
    game({
      id: 9106,
      white: 'mock_rival_a',
      black: PLAYER,
      result: '1-0',
      date: `${today.getUTCFullYear()}.${pad(today.getUTCMonth() + 1)}.${pad(today.getUTCDate())}`,
      moves: '1. e4 e5 2. Nf3 Nc6 3. Bb5',
    }),
  ],
};
const ADDED = ['chesscom:live-9101', 'chesscom:live-9102', 'chesscom:daily-9103', 'chesscom:live-9106'];

interface MockApi {
  /** Every request that reached the mocked host, in order. */
  requests: string[];
  /** Addresses that fail as a dropped connection does. */
  unreachable: Set<string>;
  /** Addresses that answer this status instead. */
  status: Map<string, number>;
}

async function mockApi(context: BrowserContext): Promise<MockApi> {
  const mock: MockApi = { requests: [], unreachable: new Set(), status: new Map() };
  const cors = { 'access-control-allow-origin': '*' };
  await context.route(`${API}/**`, async (route) => {
    const url = route.request().url();
    mock.requests.push(url);
    if (mock.unreachable.has(url)) return route.abort('internetdisconnected');
    const forced = mock.status.get(url);
    if (forced) return route.fulfill({ status: forced, headers: cors, json: { message: 'error' } });
    if (url === LIST) {
      return route.fulfill({ status: 200, headers: cors, json: { archives: Object.keys(MONTHS).map(monthUrl) } });
    }
    const month = Object.keys(MONTHS).find((m) => monthUrl(m) === url);
    if (month) return route.fulfill({ status: 200, headers: cors, json: { games: MONTHS[month] } });
    return route.fulfill({ status: 404, headers: cors, json: { message: 'not found' } });
  });
  return mock;
}

/** Every request the page makes that is not to the app itself. */
function watchExternal(page: Page): string[] {
  const external: string[] = [];
  page.on('request', (r) => {
    const url = r.url();
    if (/^https?:/.test(url) && new URL(url).origin !== new URL(SITE_URL).origin) external.push(url);
  });
  return external;
}

async function screenshot(page: Page, name: string): Promise<void> {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, `${test.info().project.name}-${name}.png`) });
}

async function openApp(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.getByTestId('play-layout').getByTestId('chess-board')).toBeVisible();
  await page.evaluate(() => window.__wizardChessLibraryReady);
}

async function openSettings(page: Page): Promise<void> {
  await page.getByTestId('btn-settings').click();
  await expect(page.getByTestId('settings-sheet')).toBeVisible();
}

async function setUsername(page: Page, name: string): Promise<void> {
  const input = page.getByTestId('input-chesscom-username');
  await input.scrollIntoViewIfNeeded();
  await input.fill(name);
  await input.blur();
  await page.waitForFunction(
    (wanted) => (window.__wizardChessLibrary?.library.getMyAccounts()?.chesscom ?? '') === wanted,
    name,
  );
}

/** Presses the sync button and waits for the run to end (the button is back to its own label). */
async function syncAndWait(page: Page): Promise<void> {
  const button = page.getByTestId('btn-chesscom-sync');
  await button.scrollIntoViewIfNeeded();
  await button.click();
  await expect(button).toHaveAttribute('data-state', 'idle', { timeout: 30_000 });
  await expect(page.getByTestId('chesscom-sync-label')).toHaveText('Sync my Chess.com games');
}

const storedIds = (page: Page) =>
  page.evaluate(async () => (await window.__wizardChessLibrary!.library.listIds()).sort());

test.describe('Phase 11 — Chess.com sync', () => {
  test('nothing is asked until the button is pressed; a sync adds the games once, with my colour', async ({
    page,
    context,
  }) => {
    const mock = await mockApi(context);
    const external = watchExternal(page);
    await openApp(page);

    // Around the app, into Settings, a username typed: still not one request
    await page.getByTestId('mode-tab-games').click();
    await expect(page.getByTestId('games-list')).toBeVisible();
    await openSettings(page);
    await setUsername(page, PLAYER);
    const button = page.getByTestId('btn-chesscom-sync');
    await button.scrollIntoViewIfNeeded();
    await expect(button).toBeVisible();
    await expect(page.getByTestId('sync-hint')).toContainText('only when you press the button');
    await page.waitForTimeout(1500);
    expect(external).toEqual([]);
    expect(mock.requests).toEqual([]);

    // The first sync: progress in months, then the count
    await button.click();
    await expect(button).toHaveAttribute('data-state', 'running');
    await expect(page.getByTestId('chesscom-sync-label')).toHaveText('Stop');
    await expect(page.getByTestId('sync-progress')).toHaveText(/^\d of 3 months/);
    await page.getByTestId('sync-progress').scrollIntoViewIfNeeded();
    await screenshot(page, 'sync-running');
    await expect(button).toHaveAttribute('data-state', 'idle', { timeout: 30_000 });
    const status = page.getByTestId('sync-status');
    await expect(status).toHaveAttribute('data-tone', 'ok');
    await expect(status).toContainText('Added 4 games.');
    await expect(status).toContainText('Skipped 2 games: 1 variant game the app does not play, 1 with no moves.');
    await expect(page.getByTestId('sync-progress')).toHaveText('');
    await status.scrollIntoViewIfNeeded();
    await screenshot(page, 'sync-done');

    // One request at a time, to the player's own archive addresses only
    expect(mock.requests).toEqual([LIST, monthUrl('2024-05'), monthUrl('2024-06'), monthUrl(THIS_MONTH)]);
    expect(external).toEqual(mock.requests);
    expect(await storedIds(page)).toEqual([...ADDED].sort());

    // A second sync: only the month that can still change is asked for, and nothing is added
    await syncAndWait(page);
    await expect(status).toContainText('No new games. 1 was already here.');
    await expect(status).toContainText('2 earlier months were already stored and not asked for again.');
    expect(mock.requests.slice(4)).toEqual([LIST, monthUrl(THIS_MONTH)]);
    expect(await storedIds(page)).toEqual([...ADDED].sort());

    // The games are in the list, each once, on my side
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('settings-sheet')).toBeHidden();
    const rows = page.getByTestId('games-row');
    await expect(rows).toHaveCount(4);
    const row = (id: string) => page.locator(`[data-testid="games-row"][data-game-id="${id}"]`);
    await expect(row('chesscom:live-9101').getByTestId('games-row-color')).toHaveAttribute('data-color', 'w');
    await expect(row('chesscom:live-9102').getByTestId('games-row-color')).toHaveAttribute('data-color', 'b');
    await expect(row('chesscom:daily-9103')).toHaveAttribute('data-source', 'chesscom');
    await expect(row('chesscom:live-9106').getByTestId('games-row-opponent')).toContainText('mock_rival_a');
    await screenshot(page, 'sync-games');
    const stored = await page.evaluate(() => window.__wizardChessLibrary!.library.get('chesscom:live-9102'));
    expect(stored).toMatchObject({
      playerColor: 'b',
      source: 'chesscom',
      captureMethod: 'chesscom-archive-history',
      capturedAt: null,
      url: 'https://www.chess.com/game/live/9102',
    });
  });

  test('offline and API errors say so, keep what was read, and the next sync continues', async ({ page, context }) => {
    const mock = await mockApi(context);
    await openApp(page);
    await openSettings(page);
    await setUsername(page, PLAYER);
    const status = page.getByTestId('sync-status');

    // The browser knows it is offline: said at once, nothing asked
    await context.setOffline(true);
    await syncAndWait(page);
    await expect(status).toHaveAttribute('data-tone', 'bad');
    await expect(status).toHaveText('You are offline. Connect to the internet and sync again.');
    expect(mock.requests).toEqual([]);
    await context.setOffline(false);

    // The connection drops at the second month: the first month's games stay
    mock.unreachable.add(monthUrl('2024-06'));
    await syncAndWait(page);
    await expect(status).toHaveAttribute('data-tone', 'bad');
    await expect(status).toContainText('Chess.com could not be reached; you may be offline.');
    await expect(status).toContainText('sync again to continue');
    await expect(status).toContainText('Added 2 games.');
    expect(await storedIds(page)).toEqual(['chesscom:live-9101', 'chesscom:live-9102']);
    await status.scrollIntoViewIfNeeded();
    await screenshot(page, 'sync-error');

    // A month the API answers with an error: the others go on, and it is named
    mock.unreachable.clear();
    mock.status.set(monthUrl('2024-06'), 500);
    const before = mock.requests.length;
    await syncAndWait(page);
    await expect(status).toContainText('Added 1 game.');
    await expect(status).toContainText('1 month could not be read (2024-06: HTTP 500). Sync again to read it.');
    // The month stored in the first run is not asked for again
    expect(mock.requests.slice(before)).toEqual([LIST, monthUrl('2024-06'), monthUrl(THIS_MONTH)]);

    // The API is well again: the missing month arrives, nothing twice
    mock.status.clear();
    await syncAndWait(page);
    await expect(status).toHaveAttribute('data-tone', 'ok');
    await expect(status).toContainText('Added 1 game. 1 was already here.');
    expect(await storedIds(page)).toEqual([...ADDED].sort());
  });

  test('without a username it asks for one; an unknown player and a refused list are said plainly', async ({
    page,
    context,
  }) => {
    const mock = await mockApi(context);
    await openApp(page);
    await openSettings(page);
    const status = page.getByTestId('sync-status');

    await syncAndWait(page);
    await expect(status).toHaveText('Add your Chess.com username under Your games first.');
    expect(mock.requests).toEqual([]);

    await setUsername(page, 'not a name');
    await syncAndWait(page);
    await expect(status).toContainText('That Chess.com username does not look right');
    expect(mock.requests).toEqual([]);

    await setUsername(page, 'Nobody_Here99');
    await syncAndWait(page);
    await expect(status).toHaveText('Chess.com does not know a player with that username. Check it under Your games.');
    expect(mock.requests).toEqual([`${API}/pub/player/nobody_here99/games/archives`]);

    await setUsername(page, PLAYER);
    mock.status.set(LIST, 503);
    await syncAndWait(page);
    await expect(status).toContainText(
      "Chess.com's list of your archives could not be read (HTTP 503). Try again later.",
    );
    expect(await storedIds(page)).toEqual([]);
  });

  test('Stop ends a running sync; what it stored stays and the button works again', async ({ page, context }) => {
    await mockApi(context);
    await openApp(page);
    await openSettings(page);
    await setUsername(page, PLAYER);
    const button = page.getByTestId('btn-chesscom-sync');
    await button.scrollIntoViewIfNeeded();
    await button.click();
    await expect(page.getByTestId('sync-progress')).toHaveText(/^1 of 3 months/, { timeout: 15_000 });
    await button.click();
    await expect(button).toHaveAttribute('data-state', 'idle', { timeout: 15_000 });
    const status = page.getByTestId('sync-status');
    await expect(status).toContainText('Stopped. What was read so far is kept: sync again to continue.');
    expect((await storedIds(page)).length).toBeGreaterThanOrEqual(2);

    await syncAndWait(page);
    await expect(status).toHaveAttribute('data-tone', 'ok');
    expect(await storedIds(page)).toEqual([...ADDED].sort());
  });
});
