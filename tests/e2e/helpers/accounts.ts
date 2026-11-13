import type { Page } from '@playwright/test';

/**
 * My usernames in the tests. The app has no built-in account (src/review/perspective.ts, DEFAULT_USER_ACCOUNTS is
 * empty): a test whose game is "mine" saves the name first, as Settings › Your games, a preset or the capture
 * extension would.
 */
export const MY_LICHESS = 'Lobo017';

/**
 * Saves my usernames in the open app, and waits until they are stored. Call it before a game of mine is imported or
 * reviewed: a game's "my color" is worked out when it is stored and shown, and a review's side when it opens.
 */
export async function saveMyAccounts(
  page: Page,
  accounts: { lichess?: string; chesscom?: string } = { lichess: MY_LICHESS },
): Promise<void> {
  await page.evaluate(async (mine) => {
    const api = (await window.__wizardChessLibraryReady)!;
    await api.library.setMyAccounts({ lichess: mine.lichess ?? '', chesscom: mine.chesscom ?? '' });
  }, accounts);
}
