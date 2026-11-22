import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { SITE_URL } from './helpers/site';

// Phase 0 of the sync plan: Restore keeps newer progress. A restore merges the file into what is on the device: progress
// that is newer here stays, older or missing records come from the file, settings and bots are replaced as before, a
// damaged file is refused whole, and the work happens in a background worker that starts only when a file is chosen.
// Invented data only.
const SCREENSHOT_DIR = path.join('test-results', 'phase11-restore-newer-screens');
fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

interface PuzzleRow {
  id: string;
  source: 'personal';
  fen: string;
  moves: string[];
  rating: number;
  themes: string[];
  dueDate: number;
  attempts: number;
  solvedCount: number;
  updatedAt: number;
  lastAttemptAt?: number;
}

const puzzle = (id: string, attempts = 0, lastAttemptAt?: number): PuzzleRow => ({
  id,
  source: 'personal',
  fen: '8/8/8/8/8/8/8/K6k w - - 0 1',
  moves: ['a1a2', 'h1h2'],
  rating: 0,
  themes: [],
  dueDate: 5000,
  attempts,
  solvedCount: Math.min(attempts, 1),
  updatedAt: 1000,
  ...(lastAttemptAt === undefined ? {} : { lastAttemptAt }),
});

const backupText = (parts: Record<string, unknown>): string =>
  JSON.stringify({
    format: 'wizards-chess-backup',
    schemaVersion: 4,
    exportedAt: Date.UTC(2026, 10, 12),
    games: [],
    settings: [],
    puzzles: [],
    srsCards: [],
    reviews: [],
    ...parts,
  });

const asFile = (text: string, name = 'backup.json') => ({
  name,
  mimeType: 'application/json',
  buffer: Buffer.from(text),
});

async function open(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.getByTestId('play-layout')).toBeVisible();
  await page.evaluate(() => window.__wizardChessLibraryReady);
}

async function openSettings(page: Page): Promise<void> {
  await page.getByTestId('btn-settings').click();
  await expect(page.getByTestId('settings-sheet')).toBeVisible();
}

/** Writes records into one store of the page's database, exactly as given. */
async function putRows(page: Page, store: string, rows: unknown[]): Promise<void> {
  await page.evaluate(
    ([name, records]) =>
      new Promise<void>((resolve, reject) => {
        const req = indexedDB.open('wizards-chess-db');
        req.onerror = () => reject(req.error);
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction(name as string, 'readwrite');
          for (const record of records as unknown[]) tx.objectStore(name as string).put(record);
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onerror = () => reject(tx.error);
        };
      }),
    [store, rows] as const,
  );
}

/** Every record of the named stores, as plain data (to compare a database before and after). */
async function readStores(page: Page, stores: string[]): Promise<Record<string, unknown[]>> {
  return page.evaluate(
    (names) =>
      new Promise<Record<string, unknown[]>>((resolve, reject) => {
        const req = indexedDB.open('wizards-chess-db');
        req.onerror = () => reject(req.error);
        req.onsuccess = () => {
          const db = req.result;
          const out: Record<string, unknown[]> = {};
          const tx = db.transaction(names, 'readonly');
          for (const name of names) {
            const all = tx.objectStore(name).getAll();
            all.onsuccess = () => {
              out[name] = all.result as unknown[];
            };
          }
          tx.oncomplete = () => {
            db.close();
            resolve(out);
          };
          tx.onerror = () => reject(tx.error);
        };
      }),
    stores,
  );
}

const puzzlesOf = async (page: Page): Promise<Map<string, PuzzleRow>> => {
  const { puzzles } = await readStores(page, ['puzzles']);
  return new Map((puzzles as PuzzleRow[]).map((p) => [p.id, p]));
};

async function chooseFile(
  page: Page,
  file: { name: string; mimeType: string; buffer: Buffer } | string,
): Promise<void> {
  await page.getByTestId('backup-file-input').setInputFiles(file);
}

/** A second browser profile on this machine: its own database, as a second device would have. */
async function newDevice(browser: Browser): Promise<{ context: BrowserContext; page: Page }> {
  const { viewport, userAgent, deviceScaleFactor, isMobile, hasTouch } = test.info().project.use;
  const context = await browser.newContext({
    baseURL: SITE_URL,
    serviceWorkers: 'block',
    ...(viewport ? { viewport } : {}),
    ...(userAgent ? { userAgent } : {}),
    ...(deviceScaleFactor ? { deviceScaleFactor } : {}),
    ...(isMobile !== undefined ? { isMobile } : {}),
    ...(hasTouch !== undefined ? { hasTouch } : {}),
    storageState: {
      cookies: [],
      origins: [
        {
          origin: SITE_URL,
          localStorage: [
            { name: 'wc.story.v1', value: 'skipped' },
            { name: 'wc-install-guide-seen', value: '1' },
          ],
        },
      ],
    },
  });
  const page = await context.newPage();
  await open(page);
  return { context, page };
}

test.describe('Phase 0 — Restore keeps newer progress', () => {
  test('an older backup keeps the newer progress on this device; the dialog and the result say so', async ({
    page,
  }) => {
    await open(page);
    // This device: P1 solved again after the backup was made, P2 older than the file's, P3 only here
    await putRows(page, 'puzzles', [puzzle('p1', 3, 3000), puzzle('p2', 1, 500), puzzle('p3', 2, 2500)]);
    // The file: P1 as it was (older), P2 later, P4 only in the file
    const file = backupText({ puzzles: [puzzle('p1', 1, 1000), puzzle('p2', 4, 4000), puzzle('p4', 2, 2000)] });

    await openSettings(page);
    await chooseFile(page, asFile(file));
    await expect(page.getByTestId('backup-confirm')).toBeVisible();
    await expect(page.getByTestId('backup-confirm-text')).toHaveText(
      /^Restore this backup from .+\? It holds 0 games, 0 reviews and 3 puzzles\. Progress that is newer on this device is kept; anything older here is updated from the file and anything missing is added\.$/,
    );
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, `${test.info().project.name}-dialog.png`) });
    await page.getByTestId('btn-backup-confirm').click();
    await expect(page.getByTestId('backup-status')).toHaveText(
      'Restored 0 games, 0 reviews and 2 puzzles. Kept what was newer here: 1 puzzle.',
    );
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, `${test.info().project.name}-result.png`) });

    const rows = await puzzlesOf(page);
    expect(rows.get('p1')).toMatchObject({ attempts: 3, lastAttemptAt: 3000 }); // newer here: kept
    expect(rows.get('p2')).toMatchObject({ attempts: 4, lastAttemptAt: 4000 }); // older here: updated
    expect(rows.get('p3')).toMatchObject({ attempts: 2, lastAttemptAt: 2500 }); // only here: untouched
    expect(rows.get('p4')).toMatchObject({ attempts: 2, lastAttemptAt: 2000 }); // only in the file: added

    // The same file again: nothing left to do
    await chooseFile(page, asFile(file));
    await page.getByTestId('btn-backup-confirm').click();
    await expect(page.getByTestId('backup-status')).toHaveText(
      'Nothing to restore: this device already has everything in the file. Kept what was newer here: 1 puzzle.',
    );
  });

  test('a damaged file is refused whole and nothing changes', async ({ page }) => {
    await open(page);
    await putRows(page, 'puzzles', [puzzle('p1', 3, 3000)]);
    const before = await readStores(page, ['puzzles', 'games', 'settings']);
    await openSettings(page);

    // A record without an id, and a duplicate: two damaged records
    const damaged = backupText({
      puzzles: [puzzle('p1', 1, 1000), { ...puzzle('x'), id: '' }, puzzle('p1', 2, 2000)],
    });
    await chooseFile(page, asFile(damaged));
    await expect(page.getByTestId('backup-status')).toHaveText('2 records in this file are damaged.');
    await expect(page.getByTestId('backup-confirm')).toBeHidden();
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, `${test.info().project.name}-damaged.png`) });

    // A file from a newer version of the app
    await chooseFile(page, asFile(backupText({ schemaVersion: 99 })));
    await expect(page.getByTestId('backup-status')).toHaveText(
      'This backup was made by a newer version of Afterplay. Update the app, then try again.',
    );
    await expect(page.getByTestId('backup-confirm')).toBeHidden();

    // A file that is not JSON at all
    await chooseFile(page, asFile('{"games": [', 'cut.json'));
    await expect(page.getByTestId('backup-status')).toHaveText('This file is not an Afterplay backup (not JSON).');

    const after = await readStores(page, ['puzzles', 'games', 'settings']);
    expect(after).toEqual(before);
  });

  test('settings and bots from the file replace the ones here, as they always did', async ({ page }) => {
    await open(page);
    await putRows(page, 'settings', [{ key: 'bots.book.me', value: 'newer here', updatedAt: 9_000_000 }]);
    const prefs = {
      key: 'app.preferences',
      updatedAt: 1,
      value: { version: 1, app: { boardTheme: 'high-contrast' }, boardFeel: {}, boardSize: null },
    };
    await openSettings(page);
    await chooseFile(
      page,
      asFile(backupText({ settings: [prefs, { key: 'bots.book.me', value: 'from the file', updatedAt: 5 }] })),
    );
    await expect(page.getByTestId('backup-confirm-text')).toContainText(
      'It also replaces your settings and your bots with the ones in the file.',
    );
    await page.getByTestId('btn-backup-confirm').click();
    await expect(page.getByTestId('backup-status')).toContainText('and your settings.');
    await expect(page.getByTestId('select-board-theme')).toHaveValue('high-contrast');
    const { settings } = await readStores(page, ['settings']);
    const book = (settings as Array<{ key: string; value: unknown }>).find((s) => s.key === 'bots.book.me');
    expect(book?.value).toBe('from the file');
  });

  test('two devices: each restores the other one’s half of a puzzle set, in both directions', async ({ browser }) => {
    const a = await newDevice(browser);
    const b = await newDevice(browser);
    try {
      const ids = Array.from({ length: 10 }, (_, i) => `set${i + 1}`);
      // The same ten puzzles on both; each device solved a different half
      await putRows(
        a.page,
        'puzzles',
        ids.map((id, i) => puzzle(id, i < 5 ? 1 : 0, i < 5 ? 1000 + i : undefined)),
      );
      await putRows(
        b.page,
        'puzzles',
        ids.map((id, i) => puzzle(id, i >= 5 ? 1 : 0, i >= 5 ? 2000 + i : undefined)),
      );
      const backups: Record<string, string> = {};
      for (const [name, device] of [
        ['a', a],
        ['b', b],
      ] as const) {
        await openSettings(device.page);
        const download = device.page.waitForEvent('download');
        await device.page.getByTestId('btn-backup-download').click();
        backups[name] = path.join('test-results', `phase11-restore-newer-${name}-${process.pid}.json`);
        await (await download).saveAs(backups[name]!);
        await expect(device.page.getByTestId('backup-status')).toContainText('Backup saved');
      }
      await chooseFile(a.page, backups.b!);
      await a.page.getByTestId('btn-backup-confirm').click();
      await expect(a.page.getByTestId('backup-status')).toContainText('Restored 0 games, 0 reviews and 5 puzzles');
      await chooseFile(b.page, backups.a!);
      await b.page.getByTestId('btn-backup-confirm').click();
      await expect(b.page.getByTestId('backup-status')).toContainText('Restored 0 games, 0 reviews and 5 puzzles');

      for (const device of [a, b]) {
        const rows = await puzzlesOf(device.page);
        expect(rows.size).toBe(10);
        expect(ids.every((id) => (rows.get(id)?.attempts ?? 0) === 1)).toBe(true);
      }
      for (const file of Object.values(backups)) fs.rmSync(file, { force: true });
    } finally {
      await a.context.close();
      await b.context.close();
    }
  });

  test('opening the app starts no restore worker and writes nothing to the database', async ({ browser }) => {
    const device = await newDevice(browser);
    try {
      // Data of the kind a real library holds, written the way a restore would leave it
      await putRows(device.page, 'puzzles', [puzzle('p1', 3, 3000), puzzle('p2')]);
      await putRows(device.page, 'settings', [
        { key: 'library.myAccounts', value: { lichess: 'x', chesscom: '' }, updatedAt: 7 },
      ]);
      const stores = ['games', 'puzzles', 'srs_cards', 'repertoires', 'endgame_progress', 'reviews', 'settings'];
      await device.page.reload();
      await device.page.evaluate(() => window.__wizardChessLibraryReady);
      await device.page.waitForTimeout(500);
      const before = await readStores(device.page, stores);

      const workers: string[] = [];
      device.page.on('worker', (w) => workers.push(w.url()));
      await device.page.reload();
      await expect(device.page.getByTestId('play-layout')).toBeVisible();
      await device.page.evaluate(() => window.__wizardChessLibraryReady);
      await device.page.waitForTimeout(1500);

      expect(workers.filter((url) => /backup-restore/.test(url))).toEqual([]);
      // (the app has always mirrored its preferences into the settings store when it opens, so that one row's time moves;
      // nothing else may)
      const withoutMirror = (data: Record<string, unknown[]>) => ({
        ...data,
        settings: (data.settings as Array<{ key: string }>).filter((row) => row.key !== 'app.preferences'),
      });
      expect(withoutMirror(await readStores(device.page, stores))).toEqual(withoutMirror(before));

      // Choosing a file is what starts it
      await openSettings(device.page);
      const started = device.page.waitForEvent('worker');
      await chooseFile(device.page, asFile(backupText({})));
      expect((await started).url()).toMatch(/backup-restore/);
      await expect(device.page.getByTestId('backup-confirm')).toBeVisible();
    } finally {
      await device.context.close();
    }
  });

  test('phone: the dialog and the result fit the screen', async ({ page }) => {
    test.skip(test.info().project.name !== 'webkit-iphone', 'the phone layout is the iPhone project');
    await open(page);
    await putRows(page, 'puzzles', [puzzle('p1', 3, 3000)]);
    await openSettings(page);
    await chooseFile(page, asFile(backupText({ puzzles: [puzzle('p1', 1, 1000), puzzle('p9', 1, 1)] })));
    await expect(page.getByTestId('backup-confirm')).toBeVisible();
    await page.getByTestId('backup-confirm').scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'phone-dialog.png') });
    await page.getByTestId('btn-backup-confirm').click();
    await expect(page.getByTestId('backup-status')).toContainText('Kept what was newer here: 1 puzzle.');
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'phone-result.png') });
    const box = await page.getByTestId('backup-status').boundingBox();
    expect(box && box.x >= 0 && box.x + box.width <= (page.viewportSize()?.width ?? 0) + 1).toBe(true);
  });
});
