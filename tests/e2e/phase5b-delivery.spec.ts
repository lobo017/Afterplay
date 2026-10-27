import path from 'node:path';
import { expect, test } from '@playwright/test';
import {
  badgeText,
  launchWithExtension,
  openGamesList,
  openPopup,
  queueEntry,
  SITE_URL,
  SITE_URL_LOCALHOST,
  type ExtensionSession,
} from './helpers/extension';

// "21 games waiting for the analysis site" (docs/PROGRESS.md, "Delivery outcomes"): games the
// site refuses (Lichess variants, Chess.com games without moves) were offered on every sync
// and stayed waiting forever. Synthetic PGNs of the same shape.

const SCREENSHOT_DIR = path.join('test-results', 'phase5b-screens');

const STANDARD =
  '[Event "Live Chess"]\n[Site "Chess.com"]\n[Date "2026.10.18"]\n[White "Alice"]\n[Black "Bob"]\n[Result "1-0"]\n\n1. e4 e5 2. Qh5 Nc6 3. Bc4 Nf6 4. Qxf7# 1-0';
const ANTICHESS =
  '[Event "casual variant:antichess game"]\n[Site "https://lichess.org/6XyS2AA6"]\n[Date "2021.04.08"]\n[White "BradyAranya"]\n[Black "Lobo017"]\n' +
  '[Result "1-0"]\n[Variant "Antichess"]\n\n1. e3 b6 2. Ba6 Bxa6 3. Qe2 Bxe2 4. Kxe2 Nc6 5. Kd3 Qc8 6. Kc4 1-0';
const ATOMIC = ANTICHESS.replace('Antichess', 'Atomic').replace('6XyS2AA6', 'N8YdYmlV');
const NO_MOVES =
  '[Event "2022 Chess.com Daily Chess Championship - Round 1"]\n[Site "Chess.com"]\n[Date "2022.01.01"]\n[White "Marufazimov"]\n[Black "LocoLobo06"]\n' +
  '[Result "0-1"]\n[Termination "LocoLobo06 won on time"]\n\n0-1';
const ILLEGAL = '[Event "Bad"]\n[White "Carol"]\n[Black "Dave"]\n[Result "*"]\n\n1. e4 e5 2. Ke3 *';
const UNUSUAL = STANDARD.replace('[Event "Live Chess"]', '[Event "The "big" one"]').replace(
  '[Site "Chess.com"]',
  "[Site 'Club']",
);

let session: ExtensionSession | null = null;

test.afterEach(async () => {
  await session?.close();
  session = null;
});

/** Games in the queue as the extension stored them before it looked at them: ready, every one. */
async function seedWaiting(s: ExtensionSession, games: Array<[string, string]>): Promise<void> {
  await s.worker.evaluate(
    async ({ games, placeholder }) => {
      const api = (
        self as unknown as {
          __wizardChessCapture: { queue: { addReady(i: unknown[]): Promise<unknown> }; updateBadge(): Promise<void> };
        }
      ).__wizardChessCapture;
      for (const [key, pgn] of games) {
        await api.queue.addReady([
          { key, source: key.split(':')[0], pgn: placeholder, method: 'lichess-history', trigger: 'history' },
        ]);
        await chrome.storage.local.set({ [`queue:pgn:${key}`]: pgn });
        // The index row as the old queue wrote it: players, date and result from the game's own PGN
        const tag = (name: string) => new RegExp(`\\[${name} "([^"]*)"\\]`).exec(pgn)?.[1] ?? '';
        const index = (await chrome.storage.local.get(['queue:index']))['queue:index'] as Record<
          string,
          Record<string, unknown>
        >;
        index[key] = {
          ...index[key],
          white: tag('White'),
          black: tag('Black'),
          date: tag('Date'),
          result: tag('Result'),
          playedAt: null,
        };
        await chrome.storage.local.set({ 'queue:index': index });
      }
      await api.updateBadge();
    },
    { games, placeholder: STANDARD },
  );
}

test.describe('Phase 5b — delivery outcomes', () => {
  test('every offered game ends saved, already on the site, or not imported with the reason; Retry and Dismiss', async () => {
    const s = (session = await launchWithExtension());
    // One game is on the site already
    const site = await openGamesList(s);
    await site.evaluate(async (pgn) => {
      const api = (await window.__wizardChessLibraryReady)!;
      await api.library.saveBridgeGames([
        { key: 'chesscom:live-1', source: 'chesscom', pgn, capturedAt: 1, method: 'chesscom-callback' },
      ]);
    }, STANDARD);
    await site.close();

    await seedWaiting(s, [
      ['lichess:6XyS2AA6', ANTICHESS],
      ['lichess:N8YdYmlV', ATOMIC],
      ['chesscom:daily-376600893', NO_MOVES],
      ['chesscom:live-1', STANDARD],
      ['chesscom:live-2', ILLEGAL],
      ['chesscom:live-3', UNUSUAL],
    ]);
    expect(await badgeText(s.worker)).toBe('6');
    const popup = await openPopup(s);
    await expect(popup.getByTestId('popup-counts')).toHaveText('6 games waiting for the analysis site');

    // The site opens: one sync settles every game
    const reopened = await openGamesList(s);
    await expect.poll(() => badgeText(s.worker), { timeout: 10_000 }).toBe('');
    await expect(reopened.getByTestId('games-row')).toHaveCount(2);
    expect(await queueEntry(s, 'chesscom:live-1')).toMatchObject({ status: 'delivered' });
    expect(await queueEntry(s, 'chesscom:live-3')).toMatchObject({ status: 'delivered' });
    await expect(reopened.locator('[data-game-id="chesscom:live-3"]').getByTestId('games-row-opponent')).toContainText(
      'Alice vs Bob',
    );

    await expect(popup.getByTestId('popup-counts')).toHaveText(
      'No games waiting · 2 games on the analysis site · 4 not imported',
    );
    const section = popup.getByTestId('popup-rejected-section');
    await expect(section).toBeVisible();
    const reason = (key: string) =>
      popup.locator(`[data-testid="popup-rejected-entry"][data-key="${key}"] [data-testid="popup-rejected-reason"]`);
    await expect(reason('lichess:6XyS2AA6')).toHaveText('not imported (variant: Antichess)');
    await expect(reason('lichess:N8YdYmlV')).toHaveText('not imported (variant: Atomic)');
    await expect(reason('chesscom:daily-376600893')).toHaveText('not imported (no moves)');
    await expect(reason('chesscom:live-2')).toContainText('rejected: not a valid PGN (Illegal move: Ke3');
    // Retry only where trying again can help
    await expect(popup.locator('[data-key="chesscom:live-2"] [data-testid="popup-rejected-retry"]')).toBeVisible();
    await expect(popup.locator('[data-key="lichess:6XyS2AA6"] [data-testid="popup-rejected-retry"]')).toHaveCount(0);
    await expect(popup.getByTestId('popup-rejected-dismiss')).toHaveCount(4);
    await popup.setViewportSize({ width: 380, height: 900 });
    await popup.screenshot({ path: path.join(SCREENSHOT_DIR, 'popup-not-imported.png'), fullPage: true });

    // Retry: offered again at once (the site is open), refused again with the same reason
    await popup.locator('[data-key="chesscom:live-2"] [data-testid="popup-rejected-retry"]').click();
    await expect
      .poll(async () => (await queueEntry(s, 'chesscom:live-2'))?.status, { timeout: 10_000 })
      .toBe('rejected');
    await expect(reason('chesscom:live-2')).toContainText('Illegal move: Ke3');

    // Dismiss: gone from the list and the counts, and not imported again
    await popup.locator('[data-key="chesscom:live-2"] [data-testid="popup-rejected-dismiss"]').click();
    await expect(popup.locator('[data-testid="popup-rejected-entry"][data-key="chesscom:live-2"]')).toHaveCount(0);
    await expect(popup.getByTestId('popup-counts')).toHaveText(
      'No games waiting · 2 games on the analysis site · 3 not imported',
    );
    expect(await queueEntry(s, 'chesscom:live-2')).toMatchObject({ status: 'rejected', dismissed: true });
    expect(await badgeText(s.worker)).toBe('');
    await expect(reopened.getByTestId('games-row')).toHaveCount(2);
  });

  test('the site opened as localhost lands on 127.0.0.1 and gets its games there', async () => {
    const s = (session = await launchWithExtension());
    const popup = await openPopup(s);
    await popup.getByTestId('popup-settings').locator('summary').click();
    await expect(popup.getByTestId('popup-site-url')).toHaveValue(SITE_URL);
    const site = await s.context.newPage();
    await site.goto(`${SITE_URL_LOCALHOST}/#games`);
    // npm run serve redirects localhost to the one origin (one IndexedDB library)
    expect(site.url()).toBe(`${SITE_URL}/#games`);
    await site.evaluate(() => window.__wizardChessLibraryReady);
    await expect(site.getByTestId('games-extension-status')).toContainText('up to date');
    await popup.reload();
    await expect(popup.getByTestId('popup-site-state')).toHaveText('The analysis site is open in a tab.');
    await popup.getByTestId('popup-paste').fill(STANDARD);
    await popup.getByTestId('popup-save').click();
    await expect(site.getByTestId('games-row')).toHaveCount(1, { timeout: 10_000 });
    await expect.poll(() => badgeText(s.worker)).toBe('');
  });
});
