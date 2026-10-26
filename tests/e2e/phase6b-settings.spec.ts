import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';

// Phase 6b stage 6: Settings. Every setting remembered on this device (board, board feel,
// board size, moves, sound, Review's animation, Play's live evaluation, the new-game choices),
// the Board feel section (moved from the dev overlay) with "Reset to defaults", and the JSON
// backup and restore carrying all of it.
const SCREENSHOT_DIR = path.join('test-results', 'phase6b-screens');

const GAME_PGN = `[Event "Backup test"]
[Site "https://lichess.org/BkUp0001"]
[Date "2026.10.18"]
[White "Opponent1"]
[Black "Lobo017"]
[Result "0-1"]

1. e4 e5 2. Qh5 Nc6 3. Bc4 Nf6 4. Qxf7# 1-0`;

async function open(page: Page, width = 1440, height = 900): Promise<void> {
  await page.setViewportSize({ width, height });
  await page.goto('/');
  await expect(page.getByTestId('play-layout')).toBeVisible();
  await page.evaluate(() => window.__wizardChessLibraryReady);
}

async function openSettings(page: Page): Promise<void> {
  await page.getByTestId('btn-settings').click();
  await expect(page.getByTestId('settings-sheet')).toBeVisible();
}

test.describe('Phase 6b — Settings', () => {
  test('the sheet: sections in order; Board feel lives here now, not in the dev overlay', async ({ page }) => {
    await open(page);
    await openSettings(page);
    await expect(page.getByTestId('settings-sheet').locator('.wc-settings-sec-title')).toHaveText([
      'Board',
      'Board feel',
      'Moves',
      'Analysis & review',
      'Sound & effects',
      'Your games',
      'Your data',
      'About & diagnostics',
    ]);
    for (const key of ['dragThresholdPx', 'liftScale', 'snapMs', 'dropTolerance', 'touchOffset', 'animationMs']) {
      await expect(page.getByTestId(`feel-${key}`)).toBeVisible();
    }
    await page.getByTestId('settings-board-feel').scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'desktop-settings-board-feel.png') });
    await page.keyboard.press('Escape');

    await page.keyboard.press('`');
    await expect(page.getByTestId('dev-overlay')).toBeVisible();
    await expect(page.getByTestId('dev-overlay')).toContainText('FPS');
    await expect(page.getByTestId('dev-board-feel')).toHaveCount(0);
  });

  test('Board feel: sliders change every board live; Reset to defaults restores them', async ({ page }) => {
    await open(page);
    await openSettings(page);
    await page.getByTestId('feel-liftScale').fill('1.25');
    await expect(page.getByTestId('feel-value-liftScale')).toHaveText('1.25 ×');
    await expect(page.getByTestId('feel-value-liftScale')).toHaveClass(/wc-feel-changed/);
    await page.keyboard.press('Escape');
    const e2 = (await page.getByTestId('play-layout').getByTestId('square-e2').boundingBox())!;
    await page.mouse.move(e2.x + e2.width / 2, e2.y + e2.height / 2);
    await page.mouse.down();
    expect(await page.getByTestId('play-layout').getByTestId('piece-e2').evaluate((el) => (el as HTMLElement).style.transform)).toContain('scale(1.25)');
    await page.mouse.up();

    await openSettings(page);
    await page.getByTestId('btn-feel-reset').click();
    await expect(page.getByTestId('feel-value-liftScale')).toHaveText('1.12 ×');
    await expect(page.getByTestId('feel-value-liftScale')).not.toHaveClass(/wc-feel-changed/);
    expect(await page.evaluate(() => window.__wizardChessPlay!.boardFeel.get().liftScale)).toBe(1.12);
  });

  test('every setting and the new-game choices are remembered after a reload', async ({ page }) => {
    await open(page);
    // New game card
    await page.getByTestId('bot-tier-Expert').click();
    await page.getByTestId('time-control-10+0').click();
    await page.getByTestId('play-as-b').click();
    // Settings
    await openSettings(page);
    await page.getByTestId('select-board-theme').selectOption('imperial-walnut');
    await page.getByTestId('select-piece-set').selectOption('staunton');
    await page.getByTestId('toggle-auto-queen').check();
    await page.getByTestId('input-max-premoves').fill('3');
    await page.getByTestId('input-max-premoves').dispatchEvent('change');
    await page.getByTestId('select-nav-animation').selectOption('off');
    await page.getByTestId('toggle-audio-mute').uncheck();
    await page.getByTestId('slider-audio-volume').fill('35');
    await page.getByTestId('feel-snapMs').fill('200');
    await page.keyboard.press('Escape');
    // Board size from its grip
    const frame = page.getByTestId('play-layout').getByTestId('chess-board-frame');
    const grip = (await page.getByTestId('play-layout').getByTestId('board-resize-handle').boundingBox())!;
    await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
    await page.mouse.down();
    await page.mouse.move(grip.x + grip.width / 2 - 80, grip.y + grip.height / 2, { steps: 6 });
    await page.mouse.up();
    await expect.poll(async () => Math.round((await frame.boundingBox())!.width)).toBe(520);

    await page.reload();
    await expect(page.getByTestId('play-layout')).toBeVisible();
    await expect(page.getByTestId('bot-rating-label')).toHaveText('1800 Elo (Expert)');
    await expect(page.getByTestId('time-control-10+0')).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByTestId('play-as-b')).toHaveAttribute('aria-checked', 'true');
    await expect(frame).toHaveAttribute('data-theme', 'imperial-walnut');
    await expect(frame).toHaveAttribute('data-piece-set', 'staunton');
    expect(Math.round((await frame.boundingBox())!.width)).toBe(520);
    const live = await page.evaluate(() => {
      const play = window.__wizardChessPlay!;
      return {
        autoQueen: play.controller.getBoard().isAutoQueen(),
        premoves: play.controller.getMaxPremoves(),
        sound: play.controller.getAudio().isEnabled(),
        volume: play.controller.getAudio().getVolume(),
        snap: play.boardFeel.get().snapMs,
        nav: window.__wizardChessAnalysis!.controller.getNavAnimation(),
      };
    });
    expect(live).toEqual({ autoQueen: true, premoves: 3, sound: false, volume: 0.35, snap: 200, nav: 'off' });
    await openSettings(page);
    await expect(page.getByTestId('board-size-value')).toHaveText('520 px');
    await expect(page.getByTestId('select-nav-animation')).toHaveValue('off');
    await expect(page.getByTestId('audio-volume-label')).toHaveText('35%');
  });

  test('a backup carries games and every setting; restoring it brings them back', async ({ page }) => {
    await open(page);
    // A game, and some settings
    await page.evaluate(async (pgn) => {
      const lib = await window.__wizardChessLibraryReady!;
      await lib.library.importPgnText(pgn);
    }, GAME_PGN);
    await openSettings(page);
    await page.getByTestId('select-board-theme').selectOption('high-contrast');
    await page.getByTestId('feel-touchOffset').fill('1.2');
    await page.getByTestId('toggle-capture-particles').uncheck();

    const downloadPromise = page.waitForEvent('download');
    await page.getByTestId('btn-backup-download').click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/^wizards-chess-backup-\d{4}-\d{2}-\d{2}\.json$/);
    const file = path.join('test-results', 'phase6b-backup.json');
    await download.saveAs(file);
    await expect(page.getByTestId('backup-status')).toContainText('Backup saved: 1 game');
    const backup = JSON.parse(fs.readFileSync(file, 'utf8')) as {
      games: Array<{ id: string }>;
      settings: Array<{ key: string; value: { app: { boardTheme: string; captureEffects: boolean }; boardFeel: { touchOffset: number } } }>;
    };
    expect(backup.games).toHaveLength(1);
    const prefs = backup.settings.find((s) => s.key === 'app.preferences')!.value;
    expect(prefs.app.boardTheme).toBe('high-contrast');
    expect(prefs.app.captureEffects).toBe(false);
    expect(prefs.boardFeel.touchOffset).toBe(1.2);

    // Change everything, delete the game
    await page.getByTestId('select-board-theme').selectOption('marble-obsidian');
    await page.getByTestId('btn-feel-reset').click();
    await page.getByTestId('toggle-capture-particles').check();
    await page.evaluate(
      () =>
        new Promise<void>((resolve, reject) => {
          const req = indexedDB.open('wizards-chess-db');
          req.onerror = () => reject(req.error);
          req.onsuccess = () => {
            const db = req.result;
            const tx = db.transaction('games', 'readwrite');
            tx.objectStore('games').clear();
            tx.oncomplete = () => {
              db.close();
              resolve();
            };
            tx.onerror = () => reject(tx.error);
          };
        }),
    );
    expect(await page.evaluate(async () => (await (await window.__wizardChessLibraryReady!).library.list()).length)).toBe(0);

    // A file that isn't a backup is refused
    await page.getByTestId('backup-file-input').setInputFiles({ name: 'x.json', mimeType: 'application/json', buffer: Buffer.from('{"hello":1}') });
    await expect(page.getByTestId('backup-status')).toHaveText('This file is not a Wizard’s Chess backup.');
    await expect(page.getByTestId('backup-confirm')).toBeHidden();

    // The real one: a confirmation, then everything is back
    await page.getByTestId('backup-file-input').setInputFiles(file);
    await expect(page.getByTestId('backup-confirm')).toBeVisible();
    await expect(page.getByTestId('backup-confirm-text')).toContainText('1 game');
    await expect(page.getByTestId('backup-confirm-text')).toContainText('replaces your settings');
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'desktop-settings-restore.png') });
    await page.getByTestId('btn-backup-confirm').click();
    await expect(page.getByTestId('backup-status')).toContainText('Restored 1 game');
    await expect(page.getByTestId('select-board-theme')).toHaveValue('high-contrast');
    await expect(page.getByTestId('feel-value-touchOffset')).toHaveText('1.20 sq');
    await expect(page.getByTestId('toggle-capture-particles')).not.toBeChecked();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('play-layout').getByTestId('chess-board-frame')).toHaveAttribute('data-theme', 'high-contrast');
    await page.getByTestId('mode-tab-games').click();
    await expect(page.getByTestId('games-row')).toHaveCount(1);
  });

  test('phone: Settings is full screen and its controls fit', async ({ page }) => {
    await open(page, 390, 844);
    await openSettings(page);
    await page.getByTestId('feel-liftScale').scrollIntoViewIfNeeded();
    for (const id of ['feel-liftScale', 'btn-feel-reset', 'select-board-theme', 'btn-backup-download']) {
      const box = (await page.getByTestId(id).boundingBox())!;
      expect(box.x, id).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width, id).toBeLessThanOrEqual(390);
    }
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'phone-settings.png') });
  });
});
