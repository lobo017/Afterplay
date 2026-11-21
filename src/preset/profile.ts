import type { BotStyleId } from '../engine/bot';
import { parseBook, type Book } from '../engine/bot-profile';
import type { FeelStorage } from '../render/board-feel';
import {
  PRESET_LIMITS,
  botRatings,
  cleanText,
  parseBots,
  parseBotsRevision,
  parseStoryText,
  parseWelcome,
  type BotClass,
  type CustomBot,
  type StoryText,
  type WelcomeMessage,
} from './preset';

/**
 * Who uses this copy of the app and what it is called: a display name and title (shown in Play and written into the
 * PGN of games played here), the app's name (page title, Home Screen), bots with names of their own, and a welcome
 * message. Empty by default; a preset fills it (first-run.ts) and Settings › Profile edits the name and title.
 */
export interface Profile {
  displayName: string;
  title: string;
  appName: string;
  bots: CustomBot[];
  welcome: WelcomeMessage | null;
  /** The optional intro and closing paragraphs of the Chess Story; absent when there are none. */
  story?: StoryText;
  /** The `botsRevision` of the bot list this profile holds (see Preset); absent: 0. */
  botsRevision?: number;
}

export const EMPTY_PROFILE: Readonly<Profile> = Object.freeze({
  displayName: '',
  title: '',
  appName: '',
  bots: [],
  welcome: null,
});

/** The app's own name, used wherever the profile names none. */
export const DEFAULT_APP_NAME = 'Afterplay';

/** A welcome text names the app with {appName}: the preset's app name, or the app's own when the preset has none. */
export function welcomeWithAppName(welcome: WelcomeMessage, appName: string): WelcomeMessage {
  const name = appName || DEFAULT_APP_NAME;
  const fill = (text: string): string => text.split('{appName}').join(name);
  return { ...welcome, title: fill(welcome.title), message: fill(welcome.message) };
}

/** Where the profile lives on this device (read synchronously at start-up, so the first frame has the names). */
export const PROFILE_STORAGE_KEY = 'wc.profile.v1';

/** Fills in and cleans every field; anything malformed falls back to empty. */
export function sanitizeProfile(input: unknown): Profile {
  const src = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const story = parseStoryText(src.story ?? null);
  const botsRevision = parseBotsRevision(src.botsRevision);
  return {
    displayName: cleanText(src.displayName, PRESET_LIMITS.displayName),
    title: cleanText(src.title, PRESET_LIMITS.title),
    appName: cleanText(src.appName, PRESET_LIMITS.appName),
    bots: parseBots(src.bots ?? []),
    welcome: parseWelcome(src.welcome ?? null),
    ...(story ? { story } : {}),
    ...(botsRevision > 0 ? { botsRevision } : {}),
  };
}

/**
 * The custom bot that a rating and style are, if any. Unambiguous: `parseBots` keeps no two bots with the same rating
 * and style, books or not.
 */
export function customBotFor(profile: Profile, rating: number, style: BotStyleId): CustomBot | null {
  return profile.bots.find((bot) => bot.rating === rating && bot.style === style) ?? null;
}

/**
 * The named bot for a rating: the one with that rating and style, else the first with that rating. A bot keeps its name
 * when the style changes; the style is only a suffix.
 */
export function namedBotForRating(profile: Profile, rating: number, style: BotStyleId): CustomBot | null {
  return (
    customBotFor(profile, rating, style) ??
    // A bot with classes is also found by the rating of any of its classes (`parseBots` keeps those unambiguous)
    profile.bots.find((bot) => botRatings(bot).includes(rating)) ??
    null
  );
}

/**
 * The bot as it plays in a time class: that class's rating and book references. A bot without classes, or without an
 * entry for this class, is returned as it is (its own rating and books are the Rapid, the default, ones); a class
 * without `bookRefs` keeps the bot's own. The result is what `awaitBotBooks` and `warmBotBooks` take, so they need to
 * know nothing about classes.
 */
export function resolveBotForClass(bot: CustomBot, botClass: BotClass): CustomBot {
  const entry = bot.classes?.[botClass];
  if (!entry) return bot;
  const resolved: CustomBot = { ...bot, rating: entry.rating };
  const bookRefs = entry.bookRefs ?? bot.bookRefs;
  if (bookRefs) resolved.bookRefs = bookRefs;
  return resolved;
}

/** The bots lowest rating first (a tie keeps the list's order), each with its place in the profile's list. */
export function botsByRating(bots: readonly CustomBot[]): Array<{ bot: CustomBot; index: number }> {
  return bots.map((bot, index) => ({ bot, index })).sort((a, b) => a.bot.rating - b.bot.rating || a.index - b.index);
}

/** Parsed books by their text, for the session (null: the text is not a book). */
const parsedBooks = new Map<string, Book | null>();
const MAX_PARSED_BOOKS = PRESET_LIMITS.bots * PRESET_LIMITS.booksPerBot;

/**
 * A custom bot's opening books, in order, parsed the first time they are asked for and kept for the session. A text
 * that does not parse is left out without a word (the bot then plays as the usual bot); none gives an empty list.
 */
export function customBotBooks(bot: CustomBot): Book[] {
  if (!bot.books || bot.books.length === 0) return [];
  const books: Book[] = [];
  for (const text of bot.books) {
    const book = parsedBook(text);
    if (book) books.push(book);
  }
  return books;
}

/** One book's text parsed once per session (null when it is not a book). */
function parsedBook(text: string): Book | null {
  let book = parsedBooks.get(text);
  if (book === undefined) {
    book = parseBook(text);
    if (parsedBooks.size >= MAX_PARSED_BOOKS) parsedBooks.clear();
    parsedBooks.set(text, book);
  }
  return book;
}

/** Runs `task` in an idle moment of the page: requestIdleCallback (within 2 s at the latest), else a zero-delay timer. */
export function scheduleIdle(task: () => void): void {
  const idle = (globalThis as { requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number })
    .requestIdleCallback;
  if (typeof idle === 'function') idle.call(globalThis, task, { timeout: 2000 });
  else setTimeout(task, 0);
}

/**
 * Parses a custom bot's books ahead of its first book move, each in an idle moment of its own (one book is about
 * 10-20 ms of parsing), so the move does not wait for it. A book already parsed is not parsed again, and the books are
 * still parsed on demand by `customBotBooks` if the bot moves first.
 */
export function warmBotBooks(
  bot: CustomBot | null,
  schedule: (task: () => void) => void = scheduleIdle,
  load?: BookTextLoader,
): void {
  if (!bot) return;
  for (const text of new Set(bot.books ?? [])) {
    if (parsedBooks.has(text)) continue;
    schedule(() => {
      parsedBook(text);
    });
  }
  // Books by reference: read from the database and parsed, each in an idle moment, kept by name for the session
  if (load) {
    for (const name of bot.bookRefs ?? []) {
      if (refBooks.has(name)) continue;
      schedule(() => {
        void loadRefBook(name, load);
      });
    }
  }
}

/** Forgets the parsed books (for tests). */
export function clearParsedBooks(): void {
  parsedBooks.clear();
  refBooks.clear();
}

// ---------------------------------------------------------------------------------------- books by reference

/** The text of the book a preset brought under this name (the database; null when there is none or it cannot be read). */
export type BookTextLoader = (name: string) => Promise<string | null>;

/** The longest the first move of a bot waits for its books to load; after that it plays as the usual bot. */
export const BOOK_LOAD_TIMEOUT_MS = 1500;

/** Books by name for the session, once their load has started. A load that finds no book is forgotten (see below). */
const refBooks = new Map<string, Promise<Book | null>>();

/**
 * The book of this name: read, parsed and kept for the session. A load that finds nothing is not kept: the first run
 * writes the books a moment after it starts, so a game begun in that moment must be able to find them later. A text that
 * is not a book, and a read that fails, both give null (no book, no crash).
 */
function loadRefBook(name: string, load: BookTextLoader): Promise<Book | null> {
  let pending = refBooks.get(name);
  if (!pending) {
    pending = Promise.resolve()
      .then(() => load(name))
      .then((text) => (typeof text === 'string' ? parseBook(text) : null))
      .catch(() => null)
      .then((book) => {
        if (book === null && refBooks.get(name) === pending) refBooks.delete(name);
        return book;
      });
    refBooks.set(name, pending);
  }
  return pending;
}

/**
 * A custom bot's books for its next move: its own inline books, then the books it refers to. A referenced book that has
 * not loaded yet is waited for at most `timeoutMs`; after that the bot goes on with the books it has (none: the usual
 * bot), and the load finishes in the background for its next move. Never throws.
 */
export async function awaitBotBooks(
  bot: CustomBot | null,
  load?: BookTextLoader,
  timeoutMs: number = BOOK_LOAD_TIMEOUT_MS,
): Promise<Book[]> {
  if (!bot) return [];
  const inline = customBotBooks(bot);
  const names = bot.bookRefs ?? [];
  if (names.length === 0 || !load) return inline;
  const loaded: (Book | null | undefined)[] = names.map(() => undefined);
  const loads = Promise.all(
    names.map((name, i) =>
      loadRefBook(name, load).then((book) => {
        loaded[i] = book;
      }),
    ),
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, Math.max(0, timeoutMs));
  });
  try {
    await Promise.race([loads, timeout]);
  } finally {
    clearTimeout(timer);
  }
  return [...inline, ...loaded.filter((book): book is Book => book !== null && book !== undefined)];
}

/**
 * The opening books of the named bot for this rating and style (empty when there is no such bot or it has none). The bot
 * is found as the Play screen finds it, by rating (`namedBotForRating`), so its books stay with it when the style changes.
 */
export function personalBooksFor(profile: Profile, rating: number, style: BotStyleId): Book[] {
  const bot = namedBotForRating(profile, rating, style);
  return bot ? customBotBooks(bot) : [];
}

/** The same profile without any bot's inline books (the names of its referenced books are small and stay). */
function withoutBooks(profile: Profile): Profile {
  return {
    ...profile,
    bots: profile.bots.map(({ name, rating, style, bookRefs, classes }) => ({
      name,
      rating,
      style,
      ...(bookRefs ? { bookRefs } : {}),
      ...(classes ? { classes } : {}),
    })),
  };
}

function localStore(): FeelStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export class ProfileStore {
  private value: Profile;
  private readonly listeners = new Set<(profile: Profile, previous: Profile) => void>();

  constructor(private readonly storage: FeelStorage | null = localStore()) {
    this.value = this.load();
  }

  private load(): Profile {
    try {
      const raw = this.storage?.getItem(PROFILE_STORAGE_KEY);
      return raw ? sanitizeProfile(JSON.parse(raw)) : sanitizeProfile(null);
    } catch {
      return sanitizeProfile(null);
    }
  }

  public get(): Readonly<Profile> {
    return this.value;
  }

  public set(patch: Partial<Profile>): void {
    this.replace({ ...this.value, ...patch });
  }

  /** Replaces everything (a preset, a restore); missing fields become empty. */
  public replace(next: unknown): void {
    const previous = this.value;
    this.value = sanitizeProfile(next);
    try {
      this.storage?.setItem(PROFILE_STORAGE_KEY, JSON.stringify(this.value));
    } catch {
      // Storage full or blocked: the profile still applies until the page closes. Books are the only large part, so
      // the profile is kept without them rather than lost (the old one would come back at the next start-up)
      if (this.value.bots.some((bot) => bot.books)) {
        try {
          this.storage?.setItem(PROFILE_STORAGE_KEY, JSON.stringify(withoutBooks(this.value)));
        } catch {
          // Blocked altogether: nothing more to try
        }
      }
    }
    for (const listener of this.listeners) listener(this.value, previous);
  }

  public subscribe(listener: (profile: Profile, previous: Profile) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
