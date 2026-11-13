import { BOT_STYLE_PRESETS, clampBotRating, type BotStyleId } from '../engine/bot';
import {
  DEFAULT_APP_SETTINGS,
  DEFAULT_NEW_GAME,
  sanitizeAppSettings,
  type AppSettings,
  type AppSettingsPatch,
  type NewGameOptions,
} from '../ui/app-settings';

/**
 * A preset: one JSON file that sets the app up for somebody (look, settings, names, a welcome). A first-run link
 * (`/start/<slug>/`, first-run.ts) applies it once. docs: README, "Presets and first-run links".
 *
 * ```json
 * {
 *   "version": 1,
 *   "appName": "…",                                   the Home Screen name
 *   "profile": { "displayName": "…", "title": "…" },
 *   "welcome": { "title": "…", "message": "…", "from": "…" },
 *   "settings": { "boardTheme": "green", "newGame": { "botRating": 1200 } },   any app setting
 *   "usernames": { "lichess": "…", "chesscom": "…" },
 *   "bots": [{ "name": "…", "rating": 1200, "style": "solid" }]
 * }
 * ```
 */
export const PRESET_VERSION = 1;

export const PRESET_LIMITS = {
  appName: 30,
  displayName: 30,
  title: 24,
  welcomeTitle: 80,
  welcomeMessage: 2000,
  welcomeFrom: 60,
  username: 40,
  botName: 30,
  bots: 8,
} as const;

/** A bot with a name of its own: the usual bot at this rating and style. */
export interface CustomBot {
  name: string;
  rating: number;
  style: BotStyleId;
}

export interface WelcomeMessage {
  title: string;
  /** Plain text; a blank line starts a new paragraph. */
  message: string;
  from: string;
}

export interface PresetUsernames {
  lichess: string;
  chesscom: string;
}

export interface Preset {
  version: typeof PRESET_VERSION;
  /** '' when the preset names none. */
  appName: string;
  displayName: string;
  title: string;
  welcome: WelcomeMessage | null;
  /** Only the settings the preset names; everything else keeps its value. */
  settings: AppSettingsPatch;
  usernames: PresetUsernames | null;
  bots: CustomBot[];
}

export interface ParsedPreset {
  /** Null when the file is not a preset at all (not an object, or another version). */
  preset: Preset | null;
  /** Everything that was dropped, cut or not understood, in words (for whoever writes the file). */
  problems: string[];
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Control characters other than a line break (which only multi-line text keeps). */
function isControl(code: number, keepNewlines: boolean): boolean {
  if (keepNewlines && code === 10) return false;
  return code < 32 || (code >= 127 && code < 160);
}

/** One clean line (or, with `multiline`, paragraphs) of at most `max` characters. */
export function cleanText(value: unknown, max: number, multiline = false): string {
  if (typeof value !== 'string') return '';
  let text = '';
  for (const ch of value.replace(/\r\n?/g, '\n')) {
    text += isControl(ch.codePointAt(0) ?? 0, multiline) ? ' ' : ch;
  }
  text = multiline
    ? text
        .split('\n')
        .map((line) => line.replace(/[ \t]+/g, ' ').trim())
        .join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim()
    : text.replace(/\s+/g, ' ').trim();
  return [...text].slice(0, max).join('').trim();
}

/** Reads a text field, noting what was wrong with it. */
function textField(
  src: Record<string, unknown>,
  key: string,
  where: string,
  max: number,
  problems: string[],
  multiline = false,
): string {
  const value = src[key];
  if (value === undefined) return '';
  if (typeof value !== 'string') {
    problems.push(`${where}${key}: must be text`);
    return '';
  }
  const text = cleanText(value, max, multiline);
  if ([...cleanText(value, Number.MAX_SAFE_INTEGER, multiline)].length > max) {
    problems.push(`${where}${key}: longer than ${max} characters (cut)`);
  }
  return text;
}

function noteUnknownKeys(
  src: Record<string, unknown>,
  known: readonly string[],
  where: string,
  problems: string[],
): void {
  for (const key of Object.keys(src)) {
    if (!known.includes(key)) problems.push(`${where}${key}: not a known field (ignored)`);
  }
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** The named settings that are valid as given; anything else is reported and left out. */
function parseSettings(value: unknown, problems: string[]): AppSettingsPatch {
  if (value === undefined) return {};
  if (!isObject(value)) {
    problems.push('settings: must be an object');
    return {};
  }
  const patch: Record<string, unknown> = {};
  const keys = Object.keys(DEFAULT_APP_SETTINGS) as Array<keyof AppSettings>;
  noteUnknownKeys(value, keys, 'settings.', problems);
  for (const key of keys) {
    if (key === 'newGame' || value[key] === undefined) continue;
    // A value is valid when the app's own check keeps it as it is
    const kept = sanitizeAppSettings({ [key]: value[key] })[key];
    if (same(kept, value[key])) patch[key] = kept;
    else problems.push(`settings.${key}: ${JSON.stringify(value[key])} is not a valid value (ignored)`);
  }
  if (value.newGame !== undefined) {
    if (!isObject(value.newGame)) {
      problems.push('settings.newGame: must be an object');
    } else {
      const ng: Record<string, unknown> = {};
      const ngKeys = Object.keys(DEFAULT_NEW_GAME) as Array<keyof NewGameOptions>;
      noteUnknownKeys(value.newGame, ngKeys, 'settings.newGame.', problems);
      for (const key of ngKeys) {
        const given = value.newGame[key];
        if (given === undefined) continue;
        const kept = sanitizeAppSettings({ newGame: { [key]: given } }).newGame[key];
        if (same(kept, given)) ng[key] = kept;
        else problems.push(`settings.newGame.${key}: ${JSON.stringify(given)} is not a valid value (ignored)`);
      }
      if (Object.keys(ng).length > 0) patch.newGame = ng;
    }
  }
  return patch as AppSettingsPatch;
}

/** Custom bots from a preset or a stored profile: named, in range, no two the same bot. */
export function parseBots(value: unknown, problems: string[] = []): CustomBot[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    problems.push('bots: must be a list');
    return [];
  }
  const styles = Object.keys(BOT_STYLE_PRESETS) as BotStyleId[];
  const bots: CustomBot[] = [];
  value.forEach((entry: unknown, i) => {
    const where = `bots[${i}].`;
    if (!isObject(entry)) {
      problems.push(`bots[${i}]: must be an object`);
      return;
    }
    noteUnknownKeys(entry, ['name', 'rating', 'style'], where, problems);
    const name = textField(entry, 'name', where, PRESET_LIMITS.botName, problems);
    if (!name) {
      problems.push(`${where}name: missing (bot ignored)`);
      return;
    }
    if (typeof entry.rating !== 'number' || clampBotRating(entry.rating) !== entry.rating) {
      problems.push(`${where}rating: must be a whole number from 400 to 2400 (bot ignored)`);
      return;
    }
    const style = entry.style === undefined ? 'solid' : entry.style;
    if (typeof style !== 'string' || !styles.includes(style as BotStyleId)) {
      problems.push(`${where}style: must be one of ${styles.join(', ')} (bot ignored)`);
      return;
    }
    if (bots.some((b) => b.rating === entry.rating && b.style === style)) {
      problems.push(`${where.slice(0, -1)}: the same rating and style as an earlier bot (ignored)`);
      return;
    }
    if (bots.length >= PRESET_LIMITS.bots) {
      problems.push(`${where.slice(0, -1)}: more than ${PRESET_LIMITS.bots} bots (ignored)`);
      return;
    }
    bots.push({ name, rating: entry.rating, style: style as BotStyleId });
  });
  return bots;
}

export function parseWelcome(value: unknown, problems: string[] = []): WelcomeMessage | null {
  if (value === undefined || value === null) return null;
  if (!isObject(value)) {
    problems.push('welcome: must be an object');
    return null;
  }
  noteUnknownKeys(value, ['title', 'message', 'from'], 'welcome.', problems);
  const welcome: WelcomeMessage = {
    title: textField(value, 'title', 'welcome.', PRESET_LIMITS.welcomeTitle, problems),
    message: textField(value, 'message', 'welcome.', PRESET_LIMITS.welcomeMessage, problems, true),
    from: textField(value, 'from', 'welcome.', PRESET_LIMITS.welcomeFrom, problems),
  };
  if (!welcome.message) {
    problems.push('welcome.message: missing (no welcome is shown)');
    return null;
  }
  return welcome;
}

/** Checks a preset file's content. The app uses whatever is valid and ignores the rest. */
export function parsePreset(input: unknown): ParsedPreset {
  const problems: string[] = [];
  if (!isObject(input)) return { preset: null, problems: ['not a preset (a JSON object is expected)'] };
  if (input.version !== PRESET_VERSION) {
    return { preset: null, problems: [`version: this app reads version ${PRESET_VERSION} presets`] };
  }
  noteUnknownKeys(input, ['version', 'appName', 'profile', 'welcome', 'settings', 'usernames', 'bots'], '', problems);

  let displayName = '';
  let title = '';
  if (input.profile !== undefined) {
    if (!isObject(input.profile)) {
      problems.push('profile: must be an object');
    } else {
      noteUnknownKeys(input.profile, ['displayName', 'title'], 'profile.', problems);
      displayName = textField(input.profile, 'displayName', 'profile.', PRESET_LIMITS.displayName, problems);
      title = textField(input.profile, 'title', 'profile.', PRESET_LIMITS.title, problems);
    }
  }

  let usernames: PresetUsernames | null = null;
  if (input.usernames !== undefined) {
    if (!isObject(input.usernames)) {
      problems.push('usernames: must be an object');
    } else {
      noteUnknownKeys(input.usernames, ['lichess', 'chesscom'], 'usernames.', problems);
      usernames = {
        lichess: textField(input.usernames, 'lichess', 'usernames.', PRESET_LIMITS.username, problems),
        chesscom: textField(input.usernames, 'chesscom', 'usernames.', PRESET_LIMITS.username, problems),
      };
      if (!usernames.lichess && !usernames.chesscom) usernames = null;
    }
  }

  return {
    preset: {
      version: PRESET_VERSION,
      appName: textField(input, 'appName', '', PRESET_LIMITS.appName, problems),
      displayName,
      title,
      welcome: parseWelcome(input.welcome, problems),
      settings: parseSettings(input.settings, problems),
      usernames,
      bots: parseBots(input.bots, problems),
    },
    problems,
  };
}

// A first-run link's addresses live in start-path.ts (the service worker reads them without the rest of this file)
export {
  START_PATH_PREFIX,
  START_SLUG_PATTERN,
  presetUrl,
  startManifestUrl,
  startPath,
  startSlugFromPath,
} from './start-path';
