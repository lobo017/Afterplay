import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type BrowserContext, type Page, type Route } from '@playwright/test';
import { startServer, waitForOfflineReady, type Server } from './helpers/server';
import { SITE_URL } from './helpers/site';

// Chess Story, session 2: the link's history file, Games › Story, and where the app opens (wc.story.v1). The sample link
// (public/start/sample/) carries a small invented history of 30 games for the invented player "ada-sample": 15 won,
// 9 lost, 6 drawn, all Chess.com. Nothing here reaches a real network; no real name appears in any file.
// These tests clear the landing value that the Playwright config sets for every other test.
test.use({
  storageState: {
    cookies: [],
    origins: [{ origin: SITE_URL, localStorage: [{ name: 'wc-install-guide-seen', value: '1' }] }],
  },
});

const SCREENSHOT_DIR = path.join('test-results', 'phase11-story-screens');
const SAMPLE = '/start/sample/';
const LANDING_KEY = 'wc.story.v1';
const SAMPLE_HISTORY = path.join('public', 'start', 'sample', 'history.json');

const landingValue = (page: Page) => page.evaluate((key) => localStorage.getItem(key), LANDING_KEY);
const mode = (page: Page) => page.getByTestId('app-shell').getAttribute('data-mode');

async function shot(page: Page, name: string): Promise<void> {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, `${test.info().project.name}-${name}.png`) });
}

/** The welcome message of the sample link covers the screen for a moment; the story tests look past it. */
async function closeWelcomeIfShown(page: Page): Promise<void> {
  const welcome = page.getByTestId('welcome-sheet');
  await welcome.waitFor({ state: 'visible', timeout: 8000 }).catch(() => undefined);
  if (await welcome.isVisible()) {
    await page.getByTestId('welcome-done').click();
    await expect(welcome).toBeHidden();
  }
}

/** Opens the sample link and waits until the preset is applied and its history is in the library. */
async function openSampleLink(page: Page, games = 30): Promise<void> {
  await page.goto(SAMPLE);
  await expect(page.getByTestId('app-shell')).toHaveAttribute('data-first-run', 'applied', { timeout: 15_000 });
  await expect
    .poll(() => storedGames(page), {
      timeout: 15_000,
    })
    .toBe(games);
}

/** Games stored in the library (-1 while the page is still starting or reloading). */
const storedGames = (page: Page) =>
  page.evaluate(() => window.__wizardChessLibrary?.library.listIds().then((ids) => ids.length) ?? -1).catch(() => -1);

const historyFile = (): Record<string, unknown> => JSON.parse(fs.readFileSync(SAMPLE_HISTORY, 'utf8'));
const fulfilJson = (route: Route, body: unknown) =>
  route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

test.describe('Chess Story: first launch and where the app opens', () => {
  test('a new user sees the account form first; "Skip for now" opens Play and the next launch stays there', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');
    await expect(page.getByTestId('story-form')).toBeVisible();
    expect(await mode(page)).toBe('games');
    await expect(page.getByTestId('games-tab-story')).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByTestId('story-account-chesscom')).toHaveValue('');
    await expect(page.getByTestId('story-card-intro')).toHaveCount(0);
    // "Start import" is a live button now (session 3); nothing is asked of Chess.com until it is pressed
    await expect(page.getByTestId('story-start-import')).toBeEnabled();
    await expect(page.getByText('Lichess import is not available yet.')).toBeVisible();
    await shot(page, 'card-form');

    // The usernames are saved on the device and mark my side in later counts
    await page.getByTestId('story-account-chesscom').fill('ada-sample');
    await page.getByTestId('story-save').click();
    await expect(page.getByTestId('story-form-saved')).toBeVisible();
    expect(await page.evaluate(() => window.__wizardChessLibrary?.library.getMyAccounts())).toEqual({
      chesscom: 'ada-sample',
      lichess: '',
    });

    await page.getByTestId('story-skip').click();
    await expect(page.getByTestId('play-layout').getByTestId('chess-board')).toBeVisible();
    expect(await mode(page)).toBe('play');
    expect(await landingValue(page)).toBe('skipped');
    await page.reload();
    await expect(page.getByTestId('play-layout').getByTestId('chess-board')).toBeVisible();
    expect(await mode(page)).toBe('play');
  });

  for (const [value, screen] of [
    [null, 'form'],
    ['new', 'form'],
    ['importing', 'story'],
    ['ready', 'story'],
    ['skipped', 'play'],
    ['seen', 'play'],
  ] as const) {
    test(`the landing value ${value === null ? '(absent)' : `"${value}"`} opens ${screen}`, async ({ page }) => {
      await page.addInitScript(
        ([key, v]) => {
          if (v !== null && localStorage.getItem(key) === null) localStorage.setItem(key, v);
        },
        [LANDING_KEY, value] as const,
      );
      await page.goto('/');
      if (screen === 'play') {
        await expect(page.getByTestId('play-layout').getByTestId('chess-board')).toBeVisible();
        expect(await mode(page)).toBe('play');
        return;
      }
      expect(await mode(page)).toBe('games');
      await expect(page.getByTestId('games-tab-story')).toHaveAttribute('aria-selected', 'true');
      if (screen === 'form') await expect(page.getByTestId('story-form')).toBeVisible();
      // No games stored: the cards say so, and the form stays above them
      else {
        await expect(page.getByTestId('story-card-totals')).toContainText(
          'No games yet. Add your username and import.',
        );
        await expect(page.getByTestId('story-form')).toBeVisible();
      }
    });
  }
});

test.describe('Chess Story: the sample link’s history', () => {
  test('fills the Story: cards in order, the totals, the time-class line, a month record, nothing else from the file', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const requests: string[] = [];
    page.on('request', (r) => {
      if (r.url().endsWith('/history.json')) requests.push(r.url());
    });
    // Progress texts, collected as they appear (a 450-game file loads in three batches)
    await page.addInitScript(() => {
      const seen: string[] = [];
      (window as unknown as { __storyBanners: string[] }).__storyBanners = seen;
      new MutationObserver(() => {
        const el = document.querySelector('[data-testid="story-load-status"] strong');
        const text = el?.textContent ?? '';
        if (text && seen[seen.length - 1] !== text) seen.push(text);
      }).observe(document, { childList: true, subtree: true, characterData: true });
    });
    const big = historyFile() as { games: Array<Record<string, unknown>> };
    const copies = Array.from({ length: 15 }, (_, k) =>
      big.games.map((g) => ({ ...g, id: `${String(g.id)}-${k}`, ...(k === 0 ? { id: g.id } : {}) })),
    ).flat();
    await page.route('**/start/sample/history.json', (route) => fulfilJson(route, { ...big, games: copies }));
    await page.goto(SAMPLE);
    await expect(page.getByTestId('app-shell')).toHaveAttribute('data-first-run', 'applied', { timeout: 15_000 });
    await closeWelcomeIfShown(page);

    await expect(page.getByTestId('story-card-totals')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('story-value-totals')).toHaveText('450', { timeout: 20_000 });
    await expect(page.getByTestId('story-load-status')).toHaveCount(0);
    const banners = await page.evaluate(() => (window as unknown as { __storyBanners: string[] }).__storyBanners);
    expect(banners).toContain('Loading your games: 450 of 450');
    expect(banners.some((b) => /^Loading your games: \d+ of 450$/.test(b))).toBe(true);
    expect(requests).toHaveLength(1);

    // The cards, in order; no Lichess card (no Lichess game is stored)
    const order = await page
      .locator('[data-testid="story-scroll"] > section')
      .evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.card));
    expect(order).toEqual(['intro', 'totals', 'chesscom', 'closing']);
    await expect(page.getByTestId('story-card-totals')).toContainText('450 games in all: 225 W · 135 L · 90 D');
    await expect(page.getByTestId('story-card-totals')).toContainText(
      'Time classes follow one rule for both sites, so a few games may be labelled differently on Chess.com or Lichess.',
    );
    await expect(page.getByTestId('story-card-chesscom')).toContainText('450 games on Chess.com');
    await expect(page.getByTestId('story-card-closing')).toContainText('That is the story so far.');

    // The sync's month record came with the file; the file's other settings did not
    const settings = await page.evaluate(async () => {
      const lib = window.__wizardChessLibrary!.library;
      return {
        month: await lib.readSetting<{ player: string }>('sync.chesscom'),
        decoy: await lib.readSetting('decoy.setting'),
        state: await lib.readSetting<{ file: { status: string; loaded: number; total: number } }>('story.import'),
      };
    });
    expect(settings.month?.player).toBe('ada-sample');
    expect(settings.decoy).toBeUndefined();
    expect(settings.state?.file).toMatchObject({ status: 'done', loaded: 450, total: 450 });
    // Shown once the import finished: it opens Play from now on
    await expect.poll(() => landingValue(page)).toBe('seen');
  });

  test('a stopped load shows "Paused" with Continue; Continue finishes it and keeps every stored game once', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    let calls = 0;
    await page.route('**/start/sample/history.json', (route) => {
      calls++;
      return calls === 1 ? route.abort('connectionreset') : route.continue();
    });
    await page.goto(SAMPLE);
    await expect(page.getByTestId('app-shell')).toHaveAttribute('data-first-run', 'applied', { timeout: 15_000 });
    await closeWelcomeIfShown(page);
    const banner = page.getByTestId('story-load-status');
    await expect(banner).toHaveAttribute('data-state', 'paused', { timeout: 15_000 });
    await expect(banner).toContainText('Paused');
    await expect(page.getByTestId('story-continue')).toBeVisible();
    expect(await landingValue(page)).toBe('importing');
    await shot(page, 'card-paused');

    // Closing the app and coming back shows the same offer (the Story opens, not Play)
    await page.reload();
    await expect(page.getByTestId('story-continue')).toBeVisible();
    expect(await mode(page)).toBe('games');

    await page.getByTestId('story-continue').click();
    await expect(page.getByTestId('story-load-status')).toHaveCount(0, { timeout: 15_000 });
    await expect(page.getByTestId('story-value-totals')).toHaveText('30');
    expect(calls).toBe(2);
    expect(await page.evaluate(() => window.__wizardChessLibrary?.library.listIds().then((ids) => ids.length))).toBe(
      30,
    );
    // Continue again changes nothing: the stored games are skipped
    await expect.poll(() => landingValue(page)).toBe('seen');
  });

  test('a history with no games shows the empty state, with the form', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.route('**/start/sample/history.json', (route) =>
      fulfilJson(route, { ...historyFile(), games: [], settings: [] }),
    );
    await page.goto(SAMPLE);
    await expect(page.getByTestId('app-shell')).toHaveAttribute('data-first-run', 'applied', { timeout: 15_000 });
    await closeWelcomeIfShown(page);
    await expect(page.getByTestId('story-card-totals')).toContainText('No games yet. Add your username and import.', {
      timeout: 15_000,
    });
    await expect(page.getByTestId('story-form')).toBeVisible();
    await expect(page.getByTestId('story-card-lichess')).toHaveCount(0);
    await expect(page.getByTestId('story-load-status')).toHaveCount(0);
    await shot(page, 'card-empty');
  });

  test('a link with no history file is left alone', async ({ page }) => {
    await page.route('**/start/sample/history.json', (route) => route.fulfill({ status: 404, body: 'not found' }));
    await page.goto(SAMPLE);
    await expect(page.getByTestId('app-shell')).toHaveAttribute('data-first-run', 'applied', { timeout: 15_000 });
    await page.waitForTimeout(500);
    expect(await landingValue(page)).toBeNull();
    expect(await page.evaluate(() => window.__wizardChessLibrary?.library.listIds().then((ids) => ids.length))).toBe(0);
    await expect(page.getByTestId('story-form')).toBeVisible();
  });

  test('shows once: the next launch opens Play, and Games › Story still shows it, with "Start from the top"', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openSampleLink(page);
    await closeWelcomeIfShown(page);
    await expect(page.getByTestId('story-value-totals')).toHaveText('30');
    await expect.poll(() => landingValue(page)).toBe('seen');

    // Every card at 390 px
    for (const id of ['intro', 'totals', 'chesscom', 'closing']) {
      const card = page.getByTestId(`story-card-${id}`);
      await card.evaluate((el) => el.scrollIntoView({ block: 'start' }));
      await expect(card).toBeVisible();
      const box = (await card.boundingBox())!;
      expect(Math.round(box.width)).toBe(358);
      await shot(page, `card-${id}`);
    }
    await expect(page.getByTestId('story-card-totals')).toContainText('30 games in all: 15 W · 9 L · 6 D');
    for (const target of ['story-skip', 'story-save', 'story-top']) {
      const el = page.getByTestId(target);
      if ((await el.count()) === 0) continue;
      await el.scrollIntoViewIfNeeded();
      const box = (await el.boundingBox())!;
      expect(box.height).toBeGreaterThanOrEqual(44);
    }

    // The next launch: Play
    await page.goto('/');
    await expect(page.getByTestId('play-layout').getByTestId('chess-board')).toBeVisible();
    expect(await mode(page)).toBe('play');
    // Games › Story is still there
    await page.getByTestId('mode-tab-games').click();
    await page.getByTestId('games-tab-story').click();
    await expect(page.getByTestId('story-value-totals')).toHaveText('30');
    expect(await landingValue(page)).toBe('seen');
    const top = page.getByTestId('story-top');
    await top.scrollIntoViewIfNeeded();
    await expect(top).toBeVisible();
    await expect.poll(() => page.getByTestId('story-scroll').evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
    await top.click();
    await expect.poll(() => page.getByTestId('story-scroll').evaluate((el) => el.scrollTop)).toBe(0);
    // A #story link opens it from anywhere
    await page.getByTestId('mode-tab-play').click();
    await page.evaluate(() => {
      window.location.hash = '#story';
    });
    await expect(page.getByTestId('story-card-totals')).toBeVisible();
    expect(await mode(page)).toBe('games');
  });
});

test.describe('Chess Story: offline', () => {
  test.use({ serviceWorkers: 'allow' });
  let server: Server | null = null;
  test.afterEach(async () => {
    await server?.stop();
    server = null;
  });

  test('the Story loads with no network once the games are on the device', async ({ page, context }) => {
    test.setTimeout(240_000);
    server = await startServer();
    // (an origin of its own: the install guide's "seen" mark is not set for it)
    await page.addInitScript(() => localStorage.setItem('wc-install-guide-seen', '1'));
    await page.goto(`${server.url}${SAMPLE}`);
    await expect(page.getByTestId('app-shell')).toHaveAttribute('data-first-run', 'applied', { timeout: 20_000 });
    await expect
      .poll(() => storedGames(page), {
        timeout: 20_000,
      })
      .toBe(30);
    await closeWelcomeIfShown(page);
    await waitForOfflineReady(page);
    await context.setOffline(true);
    await page.goto(`${server.url}/#story`);
    await expect(page.getByTestId('story-value-totals')).toHaveText('30', { timeout: 15_000 });
    await expect(page.getByTestId('story-card-chesscom')).toContainText('30 games on Chess.com');
    await context.setOffline(false);
  });
});

test.describe('Chess Story: a load cut off by a reload', () => {
  test('goes on by itself at the next start (no press), with every game stored once', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    let calls = 0;
    await page.route('**/start/sample/history.json', async (route) => {
      calls++;
      // The first request never answers: the page is reloaded while it waits
      if (calls === 1) return;
      await route.continue();
    });
    await page.goto(SAMPLE);
    await expect(page.getByTestId('app-shell')).toHaveAttribute('data-first-run', 'applied', { timeout: 15_000 });
    await expect.poll(() => calls).toBe(1);
    await page.reload();
    await expect.poll(() => storedGames(page), { timeout: 15_000 }).toBe(30);
    expect(calls).toBe(2);
    await closeWelcomeIfShown(page);
    await expect(page.getByTestId('story-value-totals')).toHaveText('30');
    await expect(page.getByTestId('story-continue')).toHaveCount(0);
    expect(await page.evaluate(() => window.__wizardChessLibrary?.library.readSetting('story.import'))).toMatchObject({
      file: { status: 'done', loaded: 30, total: 30 },
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Session 3: "Start import" and "Continue" on Games › Story run the shared Chess.com sync (the API is answered here by
// route interception; the players and games are invented), and the add-another-account control.
// ---------------------------------------------------------------------------------------------------------------------
const API = 'https://api.chess.com';
const PLAYER_A = 'Mock_Story_A';
const PLAYER_B = 'Mock_Story_B';
const baseOf = (player: string) => `${API}/pub/player/${player.toLowerCase()}/games`;
const monthUrl = (player: string, month: string) => `${baseOf(player)}/${month.slice(0, 4)}/${month.slice(5, 7)}`;
const listUrl = (player: string) => `${baseOf(player)}/archives`;

function archiveGame(player: string, id: number, date: string): { url: string; pgn: string } {
  const url = `https://www.chess.com/game/live/${id}`;
  const tags = [
    ['Event', 'Live Chess'],
    ['Site', 'Chess.com'],
    ['Date', date],
    ['White', player],
    ['Black', 'mock_rival_x'],
    ['Result', '1-0'],
    ['UTCDate', date],
    ['UTCTime', '18:02:11'],
    ['WhiteElo', '905'],
    ['BlackElo', '890'],
    ['TimeControl', '600'],
    ['Link', url],
  ];
  return {
    url,
    pgn: `${tags.map(([k, v]) => `[${k} "${v}"]`).join('\n')}\n\n1. e4 e5 2. Qh5 Nc6 3. Bc4 Nf6 4. Qxf7# 1-0\n`,
  };
}

const ARCHIVES: Record<string, Record<string, unknown[]>> = {
  [PLAYER_A]: {
    '2024-05': [archiveGame(PLAYER_A, 7101, '2024.05.04'), archiveGame(PLAYER_A, 7102, '2024.05.19')],
    '2024-06': [archiveGame(PLAYER_A, 7103, '2024.06.02')],
    '2024-07': [archiveGame(PLAYER_A, 7104, '2024.07.09')],
  },
  [PLAYER_B]: {
    '2024-08': [archiveGame(PLAYER_B, 7201, '2024.08.03'), archiveGame(PLAYER_B, 7202, '2024.08.21')],
  },
};

interface StoryMock {
  /** Every request that reached the mocked host, in order. */
  requests: string[];
  /** Addresses that fail as a dropped connection does (while listed). */
  unreachable: Set<string>;
  /** Addresses that answer 429 this many more times. */
  limited: Map<string, number>;
  /** An address held back until `release()` is called. */
  hold: { url: string; released: Promise<void>; release: () => void } | null;
}

/** Holds the answer for one address until `release()` (set before the press, so the order cannot matter). */
function holdUrl(mock: StoryMock, url: string): void {
  let release: () => void = () => undefined;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  mock.hold = { url, released, release };
}

async function mockChessCom(context: BrowserContext): Promise<StoryMock> {
  const mock: StoryMock = { requests: [], unreachable: new Set(), limited: new Map(), hold: null };
  const cors = { 'access-control-allow-origin': '*' };
  await context.route(`${API}/**`, async (route) => {
    const url = route.request().url();
    mock.requests.push(url);
    if (mock.unreachable.has(url)) return route.abort('internetdisconnected');
    const left = mock.limited.get(url) ?? 0;
    if (left > 0) {
      mock.limited.set(url, left - 1);
      return route.fulfill({ status: 429, headers: { ...cors, 'retry-after': '0' }, json: { message: 'slow down' } });
    }
    if (mock.hold?.url === url) await mock.hold.released;
    for (const [player, months] of Object.entries(ARCHIVES)) {
      if (url === listUrl(player)) {
        return route.fulfill({
          status: 200,
          headers: cors,
          json: { archives: Object.keys(months).map((m) => monthUrl(player, m)) },
        });
      }
      const month = Object.keys(months).find((m) => monthUrl(player, m) === url);
      if (month) return route.fulfill({ status: 200, headers: cors, json: { games: months[month] } });
    }
    return route.fulfill({ status: 404, headers: cors, json: { message: 'not found' } });
  });
  return mock;
}

const importBanner = (page: Page) => page.getByTestId('story-sync-status');
const countOf = (mock: StoryMock, url: string) => mock.requests.filter((r) => r === url).length;
const libraryGames = (page: Page) =>
  page.evaluate(() => window.__wizardChessLibrary?.library.listIds().then((ids) => ids.length) ?? -1);

async function openStoryForm(page: Page): Promise<void> {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.getByTestId('story-form')).toBeVisible();
  await page.evaluate(() => window.__wizardChessLibraryReady);
}

test.describe('Chess Story: Start import', () => {
  test('asks nothing until pressed, then reads the newest month first with progress, and fills the cards', async ({
    page,
    context,
  }) => {
    const mock = await mockChessCom(context);
    await openStoryForm(page);
    await page.waitForTimeout(1200);
    expect(mock.requests).toEqual([]);

    // The "comes later" line is gone; the button is live
    await expect(page.getByText('comes in a later update')).toHaveCount(0);
    await expect(page.getByTestId('story-start-import')).toBeEnabled();

    // Typed but not saved: Start import saves it first, then runs. The newest month is held back so the running
    // state can be looked at.
    await page.getByTestId('story-account-chesscom').fill(PLAYER_A);
    holdUrl(mock, monthUrl(PLAYER_A, '2024-07'));
    await page.getByTestId('story-start-import').click();
    await expect(importBanner(page)).toHaveAttribute('data-state', 'running', { timeout: 10_000 });
    await expect(importBanner(page)).toContainText('Chess.com: 0 of 3 months · 0 games');
    await expect(importBanner(page)).toContainText('The numbers grow as games arrive');
    await expect(page.getByTestId('story-start-import')).toBeDisabled();
    expect(await landingValue(page)).toBe('importing');
    await shot(page, 'import-running');
    mock.hold?.release();

    await expect(page.getByTestId('story-value-totals')).toHaveText('4', { timeout: 20_000 });
    await expect(importBanner(page)).toContainText('Import finished: 4 games added.');
    // Newest month first: the list, then July, June, May
    expect(mock.requests).toEqual([
      listUrl(PLAYER_A),
      monthUrl(PLAYER_A, '2024-07'),
      monthUrl(PLAYER_A, '2024-06'),
      monthUrl(PLAYER_A, '2024-05'),
    ]);
    expect(await page.evaluate(() => window.__wizardChessLibrary?.library.getMyAccounts())).toEqual({
      chesscom: PLAYER_A,
      lichess: '',
    });
    await expect(page.getByTestId('story-card-chesscom')).toContainText('4 games on Chess.com');
    await expect.poll(() => landingValue(page)).toBe('seen');
    expect(await libraryGames(page)).toBe(4);
    await shot(page, 'import-finished');
  });

  test('a wrong username shows an error on the field and starts nothing', async ({ page, context }) => {
    const mock = await mockChessCom(context);
    await openStoryForm(page);

    // Not a name Chess.com allows: no request at all
    await page.getByTestId('story-account-chesscom').fill('ab');
    await page.getByTestId('story-start-import').click();
    await expect(page.getByTestId('story-account-chesscom-error')).toContainText('does not look right', {
      timeout: 10_000,
    });
    expect(mock.requests).toEqual([]);

    // A well-formed name that Chess.com does not know
    await page.getByTestId('story-account-chesscom').fill('Nobody_Here_77');
    await page.getByTestId('story-start-import').click();
    await expect(page.getByTestId('story-account-chesscom-error')).toContainText(
      'Chess.com does not know a player with that username.',
      { timeout: 10_000 },
    );
    expect(mock.requests).toEqual([listUrl('Nobody_Here_77')]);
    // Still the form, still a new user, no Continue offered
    await expect(page.getByTestId('story-form')).toBeVisible();
    await expect(page.getByTestId('story-sync-continue')).toHaveCount(0);
    // Still a new user: the landing value was never moved on to "importing"
    expect(await landingValue(page)).not.toBe('importing');
    await shot(page, 'import-field-error');
  });

  test('a dropped connection pauses with Continue; Continue reads only what is left, and a reload keeps the offer', async ({
    page,
    context,
  }) => {
    const mock = await mockChessCom(context);
    await openStoryForm(page);
    // The middle month fails as a lost connection does
    mock.unreachable.add(monthUrl(PLAYER_A, '2024-06'));
    await page.getByTestId('story-account-chesscom').fill(PLAYER_A);
    await page.getByTestId('story-start-import').click();

    await expect(importBanner(page)).toHaveAttribute('data-state', 'paused', { timeout: 20_000 });
    await expect(importBanner(page)).toContainText('Import paused at 1 of 3 months');
    await expect(importBanner(page)).toContainText('Chess.com could not be reached');
    await expect(page.getByTestId('story-sync-continue')).toBeVisible();
    // What was read is on the cards: July's game
    await expect(page.getByTestId('story-value-totals')).toHaveText('1');
    expect(await landingValue(page)).toBe('importing');
    await shot(page, 'import-paused');
    // No automatic retry
    await page.waitForTimeout(2500);
    expect(countOf(mock, monthUrl(PLAYER_A, '2024-06'))).toBe(1);

    // Closing the app and coming back: the same offer, in the Story (not Play)
    await page.reload();
    await expect(page.getByTestId('story-sync-continue')).toBeVisible();
    expect(await mode(page)).toBe('games');
    await expect(importBanner(page)).toContainText('Import paused at 1 of 3 months');

    mock.unreachable.clear();
    mock.requests.length = 0;
    await page.getByTestId('story-sync-continue').click();
    await expect(page.getByTestId('story-value-totals')).toHaveText('4', { timeout: 20_000 });
    await expect(importBanner(page)).toContainText('Import finished: 4 games added.');
    // July was read before and is final: it is not asked for again
    expect(mock.requests).toEqual([listUrl(PLAYER_A), monthUrl(PLAYER_A, '2024-06'), monthUrl(PLAYER_A, '2024-05')]);
    expect(await libraryGames(page)).toBe(4);
    await expect(page.getByTestId('story-sync-continue')).toHaveCount(0);
  });

  test('a second "too many requests" answer pauses with "wait a few minutes", and is not retried by itself', async ({
    page,
    context,
  }) => {
    const mock = await mockChessCom(context);
    await openStoryForm(page);
    const june = monthUrl(PLAYER_A, '2024-06');
    // The sync waits once and tries again (retry-after is 0); the second 429 ends the run
    mock.limited.set(june, 2);
    await page.getByTestId('story-account-chesscom').fill(PLAYER_A);
    await page.getByTestId('story-start-import').click();

    await expect(importBanner(page)).toHaveAttribute('data-state', 'paused', { timeout: 20_000 });
    await expect(importBanner(page)).toContainText('Wait a few minutes');
    await expect(page.getByTestId('story-sync-continue')).toBeVisible();
    expect(countOf(mock, june)).toBe(2);
    await page.waitForTimeout(2500);
    expect(countOf(mock, june)).toBe(2);
    await shot(page, 'import-rate-limited');

    await page.getByTestId('story-sync-continue').click();
    await expect(page.getByTestId('story-value-totals')).toHaveText('4', { timeout: 20_000 });
    expect(countOf(mock, june)).toBe(3);
  });

  test('only one run exists at a time: the Settings button says so while an import runs', async ({ page, context }) => {
    const mock = await mockChessCom(context);
    await openStoryForm(page);
    holdUrl(mock, monthUrl(PLAYER_A, '2024-07'));
    await page.getByTestId('story-account-chesscom').fill(PLAYER_A);
    await page.getByTestId('story-start-import').click();
    await expect(importBanner(page)).toHaveAttribute('data-state', 'running', { timeout: 10_000 });

    await page.getByTestId('btn-settings').click();
    await expect(page.getByTestId('settings-sheet')).toBeVisible();
    const button = page.getByTestId('btn-chesscom-sync');
    await button.scrollIntoViewIfNeeded();
    await button.click();
    await expect(page.getByTestId('sync-status')).toContainText('An import is running on Games › Story');
    // The Settings press asked for nothing: the list was asked for once, by the import
    expect(countOf(mock, listUrl(PLAYER_A))).toBe(1);
    mock.hold?.release();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('story-value-totals')).toHaveText('4', { timeout: 20_000 });
  });
});

test.describe('Chess Story: add another account', () => {
  test('an added account syncs with its own month record, is counted, and Remove keeps its games but stops counting them', async ({
    page,
    context,
  }) => {
    const mock = await mockChessCom(context);
    await openStoryForm(page);
    await page.getByTestId('story-account-chesscom').fill(PLAYER_A);

    // An empty or a repeated name is refused, with the reason on the control
    await page.getByTestId('story-more-chesscom-add').click();
    await expect(page.getByTestId('story-more-chesscom-error')).toContainText('Type the Chess.com username first.');
    await page.getByTestId('story-more-chesscom-input').fill(PLAYER_B);
    await page.getByTestId('story-more-chesscom-add').click();
    await expect(page.getByTestId('story-more-chesscom-item')).toHaveText(new RegExp(PLAYER_B));
    await page.getByTestId('story-save').click();
    await page.getByTestId('story-more-chesscom-input').fill(PLAYER_A.toUpperCase());
    await page.getByTestId('story-more-chesscom-add').click();
    await expect(page.getByTestId('story-more-chesscom-error')).toContainText('already in your list');
    await shot(page, 'form-added-account');

    await page.getByTestId('story-start-import').click();
    await expect(page.getByTestId('story-value-totals')).toHaveText('6', { timeout: 30_000 });
    await expect(importBanner(page)).toContainText('Import finished: 6 games added.');
    // The saved account first, then the added one, one after another
    const a = PLAYER_A.toLowerCase();
    const b = PLAYER_B.toLowerCase();
    expect(mock.requests.map((r) => r.replace(/^.*\/player\//, ''))).toEqual([
      `${a}/games/archives`,
      `${a}/games/2024/07`,
      `${a}/games/2024/06`,
      `${a}/games/2024/05`,
      `${b}/games/archives`,
      `${b}/games/2024/08`,
    ]);
    // Each account has a month record of its own
    const records = await page.evaluate(async (second) => {
      const lib = window.__wizardChessLibrary!.library;
      const first = await lib.readSetting<{ player: string; months: object }>('sync.chesscom');
      const other = await lib.readSetting<{ player: string; months: object }>(`sync.chesscom.${second}`);
      return {
        first: [first?.player, Object.keys(first?.months ?? {}).length],
        other: [other?.player, Object.keys(other?.months ?? {}).length],
      };
    }, b);
    expect(records.first).toEqual([a, 3]);
    expect(records.other).toEqual([b, 1]);
    expect(await page.evaluate(() => window.__wizardChessLibrary?.library.getMoreAccounts())).toEqual([
      { site: 'chesscom', username: PLAYER_B },
    ]);

    // Settings › Your games shows the same list; Remove there keeps the games stored and stops counting them
    await page.getByTestId('btn-settings').click();
    await expect(page.getByTestId('settings-sheet')).toBeVisible();
    const item = page.getByTestId('settings-more-chesscom-item');
    await item.scrollIntoViewIfNeeded();
    await expect(item).toHaveText(new RegExp(PLAYER_B));
    await page.getByTestId('settings-more-chesscom-remove').click();
    await expect(page.getByTestId('settings-more-chesscom-item')).toHaveCount(0);
    expect(await libraryGames(page)).toBe(6);
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('story-value-totals')).toHaveText('4');
    expect(await libraryGames(page)).toBe(6);
  });

  test('Settings › Your games adds an account too, and its sync button covers every Chess.com account', async ({
    page,
    context,
  }) => {
    await mockChessCom(context);
    await openStoryForm(page);
    await page.getByTestId('story-account-chesscom').fill(PLAYER_A);
    await page.getByTestId('story-save').click();
    await expect(page.getByTestId('story-form-saved')).toBeVisible();

    await page.getByTestId('btn-settings').click();
    await expect(page.getByTestId('settings-sheet')).toBeVisible();
    const input = page.getByTestId('settings-more-chesscom-input');
    await input.scrollIntoViewIfNeeded();
    await input.fill('x y');
    await page.getByTestId('settings-more-chesscom-add').click();
    await expect(page.getByTestId('settings-more-chesscom-error')).toContainText('does not look right');
    await input.fill(PLAYER_B);
    await page.getByTestId('settings-more-chesscom-add').click();
    await expect(page.getByTestId('settings-more-chesscom-item')).toHaveText(new RegExp(PLAYER_B));
    await shot(page, 'settings-added-list');
    const box = (await page.getByTestId('settings-more-chesscom-add').boundingBox())!;
    expect(box.height).toBeGreaterThanOrEqual(44);
    expect(await page.evaluate(() => window.__wizardChessLibrary?.library.getUserAccounts().length)).toBe(2);

    const button = page.getByTestId('btn-chesscom-sync');
    await button.scrollIntoViewIfNeeded();
    await button.click();
    await expect(button).toHaveAttribute('data-state', 'idle', { timeout: 30_000 });
    await expect(page.getByTestId('sync-status')).toContainText(PLAYER_B);
    expect(await libraryGames(page)).toBe(6);
    await shot(page, 'settings-added-account');
  });
});
