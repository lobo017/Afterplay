import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { installIndexedDBPolyfill } from './helpers/indexeddb-polyfill';
installIndexedDBPolyfill();

import { BRIDGE_MESSAGE_SOURCE, PAGE_MESSAGE_SOURCE } from '../../src/capture/protocol';
import { FIRST_RUN_STORAGE_KEY } from '../../src/preset/first-run';
import { PROFILE_STORAGE_KEY } from '../../src/preset/profile';
import { BOARD_FEEL_STORAGE_KEY } from '../../src/render/board-feel';
import { BOARD_SIZE_STORAGE_KEY } from '../../src/render/board-size';
import { DEFAULT_DB_NAME, LATEST_SCHEMA_VERSION, WizardChessStorage, deleteWizardChessDB } from '../../src/storage/db';
import { LINKS_CACHE } from '../../src/sw-links';
import { STORY_LANDING_KEY } from '../../src/story/landing';
import { INSTALL_GUIDE_SEEN_KEY } from '../../src/ui/install-guide';
import { backupFileName, summarizeBackup } from '../../src/ui/settings-data-section';
import { APP_SETTINGS_STORAGE_KEY, PREFERENCES_SETTING_KEY } from '../../src/ui/settings-persistence';

/**
 * The app was renamed (Wizard's Chess → Afterplay) without renaming anything a device has already stored under.
 * Every name below is where an installed copy keeps its games, settings and offline files: changing one would
 * silently orphan that data. A change here must come with a migration, never with an edit of the expected value.
 */
const ROOT = path.resolve(__dirname, '..', '..');
const source = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((entry) => {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) return sourceFiles(rel);
    return /\.(ts|mjs|html)$/.test(entry.name) ? [rel] : [];
  });
}

describe('Storage names stay what installed copies already use', () => {
  it('IndexedDB: database name, version, stores and indexes', async () => {
    expect(DEFAULT_DB_NAME).toBe('wizards-chess-db');
    expect(LATEST_SCHEMA_VERSION).toBe(4);

    const dbName = 'wizards-chess-storage-names-test';
    await deleteWizardChessDB(dbName);
    const storage = await WizardChessStorage.create({ dbName });
    try {
      expect(storage.storeNames.sort()).toEqual([
        'endgame_progress',
        'games',
        'puzzles',
        'repertoires',
        'reviews',
        'schema_meta',
        'settings',
        'srs_cards',
      ]);
      expect(storage.getIndexNames('games').sort()).toEqual([
        'by-accuracy',
        'by-color',
        'by-date',
        'by-opening',
        'by-result',
        'by-updated',
      ]);
      expect(storage.getIndexNames('puzzles').sort()).toEqual(['by-due', 'by-rating', 'by-source']);
      expect(storage.getIndexNames('srs_cards').sort()).toEqual(['by-deck', 'by-due', 'by-state']);
      expect(storage.getIndexNames('repertoires').sort()).toEqual(['by-color', 'by-updated']);
      expect(storage.getIndexNames('endgame_progress').sort()).toEqual(['by-category', 'by-completed']);
    } finally {
      storage.close();
      await deleteWizardChessDB(dbName);
    }
  });

  it('localStorage and sessionStorage keys, and the preferences record', () => {
    expect({
      APP_SETTINGS_STORAGE_KEY,
      BOARD_FEEL_STORAGE_KEY,
      BOARD_SIZE_STORAGE_KEY,
      PROFILE_STORAGE_KEY,
      FIRST_RUN_STORAGE_KEY,
      INSTALL_GUIDE_SEEN_KEY,
      STORY_LANDING_KEY,
      PREFERENCES_SETTING_KEY,
    }).toEqual({
      APP_SETTINGS_STORAGE_KEY: 'wc.settings.v1',
      BOARD_FEEL_STORAGE_KEY: 'wc.boardFeel.v1',
      BOARD_SIZE_STORAGE_KEY: 'wc.boardSize.v1',
      PROFILE_STORAGE_KEY: 'wc.profile.v1',
      FIRST_RUN_STORAGE_KEY: 'wc.first-run.v1',
      INSTALL_GUIDE_SEEN_KEY: 'wc-install-guide-seen',
      STORY_LANDING_KEY: 'wc.story.v1',
      PREFERENCES_SETTING_KEY: 'app.preferences',
    });
    // Not exported (src/pwa.ts runs in the page only)
    expect(source('src/pwa.ts')).toContain("const ISOLATION_RELOAD_KEY = 'wc-isolation-reload';");
  });

  it('every key the site passes to localStorage or sessionStorage is one of the pinned ones', () => {
    // A new key is fine, but it has to be added here (and to the list above) on purpose
    const known = [
      'APP_SETTINGS_STORAGE_KEY',
      'BOARD_FEEL_STORAGE_KEY',
      'BOARD_SIZE_STORAGE_KEY',
      'PROFILE_STORAGE_KEY',
      'FIRST_RUN_STORAGE_KEY',
      'INSTALL_GUIDE_SEEN_KEY',
      'STORY_LANDING_KEY',
      'ISOLATION_RELOAD_KEY',
      // settings-persistence.ts loops over four of the constants above with a variable of this name
      'key',
    ];
    const used = new Set<string>();
    for (const rel of sourceFiles('src')) {
      for (const m of source(rel).matchAll(/\.(?:getItem|setItem|removeItem)\(\s*([^,)\s]+)/g)) used.add(m[1]!);
    }
    expect([...used].sort()).toEqual([...known].sort());
  });

  it('the service worker cache names', () => {
    expect(source('src/sw.ts')).toContain("const CACHE = 'wizards-chess-precache-v1';");
    // The first-run links a device has learned (sw-links.ts): a rename would make an installed app forget its link
    expect(LINKS_CACHE).toBe('wizards-chess-links-v1');
    const cacheNames = new Set<string>();
    for (const rel of ['src/sw.ts', 'src/sw-links.ts']) {
      for (const m of source(rel).matchAll(/caches\.open\(\s*([^,)\s]+)/g)) cacheNames.add(m[1]!);
    }
    expect([...cacheNames].sort()).toEqual(['CACHE', 'LINKS_CACHE']);
  });

  it('the bridge message names the extension and the site share', () => {
    expect(PAGE_MESSAGE_SOURCE).toBe('wizard-chess-page');
    expect(BRIDGE_MESSAGE_SOURCE).toBe('wizard-chess-extension');
  });

  it('the capture extension’s own storage keys', () => {
    const pinned: Array<[string, string]> = [
      ['extension/src/queue.ts', "const INDEX_KEY = 'queue:index';"],
      ['extension/src/settings.ts', "const SETTINGS_KEY = 'settings';"],
      ['extension/src/game-retry.ts', "const RETRIES_KEY = 'gameRetries';"],
      ['extension/src/capture-service.ts', "const LAST_FAILURE_KEY = 'lastFailure';"],
      ['extension/src/tab-tracker.ts', "export const TRACKED_TABS_KEY = 'trackedTabs';"],
      ['extension/src/background.ts', "const FOLLOW_UP_KEY = 'autoSyncFollowUp';"],
      ['extension/src/background.ts', "const LAST_LEAVE_KEY = 'lastLeave';"],
    ];
    for (const [rel, line] of pinned) expect(source(rel), rel).toContain(line);
  });

  it('nothing in the app, the service worker or the build config takes a name from package.json', () => {
    const offenders = [...sourceFiles('src'), ...sourceFiles('extension/src'), 'vite.config.ts'].filter((rel) =>
      /package\.json|npm_package_|process\.env\.npm/.test(source(rel)),
    );
    expect(offenders).toEqual([]);
    // The one script that reads package.json takes the version number only (the extension's manifest version)
    const pkgUses = [...source('scripts/build-extension.mjs').matchAll(/\bpkg\.(\w+)/g)].map((m) => m[1]);
    expect([...new Set(pkgUses)]).toEqual(['version']);
  });
});

describe('Backups from before the rename still restore', () => {
  const OLD_FILE_NAME = 'wizards-chess-backup-2026-10-09.json';
  const oldBackup = JSON.stringify({
    format: 'wizards-chess-backup',
    schemaVersion: 4,
    exportedAt: 1_700_000_000_000,
    games: [
      {
        id: 'old-1',
        white: 'A',
        black: 'B',
        playerColor: 'w',
        result: '1-0',
        date: '2026.10.09',
        openingEco: 'C20',
        openingName: 'King’s Pawn Game',
        accuracy: null,
        pgn: '1. e4 e5 1-0',
        tags: [],
      },
    ],
    settings: [],
    puzzles: [],
    srsCards: [],
    repertoires: [],
    endgameProgress: [],
    reviews: [],
  });

  it('a file with the old name and the old format string is read and imported', async () => {
    // The name the app gives a new backup changed; what a backup is recognised by did not
    expect(backupFileName(new Date(2026, 9, 9))).toBe('afterplay-backup-2026-10-09.json');
    const file = new File([oldBackup], OLD_FILE_NAME, { type: 'application/json' });
    const text = await file.text();
    expect(summarizeBackup(text)).toMatchObject({ games: 1, exportedAt: 1_700_000_000_000 });

    const dbName = 'wizards-chess-old-backup-test';
    await deleteWizardChessDB(dbName);
    const storage = await WizardChessStorage.create({ dbName });
    try {
      expect((await storage.importBackupJson(text)).gamesImported).toBe(1);
      expect((await storage.getGame('old-1'))?.white).toBe('A');
      // And what the app writes today is still the same format
      expect(JSON.parse(await storage.exportBackupJson()).format).toBe('wizards-chess-backup');
    } finally {
      storage.close();
      await deleteWizardChessDB(dbName);
    }
  });

  it('reading a backup never looks at the file name', () => {
    const section = source('src/ui/settings-data-section.ts');
    expect(section).not.toMatch(/file\.name|files\[0\]\.name|\.name\.(endsWith|startsWith|includes|match)/);
  });
});
