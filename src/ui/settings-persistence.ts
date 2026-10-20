import { boardFeel as sharedBoardFeel, sanitizeBoardFeel, type BoardFeel, type BoardFeelStore, type FeelStorage } from '../render/board-feel';
import { applyBoardSize, loadBoardSize, saveBoardSize } from '../render/board-size';
import { AppSettingsStore, sanitizeAppSettings, type AppSettings } from './app-settings';

/** Where the app settings live on this device (read synchronously at start-up). */
export const APP_SETTINGS_STORAGE_KEY = 'wc.settings.v1';

/**
 * The IndexedDB settings record holding every preference (app settings, board feel, board
 * size), so the JSON backup carries them and a restore brings them back.
 */
export const PREFERENCES_SETTING_KEY = 'app.preferences';

export interface PreferencesSnapshot {
  version: 1;
  app: AppSettings;
  boardFeel: BoardFeel;
  /** Board frame width in px, or null for the layout's default. */
  boardSize: number | null;
}

/** Reads and checks a preferences record (from storage or a backup); null when unusable. */
export function parsePreferences(value: unknown): PreferencesSnapshot | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  const size = typeof v.boardSize === 'number' && Number.isFinite(v.boardSize) && v.boardSize > 0 ? v.boardSize : null;
  return {
    version: 1,
    app: sanitizeAppSettings(v.app),
    boardFeel: sanitizeBoardFeel(v.boardFeel),
    boardSize: size,
  };
}

function localStore(): FeelStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** The app settings remembered on this device, or null when none were saved yet. */
export function loadStoredAppSettings(store: FeelStorage | null = localStore()): AppSettings | null {
  try {
    const raw = store?.getItem(APP_SETTINGS_STORAGE_KEY);
    return raw ? sanitizeAppSettings(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

/** Something that can keep the preferences record (the app's IndexedDB storage). */
export interface PreferencesBackend {
  getSetting<T>(key: string): Promise<T | undefined>;
  setSetting<T>(key: string, value: T): Promise<void>;
}

export interface PreferencesOptions {
  appSettings: AppSettingsStore;
  boardFeel?: BoardFeelStore;
  storage?: FeelStorage | null;
  /** How long to wait after the last change before writing the IndexedDB record. */
  mirrorDelayMs?: number;
}

/**
 * Keeps every preference on this device: the app settings in `localStorage` (so the first
 * frame already has them), mirrored with the board feel and board size into one IndexedDB
 * settings record for the JSON backup. A restore applies a backup's record everywhere.
 */
export class Preferences {
  private readonly appSettings: AppSettingsStore;
  private readonly feel: BoardFeelStore;
  private readonly storage: FeelStorage | null;
  private readonly mirrorDelayMs: number;
  private backend: PreferencesBackend | null = null;
  private mirrorTimer: ReturnType<typeof setTimeout> | null = null;
  private mirrorChain: Promise<void> = Promise.resolve();

  constructor(options: PreferencesOptions) {
    this.appSettings = options.appSettings;
    this.feel = options.boardFeel ?? sharedBoardFeel;
    this.storage = options.storage === undefined ? localStore() : options.storage;
    this.mirrorDelayMs = options.mirrorDelayMs ?? 300;
    this.appSettings.subscribe((settings) => {
      this.writeLocal(settings);
      this.scheduleMirror();
    });
    this.feel.subscribe(() => this.scheduleMirror());
    if (typeof window !== 'undefined') {
      // The board size is written by the resize grip; mirror it when it's done
      window.addEventListener('wc-board-size', () => this.scheduleMirror());
    }
  }

  private writeLocal(settings: AppSettings): void {
    try {
      this.storage?.setItem(APP_SETTINGS_STORAGE_KEY, JSON.stringify(settings));
    } catch {
      // Storage full or blocked: the settings still apply until the page closes
    }
  }

  public snapshot(): PreferencesSnapshot {
    return {
      version: 1,
      app: this.appSettings.get(),
      boardFeel: { ...this.feel.get() },
      boardSize: loadBoardSize(this.storage),
    };
  }

  /**
   * Connects the IndexedDB storage once it's open. If this device has no saved settings yet
   * but the database has a record (e.g. site data partly cleared), that record is applied.
   */
  public async attach(backend: PreferencesBackend): Promise<void> {
    this.backend = backend;
    let hadLocal = false;
    try {
      hadLocal = Boolean(this.storage?.getItem(APP_SETTINGS_STORAGE_KEY));
    } catch {
      hadLocal = false;
    }
    if (!hadLocal) {
      const stored = parsePreferences(await backend.getSetting(PREFERENCES_SETTING_KEY));
      if (stored) {
        this.apply(stored);
        return;
      }
    }
    await this.mirrorNow();
  }

  /** Applies a snapshot (a restore) to every screen and to this device's storage. */
  public apply(snapshot: PreferencesSnapshot): void {
    this.appSettings.replace(snapshot.app);
    this.writeLocal(this.appSettings.get());
    this.feel.set(snapshot.boardFeel);
    saveBoardSize(snapshot.boardSize, this.storage);
    applyBoardSize(snapshot.boardSize);
    this.scheduleMirror();
  }

  private scheduleMirror(): void {
    if (!this.backend) return;
    if (this.mirrorTimer !== null) clearTimeout(this.mirrorTimer);
    this.mirrorTimer = setTimeout(() => {
      this.mirrorTimer = null;
      void this.mirrorNow();
    }, this.mirrorDelayMs);
  }

  /** Writes the IndexedDB record now (before a backup is made). */
  public mirrorNow(): Promise<void> {
    if (this.mirrorTimer !== null) {
      clearTimeout(this.mirrorTimer);
      this.mirrorTimer = null;
    }
    const backend = this.backend;
    if (!backend) return Promise.resolve();
    const snapshot = this.snapshot();
    this.mirrorChain = this.mirrorChain
      .then(() => backend.setSetting(PREFERENCES_SETTING_KEY, snapshot))
      .catch(() => undefined);
    return this.mirrorChain;
  }
}
