import { beforeEach, describe, expect, it } from 'vitest';
import { installIndexedDBPolyfill } from './helpers/indexeddb-polyfill';
installIndexedDBPolyfill();

import { buildBook, serializeBook } from '../../src/engine/bot-profile';
import {
  BOT_BOOK_NAMES,
  BOT_SETTING_KEYS,
  botBookKey,
  loadBook,
  resetBotData,
  saveBook,
} from '../../src/engine/bot-profile-store';
import { GameLibrary } from '../../src/library/library';
import { WizardChessStorage, deleteWizardChessDB } from '../../src/storage/db';
import { playout, record } from './helpers/book-games';

const DB = 'wizards-chess-bot-books-test';

async function open() {
  const storage = await WizardChessStorage.create({ dbName: DB });
  const library = new GameLibrary(storage);
  await library.init();
  return { storage, library };
}

const sampleBook = (seed: number) => buildBook([record(playout([], 16, seed))], { side: 'own', pliesCap: 16 }).book;

describe('bot-profile-store: books in the settings store', () => {
  beforeEach(async () => {
    await deleteWizardChessDB(DB);
  });

  it('saves a book as JSON text under bots.book.<name> and loads it back', async () => {
    const { storage, library } = await open();
    const book = sampleBook(1);
    expect(await loadBook(library, 'me')).toBeNull();
    await saveBook(library, 'me', book);
    expect(await storage.getSetting<string>('bots.book.me')).toBe(serializeBook(book));
    expect(await loadBook(library, 'me')).toEqual(book);
    expect(await loadBook(library, 'peak')).toBeNull();
    expect(storage.version).toBe(4); // no schema change
    storage.close();
  });

  it('loads null for a stored value that is not a valid book', async () => {
    const { storage, library } = await open();
    await library.writeSetting('bots.book.me', 'not a book');
    await library.writeSetting('bots.book.peak', { v: 1, pliesCap: 4, entries: {} });
    await library.writeSetting('bots.book.student', 42);
    for (const name of BOT_BOOK_NAMES) expect(await loadBook(library, name)).toBeNull();
    storage.close();
  });

  it('deleteSetting removes one row, and removing a missing row is harmless', async () => {
    const { storage, library } = await open();
    await library.writeSetting('a', 1);
    await library.writeSetting('b', 2);
    await library.deleteSetting('a');
    await library.deleteSetting('never-set');
    expect(await storage.getAllSettings()).toEqual({ b: 2 });
    await storage.deleteSetting('b');
    expect(await storage.getAllSettings()).toEqual({});
    storage.close();
  });

  it('resetBotData deletes the books and nothing else', async () => {
    expect(BOT_SETTING_KEYS).toEqual(BOT_BOOK_NAMES.map(botBookKey));
    expect(BOT_SETTING_KEYS.every((key) => key.startsWith('bots.'))).toBe(true);
    const { storage, library } = await open();
    await library.writeSetting('boardTheme', 'green');
    for (const [i, name] of BOT_BOOK_NAMES.entries()) await saveBook(library, name, sampleBook(i + 1));
    await resetBotData(library);
    for (const name of BOT_BOOK_NAMES) expect(await loadBook(library, name)).toBeNull();
    expect(await storage.getAllSettings()).toEqual({ boardTheme: 'green' });
    await resetBotData(library); // nothing left to delete: still fine
    storage.close();
  });

  it('a restored backup overwrites rows with the same key and never deletes the others', async () => {
    const { storage, library } = await open();
    const old = sampleBook(1);
    await saveBook(library, 'me', old);
    const backup = await storage.exportBackupJson();
    expect(backup).toContain('bots.book.me');

    await saveBook(library, 'me', sampleBook(2));
    await saveBook(library, 'peak', sampleBook(3));
    await storage.importBackupJson(backup);
    expect(await loadBook(library, 'me')).toEqual(old); // overwritten by the backup's row
    expect(await loadBook(library, 'peak')).toEqual(sampleBook(3)); // not in the backup, so kept

    await resetBotData(library);
    await storage.importBackupJson(backup);
    expect(await loadBook(library, 'me')).toEqual(old); // a backup made before the reset brings the book back
    expect(await loadBook(library, 'peak')).toBeNull();
    storage.close();
  });
});
