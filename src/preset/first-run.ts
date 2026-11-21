import type { FeelStorage } from '../render/board-feel';
import { botClassOfTimeControl, type TimeControlPresetId } from '../ui/clock';
import {
  PRESET_VERSION,
  botRatings,
  parseBotsRevision,
  parsePreset,
  presetUrl,
  startSlugFromPath,
  type CustomBot,
  type Preset,
} from './preset';
import { resolveBotForClass, type Profile } from './profile';
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
  /**
   * The build (`build-id.ts`) that last looked at the link's bot list: it applied the preset, or found its list up to
   * date, or took a newer list. Absent until one did. The bots-only update asks again only when the running build differs.
   */
  botsBuild?: string;
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
    const botsBuild = typeof v?.botsBuild === 'string' && v.botsBuild.length <= 64 ? v.botsBuild : '';
    return {
      slug: typeof v?.slug === 'string' ? v.slug : '',
      welcomeSeen: v?.welcomeSeen === true,
      // Returned only when there is one, so a device that never recorded a build reads exactly as before
      ...(botsBuild ? { botsBuild } : {}),
    };
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

/** The one same-origin request of a first-run link's files (preset, history, puzzles): fresh, no credentials beyond the origin. */
export const defaultFetch = (url: string, signal: AbortSignal): Promise<Response> =>
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

// ---------------------------------------------------------------------------- the link's bots, updated on a new build

/**
 * What the bots-only update did. Everything but `updated` and `unchanged` leaves the build unrecorded, so the check runs
 * again at the next start (a game in progress, a request that failed, an answer that is not a preset with bots).
 */
export type BotsUpdateResult =
  | { kind: 'skipped'; reason: 'not-this-link' | 'no-build' | 'same-build' | 'busy' }
  /** The preset's bot list is not newer than this profile's: nothing changed, the build is recorded. */
  | { kind: 'unchanged' }
  /** A newer bot list was taken (its books written first, the profile last), the build recorded. */
  | { kind: 'updated'; revision: number }
  | { kind: 'failed' };

export interface BotsUpdateOptions {
  /** The address of the page (`window.location.pathname`): only the link this device already applied is asked again. */
  pathname: string;
  /** What this device remembers (the applied link and the build that last looked). */
  state: FirstRunState;
  /** The running build's id (`runningBuildId()`); null when it cannot be told, which skips the update. */
  build: string | null;
  profile: { get(): Readonly<Profile>; set(patch: Partial<Profile>): void };
  /** The saved New game choices: the update moves only the rating, and only when it was one of a replaced bot. */
  newGame: { get(): { botRating: number; timeControlId: TimeControlPresetId }; setBotRating(rating: number): void };
  /** Writes the books of the new list, one row each; returns the names that were written. */
  writeBooks: (books: Readonly<Record<string, string>>) => Promise<string[]>;
  /** True while a game is in progress: the update then waits for the next start. */
  isBusy: () => boolean;
  /** Remembers the build that looked (the caller saves it with the rest of the first-run state). */
  recordBuild: (build: string) => void;
  fetchPreset?: (url: string, signal: AbortSignal) => Promise<Response>;
  timeoutMs?: number;
}

/**
 * The saved New game rating after the bot list changed: when it is a rating of a bot that the new list replaces by name
 * (the same name), the new bot's rating for the class of the time control that is chosen; otherwise null (leave it).
 */
export function remapSavedRating(
  oldBots: readonly CustomBot[],
  newBots: readonly CustomBot[],
  savedRating: number,
  timeControlId: TimeControlPresetId,
): number | null {
  const old = oldBots.find((bot) => botRatings(bot).includes(savedRating));
  const replacement = old ? newBots.find((bot) => bot.name === old.name) : undefined;
  if (!replacement) return null;
  const rating = resolveBotForClass(replacement, botClassOfTimeControl(timeControlId)).rating;
  return rating === savedRating ? null : rating;
}

/**
 * The bots-only update. On a device that applied this link before, and only when the running build is not the one that
 * last looked, the link's preset file (the one same-origin request of the first run, nothing else) is read again and,
 * when its `botsRevision` is higher than the profile's, its bot list replaces the profile's.
 *
 * It touches nothing else: not `applyPreset`, not the settings (except the saved New game rating of a replaced bot),
 * theme, names, welcome, games, puzzles or history, and it never deletes a book row. Books are written first and the
 * profile last, so a failure before the profile write changes nothing and leaves the build unrecorded (it runs again at
 * the next start). Never throws; the caller runs it after start-up has settled, so it blocks nothing.
 */
export async function checkBotsUpdate(options: BotsUpdateOptions): Promise<BotsUpdateResult> {
  try {
    const slug = startSlugFromPath(options.pathname);
    if (!slug || slug !== options.state.slug) return { kind: 'skipped', reason: 'not-this-link' };
    const build = options.build;
    if (!build) return { kind: 'skipped', reason: 'no-build' };
    if (options.state.botsBuild === build) return { kind: 'skipped', reason: 'same-build' };
    if (options.isBusy()) return { kind: 'skipped', reason: 'busy' };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 30_000);
    let json: unknown;
    try {
      const response = await (options.fetchPreset ?? defaultFetch)(presetUrl(slug), controller.signal);
      if (!response.ok) return { kind: 'failed' };
      json = JSON.parse(await response.text());
    } catch {
      // Offline, a timeout, an HTML page from a host that answers every path, text that is not JSON
      return { kind: 'failed' };
    } finally {
      clearTimeout(timer);
    }
    // Reading the whole preset checks every book, a task of 100 ms and more for a file of this size, so a list that is not
    // newer is told by its number alone (a new build with the same list is the usual case)
    if (!isObject(json) || json.version !== PRESET_VERSION || !Array.isArray(json.bots) || json.bots.length === 0) {
      return { kind: 'failed' };
    }
    if (parseBotsRevision(json.botsRevision) <= (options.profile.get().botsRevision ?? 0)) {
      options.recordBuild(build);
      return { kind: 'unchanged' };
    }
    // A game may have started while the file was loading
    if (options.isBusy()) return { kind: 'skipped', reason: 'busy' };

    const { preset } = parsePreset(json);
    if (!preset || preset.bots.length === 0) return { kind: 'failed' };
    const revision = preset.botsRevision ?? 0;

    // Books first: every book of the new list must be in the database before any bot refers to it
    const books = preset.books ?? {};
    const wanted = Object.keys(books);
    if (wanted.length > 0) {
      const written = await options.writeBooks(books);
      if (!wanted.every((name) => written.includes(name))) return { kind: 'failed' };
    }
    if (options.isBusy()) return { kind: 'skipped', reason: 'busy' };

    // The profile last, and only the bots and their revision
    const oldBots = options.profile.get().bots;
    options.profile.set({ bots: preset.bots, botsRevision: revision });
    const choice = options.newGame.get();
    const rating = remapSavedRating(oldBots, preset.bots, choice.botRating, choice.timeControlId);
    if (rating !== null) options.newGame.setBotRating(rating);
    options.recordBuild(build);
    return { kind: 'updated', revision };
  } catch {
    return { kind: 'failed' };
  }
}
