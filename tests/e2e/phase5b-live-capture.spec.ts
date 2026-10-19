import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import {
  badgeText,
  launchWithExtension,
  mock,
  openGamesList,
  openPopup,
  queueEntry,
  readFixture,
  setUsernames,
  SITE_URL,
  stripPageAssets,
  tabIdOf,
  type ExtensionSession,
  type LaunchOptions,
} from './helpers/extension';

// The fixes from live testing (docs/PROGRESS.md, "Phase 5b — Live capture fixes"): the end of
// a game from the sites' own data, finished games opened afterwards, Chess.com play pages,
// leaving a game page, the background sync, delivery without focus, "Debug this tab", and
// local dates.

const SCREENSHOT_DIR = path.join('test-results', 'phase5b-screens');

const LICHESS_GAME = 'https://lichess.org/Bjl39T9x';
const CHESSCOM_GAME = 'https://www.chess.com/game/live/185518487990';
const CHESSCOM_CALLBACK = 'https://www.chess.com/callback/live/game/185518487990';
const CHESSCOM_PAGE = '<!doctype html><html><head><title>Chess.com</title></head><body><div id="board-layout-main"></div></body></html>';

const lichessFinished = () => stripPageAssets(readFixture('lichess/page-Bjl39T9x.html'));
const lichessLive = () =>
  lichessFinished().replace('"status":{"id":30,"name":"mate"}', '"status":{"id":20,"name":"started"}').replace('"winner":"black",', '');

/** Hikaru's game 185518487990 as Chess.com's game data, finished `endedAgoS` seconds ago (null: still running). */
function chessComCallback(endedAgoS: number | null): string {
  const data = JSON.parse(readFixture('chesscom/callback-live-185518487990.json')) as { game: Record<string, unknown> };
  if (endedAgoS === null) data.game.isFinished = false;
  else data.game.endTime = Math.floor(Date.now() / 1000) - endedAgoS;
  return JSON.stringify(data);
}

const json = (body: string) => ({ body, contentType: 'application/json' });

async function debugRow(popup: Page, label: string) {
  return popup.locator(`[data-testid="popup-debug-rows"] dd[data-label="${label}"]`);
}

let session: ExtensionSession | null = null;

async function start(options: LaunchOptions = {}): Promise<ExtensionSession> {
  session = await launchWithExtension(options);
  return session;
}

test.afterEach(async () => {
  await session?.close();
  session = null;
});

test.describe('Phase 5b — live capture fixes', () => {
  test('Lichess: the end of my game comes from the official game stream (no result block on the page)', async () => {
    const s = await start();
    let pageHtml = lichessLive();
    mock(s, LICHESS_GAME, (route) => route.fulfill({ body: pageHtml, contentType: 'text/html; charset=utf-8' }));
    mock(s, 'https://lichess.org/game/export/Bjl39T9x*', { status: 401, ...json('{"error":"Login required"}') });
    let endGame: () => void = () => undefined;
    const ended = new Promise<void>((r) => {
      endGame = r;
    });
    const streamRequests: string[] = [];
    mock(s, 'https://lichess.org/api/stream/game/Bjl39T9x', async (route) => {
      streamRequests.push(route.request().url());
      // Lichess keeps the stream open while the game runs and sends the last line when it ends
      await ended;
      await route.fulfill({ body: readFixture('lichess/stream-Bjl39T9x-finished.ndjson'), contentType: 'application/x-ndjson' });
    });
    await setUsernames(s, 'lobo017', '');

    const page = await s.context.newPage();
    await page.goto(LICHESS_GAME);
    const save = page.getByTestId('wc-save-button');
    await expect(save).toHaveAttribute('data-state', 'in-progress');
    await expect.poll(() => streamRequests.length).toBe(1);

    pageHtml = lichessFinished();
    endGame();
    await expect(save).toHaveAttribute('data-state', 'saved', { timeout: 15_000 });
    expect(await page.locator('.result-wrap').count()).toBe(0);
    expect(await queueEntry(s, 'lichess:Bjl39T9x')).toMatchObject({ method: 'lichess-page-data', trigger: 'game-end' });
    await expect.poll(() => badgeText(s.worker)).toBe('1');
  });

  test('Chess.com: a game of mine opened just after it ended is captured; an old one only gets the Save button', async () => {
    const s = await start();
    mock(s, CHESSCOM_GAME, { body: CHESSCOM_PAGE });
    mock(s, CHESSCOM_CALLBACK, json(chessComCallback(90)));
    const OLD = 'https://www.chess.com/game/live/185358990103';
    mock(s, OLD, { body: CHESSCOM_PAGE });
    mock(s, 'https://www.chess.com/callback/live/game/185358990103', json(readFixture('chesscom/callback-live-185358990103.json')));
    await setUsernames(s, '', 'hikaru');

    const page = await s.context.newPage();
    await page.goto(CHESSCOM_GAME);
    await expect(page.getByTestId('wc-save-button')).toHaveAttribute('data-state', 'saved', { timeout: 10_000 });
    await expect(page.getByTestId('wc-save-note')).toContainText('Captured automatically');
    expect(await queueEntry(s, 'chesscom:live-185518487990')).toMatchObject({ method: 'chesscom-callback', trigger: 'page-open' });

    await page.goto(OLD);
    await expect(page.getByTestId('wc-save-button')).toHaveAttribute('data-state', 'ready');
    expect(await queueEntry(s, 'chesscom:live-185358990103')).toBeNull();
  });

  test("Chess.com play page: the game ID comes from the page's own requests", async () => {
    const s = await start();
    const PLAY = 'https://www.chess.com/play/online';
    mock(s, PLAY, {
      body: `<!doctype html><html><body><div id="board-layout-main"></div>
<script>setTimeout(() => fetch('/callback/live/game/185518487990').catch(() => {}), 300);</script></body></html>`,
    });
    mock(s, CHESSCOM_CALLBACK, json(chessComCallback(30)));
    await setUsernames(s, '', 'hikaru');

    const page = await s.context.newPage();
    await page.goto(PLAY);
    await expect(page.getByTestId('wc-save-button')).toHaveAttribute('data-state', 'saved', { timeout: 10_000 });
    expect(await queueEntry(s, 'chesscom:live-185518487990')).toMatchObject({ trigger: 'page-open' });

    const popup = await openPopup(s, await tabIdOf(s, PLAY));
    await popup.getByTestId('popup-debug-btn').click();
    await expect(await debugRow(popup, 'Page')).toHaveText('play page (no game ID in the URL)');
    await expect(await debugRow(popup, 'Game ID')).toHaveText("live-185518487990 (from the page's requests (/callback/live/game/185518487990))");
  });

  test('Leaving a Chess.com game page before the end shows: the background captures the game, then syncs', async () => {
    const s = await start();
    let callback = chessComCallback(null);
    mock(s, CHESSCOM_GAME, { body: CHESSCOM_PAGE });
    mock(s, CHESSCOM_CALLBACK, (route) => route.fulfill(json(callback)));
    const archiveRequests: string[] = [];
    mock(s, 'https://api.chess.com/pub/player/hikaru/games/*', (route) => {
      archiveRequests.push(route.request().url());
      return route.fulfill(json('{"games":[]}'));
    });
    await setUsernames(s, '', 'hikaru');

    const page = await s.context.newPage();
    await page.goto(CHESSCOM_GAME);
    await expect(page.getByTestId('wc-save-button')).toHaveAttribute('data-state', 'in-progress');
    // The background has the page's report (in progress, my game)
    await expect
      .poll(() =>
        s.worker.evaluate(async () => {
          const api = (self as unknown as { __wizardChessCapture: { readTabs(): Promise<Record<string, { state: string; mine: boolean }>> } })
            .__wizardChessCapture;
          return Object.values(await api.readTabs()).map((t) => `${t.state}/${t.mine}`);
        }),
      )
      .toEqual(['in-progress/true']);

    // The game ends and I close the tab at once, before the page's next check
    callback = chessComCallback(5);
    await page.close();
    await expect.poll(() => queueEntry(s, 'chesscom:live-185518487990'), { timeout: 10_000 }).toMatchObject({
      status: 'ready',
      method: 'chesscom-callback',
      trigger: 'left-page',
    });
    // …and my recent games are checked too (the safety net)
    await expect.poll(() => archiveRequests.length, { timeout: 15_000 }).toBeGreaterThan(0);
    expect(archiveRequests[0]).toMatch(/\/pub\/player\/hikaru\/games\/\d{4}\/\d{2}$/);
  });

  test('Background sync: my recent games come in on the alarm while a Lichess tab is open, not without one', async () => {
    const s = await start();
    const now = Date.now();
    const lines = readFixture('lichess/user-games.ndjson')
      .split('\n')
      .filter(Boolean)
      .map((l, i) => ({ ...(JSON.parse(l) as Record<string, unknown>), createdAt: now - (i + 1) * 10 * 60_000 }));
    const userRequests: string[] = [];
    mock(s, 'https://lichess.org/api/games/user/lobo017*', (route) => {
      const url = new URL(route.request().url());
      userRequests.push(url.toString());
      const since = Number(url.searchParams.get('since'));
      const body = lines.filter((l) => (l.createdAt as number) >= since).map((l) => JSON.stringify(l)).join('\n');
      return route.fulfill({ body, contentType: 'application/x-ndjson' });
    });
    mock(s, 'https://lichess.org/', { body: '<!doctype html><title>lichess.org</title><p>Lobby</p>' });
    await setUsernames(s, 'lobo017', '');
    expect(await s.worker.evaluate(async () => (await chrome.alarms.get('auto-sync'))?.periodInMinutes)).toBe(3);
    const alarm = () =>
      s.worker.evaluate(async () => {
        const api = (self as unknown as { __wizardChessCapture: { onAutoSyncAlarm(): Promise<void> } }).__wizardChessCapture;
        await api.onAutoSyncAlarm();
      });

    // No Lichess or Chess.com tab: nothing is fetched
    await alarm();
    expect(userRequests).toHaveLength(0);

    const lobby = await s.context.newPage();
    await lobby.goto('https://lichess.org/');
    await alarm();
    expect(userRequests).toHaveLength(1);
    await expect.poll(() => badgeText(s.worker)).toBe('4');
    expect(await queueEntry(s, 'lichess:iTIXmTZF')).toMatchObject({ status: 'ready', method: 'lichess-sync', trigger: 'sync' });

    const popup = await openPopup(s);
    await expect(popup.getByTestId('popup-sync-lichess-status')).toContainText('4 new games.');
    await expect(popup.locator('[data-key="lichess:iTIXmTZF"]')).toContainText('auto: background check');
    await popup.close();

    await lobby.close();
    await alarm();
    expect(userRequests).toHaveLength(1);
  });

  test('Delivery: a game captured while the analysis site sits in a background tab reaches it with no focus or visibility event', async () => {
    const s = await start();
    const site = await openGamesList(s);
    await expect(site.getByTestId('games-extension-status')).toContainText('up to date');
    await site.evaluate(() => {
      const w = window as unknown as { __wakes: number };
      w.__wakes = 0;
      window.addEventListener('focus', () => w.__wakes++);
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') w.__wakes++;
      });
    });
    mock(s, CHESSCOM_GAME, { body: CHESSCOM_PAGE });
    mock(s, CHESSCOM_CALLBACK, json(readFixture('chesscom/callback-live-185518487990.json')));
    const page = await s.context.newPage();
    await page.goto(CHESSCOM_GAME);
    await page.getByTestId('wc-save-button').click();
    await expect(page.getByTestId('wc-save-button')).toHaveAttribute('data-state', 'saved');

    await expect(site.getByTestId('games-row')).toHaveCount(1, { timeout: 10_000 });
    expect(await site.evaluate(() => (window as unknown as { __wakes: number }).__wakes)).toBe(0);
    await expect.poll(() => badgeText(s.worker)).toBe('');
    expect(await queueEntry(s, 'chesscom:live-185518487990')).toMatchObject({ status: 'delivered', trigger: 'save-button' });
  });

  test('Debug this tab: what the page sees; a stopped script is reported and can be started again; other tabs', async () => {
    const s = await start();
    mock(s, LICHESS_GAME, { body: lichessLive() });
    // The stream stays open, as for a running game
    mock(s, 'https://lichess.org/api/stream/game/Bjl39T9x', () => new Promise(() => undefined));
    await setUsernames(s, 'lobo017', '');
    const page = await s.context.newPage();
    await page.goto(LICHESS_GAME);
    await expect(page.getByTestId('wc-save-button')).toHaveAttribute('data-state', 'in-progress');

    const popup = await openPopup(s, await tabIdOf(s, LICHESS_GAME));
    await popup.getByTestId('popup-debug-btn').click();
    await expect(await debugRow(popup, 'Tab')).toHaveText(LICHESS_GAME);
    await expect(await debugRow(popup, 'Capture script')).toContainText('running since');
    await expect(await debugRow(popup, 'Page')).toHaveText('game page');
    await expect(await debugRow(popup, 'Game ID')).toHaveText('Bjl39T9x (from the URL)');
    await expect(await debugRow(popup, 'Game state')).toHaveText('in progress (page data)');
    await expect(await debugRow(popup, 'Players')).toHaveText('GEU3 (White) vs Lobo017 (Black)');
    await expect(await debugRow(popup, 'My game')).toHaveText('yes: lobo017 plays Black');
    await expect(await debugRow(popup, 'Watching for the end')).toContainText('Lichess game stream');
    await expect(await debugRow(popup, 'Watching for the end')).toContainText('.result-wrap');
    await expect(await debugRow(popup, 'Last detection event')).toContainText('Game Bjl39T9x: in progress (page data).');
    await expect(await debugRow(popup, 'Lichess check')).toContainText('on: every 3 min while a Lichess tab is open');
    await expect(await debugRow(popup, 'This game')).toHaveText('not captured');
    await expect(popup.getByTestId('popup-debug-events')).toContainText('Capture script started');
    await expect(popup.getByTestId('popup-debug-copy')).toBeVisible();
    await expect(popup.getByTestId('popup-debug-inject')).toBeHidden();
    await popup.setViewportSize({ width: 380, height: 1100 });
    await popup.screenshot({ path: path.join(SCREENSHOT_DIR, 'popup-debug-lichess.png'), fullPage: true });

    // The page's script stops (as after the extension is reloaded): its button goes
    await page.evaluate(() => document.documentElement.setAttribute('data-wc-capture', 'replaced'));
    await expect(page.getByTestId('wc-save-button')).toHaveCount(0);
    await popup.getByTestId('popup-debug-btn').click();
    await expect(await debugRow(popup, 'Capture script')).toContainText('not running on this tab');
    await popup.getByTestId('popup-debug-inject').click();
    await expect(await debugRow(popup, 'Capture script')).toContainText('running since', { timeout: 10_000 });
    await expect(page.getByTestId('wc-save-button')).toHaveAttribute('data-state', 'in-progress');
    await expect(page.getByTestId('wc-save-button')).toHaveCount(1);

    // A tab off the game sites
    const site = await openGamesList(s);
    const popup2 = await openPopup(s, await tabIdOf(s, `${SITE_URL}/#games`));
    await popup2.getByTestId('popup-debug-btn').click();
    await expect(await debugRow(popup2, 'Capture script')).toContainText('none (it only runs on lichess.org and www.chess.com)');
    await expect(await debugRow(popup2, 'Analysis site')).toContainText('open in a tab');
    await site.close();
  });

  test('Tabs open before the extension was installed get the capture script', async () => {
    const OLD = 'https://www.chess.com/game/live/185358990103';
    const s = await start({
      beforeLoad: async (context, mocks) => {
        mocks.push({ url: OLD, respond: { body: CHESSCOM_PAGE } });
        mocks.push({
          url: 'https://www.chess.com/callback/live/game/185358990103',
          respond: json(readFixture('chesscom/callback-live-185358990103.json')),
        });
        const early = await context.newPage();
        await early.goto(OLD);
      },
    });
    const early = s.context.pages().find((p) => p.url() === OLD)!;
    await expect(early.getByTestId('wc-save-button')).toHaveAttribute('data-state', 'ready', { timeout: 10_000 });
    expect(await early.locator('#wizard-chess-capture').count()).toBe(1);
  });

  test('Popup wording and local dates: what "waiting" means, opening the site, times in my time zone (Asia/Tokyo)', async () => {
    const s = await start({ timezoneId: 'Asia/Tokyo' });
    const popup = await openPopup(s);
    await expect(popup.getByTestId('popup-counts')).toHaveText('No games waiting · 0 games on the analysis site');
    await popup.getByTestId('popup-paste').fill(`[Event "Late game"]
[Site "Lisbon"]
[Date "2026.10.17"]
[UTCDate "2026.10.17"]
[UTCTime "20:30:00"]
[White "Alice"]
[Black "Bob"]
[Result "1-0"]

1. e4 e5 2. Qh5 Nc6 3. Bc4 Nf6 4. Qxf7# 1-0`);
    await popup.getByTestId('popup-save').click();
    await expect(popup.getByTestId('popup-result')).toContainText('Saved Alice vs Bob');
    await expect(popup.getByTestId('popup-counts')).toHaveText('1 game waiting for the analysis site');
    await expect(popup.getByTestId('popup-delivery-text')).toContainText(
      '“Waiting” means captured and kept here in the extension, but not yet copied into the analysis site’s Games list.',
    );
    await expect(popup.getByTestId('popup-delivery-text')).toContainText(`as soon as the site (${SITE_URL}) is open in a tab`);
    await expect(popup.getByTestId('popup-site-state')).toHaveText('The analysis site isn’t open in any tab.');
    // 20:30 UTC on the 17th is 05:30 on the 18th in Tokyo
    await expect(popup.getByTestId('popup-entry-played')).toHaveText('2026-10-18 05:30');
    await expect(popup.getByTestId('popup-entry').locator('.status')).toHaveText('ready to send');
    await popup.screenshot({ path: path.join(SCREENSHOT_DIR, 'popup-waiting.png'), fullPage: true });

    const [site] = await Promise.all([s.context.waitForEvent('page'), popup.getByTestId('popup-open-site').click()]);
    await site.waitForURL(`${SITE_URL}/#games`);
    await site.evaluate(() => window.__wizardChessLibraryReady);
    await expect(site.getByTestId('games-row')).toHaveCount(1, { timeout: 10_000 });
    await expect(site.getByTestId('games-row-date')).toHaveText('2026-10-18 05:30');
    await expect(site.locator('.wc-games-date')).toHaveAttribute('title', 'Started 2026-10-18 05:30 (Asia/Tokyo)');
    await site.screenshot({ path: path.join(SCREENSHOT_DIR, 'games-list-local-time.png') });

    await expect(popup.getByTestId('popup-counts')).toHaveText('No games waiting · 1 game on the analysis site', { timeout: 10_000 });
    await expect(popup.getByTestId('popup-site-state')).toHaveText('The analysis site is open in a tab.');
    await expect(popup.getByTestId('popup-open-site')).toHaveText('Show the analysis site');
  });
});

/**
 * The sequence from live testing (docs/PROGRESS.md, "Chess.com in-progress games"): during a
 * live game the URL is /game/{id} with no type, and Chess.com's game data answers 404 "Game is
 * not found." until the game has ended, then the finished game.
 */
test.describe('Phase 5b — Chess.com games with no data until they end', () => {
  const UNTYPED = 'https://www.chess.com/game/185518487990';
  const NOT_FOUND = readFixture('chesscom/callback-live-in-progress-404.json');

  /** The game page and its game data, which answers 404 until `end()`. */
  function chessComGameInProgress(s: ExtensionSession) {
    let ended = false;
    const dataRequests: string[] = [];
    mock(s, UNTYPED, { body: CHESSCOM_PAGE });
    mock(
      s,
      (url) => url.startsWith('https://www.chess.com/callback/'),
      (route) => {
        const url = route.request().url();
        dataRequests.push(url);
        if (ended && url === CHESSCOM_CALLBACK) return route.fulfill(json(chessComCallback(3)));
        return route.fulfill({ status: 404, ...json(NOT_FOUND) });
      },
    );
    return {
      dataRequests,
      end: () => {
        ended = true;
      },
    };
  }

  test('404 while the game runs, then the data: captured on the page by the game-data check', async () => {
    const s = await start();
    const game = chessComGameInProgress(s);
    await setUsernames(s, '', 'hikaru');
    const page = await s.context.newPage();
    await page.goto(UNTYPED);
    const save = page.getByTestId('wc-save-button');
    await expect(save).toHaveAttribute('data-state', 'in-progress');
    await expect(page.getByTestId('wc-save-note')).toHaveText('Captured when the game has ended (Chess.com shares it then).');

    const popup = await openPopup(s, await tabIdOf(s, UNTYPED));
    await popup.getByTestId('popup-debug-btn').click();
    await expect(await debugRow(popup, 'Game ID')).toHaveText('live-185518487990 (from the URL)');
    await expect(await debugRow(popup, 'Game state')).toHaveText(
      "not available yet (Chess.com shares a live game's data once it has ended)",
    );
    await expect(await debugRow(popup, 'My game')).toHaveText("unknown until the site has the game's data (players)");
    await expect(await debugRow(popup, 'Watching for the end')).toContainText('game data (callback) every 10 s');
    // The page keeps checking while the game runs (first check 10 s after the page loaded): still 404
    await expect.poll(() => game.dataRequests.length, { timeout: 15_000 }).toBeGreaterThanOrEqual(2);
    await popup.getByTestId('popup-debug-btn').click();
    await expect(popup.getByTestId('popup-debug-events')).toContainText('Game data check: not available yet (404).');
    await expect(save).toHaveAttribute('data-state', 'in-progress');
    await popup.screenshot({ path: path.join(SCREENSHOT_DIR, 'popup-debug-chesscom-not-available.png'), fullPage: true });

    game.end();
    await expect(save).toHaveAttribute('data-state', 'saved', { timeout: 15_000 });
    expect(await queueEntry(s, 'chesscom:live-185518487990')).toMatchObject({ method: 'chesscom-callback', trigger: 'game-end' });
    // A 12-digit ID is a live game: the daily endpoint is never asked
    expect(game.dataRequests.every((u) => u === CHESSCOM_CALLBACK)).toBe(true);
    await popup.getByTestId('popup-debug-btn').click();
    await expect(popup.getByTestId('popup-debug-events')).toContainText('Game data check: finished.');
    await expect(await debugRow(popup, 'Game state')).toHaveText('finished (game data (callback))');
  });

  test("a request of the page about the game triggers the check at once (no 10 s wait)", async () => {
    const s = await start();
    const game = chessComGameInProgress(s);
    mock(s, 'https://www.chess.com/analysis/game/live/185518487990*', { body: '<!doctype html><p>review</p>' });
    await setUsernames(s, '', 'hikaru');
    const page = await s.context.newPage();
    await page.goto(UNTYPED);
    const save = page.getByTestId('wc-save-button');
    await expect(save).toHaveAttribute('data-state', 'in-progress');

    // The game ends; the page loads something about it (here: its review)
    game.end();
    const t0 = Date.now();
    await page.evaluate(() => fetch('/analysis/game/live/185518487990?tab=review').then(() => undefined));
    await expect(save).toHaveAttribute('data-state', 'saved', { timeout: 7000 });
    expect(Date.now() - t0).toBeLessThan(7000);

    const popup = await openPopup(s, await tabIdOf(s, UNTYPED));
    await popup.getByTestId('popup-debug-btn').click();
    await expect(popup.getByTestId('popup-debug-events')).toContainText('Page request about this game: /analysis/game/live/185518487990');
  });

  test('leaving while the data is still 404: the background tries again and captures the game', async () => {
    const s = await start();
    const game = chessComGameInProgress(s);
    mock(s, 'https://api.chess.com/pub/player/hikaru/games/*', json('{"games":[]}'));
    await setUsernames(s, '', 'hikaru');
    const page = await s.context.newPage();
    await page.goto(UNTYPED);
    await expect(page.getByTestId('wc-save-button')).toHaveAttribute('data-state', 'in-progress');
    await expect
      .poll(() =>
        s.worker.evaluate(async () => {
          const api = (self as unknown as { __wizardChessCapture: { readTabs(): Promise<Record<string, { state: string }>> } })
            .__wizardChessCapture;
          return Object.values(await api.readTabs()).map((t) => t.state);
        }),
      )
      .toEqual(['not-available']);

    // I close the tab in the game's last seconds: the data isn't there when the background first asks
    const before = game.dataRequests.length;
    await page.close();
    await expect.poll(() => game.dataRequests.length).toBeGreaterThan(before);
    const retrying = () =>
      s.worker.evaluate(async () => {
        const api = (self as unknown as { __wizardChessCapture: { retries: { list(): Promise<Array<{ key: string; attempt: number }>> } } })
          .__wizardChessCapture;
        return api.retries.list();
      });
    await expect.poll(retrying).toEqual([expect.objectContaining({ key: 'chesscom:live-185518487990', attempt: 0 })]);
    expect(await queueEntry(s, 'chesscom:live-185518487990')).toBeNull();

    // The game ends; the retry 10 s later gets it
    game.end();
    await expect.poll(() => queueEntry(s, 'chesscom:live-185518487990'), { timeout: 20_000 }).toMatchObject({
      status: 'ready',
      method: 'chesscom-callback',
      trigger: 'left-page',
    });
    expect(await retrying()).toEqual([]);
  });
});
