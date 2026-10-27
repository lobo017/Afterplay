import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { startLayoutShiftRecorder, stopLayoutShiftRecorder } from './helpers/layout-shift';

// The Games list on its own: the website without the capture extension.
const SCREENSHOT_DIR = path.join('test-results', 'phase5b-screens');
const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'capture');
const read = (rel: string) => fs.readFileSync(path.join(FIX, rel), 'utf8');

const LICHESS_PGN = read('lichess/export-ids-Bjl39T9x.pgn');
const CHESSCOM_PGN = (
  JSON.parse(read('chesscom/archive-hikaru-2026-10.json')).games as Array<{ url: string; pgn: string }>
).find((g) => g.url.endsWith('/185518487990'))!.pgn;

/** Short games, so a review on Standard stays quick. */
const SHORT_CHESSCOM = `[Event "Live Chess"]
[Site "Chess.com"]
[Date "2026.10.17"]
[White "Opponent"]
[Black "hikaru"]
[Result "0-1"]
[TimeControl "180"]
[Link "https://www.chess.com/game/live/999000111"]

1. e4 e5 2. Qh5 Nc6 3. Qxe5+ Nxe5 0-1`;

const SHORT_PLAIN = `[Event "Casual"]
[White "Carol"]
[Black "Dave"]
[Result "1-0"]
[Date "2026.09.01"]

1. e4 f5 2. exf5 g5 3. Qh5# 1-0`;

async function openGames(page: Page): Promise<string[]> {
  const external: string[] = [];
  page.on('request', (r) => {
    const host = new URL(r.url()).hostname;
    if (host !== '127.0.0.1' && host !== 'localhost') external.push(r.url());
  });
  await page.goto('/');
  await page.getByTestId('mode-tab-games').click();
  await page.evaluate(() => window.__wizardChessLibraryReady);
  await expect(page.getByTestId('games-list')).toBeVisible();
  return external;
}

async function pastePgn(page: Page, pgn: string): Promise<void> {
  const panel = page.getByTestId('games-paste-panel');
  if (await panel.isHidden()) {
    // Paste PGN is in the Import menu
    await page.getByTestId('btn-games-import').click();
    await page.getByTestId('btn-games-paste').click();
  }
  await page.getByTestId('games-paste-text').fill(pgn);
  await page.getByTestId('btn-games-paste-import').click();
}

/** Drops files on the list the way a file manager does (a DataTransfer with File objects). */
async function dropFiles(page: Page, files: Array<{ name: string; text: string }>): Promise<void> {
  await page.evaluate((list) => {
    const target = document.querySelector('[data-testid="games-list"]')!;
    const dt = new DataTransfer();
    for (const f of list) dt.items.add(new File([f.text], f.name, { type: 'application/x-chess-pgn' }));
    target.dispatchEvent(new DragEvent('dragenter', { dataTransfer: dt, bubbles: true }));
    target.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }));
    (window as unknown as { __dropOverlay: boolean }).__dropOverlay =
      getComputedStyle(document.querySelector('[data-testid="games-drop-overlay"]')!).display !== 'none';
    target.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, files);
}

const opponents = (page: Page) =>
  page.getByTestId('games-row-opponent').locator('.wc-games-opp-name').allTextContents();

test.describe('Phase 5b — Games list (no extension)', () => {
  // Dates are shown in the viewer's time zone: fixed here so the expected text doesn't depend on the machine
  test.use({ timezoneId: 'UTC' });

  test('paste, drop and open PGN files; metadata, filters and sort; zero network requests', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const external = await openGames(page);
    await expect(page.getByTestId('games-empty')).toBeVisible();
    // Nothing answers the bridge: the site says so and carries on
    await expect(page.getByTestId('games-extension-status')).toHaveAttribute('data-state', 'not-detected');

    await pastePgn(page, `${LICHESS_PGN}\n\n${SHORT_PLAIN}`);
    await expect(page.getByTestId('games-message')).toHaveText('Imported 2 games');
    await expect(page.getByTestId('games-row')).toHaveCount(2);
    // The same games again: skipped
    await pastePgn(page, `${SHORT_PLAIN}\n\n${LICHESS_PGN}`);
    await expect(page.getByTestId('games-message')).toHaveText('2 already in the list');
    await expect(page.getByTestId('games-row')).toHaveCount(2);
    // A broken game is reported, the good one in the same text is kept
    await pastePgn(page, `[Event "Broken"]\n\n1. e4 e5 2. Ke3 *\n\n${SHORT_CHESSCOM}`);
    await expect(page.getByTestId('games-message')).toContainText('Imported 1 game');
    await expect(page.getByTestId('games-message')).toContainText('Game 1: not a valid PGN');
    await expect(page.getByTestId('games-row')).toHaveCount(3);

    // Drag and drop of a .pgn file
    await dropFiles(page, [{ name: 'hikaru.pgn', text: CHESSCOM_PGN }]);
    expect(await page.evaluate(() => (window as unknown as { __dropOverlay: boolean }).__dropOverlay)).toBe(true);
    await expect(page.getByTestId('games-row')).toHaveCount(4);
    await expect(page.getByTestId('games-drop-overlay')).toBeHidden();

    // The file picker
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wc-pgn-')), 'two.pgn');
    fs.writeFileSync(file, `${SHORT_PLAIN.replace('Carol', 'Erin')}\n\n${SHORT_PLAIN.replace('Carol', 'Frank')}`);
    await page.getByTestId('games-file-input').setInputFiles(file);
    await expect(page.getByTestId('games-row')).toHaveCount(6);
    await expect(page.getByTestId('games-count')).toHaveText('6 games');

    // Metadata of the Lichess game (my account Lobo017 as Black, the built-in default)
    const lichessRow = page.locator('[data-game-id="lichess:Bjl39T9x"]');
    await expect(lichessRow.getByTestId('games-row-color')).toHaveAttribute('data-color', 'b');
    await expect(lichessRow.getByTestId('games-row-opponent')).toContainText('GEU3');
    await expect(lichessRow.getByTestId('games-row-opponent')).toContainText('1374 · me 1397');
    await expect(lichessRow.getByTestId('games-row-result')).toHaveText('W');
    await expect(lichessRow.getByTestId('games-row-tc')).toHaveText('2+1');
    // 05:33:38 UTC (the PGN's UTCDate / UTCTime), shown in the page's time zone (UTC here)
    await expect(lichessRow.getByTestId('games-row-date')).toHaveText('2026-10-04 05:33');
    await expect(lichessRow.getByTestId('games-row-opening')).toContainText('Mieses');
    await expect(lichessRow.getByTestId('games-row-analysis')).toHaveText('Not analyzed');
    await expect(page.locator('[data-game-id="chesscom:live-185518487990"]').getByTestId('games-row-tc')).toHaveText(
      '3+0',
    );

    // Filters
    await page.getByTestId('games-filter-source').selectOption('chesscom');
    await expect(page.getByTestId('games-row')).toHaveCount(2);
    await expect(page.getByTestId('games-count')).toHaveText('2 of 6 games');
    await page.getByTestId('games-filter-source').selectOption('paste');
    await expect(page.getByTestId('games-row')).toHaveCount(3);
    await page.getByTestId('games-filter-source').selectOption('all');
    await page.getByTestId('games-filter-result').selectOption('win');
    // Wins are mine: only the Lichess game is one of my games
    await expect(page.getByTestId('games-row')).toHaveCount(1);
    await page.getByTestId('games-filter-result').selectOption('loss');
    await expect(page.getByTestId('games-row')).toHaveCount(0);
    await expect(page.getByTestId('games-empty')).toHaveText('No games match these filters.');
    await page.getByTestId('games-filter-result').selectOption('all');
    await page.getByTestId('games-filter-analyzed').selectOption('analyzed');
    await expect(page.getByTestId('games-row')).toHaveCount(0);
    await page.getByTestId('games-filter-analyzed').selectOption('not-analyzed');
    await expect(page.getByTestId('games-row')).toHaveCount(6);

    // Sort
    await page.getByTestId('games-sort').selectOption('opponent');
    const byName = await opponents(page);
    expect(byName).toEqual([...byName].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' })));
    await page.getByTestId('games-sort').selectOption('newest');
    const dates = await page.getByTestId('games-row-date').allTextContents();
    expect(dates.filter((d) => d !== '—')).toEqual([...dates.filter((d) => d !== '—')].sort().reverse());

    // Selection
    await page.getByTestId('games-select-all').check();
    await expect(page.getByTestId('games-selection')).toHaveText('6 selected');
    await expect(page.getByTestId('btn-games-analyze')).toHaveText('Analyze 6');
    await page.getByTestId('games-select-all').uncheck();
    await expect(page.getByTestId('btn-games-analyze')).toBeDisabled();

    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'games-list-desktop.png'), fullPage: true });
    expect(external).toEqual([]);
  });

  test('Analyze on Standard (the default), the saved review on open without the engine, auto-analyze on Quick', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    const external = await openGames(page);
    // My Chess.com username, as the extension's settings would send it
    await page.evaluate(() =>
      window.__wizardChessLibrary!.library.setMyAccounts({ lichess: 'Lobo017', chesscom: 'hikaru' }),
    );
    await pastePgn(page, SHORT_CHESSCOM);
    const row = page.locator('[data-game-id="chesscom:live-999000111"]');
    await expect(row.getByTestId('games-row-color')).toHaveAttribute('data-color', 'b');

    await expect(page.getByTestId('games-analyze-preset')).toHaveValue('standard');
    await row.locator('input[data-select]').check();
    await page.getByTestId('btn-games-analyze').click();
    await expect(row.getByTestId('games-row-analysis')).toContainText(/Queued · Standard|Analyzing/);
    await expect(row.getByTestId('games-row-analysis')).toContainText('Analyzed', { timeout: 60_000 });
    const stored = await page.evaluate(async () => {
      const lib = window.__wizardChessLibrary!.library;
      return {
        record: await lib.get('chesscom:live-999000111'),
        review: await lib.getReview('chesscom:live-999000111'),
      };
    });
    expect(stored.record?.analysis?.preset).toBe('standard');
    expect(stored.review?.review.moves).toHaveLength(6);
    expect(stored.review?.review.complete).toBe(true);

    // Opening it shows the stored review; the engine is not asked for anything
    await page.evaluate(() => {
      const engine = window.__wizardChessReview!.getEngine();
      const original = engine.analyze.bind(engine);
      (window as unknown as { __analyzeCalls: number }).__analyzeCalls = 0;
      engine.analyze = (...args: Parameters<typeof original>) => {
        (window as unknown as { __analyzeCalls: number }).__analyzeCalls++;
        return original(...args);
      };
    });
    await row.click();
    await expect(page.getByTestId('analysis-layout')).toBeVisible();
    await expect(page.getByTestId('review-panel')).toHaveAttribute('data-state', 'done');
    await expect(page.getByTestId('review-progress-text')).toHaveText(/^Reviewed · Standard · /);
    const opened = await page.evaluate(() => ({
      calls: (window as unknown as { __analyzeCalls: number }).__analyzeCalls,
      savedAt: window.__wizardChessReview!.panel.getSavedAt(),
      perspective: window.__wizardChessReview!.panel.getPerspective(),
      blunder: window.__wizardChessReview!.panel.getReview()!.moves.find((m) => m.san === 'Qxe5+')?.classification,
      openId: window.__wizardChessLibrary!.getOpenGameId(),
    }));
    expect(opened.calls).toBe(0);
    expect(opened.savedAt).toBe(stored.review!.savedAt);
    // "Review as" defaults to my side: hikaru (my Chess.com username) is Black
    expect(opened.perspective).toBe('b');
    expect(opened.blunder).toBe('Blunder');
    expect(opened.openId).toBe('chesscom:live-999000111');
    // The counts table (under "All moves by class") shows the saved review's classes
    await page.getByTestId('review-classes').locator('summary').click();
    await expect(page.getByTestId('review-counts').locator('.wc-class-badge[data-class="Blunder"]')).toBeVisible();
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'saved-review-opened.png') });

    // Auto-analyze: new games are reviewed on Quick
    await page.getByTestId('mode-tab-games').click();
    await page.getByTestId('games-auto-analyze').check();
    await pastePgn(page, SHORT_PLAIN);
    const autoRow = page.getByTestId('games-row').filter({ hasText: 'Carol' });
    await expect(autoRow.getByTestId('games-row-analysis')).toContainText(/Queued · Quick|Analyzing|Analyzed/);
    await expect(autoRow.getByTestId('games-row-analysis')).toContainText('Analyzed', { timeout: 60_000 });
    const autoPreset = await page.evaluate(async () => {
      const lib = window.__wizardChessLibrary!.library;
      const rec = (await lib.list()).find((r) => r.white === 'Carol');
      return rec?.analysis?.preset;
    });
    expect(autoPreset).toBe('quick');
    // The toggle is remembered
    await page.reload();
    await page.evaluate(() => window.__wizardChessLibraryReady);
    await page.getByTestId('mode-tab-games').click();
    await expect(page.getByTestId('games-auto-analyze')).toBeChecked();
    await expect(page.getByTestId('games-row')).toHaveCount(2);
    expect(external).toEqual([]);
  });

  test('a review run on the board for a list game is saved with it', async ({ page }) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await openGames(page);
    await pastePgn(page, SHORT_PLAIN);
    await page.getByTestId('games-row').first().click();
    await expect(page.getByTestId('analysis-layout')).toBeVisible();
    await page.getByTestId('select-review-preset').selectOption('quick');
    await page.getByTestId('btn-review-start').click();
    await expect(page.getByTestId('review-panel')).toHaveAttribute('data-state', 'done', { timeout: 60_000 });
    await page.getByTestId('mode-tab-games').click();
    await expect(page.getByTestId('games-row').first().getByTestId('games-row-analysis')).toContainText('Analyzed');
  });

  test('phone width: the list fits, with no horizontal scroll and no layout shift while filtering', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openGames(page);
    await pastePgn(page, `${LICHESS_PGN}\n\n${CHESSCOM_PGN}\n\n${SHORT_PLAIN}`);
    await expect(page.getByTestId('games-row')).toHaveCount(3);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBe(0);
    for (const row of await page.getByTestId('games-row').all()) {
      const box = (await row.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(390);
    }
    await startLayoutShiftRecorder(page);
    await page.getByTestId('games-sort').selectOption('opponent');
    await page.getByTestId('games-sort').selectOption('newest');
    const shifts = await stopLayoutShiftRecorder(page);
    expect(shifts).toEqual([]);
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'games-list-phone.png'), fullPage: true });
  });
});
