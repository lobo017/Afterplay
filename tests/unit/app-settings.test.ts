import { describe, expect, it } from 'vitest';
import {
  AppSettingsStore,
  DEFAULT_APP_SETTINGS,
  DEFAULT_NEW_GAME,
  sanitizeAppSettings,
} from '../../src/ui/app-settings';
import {
  BOARD_FEEL_STORAGE_KEY,
  BoardFeelStore,
  DEFAULT_BOARD_FEEL,
  type FeelStorage,
} from '../../src/render/board-feel';
import { BOARD_SIZE_STORAGE_KEY } from '../../src/render/board-size';
import {
  APP_SETTINGS_STORAGE_KEY,
  PREFERENCES_SETTING_KEY,
  Preferences,
  loadStoredAppSettings,
  parsePreferences,
} from '../../src/ui/settings-persistence';
import { backupFileName, backupPreferences, summarizeBackup } from '../../src/ui/settings-data-section';

class MemoryStorage implements FeelStorage {
  readonly map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
}

class MemoryBackend {
  readonly settings = new Map<string, unknown>();
  writes = 0;
  async getSetting<T>(key: string): Promise<T | undefined> {
    return this.settings.get(key) as T | undefined;
  }
  async setSetting<T>(key: string, value: T): Promise<void> {
    this.writes++;
    this.settings.set(key, JSON.parse(JSON.stringify(value)));
  }
}

describe('Phase 6b — app settings', () => {
  it('fills in defaults and clamps or drops bad values', () => {
    expect(sanitizeAppSettings(undefined)).toEqual(DEFAULT_APP_SETTINGS);
    const s = sanitizeAppSettings({
      boardTheme: 'neon',
      pieceSet: 'staunton',
      maxPremoves: 99,
      volume: -4,
      navigationAnimation: 'slow',
      newGame: {
        color: 'purple',
        timeControlId: '10+0',
        botRating: 9999,
        minThinkMs: 2000,
        maxThinkMs: 100,
        takebacks: 'yes',
      },
    });
    expect(s.boardTheme).toBe(DEFAULT_APP_SETTINGS.boardTheme);
    expect(s.pieceSet).toBe('staunton');
    expect(s.maxPremoves).toBe(20);
    expect(s.volume).toBe(0);
    expect(s.navigationAnimation).toBe('normal');
    expect(s.newGame).toEqual({
      ...DEFAULT_NEW_GAME,
      timeControlId: '10+0',
      botRating: 2400,
      minThinkMs: 2000,
      maxThinkMs: 2000,
    });
  });

  it('merges new-game choices, tells subscribers what changed, and replaces on restore', () => {
    const store = new AppSettingsStore();
    const seen: Array<[number, number]> = [];
    store.subscribe((next, prev) => seen.push([next.newGame.botRating, prev.newGame.botRating]));
    store.set({ newGame: { botRating: 1800 } });
    expect(store.get().newGame).toEqual({ ...DEFAULT_NEW_GAME, botRating: 1800 });
    store.set({ volume: 30 });
    expect(store.get().newGame.botRating).toBe(1800);
    expect(seen).toEqual([
      [1800, 1400],
      [1800, 1800],
    ]);
    store.replace({ sound: false });
    expect(store.get()).toEqual({ ...DEFAULT_APP_SETTINGS, sound: false });
  });
});

describe('Phase 6b — remembering settings and the backup record', () => {
  it('writes every change to this device and reads it back at start-up', () => {
    const storage = new MemoryStorage();
    const app = new AppSettingsStore();
    new Preferences({ appSettings: app, boardFeel: new BoardFeelStore(storage), storage });
    app.set({ boardTheme: 'high-contrast', newGame: { color: 'b' } });
    const loaded = loadStoredAppSettings(storage)!;
    expect(loaded.boardTheme).toBe('high-contrast');
    expect(loaded.newGame.color).toBe('b');
    expect(loadStoredAppSettings(new MemoryStorage())).toBeNull();
    storage.setItem(APP_SETTINGS_STORAGE_KEY, '{oops');
    expect(loadStoredAppSettings(storage)).toBeNull();
  });

  it('mirrors app settings, board feel and board size into one database record', async () => {
    const storage = new MemoryStorage();
    storage.setItem(APP_SETTINGS_STORAGE_KEY, JSON.stringify({ volume: 40 }));
    storage.setItem(BOARD_SIZE_STORAGE_KEY, '720');
    const app = new AppSettingsStore(loadStoredAppSettings(storage));
    const feel = new BoardFeelStore(storage);
    const prefs = new Preferences({ appSettings: app, boardFeel: feel, storage, mirrorDelayMs: 0 });
    const backend = new MemoryBackend();
    await prefs.attach(backend);
    const record = parsePreferences(backend.settings.get(PREFERENCES_SETTING_KEY))!;
    expect(record.app.volume).toBe(40);
    expect(record.boardSize).toBe(720);
    expect(record.boardFeel).toEqual(DEFAULT_BOARD_FEEL);

    feel.set({ liftScale: 1.2 });
    app.set({ sound: false });
    await new Promise((r) => setTimeout(r, 10));
    await prefs.mirrorNow();
    const after = parsePreferences(backend.settings.get(PREFERENCES_SETTING_KEY))!;
    expect(after.boardFeel.liftScale).toBe(1.2);
    expect(after.app.sound).toBe(false);
  });

  it('a device with no saved settings takes them from the database record', async () => {
    const storage = new MemoryStorage();
    const app = new AppSettingsStore();
    const feel = new BoardFeelStore(storage);
    const prefs = new Preferences({ appSettings: app, boardFeel: feel, storage, mirrorDelayMs: 0 });
    const backend = new MemoryBackend();
    backend.settings.set(PREFERENCES_SETTING_KEY, {
      version: 1,
      app: { ...DEFAULT_APP_SETTINGS, pieceSet: 'staunton' },
      boardFeel: { ...DEFAULT_BOARD_FEEL, snapMs: 60 },
      boardSize: 640,
    });
    await prefs.attach(backend);
    expect(app.get().pieceSet).toBe('staunton');
    expect(feel.get().snapMs).toBe(60);
    expect(storage.getItem(BOARD_SIZE_STORAGE_KEY)).toBe('640');
    expect(loadStoredAppSettings(storage)?.pieceSet).toBe('staunton');
  });

  it('a board feel tuned on this device is not replaced by an older database record (a reload right after tuning)', async () => {
    const storage = new MemoryStorage();
    // Tuned just now: kept on the device, and the database mirror (300 ms behind) still has the defaults
    storage.setItem(BOARD_FEEL_STORAGE_KEY, JSON.stringify({ ...DEFAULT_BOARD_FEEL, liftScale: 1.25 }));
    const app = new AppSettingsStore();
    const feel = new BoardFeelStore(storage);
    const prefs = new Preferences({ appSettings: app, boardFeel: feel, storage, mirrorDelayMs: 0 });
    const backend = new MemoryBackend();
    backend.settings.set(PREFERENCES_SETTING_KEY, {
      version: 1,
      app: DEFAULT_APP_SETTINGS,
      boardFeel: DEFAULT_BOARD_FEEL,
      boardSize: null,
    });
    await prefs.attach(backend);
    expect(feel.get().liftScale).toBe(1.25);
    // And the record catches up with the device
    expect(parsePreferences(backend.settings.get(PREFERENCES_SETTING_KEY))!.boardFeel.liftScale).toBe(1.25);
  });

  it('parses a preferences record defensively', () => {
    expect(parsePreferences(null)).toBeNull();
    expect(parsePreferences('x')).toBeNull();
    const p = parsePreferences({ app: { volume: 500 }, boardFeel: { liftScale: 9 }, boardSize: -3 })!;
    expect(p.app.volume).toBe(100);
    expect(p.boardFeel.liftScale).toBe(1.35);
    expect(p.boardSize).toBeNull();
  });
});

describe('Phase 6b — backup files', () => {
  const backup = (extra: Record<string, unknown> = {}) =>
    JSON.stringify({
      format: 'wizards-chess-backup',
      schemaVersion: 4,
      exportedAt: 1_700_000_000_000,
      games: [{ id: 'a' }, { id: 'b' }],
      settings: [{ key: PREFERENCES_SETTING_KEY, value: { app: { sound: false }, boardFeel: {}, boardSize: null } }],
      puzzles: [{ id: 'p' }],
      srsCards: [],
      repertoires: [],
      endgameProgress: [],
      reviews: [{ id: 'a' }],
      ...extra,
    });

  it('counts what a backup holds and finds its preferences', () => {
    expect(summarizeBackup(backup())).toEqual({
      games: 2,
      reviews: 1,
      puzzles: 1,
      cards: 0,
      hasPreferences: true,
      exportedAt: 1_700_000_000_000,
    });
    expect(backupPreferences(backup())?.app.sound).toBe(false);
    expect(summarizeBackup(backup({ settings: [] })).hasPreferences).toBe(false);
    expect(backupPreferences(backup({ settings: [] }))).toBeNull();
  });

  it('rejects files that are not backups', () => {
    expect(() => summarizeBackup('nope')).toThrow(/not JSON/);
    expect(() => summarizeBackup('{"format":"other"}')).toThrow(/not an Afterplay/);
  });

  it('names the file by date', () => {
    expect(backupFileName(new Date(2026, 9, 9))).toBe('afterplay-backup-2026-10-09.json');
  });
});
