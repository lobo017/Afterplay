import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import {
  badgeText,
  launchWithExtension,
  mock,
  openGamesList,
  openPopup,
  readFixture,
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

/** Sets my usernames through the popup's settings form. */
async function setUsernames(session: ExtensionSession, lichess: string, chesscom: string): Promise<void> {
  const popup = await openPopup(session);
  await popup.getByTestId('popup-settings').locator('summary').click();
  await popup.getByTestId('popup-lichess-user').fill(lichess);
  await popup.getByTestId('popup-chesscom-user').fill(chesscom);
  await popup.getByTestId('popup-settings-save').click();
  await expect(popup.getByTestId('popup-settings-result')).toHaveText('Saved.');
  await popup.close();
}

async function queueEntry(session: ExtensionSession, key: string) {
  return session.worker.evaluate(async (k) => {
    const api = (self as unknown as { __wizardChessCapture: { queue: { get(key: string): Promise<unknown> } } })
      .__wizardChessCapture;
    return api.queue.get(k);
  }, key);
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

    // Another sync (tab focus) and a reload don't duplicate it
    await site.evaluate(() => window.dispatchEvent(new Event('focus')));
    await site.reload();
    await site.evaluate(() => window.__wizardChessLibraryReady);
    await expect(site.getByTestId('games-extension-status')).toContainText('up to date');
    expect(await rowCount(site)).toBe(1);

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
    mock(session, 'https://lichess.org/game/export/Bjl39T9x*', { status: 303, body: '', headers: { location: '/signup' } });
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
        ? route.fulfill({ body: readFixture('lichess/export-ids-Bjl39T9x.pgn'), contentType: 'application/x-chess-pgn' })
        : route.fulfill({ status: 401, body: '{"error":"Login required"}', contentType: 'application/json' });
    });
    await session.context.addCookies([
      { name: 'lila2', value: 'test-session', domain: 'lichess.org', path: '/', secure: true, httpOnly: true, sameSite: 'Lax' },
    ]);
    await setUsernames(session, 'lobo017', '');

    const page = await session.context.newPage();
    await page.goto(PAGE);
    const save = page.getByTestId('wc-save-button');
    await expect(save).toHaveAttribute('data-state', 'in-progress');
    expect(await badgeText(session.worker)).toBe('');

    // The game ends: Lichess's server has the finished game, the page shows the result block
    pageHtml = finished;
    await page.evaluate(() => document.body.insertAdjacentHTML('beforeend', '<div class="result-wrap"><p class="result">0-1</p></div>'));
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
        return route.fulfill({ body: readFixture('lichess/export-ids-iTIXmTZF.pgn'), contentType: 'application/x-chess-pgn' });
      },
      'POST',
    );
    const popup = await openPopup(session);
    await popup.getByTestId('popup-paste').fill('https://lichess.org/iTIXmTZF/black');
    await popup.getByTestId('popup-save').click();
    await expect(popup.getByTestId('popup-result')).toHaveText('Saved cauchyunderground vs Lobo017');
    expect(exportCalls).toEqual(['iTIXmTZF']);
    expect(await queueEntry(session, 'lichess:iTIXmTZF')).toMatchObject({ status: 'ready', method: 'lichess-ids-export' });
    await expect.poll(() => badgeText(session.worker)).toBe('1');
  });
});
