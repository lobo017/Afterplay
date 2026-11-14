import type { FeelStorage } from '../render/board-feel';
import { parsePreset, presetUrl, startSlugFromPath, type Preset } from './preset';
import { historyUrl } from './start-path';

/**
 * The first-run link: `/start/<slug>/` opens the app and, the first time on a device, applies the preset stored
 * beside it (`/start/<slug>/preset.json`, same origin, fetched once). After that the link is just the app's address:
 * nothing is fetched and nothing the user changed since is overwritten.
 *
 * On an iPhone the Home Screen app does not share Safari's storage, so the link's own manifest starts the installed
 * app at the same path (scripts/build-start-pages.mjs), and its first launch applies the preset there too.
 */
export const FIRST_RUN_STORAGE_KEY = 'wc.first-run.v1';

/** What this device remembers about its first-run link. */
export interface FirstRunState {
  /** The link whose preset was applied ('' when none). */
  slug: string;
  /** The preset's welcome message was shown and closed. */
  welcomeSeen: boolean;
}

function localStore(): FeelStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export function loadFirstRunState(storage: FeelStorage | null = localStore()): FirstRunState {
  try {
    const raw = storage?.getItem(FIRST_RUN_STORAGE_KEY);
    const v = raw ? (JSON.parse(raw) as Partial<FirstRunState> | null) : null;
    return { slug: typeof v?.slug === 'string' ? v.slug : '', welcomeSeen: v?.welcomeSeen === true };
  } catch {
    return { slug: '', welcomeSeen: false };
  }
}

export function saveFirstRunState(state: FirstRunState, storage: FeelStorage | null = localStore()): void {
  try {
    storage?.setItem(FIRST_RUN_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Storage blocked: the preset is applied again next time, which only repeats the welcome
  }
}

export type FirstRunResult =
  /** The address is not a first-run link. */
  | { kind: 'none' }
  /** This link's preset was applied on this device before. */
  | { kind: 'already'; slug: string }
  | { kind: 'loaded'; slug: string; preset: Preset; problems: string[] }
  | { kind: 'failed'; slug: string; message: string };

export interface FirstRunOptions {
  pathname: string;
  /** The slug this device already applied (FirstRunState.slug). */
  appliedSlug: string;
  fetchPreset?: (url: string, signal: AbortSignal) => Promise<Response>;
  timeoutMs?: number;
}

const defaultFetch = (url: string, signal: AbortSignal): Promise<Response> =>
  fetch(url, { cache: 'no-store', credentials: 'same-origin', signal });

/** Decides what the address asks for and, when needed, loads and checks the preset. Never throws. */
export async function loadFirstRunPreset(options: FirstRunOptions): Promise<FirstRunResult> {
  const slug = startSlugFromPath(options.pathname);
  if (!slug) return { kind: 'none' };
  if (slug === options.appliedSlug) return { kind: 'already', slug };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 15_000);
  try {
    const response = await (options.fetchPreset ?? defaultFetch)(presetUrl(slug), controller.signal);
    if (!response.ok) {
      return { kind: 'failed', slug, message: 'This set-up link is not known here. Check the link and open it again.' };
    }
    let json: unknown;
    try {
      json = JSON.parse(await response.text());
    } catch {
      // A host that answers every unknown path with the app's page ends up here
      return { kind: 'failed', slug, message: 'This set-up link is not known here. Check the link and open it again.' };
    }
    const { preset, problems } = parsePreset(json);
    if (!preset) {
      return { kind: 'failed', slug, message: 'This set-up link could not be read by this version of the app.' };
    }
    return { kind: 'loaded', slug, preset, problems };
  } catch {
    return {
      kind: 'failed',
      slug,
      message: 'The set-up for this link could not be loaded. Open the link again when you are online.',
    };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------- the link's game history

/** A game of the history file: the restore file's record, of which only what the app stores is kept. */
export interface HistoryGame {
  id: string;
  pgn: string;
  [field: string]: unknown;
}

/** The settings record of the file that is kept: the sync's month record. Everything else in the file is ignored. */
export interface HistorySettingRecord {
  key: string;
  value: unknown;
}

export const HISTORY_MONTH_SETTING = 'sync.chesscom';

export type HistoryFileResult =
  /** The link has no history file (a 404, or the host answered with a page). Not an error: most links have none. */
  | { kind: 'none' }
  | { kind: 'loaded'; games: HistoryGame[]; monthRecord: HistorySettingRecord | null; ignored: number }
  /** The request or the reading stopped: the load is paused and can be continued. */
  | { kind: 'failed'; message: string };

export interface HistoryFileOptions {
  slug: string;
  fetchFile?: (url: string, signal: AbortSignal) => Promise<Response>;
  timeoutMs?: number;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Fetches the history file beside a link's preset, once, from the same origin, with no press. It is the restore file's
 * format (games and settings); only the games and the sync's month record are read. Never throws.
 */
export async function loadHistoryFile(options: HistoryFileOptions): Promise<HistoryFileResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 60_000);
  try {
    const response = await (options.fetchFile ?? defaultFetch)(historyUrl(options.slug), controller.signal);
    if (response.status === 404) return { kind: 'none' };
    if (!response.ok) return { kind: 'failed', message: 'The games for this link could not be loaded.' };
    const type = response.headers?.get('content-type') ?? '';
    const text = await response.text();
    // A host that answers every unknown path with the app's page
    if (/text\/html/i.test(type) || /^\s*</.test(text)) return { kind: 'none' };
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return { kind: 'failed', message: 'The games for this link could not be read.' };
    }
    if (!isObject(json) || json.format !== 'wizards-chess-backup' || !Array.isArray(json.games))
      return { kind: 'none' };
    const games: HistoryGame[] = [];
    let ignored = 0;
    for (const g of json.games) {
      if (isObject(g) && typeof g.id === 'string' && g.id !== '' && typeof g.pgn === 'string')
        games.push(g as HistoryGame);
      else ignored++;
    }
    let monthRecord: HistorySettingRecord | null = null;
    if (Array.isArray(json.settings)) {
      for (const s of json.settings) {
        if (isObject(s) && s.key === HISTORY_MONTH_SETTING && s.value !== undefined) {
          monthRecord = { key: s.key, value: s.value };
        }
      }
    }
    return { kind: 'loaded', games, monthRecord, ignored };
  } catch {
    return { kind: 'failed', message: 'The games for this link could not be loaded. Continue when you are online.' };
  } finally {
    clearTimeout(timer);
  }
}
