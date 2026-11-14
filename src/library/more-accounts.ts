/**
 * "Add another account": the list of accounts added after the first one per site, used by the Story's form and by
 * Settings › Your games. Both draw the same markup and call the same functions, so they cannot disagree.
 * Removing an account only takes its name off the list: its games stay stored and are no longer "mine", so they are
 * not counted (library.ts, `myColor`).
 */
import type { UserAccount } from '../review/perspective';
import { isChessComUsername } from '../sync/chesscom-archive';
import type { GameLibrary } from './library';

export type AccountSite = UserAccount['site'];

export const SITE_NAME: Record<AccountSite, string> = { chesscom: 'Chess.com', lichess: 'Lichess' };
const LICHESS_NAME_MAX = 40;

const escapeHtml = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export type AddAccountResult = { ok: true } | { ok: false; message: string };

/** Adds an account for a site, unless the name is empty, not a valid name there, or already one of mine. */
export async function addMoreAccount(
  library: GameLibrary,
  site: AccountSite,
  rawName: string,
): Promise<AddAccountResult> {
  const name = rawName.trim();
  if (name === '') return { ok: false, message: `Type the ${SITE_NAME[site]} username first.` };
  if (site === 'chesscom' && !isChessComUsername(name)) {
    return { ok: false, message: 'That username does not look right (3 to 25 letters, digits, - or _).' };
  }
  if (site === 'lichess' && name.length > LICHESS_NAME_MAX) {
    return { ok: false, message: `That username is longer than ${LICHESS_NAME_MAX} characters.` };
  }
  const key = name.toLowerCase();
  const mine = library.getMyAccounts();
  const first = (site === 'chesscom' ? mine?.chesscom : mine?.lichess) ?? '';
  const known = [
    first,
    ...library
      .getMoreAccounts()
      .filter((a) => a.site === site)
      .map((a) => a.username),
  ];
  if (known.some((k) => k.trim().toLowerCase() === key)) {
    return { ok: false, message: 'That account is already in your list.' };
  }
  await library.setMoreAccounts([...library.getMoreAccounts(), { site, username: name }]);
  return { ok: true };
}

export async function removeMoreAccount(library: GameLibrary, site: AccountSite, username: string): Promise<void> {
  const key = username.toLowerCase();
  await library.setMoreAccounts(
    library.getMoreAccounts().filter((a) => !(a.site === site && a.username.toLowerCase() === key)),
  );
}

/** The Chess.com accounts to sync, in order: the saved one first, then the added ones; no name twice. */
export function chesscomAccountsOf(library: GameLibrary): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const first = library.getMyAccounts()?.chesscom.trim() ?? '';
  for (const name of [
    first,
    ...library
      .getMoreAccounts()
      .filter((a) => a.site === 'chesscom')
      .map((a) => a.username),
  ]) {
    if (name === '' || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    out.push(name);
  }
  return out;
}

export interface MoreAccountsHtmlOptions {
  /** A prefix for the test ids and ids (the Story's and Settings' lists live on one page). */
  idPrefix: string;
  /** What is typed in the input now. */
  draft?: string;
  /** Why the last "Add" did not work. */
  error?: string;
}

/**
 * The list of added accounts for one site, with Remove, and the input with "Add another account". The page wires
 * clicks on `[data-more-action]` (add, remove) and keeps the draft from `input[data-more-input]`.
 */
export function moreAccountsHtml(
  site: AccountSite,
  accounts: readonly UserAccount[],
  o: MoreAccountsHtmlOptions,
): string {
  const mine = accounts.filter((a) => a.site === site);
  const p = `${o.idPrefix}-${site}`;
  const list = mine.length
    ? `<ul class="wc-more-accounts" data-testid="${p}-list">${mine
        .map(
          (a) =>
            `<li class="wc-more-account" data-testid="${p}-item"><span class="wc-more-account-name">${escapeHtml(a.username)}</span><button type="button" class="wc-btn wc-btn-ghost wc-more-account-remove" data-more-action="remove" data-site="${site}" data-username="${escapeHtml(a.username)}" data-testid="${p}-remove" aria-label="Remove ${escapeHtml(a.username)}">Remove</button></li>`,
        )
        .join('')}</ul>`
    : '';
  return `<div class="wc-more-accounts-block" data-site="${site}">${list}
    <div class="wc-more-accounts-add">
      <input class="wc-input wc-more-accounts-input" type="text" autocomplete="off" autocapitalize="off" spellcheck="false" maxlength="40" placeholder="Another ${SITE_NAME[site]} username" aria-label="Another ${SITE_NAME[site]} username" data-more-input data-site="${site}" data-testid="${p}-input" value="${escapeHtml(o.draft ?? '')}">
      <button type="button" class="wc-btn wc-btn-secondary wc-more-accounts-btn" data-more-action="add" data-site="${site}" data-testid="${p}-add">Add another account</button>
    </div>
    <p class="wc-story-note wc-more-accounts-error" role="alert" data-testid="${p}-error"${o.error ? '' : ' hidden'}>${escapeHtml(o.error ?? '')}</p>
  </div>`;
}
