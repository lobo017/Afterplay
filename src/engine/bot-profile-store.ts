import { parseBook, serializeBook, type Book } from './bot-profile';

/**
 * Where the personal bots' data lives: the settings store, one key per book, as the book's JSON text (a string, so a
 * backup file holds it compactly and a restore puts the same text back). No database version change.
 *
 * The three books of the personal bots are "me" (all of the user's games), "peak" (the games near the user's best
 * rating) and "student" (the opponents' moves, or another person's games).
 */
export const BOT_BOOK_NAMES = ['me', 'peak', 'student'] as const;
export type BotBookName = (typeof BOT_BOOK_NAMES)[number];

export const botBookKey = (name: BotBookName): string => `bots.book.${name}`;

/**
 * Every settings key this feature writes. `resetBotData` deletes exactly these: the settings store cannot list its keys,
 * so a `bots.*` key added later has to be added here (the unit test checks the book keys are in it).
 */
export const BOT_SETTING_KEYS: readonly string[] = BOT_BOOK_NAMES.map(botBookKey);

/** What these helpers need of the settings store: `GameLibrary` has all three (`readSetting`, `writeSetting`, `deleteSetting`). */
export interface BotSettingsStore {
  readSetting<T>(key: string): Promise<T | undefined>;
  writeSetting<T>(key: string, value: T): Promise<void>;
  deleteSetting(key: string): Promise<void>;
}

export function saveBook(store: BotSettingsStore, name: BotBookName, book: Book): Promise<void> {
  return store.writeSetting<string>(botBookKey(name), serializeBook(book));
}

/** The stored book, or null when there is none or the stored text is not a valid book. */
export async function loadBook(store: BotSettingsStore, name: BotBookName): Promise<Book | null> {
  const value = await store.readSetting<unknown>(botBookKey(name));
  return typeof value === 'string' ? parseBook(value) : null;
}

/**
 * Forgets everything the personal bots learned: deletes every `BOT_SETTING_KEYS` row.
 *
 * Restoring a backup writes its rows over the same keys but never deletes a row that is not in the backup, so a backup
 * made before a reset brings its books back, and a restore does not remove books that are only on the device.
 */
export async function resetBotData(store: Pick<BotSettingsStore, 'deleteSetting'>): Promise<void> {
  for (const key of BOT_SETTING_KEYS) await store.deleteSetting(key);
}

// ---------------------------------------------------------------------------------------------- books from a preset

/**
 * Books that arrive with a preset (its `books` table) are kept one settings row each, as the book's JSON text, under
 * `bots.preset.<name>`. This namespace is NOT in `BOT_SETTING_KEYS`: `resetBotData` forgets what the app learned from the
 * user's own games, not the books the preset brought, which cannot be rebuilt on the device. A backup carries the rows.
 */
export const PRESET_BOOK_KEY_PREFIX = 'bots.preset.';
export const presetBookKey = (name: string): string => `${PRESET_BOOK_KEY_PREFIX}${name}`;

/** What reading a preset book needs of the settings store. */
export type PresetBookReader = Pick<BotSettingsStore, 'readSetting'>;

/**
 * Writes the preset's books, one row each, one after the other. A write that fails leaves that book out and the others
 * go on: the first run must never fail because of a book. Returns the names that were written; nothing is logged (the
 * names are all the caller needs, and a book is never printed).
 */
export async function savePresetBooks(
  store: Pick<BotSettingsStore, 'writeSetting'>,
  books: Readonly<Record<string, string>>,
): Promise<string[]> {
  const written: string[] = [];
  for (const [name, text] of Object.entries(books)) {
    try {
      await store.writeSetting<string>(presetBookKey(name), text);
      written.push(name);
    } catch {
      // Storage full or blocked: this bot plays without that book
    }
  }
  return written;
}

/** The text of a stored preset book, or null when there is none, it is not text, or the store could not be read. */
export async function readPresetBookText(store: PresetBookReader, name: string): Promise<string | null> {
  try {
    const value = await store.readSetting<unknown>(presetBookKey(name));
    return typeof value === 'string' ? value : null;
  } catch {
    return null;
  }
}
