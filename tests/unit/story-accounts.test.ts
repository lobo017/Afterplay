import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installIndexedDBPolyfill } from './helpers/indexeddb-polyfill';
installIndexedDBPolyfill();

import { accountsFromSettings, myColor } from '../../src/library/game-record';
import { GameLibrary } from '../../src/library/library';
import { WizardChessStorage, deleteWizardChessDB } from '../../src/storage/db';

const DB = 'wizards-chess-story-accounts-test';

async function open() {
  const storage = await WizardChessStorage.create({ dbName: DB });
  const library = new GameLibrary(storage);
  await library.init();
  return { storage, library };
}

describe('library.moreAccounts', () => {
  beforeEach(async () => {
    await deleteWizardChessDB(DB);
  });
  afterEach(async () => {
    await deleteWizardChessDB(DB);
  });

  it('starts empty and leaves myAccounts as the first account per site', async () => {
    const { library, storage } = await open();
    expect(library.getMoreAccounts()).toEqual([]);
    await library.setMyAccounts({ lichess: '', chesscom: 'first_cc' });
    await library.setMoreAccounts([{ site: 'chesscom', username: 'second_cc' }]);
    expect(library.getMyAccounts()).toEqual({ lichess: '', chesscom: 'first_cc' });
    expect(await storage.getSetting('library.myAccounts')).toEqual({ lichess: '', chesscom: 'first_cc' });
    expect(await storage.getSetting('library.moreAccounts')).toEqual([{ site: 'chesscom', username: 'second_cc' }]);
    storage.close();
  });

  it('returns both from getUserAccounts, the first accounts first, and keeps them after a reopen', async () => {
    const { library, storage } = await open();
    await library.setMyAccounts({ lichess: 'li_one', chesscom: 'cc_one' });
    await library.setMoreAccounts([
      { site: 'chesscom', username: 'cc_two' },
      { site: 'lichess', username: 'li_two' },
    ]);
    const expected = [
      { site: 'lichess', username: 'li_one' },
      { site: 'chesscom', username: 'cc_one' },
      { site: 'chesscom', username: 'cc_two' },
      { site: 'lichess', username: 'li_two' },
    ];
    expect(library.getUserAccounts()).toEqual(expected);
    storage.close();
    const again = await open();
    expect(again.library.getUserAccounts()).toEqual(expected);
    again.storage.close();
  });

  it('marks my side with an added account, on its own site only', () => {
    const accounts = accountsFromSettings({ lichess: '', chesscom: 'cc_one' }, [
      { site: 'chesscom', username: 'CC_Two' },
    ]);
    const game = (white: string, black: string, source: 'chesscom' | 'lichess') => ({ white, black, source });
    expect(myColor(game('cc_two', 'stranger', 'chesscom'), accounts)).toBe('w');
    expect(myColor(game('stranger', 'cc_two', 'chesscom'), accounts)).toBe('b');
    expect(myColor(game('cc_two', 'stranger', 'lichess'), accounts)).toBeNull();
  });

  it('tells the account listeners, only when the list changed', async () => {
    const { library, storage } = await open();
    let calls = 0;
    library.onAccountsChange(() => calls++);
    await library.setMoreAccounts([{ site: 'lichess', username: 'li_two' }]);
    await library.setMoreAccounts([{ site: 'lichess', username: 'li_two' }]);
    expect(calls).toBe(1);
    await library.setMoreAccounts([]);
    expect(calls).toBe(2);
    expect(library.getUserAccounts()).toEqual([]);
    storage.close();
  });

  it('drops blank, repeated and malformed entries', async () => {
    const { library, storage } = await open();
    await library.setMoreAccounts([
      { site: 'chesscom', username: '  ' },
      { site: 'chesscom', username: ' cc_two ' },
      { site: 'chesscom', username: 'CC_TWO' },
      { site: 'other', username: 'x' } as never,
    ]);
    expect(library.getMoreAccounts()).toEqual([{ site: 'chesscom', username: 'cc_two' }]);
    await storage.setSetting('library.moreAccounts', 'garbage');
    await library.reloadAccounts();
    expect(library.getMoreAccounts()).toEqual([]);
    storage.close();
  });

  it('is read again after a restore', async () => {
    const { library, storage } = await open();
    await storage.setSetting('library.moreAccounts', [{ site: 'lichess', username: 'restored' }]);
    await library.reloadAccounts();
    expect(library.getUserAccounts()).toEqual([{ site: 'lichess', username: 'restored' }]);
    storage.close();
  });
});
