import type { MyAccounts } from '../../src/capture/protocol';
import type { KeyValueStore } from './queue';

export interface ExtensionSettings {
  /** My Lichess username ('' when not set). */
  lichessUsername: string;
  /** My Chess.com username ('' when not set). */
  chesscomUsername: string;
  /** The analysis site's origin, e.g. "http://127.0.0.1:4173". */
  siteUrl: string;
  /** Capture a game I played when it ends on the page I'm watching. */
  autoCapture: boolean;
}

/** `npm run serve` serves the site here. */
export const DEFAULT_SITE_URL = 'http://127.0.0.1:4173';

export const DEFAULT_SETTINGS: ExtensionSettings = {
  lichessUsername: '',
  chesscomUsername: '',
  siteUrl: DEFAULT_SITE_URL,
  autoCapture: true,
};

const SETTINGS_KEY = 'settings';

/**
 * The site's origin from what was typed, or null. Only http on localhost / 127.0.0.1 is
 * accepted: the bridge is for the local analysis site (`npm run serve`), and those are the
 * only site hosts the extension has access to.
 */
export function normalizeSiteUrl(input: string): string | null {
  const raw = input.trim();
  if (raw === '') return null;
  let url: URL;
  try {
    url = new URL(/^[a-z]+:\/\//i.test(raw) ? raw : `http://${raw}`);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:') return null;
  if (url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') return null;
  if (url.username || url.password) return null;
  return url.origin;
}

/** Lichess: 2–30 of letters, digits, _ and -. Chess.com: 3–25 of the same. '' is allowed. */
export function normalizeUsername(input: string, site: 'lichess' | 'chesscom'): string | null {
  const name = input.trim();
  if (name === '') return '';
  const ok = site === 'lichess' ? /^[A-Za-z0-9_-]{2,30}$/ : /^[A-Za-z0-9_-]{3,25}$/;
  return ok.test(name) ? name : null;
}

export interface SettingsProblem {
  field: keyof ExtensionSettings;
  message: string;
}

/** The settings as they will be stored, or the first problem with them. */
export function validateSettings(input: ExtensionSettings): { settings: ExtensionSettings } | { problem: SettingsProblem } {
  const lichess = normalizeUsername(input.lichessUsername, 'lichess');
  if (lichess === null) return { problem: { field: 'lichessUsername', message: 'That is not a valid Lichess username.' } };
  const chesscom = normalizeUsername(input.chesscomUsername, 'chesscom');
  if (chesscom === null) return { problem: { field: 'chesscomUsername', message: 'That is not a valid Chess.com username.' } };
  const siteUrl = normalizeSiteUrl(input.siteUrl);
  if (siteUrl === null) {
    return {
      problem: { field: 'siteUrl', message: 'The site URL must be http on localhost or 127.0.0.1, e.g. http://127.0.0.1:4173.' },
    };
  }
  return { settings: { lichessUsername: lichess, chesscomUsername: chesscom, siteUrl, autoCapture: Boolean(input.autoCapture) } };
}

export async function loadSettings(store: KeyValueStore): Promise<ExtensionSettings> {
  const raw = (await store.get([SETTINGS_KEY]))[SETTINGS_KEY];
  const stored = raw && typeof raw === 'object' ? (raw as Partial<ExtensionSettings>) : {};
  return {
    lichessUsername: typeof stored.lichessUsername === 'string' ? stored.lichessUsername : DEFAULT_SETTINGS.lichessUsername,
    chesscomUsername: typeof stored.chesscomUsername === 'string' ? stored.chesscomUsername : DEFAULT_SETTINGS.chesscomUsername,
    siteUrl: typeof stored.siteUrl === 'string' && normalizeSiteUrl(stored.siteUrl) ? stored.siteUrl : DEFAULT_SETTINGS.siteUrl,
    autoCapture: typeof stored.autoCapture === 'boolean' ? stored.autoCapture : DEFAULT_SETTINGS.autoCapture,
  };
}

export async function saveSettings(store: KeyValueStore, settings: ExtensionSettings): Promise<void> {
  await store.set({ [SETTINGS_KEY]: settings });
}

export function accountsOf(settings: ExtensionSettings): MyAccounts {
  return { lichess: settings.lichessUsername, chesscom: settings.chesscomUsername };
}

/** The match pattern of the site's pages, for the bridge content script. */
export function siteMatchPattern(siteUrl: string): string {
  return `${siteUrl}/*`;
}
