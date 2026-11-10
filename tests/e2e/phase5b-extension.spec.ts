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
  SITE_URL_LOCALHOST,
  stripPageAssets,
  type ExtensionSession,
} from './helpers/extension';

// Screenshots go outside Playwright's output folder, which is wiped on every run
const SCREENSHOT_DIR = path.join('test-results', 'phase5b-screens');

const PASTED_PGN = `[Event "Club night"]
[Site "Lisbon"]
[Date "2026.10.12"]
[White "Alice"]
[Black "Bob"]
[Result "1-0"]
[TimeControl "600+5"]

1. e4 e5 2. Nf3 Nc6 3. Bc4 Nf6 4. Ng5 d5 5. exd5 Na5 6. Bb5+ c6 7. dxc6 bxc6 8. Qf3 Rb8 9. Bd3 h6 10. Ne4 Nd5 11. Nbc3 Nf4 12. Bf1 1-0`;

async function rowCount(page: Page): Promise<number> {
  return page.getByTestId('games-row').count();
}

/** A Chess.com game page as the extension sees it: the game data comes from the callback request. */
const CHESSCOM_PAGE =
  '<!doctype html><html><head><title>Chess.com</title></head><body><div id="board-layout-main"></div></body></html>';

/** A Chess.com page whose Share button opens a dialog with a PGN tab, like the site's. */
function shareDialogPage(pgn: string): string {
  return `<!doctype html><html><body><div id="board-layout-main"></div>
<button type="button" aria-label="Share" class="share-button-component">Share</button>
<script>
document.querySelector('button[aria-label="Share"]').addEventListener('click', () => {
  const menu = document.createElement('div');
  menu.className = 'share-menu-component';
  menu.innerHTML = '<div class="share-menu-tab-selector-component"><button role="tab">Link</button><button role="tab">PGN</button></div><button aria-label="Close">×</button>';
  document.body.appendChild(menu);
  menu.querySelectorAll('[role="tab"]')[1].addEventListener('click', () => {
    setTimeout(() => {
      const box = document.createElement('textarea');
      box.className = 'share-menu-tab-pgn-textarea';
      box.value = ${JSON.stringify(pgn)};
      menu.appendChild(box);
    }, 200);
  });
  menu.querySelector('[aria-label="Close"]').addEventListener('click', () => menu.remove());
});
</script></body></html>`;
}

function archivePgn(file: string, id: string): string {
  const games = JSON.parse(readFixture(`chesscom/${file}`)).games as Array<{ url: string; pgn: string }>;
  return games.find((g) => g.url.endsWith(`/${id}`))!.pgn;
}

test.describe('Phase 5b — capture extension', () => {
  let session: ExtensionSession;

  test.beforeEach(async () => {
    session = await launchWithExtension();
  });

  test.afterEach(async () => {
    await session.close();
  });

  test('pasted PGN: popup → queue → badge → site Games list, delivered exactly once', async () => {
    const popup = await openPopup(session);
    await popup.getByTestId('popup-paste').fill(PASTED_PGN);
    await popup.getByTestId('popup-save').click();
    await expect(popup.getByTestId('popup-result')).toHaveText('Saved Alice vs Bob');
    await expect(popup.getByTestId('popup-entry')).toHaveCount(1);
    await expect(popup.getByTestId('popup-entry')).toHaveAttribute('data-status', 'ready');
    await expect(popup.getByTestId('popup-entry')).toContainText('pasted PGN');
    await expect.poll(() => badgeText(session.worker)).toBe('1');

    // An invalid PGN is rejected before it reaches the queue
    await popup.getByTestId('popup-paste').fill('[Event "Bad"]\n\n1. e4 e5 2. Ke3 *');
    await popup.getByTestId('popup-save').click();
    await expect(popup.getByTestId('popup-result')).toContainText('not a valid PGN');
    await expect(popup.getByTestId('popup-result')).toHaveAttribute('data-tone', 'bad');
    await expect(popup.getByTestId('popup-entry')).toHaveCount(1);

    // The site picks the game up as soon as it opens
    const site = await openGamesList(session);
    await expect(site.getByTestId('games-row')).toHaveCount(1);
    await expect(site.getByTestId('games-row-opponent')).toContainText('Alice vs Bob');
    await expect(site.getByTestId('games-row-tc')).toHaveText('10+5');
    await expect(site.getByTestId('games-row-date')).toHaveText('2026-10-12');
    // Not one of my games: the result is shown as played
    await expect(site.getByTestId('games-row-result')).toHaveText('1-0');
    await expect(site.getByTestId('games-row-color')).toHaveAttribute('data-color', 'none');
    await expect(site.getByTestId('games-extension-status')).toHaveAttribute('data-state', 'connected');
    await expect.poll(() => badgeText(session.worker)).toBe('');
    await expect(popup.getByTestId('popup-entry')).toHaveAttribute('data-status', 'delivered');

    // A game captured while the site is open arrives right away, without waiting for focus
    await popup.getByTestId('popup-paste').fill(PASTED_PGN.replace('"Alice"', '"Alicia"'));
    await popup.getByTestId('popup-save').click();
    await expect(popup.getByTestId('popup-result')).toHaveText('Saved Alicia vs Bob');
    await expect(site.getByTestId('games-row')).toHaveCount(2);
    await expect.poll(() => badgeText(session.worker)).toBe('');

    // Another sync (focus) and a reload don't duplicate anything
    await site.evaluate(() => window.dispatchEvent(new Event('focus')));
    await site.reload();
    await site.evaluate(() => window.__wizardChessLibraryReady);
    await expect(site.getByTestId('games-extension-status')).toContainText('up to date');
    expect(await rowCount(site)).toBe(2);

    // Pasting it again in the popup: already on the site
    await popup.getByTestId('popup-paste').fill(PASTED_PGN);
    await popup.getByTestId('popup-save').click();
    await expect(popup.getByTestId('popup-result')).toHaveText('Alice vs Bob: already on the site');
    expect(await badgeText(session.worker)).toBe('');
    await popup.screenshot({ path: path.join(SCREENSHOT_DIR, 'popup-after-paste.png') });
    await site.screenshot({ path: path.join(SCREENSHOT_DIR, 'games-list-one-game.png') });
    expect(session.externalRequests).toEqual([]);
  });

  test('Lichess, not logged in: Save on a finished game falls back to the page data; the site gets it once and can analyze it', async () => {
    // Includes a Quick review of the 46-ply game (about 30 s on one review thread)
    test.setTimeout(180_000);
    const PAGE = 'https://lichess.org/Bjl39T9x';
    mock(session, PAGE, { body: stripPageAssets(readFixture('lichess/page-Bjl39T9x.html')) });
    // The single-game export without a session: the recorded login wall
    mock(session, 'https://lichess.org/game/export/Bjl39T9x*', {
      status: 303,
      body: '',
      headers: { location: '/signup' },
    });
    mock(session, 'https://lichess.org/signup', { body: '<!doctype html><title>Sign up</title>' });
    await setUsernames(session, 'Lobo017', '');

    const page = await session.context.newPage();
    await page.goto(PAGE);
    const save = page.getByTestId('wc-save-button');
    await expect(save).toHaveAttribute('data-state', 'ready');
    await save.click();
    await expect(save).toHaveAttribute('data-state', 'saved');
    await expect.poll(() => badgeText(session.worker)).toBe('1');
    const entry = await queueEntry(session, 'lichess:Bjl39T9x');
    expect(entry).toMatchObject({ status: 'ready', method: 'lichess-page-data', white: 'GEU3', black: 'Lobo017' });
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'lichess-save-button.png') });

    // Saving again: already saved
    await page.reload();
    await expect(page.getByTestId('wc-save-button')).toHaveAttribute('data-state', 'already-queued');

    const site = await openGamesList(session);
    await expect(site.getByTestId('games-row')).toHaveCount(1);
    const row = site.getByTestId('games-row').first();
    await expect(row).toHaveAttribute('data-source', 'lichess');
    await expect(row.getByTestId('games-row-opponent')).toContainText('GEU3');
    await expect(row.getByTestId('games-row-opponent')).toContainText('1374');
    // My usernames came over the bridge: I'm Black and won
    await expect(row.getByTestId('games-row-color')).toHaveAttribute('data-color', 'b');
    await expect(row.getByTestId('games-row-result')).toHaveText('W');
    await expect(row.getByTestId('games-row-tc')).toHaveText('2+1');
    await expect(row.getByTestId('games-row-analysis')).toContainText('Not analyzed');
    await expect.poll(() => badgeText(session.worker)).toBe('');

    // Analyze it from the list (the preset defaults to Standard; Quick keeps the test short)
    await expect(site.getByTestId('games-analyze-preset')).toHaveValue('standard');
    await row.locator('input[data-select]').check();
    await site.getByTestId('games-analyze-preset').selectOption('quick');
    await site.getByTestId('btn-games-analyze').click();
    await expect(row.getByTestId('games-row-analysis')).toContainText(/Queued|Analyzing/);
    await expect(row.getByTestId('games-row-analysis')).toContainText('Analyzed', { timeout: 120_000 });
    await site.screenshot({ path: path.join(SCREENSHOT_DIR, 'games-list-analyzed.png') });

    // Opening it shows the saved review without running the engine again
    await row.click();
    await expect(site.getByTestId('review-panel')).toHaveAttribute('data-state', 'done');
    const shown = await site.evaluate(() => ({
      savedAt: window.__wizardChessReview!.panel.getSavedAt(),
      moves: window.__wizardChessReview!.panel.getReview()?.moves.length ?? 0,
      perspective: window.__wizardChessReview!.panel.getPerspective(),
    }));
    expect(shown.savedAt).not.toBeNull();
    expect(shown.moves).toBe(46);
    expect(shown.perspective).toBe('b');
    await site.getByTestId('mode-tab-games').click();
    expect(await rowCount(site)).toBe(1);
  });

  test('Lichess, logged in: my live game ends on the page and is captured automatically through the session export', async () => {
    const PAGE = 'https://lichess.org/Bjl39T9x';
    const finished = stripPageAssets(readFixture('lichess/page-Bjl39T9x.html'));
    const live = finished
      .replace('"status":{"id":30,"name":"mate"}', '"status":{"id":20,"name":"started"}')
      .replace('"winner":"black",', '');
    let pageHtml = live;
    mock(session, PAGE, (route) => route.fulfill({ body: pageHtml, contentType: 'text/html; charset=utf-8' }));
    // The export answers only with the session cookie, like Lichess for a logged-in user
    const exportRequests: string[] = [];
    mock(session, 'https://lichess.org/game/export/Bjl39T9x*', (route) => {
      const cookie = route.request().headers()['cookie'] ?? '';
      exportRequests.push(cookie);
      return cookie.includes('lila2=')
        ? route.fulfill({
            body: readFixture('lichess/export-ids-Bjl39T9x.pgn'),
            contentType: 'application/x-chess-pgn',
          })
        : route.fulfill({ status: 401, body: '{"error":"Login required"}', contentType: 'application/json' });
    });
    await session.context.addCookies([
      {
        name: 'lila2',
        value: 'test-session',
        domain: 'lichess.org',
        path: '/',
        secure: true,
        httpOnly: true,
        sameSite: 'Lax',
      },
    ]);
    await setUsernames(session, 'lobo017', '');

    const page = await session.context.newPage();
    await page.goto(PAGE);
    const save = page.getByTestId('wc-save-button');
    await expect(save).toHaveAttribute('data-state', 'in-progress');
    expect(await badgeText(session.worker)).toBe('');

    // The game ends: Lichess's server has the finished game, the page shows the result block
    pageHtml = finished;
    await page.evaluate(() =>
      document.body.insertAdjacentHTML('beforeend', '<div class="result-wrap"><p class="result">0-1</p></div>'),
    );
    await expect(save).toHaveAttribute('data-state', 'saved', { timeout: 15_000 });
    await expect(page.getByTestId('wc-save-note')).toContainText('Captured automatically');
    await expect.poll(() => badgeText(session.worker)).toBe('1');
    expect(await queueEntry(session, 'lichess:Bjl39T9x')).toMatchObject({ method: 'lichess-session-export' });
    expect(exportRequests.length).toBeGreaterThan(0);
    expect(exportRequests.every((c) => c.includes('lila2=test-session'))).toBe(true);

    const site = await openGamesList(session);
    await expect(site.getByTestId('games-row')).toHaveCount(1);
    await expect.poll(() => badgeText(session.worker)).toBe('');
  });

  test("Lichess: someone else's game ending on the page is not captured automatically", async () => {
    const PAGE = 'https://lichess.org/Bjl39T9x';
    const finished = stripPageAssets(readFixture('lichess/page-Bjl39T9x.html'));
    let pageHtml = finished.replace('"status":{"id":30,"name":"mate"}', '"status":{"id":20,"name":"started"}');
    mock(session, PAGE, (route) => route.fulfill({ body: pageHtml, contentType: 'text/html; charset=utf-8' }));
    mock(session, 'https://lichess.org/game/export/Bjl39T9x*', { status: 401, body: '{"error":"Login required"}' });
    await setUsernames(session, 'SomeoneElse', '');
    const page = await session.context.newPage();
    await page.goto(PAGE);
    await expect(page.getByTestId('wc-save-button')).toHaveAttribute('data-state', 'in-progress');
    pageHtml = finished;
    await page.evaluate(() => document.body.insertAdjacentHTML('beforeend', '<div class="result-wrap"></div>'));
    await expect(page.getByTestId('wc-save-button')).toHaveAttribute('data-state', 'ready', { timeout: 15_000 });
    expect(await badgeText(session.worker)).toBe('');
  });

  test('Lichess link pasted in the popup resolves through the IDs export', async () => {
    const exportCalls: string[] = [];
    mock(
      session,
      'https://lichess.org/api/games/export/_ids*',
      (route) => {
        exportCalls.push(route.request().postData() ?? '');
        return route.fulfill({
          body: readFixture('lichess/export-ids-iTIXmTZF.pgn'),
          contentType: 'application/x-chess-pgn',
        });
      },
      'POST',
    );
    const popup = await openPopup(session);
    await popup.getByTestId('popup-paste').fill('https://lichess.org/iTIXmTZF/black');
    await popup.getByTestId('popup-save').click();
    await expect(popup.getByTestId('popup-result')).toHaveText('Saved cauchyunderground vs Lobo017');
    expect(exportCalls).toEqual(['iTIXmTZF']);
    expect(await queueEntry(session, 'lichess:iTIXmTZF')).toMatchObject({
      status: 'ready',
      method: 'lichess-ids-export',
    });
    await expect.poll(() => badgeText(session.worker)).toBe('1');
  });

  test('Chess.com: Save on a finished game decodes the page data (TCN); the site gets it once', async () => {
    const GAME = 'https://www.chess.com/game/live/185518487990';
    mock(session, GAME, { body: CHESSCOM_PAGE });
    mock(session, 'https://www.chess.com/callback/live/game/185518487990', {
      body: readFixture('chesscom/callback-live-185518487990.json'),
      contentType: 'application/json',
    });
    await setUsernames(session, '', 'Hikaru');
    const page = await session.context.newPage();
    await page.goto(GAME);
    const save = page.getByTestId('wc-save-button');
    await expect(save).toHaveAttribute('data-state', 'ready');
    await save.click();
    await expect(save).toHaveAttribute('data-state', 'saved');
    expect(await queueEntry(session, 'chesscom:live-185518487990')).toMatchObject({
      status: 'ready',
      method: 'chesscom-callback',
      white: 'Billy_thekid30',
      black: 'Hikaru',
    });
    await expect.poll(() => badgeText(session.worker)).toBe('1');

    const site = await openGamesList(session);
    await expect(site.getByTestId('games-row')).toHaveCount(1);
    const row = site.getByTestId('games-row').first();
    await expect(row).toHaveAttribute('data-source', 'chesscom');
    await expect(row.getByTestId('games-row-color')).toHaveAttribute('data-color', 'b');
    await expect(row.getByTestId('games-row-opponent')).toContainText('Billy_thekid30');
    await expect(row.getByTestId('games-row-tc')).toHaveText('3+0');
    await expect(row.getByTestId('games-row-result')).toHaveText('W');
    await expect.poll(() => badgeText(session.worker)).toBe('');
    // The stored PGN keeps Chess.com's clocks
    const pgn = await site.evaluate(
      async () => (await window.__wizardChessLibrary!.library.get('chesscom:live-185518487990'))!.pgn,
    );
    expect(pgn).toContain('[%clk 0:02:56.3]');
    expect(pgn).toContain('[Link "https://www.chess.com/game/live/185518487990"]');
  });

  test("Chess.com: when the page data fails, the site's own Share → PGN dialog is used", async () => {
    const GAME = 'https://www.chess.com/game/live/185518487990';
    let callbackCalls = 0;
    mock(session, GAME, { body: shareDialogPage(archivePgn('archive-hikaru-2026-10.json', '185518487990')) });
    // The page's first request (is the game over?) works; the extractor's fails, so the dialog is next
    mock(session, 'https://www.chess.com/callback/live/game/185518487990', (route) =>
      ++callbackCalls === 1
        ? route.fulfill({
            body: readFixture('chesscom/callback-live-185518487990.json'),
            contentType: 'application/json',
          })
        : route.fulfill({ status: 500, body: 'oops' }),
    );
    const page = await session.context.newPage();
    await page.goto(GAME);
    const save = page.getByTestId('wc-save-button');
    await expect(save).toHaveAttribute('data-state', 'ready');
    await save.click();
    await expect(save).toHaveAttribute('data-state', 'saved');
    expect(await queueEntry(session, 'chesscom:live-185518487990')).toMatchObject({ method: 'chesscom-share-pgn' });
    // The dialog was closed again
    await expect(page.locator('.share-menu-component')).toHaveCount(0);
  });

  test('Chess.com: my live game ends after an in-page navigation and is captured automatically', async () => {
    const FIRST = 'https://www.chess.com/game/live/185358990103';
    const GAME = 'https://www.chess.com/game/live/185518487990';
    const finished = readFixture('chesscom/callback-live-185518487990.json');
    const running = JSON.stringify({
      ...JSON.parse(finished),
      game: { ...JSON.parse(finished).game, isFinished: false },
    });
    let callback = running;
    mock(session, FIRST, { body: CHESSCOM_PAGE });
    mock(session, 'https://www.chess.com/callback/live/game/185358990103', {
      body: readFixture('chesscom/callback-live-185358990103.json'),
      contentType: 'application/json',
    });
    mock(session, 'https://www.chess.com/callback/live/game/185518487990', (route) =>
      route.fulfill({ body: callback, contentType: 'application/json' }),
    );
    await setUsernames(session, '', 'hikaru');
    const page = await session.context.newPage();
    await page.goto(FIRST);
    await expect(page.getByTestId('wc-save-button')).toHaveAttribute('data-state', 'ready');
    // Chess.com moves to the next game without reloading the page
    await page.evaluate((url) => history.pushState({}, '', url), GAME);
    const save = page.getByTestId('wc-save-button');
    await expect(save).toHaveAttribute('data-state', 'in-progress', { timeout: 5000 });
    callback = finished;
    await page.evaluate(() =>
      document.body.insertAdjacentHTML('beforeend', '<div class="game-over-modal-content">Hikaru won on time</div>'),
    );
    await expect(save).toHaveAttribute('data-state', 'saved', { timeout: 15_000 });
    expect(await queueEntry(session, 'chesscom:live-185518487990')).toMatchObject({ method: 'chesscom-callback' });
    // The first game was only viewed, not saved
    expect(await queueEntry(session, 'chesscom:live-185358990103')).toBeNull();
  });

  test('Chess.com link: pending until the monthly archive has it, then ready (popup Retry and the context menu)', async () => {
    const LINK = 'https://www.chess.com/game/live/185518487990';
    const archiveUrl = 'https://api.chess.com/pub/player/hikaru/games/2026/10';
    let archive = { games: [] as unknown[] };
    const archiveCalls: string[] = [];
    mock(session, 'https://www.chess.com/callback/live/game/185518487990', {
      body: readFixture('chesscom/callback-live-185518487990.json'),
      contentType: 'application/json',
    });
    mock(session, archiveUrl, (route) => {
      archiveCalls.push(route.request().url());
      return route.fulfill({ body: JSON.stringify(archive), contentType: 'application/json' });
    });
    await setUsernames(session, '', 'Hikaru');

    // The context menu on a game link runs the same resolution as a pasted link
    await session.worker.evaluate(async (link) => {
      const api = (
        self as unknown as {
          __wizardChessCapture: { onContextMenuClick(info: unknown): Promise<void>; contextMenuId: string };
        }
      ).__wizardChessCapture;
      await api.onContextMenuClick({ menuItemId: api.contextMenuId, linkUrl: link });
    }, LINK);
    expect(await queueEntry(session, 'chesscom:live-185518487990')).toMatchObject({ status: 'pending' });
    await expect.poll(() => badgeText(session.worker)).toBe('1');
    expect(archiveCalls).toEqual([archiveUrl]);

    const popup = await openPopup(session);
    const entry = popup.getByTestId('popup-entry');
    await expect(entry).toHaveAttribute('data-status', 'pending');
    await expect(entry).toContainText("Not in Chess.com's archive yet");
    await popup.screenshot({ path: path.join(SCREENSHOT_DIR, 'popup-pending.png') });

    // The archive catches up
    archive = { games: JSON.parse(readFixture('chesscom/archive-hikaru-2026-10.json')).games };
    await entry.getByTestId('popup-entry-retry').click();
    await expect(entry).toHaveAttribute('data-status', 'ready');
    expect(await queueEntry(session, 'chesscom:live-185518487990')).toMatchObject({
      status: 'ready',
      method: 'chesscom-archive',
    });
    expect(await badgeText(session.worker)).toBe('1');
  });

  test('Extraction failure: a notification, and the popup offers the link for pasting', async () => {
    const GAME = 'https://www.chess.com/game/live/185518487990';
    let calls = 0;
    mock(session, GAME, { body: CHESSCOM_PAGE });
    mock(session, 'https://www.chess.com/callback/live/game/185518487990', (route) =>
      ++calls === 1
        ? route.fulfill({
            body: readFixture('chesscom/callback-live-185518487990.json'),
            contentType: 'application/json',
          })
        : route.fulfill({ status: 503, body: 'down' }),
    );
    const page = await session.context.newPage();
    await page.goto(GAME);
    const save = page.getByTestId('wc-save-button');
    await expect(save).toHaveAttribute('data-state', 'ready');
    await save.click();
    await expect(save).toHaveAttribute('data-state', 'failed');
    await expect(page.getByTestId('wc-save-note')).toContainText('Open the extension');
    await expect
      .poll(async () =>
        Object.keys(
          await session.worker.evaluate(() =>
            (chrome.notifications as unknown as { getAll(): Promise<Record<string, boolean>> }).getAll(),
          ),
        ),
      )
      .toContain('wizard-chess-capture-failed');

    const popup = await openPopup(session);
    await expect(popup.getByTestId('popup-failure')).toBeVisible();
    await expect(popup.getByTestId('popup-failure-text')).toContainText(GAME);
    await expect(popup.getByTestId('popup-failure-text')).toContainText(
      'chesscom-share-pgn: No Share button on the page.',
    );
    await popup.getByTestId('popup-failure-use').click();
    await expect(popup.getByTestId('popup-paste')).toHaveValue(GAME);
    await expect(popup.getByTestId('popup-failure')).toBeHidden();
    expect(await badgeText(session.worker)).toBe('');
  });

  test('Import my history (both sites) from the popup: one request at a time into the queue, then to the site', async () => {
    const lichessRequests: string[] = [];
    mock(session, 'https://lichess.org/api/games/user/Lobo017*', (route) => {
      lichessRequests.push(route.request().url());
      return route.fulfill({ body: readFixture('lichess/user-games.ndjson'), contentType: 'application/x-ndjson' });
    });
    const ccRequests: string[] = [];
    mock(session, 'https://api.chess.com/pub/player/hikaru/games/*', (route) => {
      const url = route.request().url();
      ccRequests.push(url);
      if (url.endsWith('/archives')) {
        return route.fulfill({
          body: JSON.stringify({ archives: ['https://api.chess.com/pub/player/hikaru/games/2026/10'] }),
          contentType: 'application/json',
        });
      }
      return route.fulfill({
        body: readFixture('chesscom/archive-hikaru-2026-10.json'),
        contentType: 'application/json',
      });
    });
    await setUsernames(session, 'Lobo017', 'hikaru');
    const popup = await openPopup(session);
    await popup.getByTestId('popup-backfill-lichess-btn').click();
    await expect(popup.getByTestId('popup-backfill-lichess-status')).toHaveText('Up to date · 4 new games imported', {
      timeout: 15_000,
    });
    expect(lichessRequests).toHaveLength(1);
    const params = new URL(lichessRequests[0]!).searchParams;
    expect(params.get('since')).toBe('0');
    expect(params.get('clocks')).toBe('true');

    await popup.getByTestId('popup-backfill-chesscom-btn').click();
    const ccGames = JSON.parse(readFixture('chesscom/archive-hikaru-2026-10.json')).games.length as number;
    await expect(popup.getByTestId('popup-backfill-chesscom-status')).toHaveText(
      `Up to date · ${ccGames} new games imported`,
      {
        timeout: 20_000,
      },
    );
    expect(ccRequests.map((u) => u.slice(-8))).toEqual(['archives', '/2026/10']);
    await expect.poll(() => badgeText(session.worker)).toBe(String(4 + ccGames));

    // The site collects them all, in batches
    const site = await openGamesList(session);
    await expect(site.getByTestId('games-count')).toHaveText(`${4 + ccGames} games`, { timeout: 30_000 });
    await expect.poll(() => badgeText(session.worker), { timeout: 30_000 }).toBe('');
    await site.getByTestId('games-filter-source').selectOption('lichess');
    await expect(site.getByTestId('games-row')).toHaveCount(4);
    // History imports aren't "new games": auto-analyze (off here anyway) would skip them
    const methods = await site.evaluate(async () =>
      (await window.__wizardChessLibrary!.library.list()).map((r) => r.captureMethod),
    );
    expect(new Set(methods)).toEqual(new Set(['lichess-history', 'chesscom-archive-history']));
    await popup.screenshot({ path: path.join(SCREENSHOT_DIR, 'popup-backfill-done.png') });

    // Importing again asks only for what's new
    await popup.getByTestId('popup-backfill-lichess-btn').click();
    await expect(popup.getByTestId('popup-backfill-lichess-status')).toHaveText('Up to date · 0 new games imported', {
      timeout: 15_000,
    });
    const newest = Math.max(
      ...readFixture('lichess/user-games.ndjson')
        .split('\n')
        .filter(Boolean)
        .map((l) => (JSON.parse(l) as { createdAt: number }).createdAt),
    );
    expect(new URL(lichessRequests[1]!).searchParams.get('since')).toBe(String(newest + 1));
  });

  test('Settings: the bridge moves with the site URL; bad values are refused; auto-capture can be switched off', async () => {
    const popup = await openPopup(session);
    await popup.getByTestId('popup-settings').locator('summary').click();
    await expect(popup.getByTestId('popup-site-url')).toHaveValue(SITE_URL);
    await expect(popup.getByTestId('popup-auto-capture')).toBeChecked();
    await popup.getByTestId('popup-site-url').fill('localhost:5173');
    await popup.getByTestId('popup-settings-save').click();
    await expect(popup.getByTestId('popup-settings-result')).toHaveText('Saved.');
    await expect(popup.getByTestId('popup-site-url')).toHaveValue('http://localhost:5173');
    const matches = () =>
      session.worker.evaluate(async () =>
        (await chrome.scripting.getRegisteredContentScripts()).flatMap((c) => c.matches ?? []).sort(),
      );
    // Both loopback names of the port
    expect(await matches()).toEqual(['http://127.0.0.1:5173/*', 'http://localhost:5173/*']);
    for (const [field, value, message] of [
      ['popup-site-url', 'https://example.com', 'The site URL must be http on localhost or 127.0.0.1'],
      ['popup-lichess-user', 'not a name!', 'That is not a valid Lichess username.'],
    ] as const) {
      await popup.getByTestId(field).fill(value);
      await popup.getByTestId('popup-settings-save').click();
      await expect(popup.getByTestId('popup-settings-result')).toContainText(message);
      await expect(popup.getByTestId('popup-settings-result')).toHaveAttribute('data-tone', 'bad');
      await popup.getByTestId(field).fill(field === 'popup-site-url' ? SITE_URL : '');
    }
    expect(await matches()).toEqual(['http://127.0.0.1:5173/*', 'http://localhost:5173/*']);
    await popup.getByTestId('popup-settings-save').click();
    await expect(popup.getByTestId('popup-settings-result')).toHaveText('Saved.');
    expect(await matches()).toEqual([`${SITE_URL}/*`, `${SITE_URL_LOCALHOST}/*`]);
    await popup.close();

    // Auto-capture off: my game ending on the page only enables the button
    const PAGE = 'https://lichess.org/Bjl39T9x';
    const finished = stripPageAssets(readFixture('lichess/page-Bjl39T9x.html'));
    let pageHtml = finished.replace('"status":{"id":30,"name":"mate"}', '"status":{"id":20,"name":"started"}');
    mock(session, PAGE, (route) => route.fulfill({ body: pageHtml, contentType: 'text/html; charset=utf-8' }));
    mock(session, 'https://lichess.org/game/export/Bjl39T9x*', { status: 401, body: '{"error":"Login required"}' });
    await setUsernames(session, 'Lobo017', '', { autoCapture: false });
    const page = await session.context.newPage();
    await page.goto(PAGE);
    await expect(page.getByTestId('wc-save-button')).toHaveAttribute('data-state', 'in-progress');
    pageHtml = finished;
    await page.evaluate(() => document.body.insertAdjacentHTML('beforeend', '<div class="result-wrap"></div>'));
    await expect(page.getByTestId('wc-save-button')).toHaveAttribute('data-state', 'ready', { timeout: 15_000 });
    expect(await badgeText(session.worker)).toBe('');
  });
});
