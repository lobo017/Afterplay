import { BOT_STYLE_PRESETS, clampBotRating, type BotStyleId } from '../engine/bot';
import { parseBook } from '../engine/bot-profile';
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
 *   "story": { "intro": "…", "closing": "…" },          optional text on the first and last Chess Story cards
 *   "settings": { "boardTheme": "green", "newGame": { "botRating": 1200 } },   any app setting
 *   "usernames": { "lichess": "…", "chesscom": "…" },
 *   "bots": [{ "name": "…", "rating": 1200, "style": "solid", "books": ["…"] }]
 * }
 * ```
 *
 * A bot's optional `books` are 1 to 3 opening books, each the text `serializeBook` writes (engine/bot-profile.ts), tried
 * in order before the engine is asked; after the books run out the bot plays as the usual bot of its rating and style.
 * The books are kept with the profile (localStorage, read at every start-up), so their size is capped
 * (`PRESET_LIMITS.bookChars` each, `booksTotalChars` for all bots together).
 *
 * Deeper books travel by reference instead: an optional top-level `books` table (name to book text) and, on a bot,
 * `bookRefs` (names in that table, 1 to 3, tried in order after the bot's own `books`). The app writes each table book
 * once into the database (`bots.preset.<name>`, bot-profile-store.ts) and keeps only the names in the profile, so these
 * books have far larger limits (`bookTableChars`, `bookTableTotalChars`). The file's `version` stays 1: both fields are
 * additions that an older app reports and ignores.
 */
export const PRESET_VERSION = 1;

export const PRESET_LIMITS = {
  appName: 30,
  displayName: 30,
  title: 24,
  welcomeTitle: 80,
  welcomeMessage: 2000,
  welcomeFrom: 60,
  /** The Story's intro or closing: one paragraph on a card. */
  storyText: 500,
  username: 40,
  botName: 30,
  bots: 8,
  /** Opening books one bot may carry. */
  booksPerBot: 3,
  /**
   * One book's text, in characters (about 7,000 book moves; parsing one took 10-19 ms in Node on the laptop). The profile lives in localStorage, whose quota in Safari
   * is about 5 MB; a profile that cannot be written is lost at the next start-up, so the books stay well under it.
   */
  bookChars: 500_000,
  /** All books of all bots together, in characters. */
  booksTotalChars: 1_500_000,
  /** Books by reference (the `books` table): names a bot may list in `bookRefs`. */
  bookRefsPerBot: 3,
  /** One table book's text, in characters (kept in the database, not in localStorage). */
  bookTableChars: 3_000_000,
  /** All table books together, in characters. */
  bookTableTotalChars: 6_000_000,
  /** The longest name of a table book. */
  bookName: 32,
} as const;

/** A table book's name: lower-case letters, digits and hyphens (it becomes part of a database key). */
export const BOOK_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
export const isBookName = (value: unknown): value is string =>
  typeof value === 'string' && value.length <= PRESET_LIMITS.bookName && BOOK_NAME_PATTERN.test(value);

/** The time classes a bot may have its own rating and book for (the Play screen's Time chips make one of these). */
export const BOT_CLASSES = ['bullet', 'blitz', 'rapid'] as const;
export type BotClass = (typeof BOT_CLASSES)[number];

/** What one time class changes about a bot: its rating and the books it refers to. */
export interface BotClassEntry {
  rating: number;
  /** 1 to 3 names of books in the preset's `books` table, tried in order; absent: the bot's own `bookRefs`. */
  bookRefs?: string[];
}

/** A bot with a name of its own: the usual bot at this rating and style, optionally opening with its own books. */
export interface CustomBot {
  name: string;
  /** For a bot with `classes` this is the Rapid rating: the default, and what an older app plays. */
  rating: number;
  style: BotStyleId;
  /** 1 to 3 opening books (`serializeBook` text), tried in order; absent when the bot has none. */
  books?: string[];
  /** 1 to 3 names of books in the preset's `books` table (kept in the database), tried after `books`; absent when none. */
  bookRefs?: string[];
  /**
   * One bot whose rating and book follow the time class of the game: the Bullet, Blitz or Rapid rating (and book
   * references) when the Play screen's Time chip makes that class. A class that is missing plays as the bot's own
   * rating and `bookRefs` (the Rapid values). Absent for an ordinary bot.
   */
  classes?: Partial<Record<BotClass, BotClassEntry>>;
}

export interface WelcomeMessage {
  title: string;
  /** Plain text; a blank line starts a new paragraph. */
  message: string;
  from: string;
}

/** The optional paragraphs on the Story's first and last cards. Plain text, never read for numbers. */
export interface StoryText {
  intro: string;
  closing: string;
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
  /** Absent when the preset has no story text. */
  story?: StoryText;
  /** Only the settings the preset names; everything else keeps its value. */
  settings: AppSettingsPatch;
  usernames: PresetUsernames | null;
  bots: CustomBot[];
  /** The books table (name to book text): only the books some bot refers to. Absent when there are none. */
  books?: Record<string, string>;
  /**
   * A number that only goes up when the bot list changes. An app that already applied a preset takes a newer list
   * (bots and their books only) when its number is higher than the one stored with the profile. Absent: 0.
   */
  botsRevision?: number;
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

/**
 * A bot's books: text, at most `booksPerBot`, each at most `bookChars` long, all bots' together at most
 * `booksTotalChars` (`budget` is what is left). With `checkBooks` each must also read as a book (`parseBook`). Whatever
 * fails is left out and the bot keeps the rest, or plays as the usual bot of its rating and style. The problems name
 * the place only, never the content.
 */
function parseBotBooks(
  value: unknown,
  where: string,
  problems: string[],
  budget: { left: number },
  checkBooks: boolean,
): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    problems.push(`${where}books: must be a list (ignored; the bot plays without a book)`);
    return [];
  }
  const books: string[] = [];
  value.forEach((book: unknown, j) => {
    const at = `${where}books[${j}]`;
    if (books.length >= PRESET_LIMITS.booksPerBot) {
      problems.push(`${at}: more than ${PRESET_LIMITS.booksPerBot} books for one bot (ignored)`);
    } else if (typeof book !== 'string') {
      problems.push(`${at}: must be text (ignored)`);
    } else if (book.length > PRESET_LIMITS.bookChars) {
      problems.push(`${at}: longer than ${PRESET_LIMITS.bookChars} characters (ignored)`);
    } else if (book.length > budget.left) {
      problems.push(
        `${at}: the books of all bots together are over ${PRESET_LIMITS.booksTotalChars} characters (ignored)`,
      );
    } else if (checkBooks && !parseBook(book)) {
      problems.push(`${at}: not a valid opening book (ignored)`);
    } else {
      budget.left -= book.length;
      books.push(book);
    }
  });
  return books;
}

/**
 * A bot's `bookRefs`: names, at most `bookRefsPerBot`, each a valid book name. With `bookNames` (the preset's own table)
 * a name that is not in it is dropped too; the stored profile has no table at hand (the books are in the database), so
 * it only checks the form. A bot left with no valid name is still a bot.
 */
function parseBookRefs(
  value: unknown,
  where: string,
  problems: string[],
  bookNames: ReadonlySet<string> | undefined,
): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    problems.push(`${where}bookRefs: must be a list (ignored; the bot plays without those books)`);
    return [];
  }
  const refs: string[] = [];
  value.forEach((ref: unknown, j) => {
    const at = `${where}bookRefs[${j}]`;
    if (!isBookName(ref)) problems.push(`${at}: not a book name (ignored)`);
    else if (bookNames && !bookNames.has(ref)) problems.push(`${at}: no book of that name in books (ignored)`);
    else if (refs.includes(ref)) problems.push(`${at}: listed twice (ignored)`);
    else if (refs.length >= PRESET_LIMITS.bookRefsPerBot)
      problems.push(`${at}: more than ${PRESET_LIMITS.bookRefsPerBot} book references for one bot (ignored)`);
    else refs.push(ref);
  });
  return refs;
}

/**
 * The preset's `books` table: name to book text. A book is kept when its name is valid, its text is at most
 * `bookTableChars` long, the table stays within `bookTableTotalChars`, and (with `checkBooks`) it reads as a book
 * (`parseBook`, a second full parse of the text). Whatever fails is left out; the problems name the place only, never
 * the content.
 */
function parseBookTable(value: unknown, problems: string[], checkBooks: boolean): Record<string, string> {
  const table: Record<string, string> = {};
  if (value === undefined) return table;
  if (!isObject(value)) {
    problems.push('books: must be an object (name to book)');
    return table;
  }
  let left: number = PRESET_LIMITS.bookTableTotalChars;
  for (const [name, text] of Object.entries(value)) {
    const at = `books[${JSON.stringify(name.slice(0, 40))}]`;
    if (!isBookName(name)) problems.push(`${at}: not a book name (ignored)`);
    else if (typeof text !== 'string') problems.push(`${at}: must be text (ignored)`);
    else if (text.length > PRESET_LIMITS.bookTableChars)
      problems.push(`${at}: longer than ${PRESET_LIMITS.bookTableChars} characters (ignored)`);
    else if (text.length > left)
      problems.push(`${at}: the books table is over ${PRESET_LIMITS.bookTableTotalChars} characters (ignored)`);
    else if (checkBooks && !parseBook(text)) problems.push(`${at}: not a valid opening book (ignored)`);
    else {
      left -= text.length;
      table[name] = text;
    }
  }
  return table;
}

/** Every rating a bot plays at: its own (the Rapid one) and each class's. */
export function botRatings(bot: CustomBot): number[] {
  const ratings = [bot.rating];
  for (const cls of BOT_CLASSES) {
    const entry = bot.classes?.[cls];
    if (entry) ratings.push(entry.rating);
  }
  return ratings;
}

/**
 * A bot's `classes`: for each of Bullet, Blitz and Rapid a rating (a whole number from 400 to 2400) and optionally
 * `bookRefs`. A class that is wrong is left out and reported, and the bot plays that class as its own rating. A class
 * rating that is another bot's rating (any class of it) is left out too: the Play screen finds a bot by rating, so it
 * would be ambiguous. Giving two classes of the same bot the same rating (or its own rating) is fine.
 */
function parseBotClasses(
  value: unknown,
  where: string,
  problems: string[],
  bookNames: ReadonlySet<string> | undefined,
  takenByOthers: ReadonlySet<number>,
): CustomBot['classes'] {
  if (value === undefined) return undefined;
  if (!isObject(value)) {
    problems.push(`${where}classes: must be an object (ignored; the bot plays as one bot)`);
    return undefined;
  }
  noteUnknownKeys(value, BOT_CLASSES, `${where}classes.`, problems);
  const classes: Partial<Record<BotClass, BotClassEntry>> = {};
  for (const cls of BOT_CLASSES) {
    const entry = value[cls];
    if (entry === undefined) continue;
    const at = `${where}classes.${cls}.`;
    if (!isObject(entry)) {
      problems.push(`${at.slice(0, -1)}: must be an object (ignored)`);
      continue;
    }
    noteUnknownKeys(entry, ['rating', 'bookRefs'], at, problems);
    if (typeof entry.rating !== 'number' || clampBotRating(entry.rating) !== entry.rating) {
      problems.push(`${at}rating: must be a whole number from 400 to 2400 (class ignored)`);
      continue;
    }
    if (takenByOthers.has(entry.rating)) {
      problems.push(`${at}rating: the same rating as another bot (class ignored)`);
      continue;
    }
    const bookRefs = parseBookRefs(entry.bookRefs, at, problems, bookNames);
    classes[cls] = { rating: entry.rating, ...(bookRefs.length > 0 ? { bookRefs } : {}) };
  }
  return Object.keys(classes).length > 0 ? classes : undefined;
}

/**
 * Custom bots from a preset or a stored profile: named, in range, no two the same bot. Two bots with the same rating
 * and style would be the same bot to the Play screen (it finds a bot by rating and prefers the style that matches,
 * `namedBotForRating`), so a later one is left out even when its books differ. `checkBooks` parses every book (a preset, read once); the stored profile is read
 * at every start-up and its books are parsed only when the bot plays (`customBotBooks`).
 */
export function parseBots(
  value: unknown,
  problems: string[] = [],
  { checkBooks = false, bookNames }: { checkBooks?: boolean; bookNames?: ReadonlySet<string> } = {},
): CustomBot[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    problems.push('bots: must be a list');
    return [];
  }
  const styles = Object.keys(BOT_STYLE_PRESETS) as BotStyleId[];
  const bots: CustomBot[] = [];
  const budget = { left: PRESET_LIMITS.booksTotalChars };
  value.forEach((entry: unknown, i) => {
    const where = `bots[${i}].`;
    if (!isObject(entry)) {
      problems.push(`bots[${i}]: must be an object`);
      return;
    }
    noteUnknownKeys(entry, ['name', 'rating', 'style', 'books', 'bookRefs', 'classes'], where, problems);
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
    const takenByOthers = new Set(bots.flatMap(botRatings));
    // A rating an earlier bot plays at in one of its classes is that bot's, whatever the style
    if (bots.some((b) => b.classes && botRatings(b).includes(entry.rating as number))) {
      problems.push(`${where.slice(0, -1)}: the same rating as a class of an earlier bot (ignored)`);
      return;
    }
    if (bots.length >= PRESET_LIMITS.bots) {
      problems.push(`${where.slice(0, -1)}: more than ${PRESET_LIMITS.bots} bots (ignored)`);
      return;
    }
    const books = parseBotBooks(entry.books, where, problems, budget, checkBooks);
    const bookRefs = parseBookRefs(entry.bookRefs, where, problems, bookNames);
    const classes = parseBotClasses(entry.classes, where, problems, bookNames, takenByOthers);
    bots.push({
      name,
      rating: entry.rating,
      style: style as BotStyleId,
      ...(books.length > 0 ? { books } : {}),
      ...(bookRefs.length > 0 ? { bookRefs } : {}),
      ...(classes ? { classes } : {}),
    });
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

/** One paragraph for a Story card: cleaned like the welcome, on one line, cut at the limit. Null when there is none. */
export function parseStoryText(value: unknown, problems: string[] = []): StoryText | null {
  if (value === undefined || value === null) return null;
  if (!isObject(value)) {
    problems.push('story: must be an object');
    return null;
  }
  noteUnknownKeys(value, ['intro', 'closing'], 'story.', problems);
  const story: StoryText = {
    intro: textField(value, 'intro', 'story.', PRESET_LIMITS.storyText, problems),
    closing: textField(value, 'closing', 'story.', PRESET_LIMITS.storyText, problems),
  };
  return story.intro || story.closing ? story : null;
}

/** The bot list's revision: a whole number from 0 up (a wrong value is reported and counts as 0). */
export function parseBotsRevision(value: unknown, problems: string[] = []): number {
  if (value === undefined) return 0;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    problems.push('botsRevision: must be a whole number, 0 or more (ignored)');
    return 0;
  }
  return value;
}

/**
 * Checks a preset file's content. The app uses whatever is valid and ignores the rest.
 *
 * `checkTableBooks` (default true: the first run reads every book of the table, once) is false for the bots-only update
 * (`checkBotsUpdate`): the books table is then checked for names, text and sizes only. A table book is parsed and
 * checked again whenever a bot uses it (`awaitBotBooks`), and one that is not a book then gives a bot without books, so
 * the update need not parse several megabytes of book text in one task.
 */
export function parsePreset(
  input: unknown,
  { checkTableBooks = true }: { checkTableBooks?: boolean } = {},
): ParsedPreset {
  const problems: string[] = [];
  if (!isObject(input)) return { preset: null, problems: ['not a preset (a JSON object is expected)'] };
  if (input.version !== PRESET_VERSION) {
    return { preset: null, problems: [`version: this app reads version ${PRESET_VERSION} presets`] };
  }
  noteUnknownKeys(
    input,
    ['version', 'appName', 'profile', 'welcome', 'story', 'settings', 'usernames', 'bots', 'books', 'botsRevision'],
    '',
    problems,
  );

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

  const story = parseStoryText(input.story, problems);
  const table = parseBookTable(input.books, problems, checkTableBooks);
  const bots = parseBots(input.bots, problems, { checkBooks: true, bookNames: new Set(Object.keys(table)) });
  // A table book no bot refers to would only take room in the database
  const used = new Set(
    bots.flatMap((bot) => [
      ...(bot.bookRefs ?? []),
      ...BOT_CLASSES.flatMap((cls) => bot.classes?.[cls]?.bookRefs ?? []),
    ]),
  );
  const books: Record<string, string> = {};
  for (const [name, text] of Object.entries(table)) {
    if (used.has(name)) books[name] = text;
    else problems.push(`books[${JSON.stringify(name)}]: no bot refers to it (left out)`);
  }
  const botsRevision = parseBotsRevision(input.botsRevision, problems);
  return {
    preset: {
      version: PRESET_VERSION,
      appName: textField(input, 'appName', '', PRESET_LIMITS.appName, problems),
      displayName,
      title,
      welcome: parseWelcome(input.welcome, problems),
      ...(story ? { story } : {}),
      settings: parseSettings(input.settings, problems),
      usernames,
      bots,
      ...(Object.keys(books).length > 0 ? { books } : {}),
      ...(botsRevision > 0 ? { botsRevision } : {}),
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
