import { looksLikePgn } from './lichess-session-export';
import type { ExtractContext, ExtractResult, Extractor } from './types';

/**
 * Fallback on a Chess.com game page: the site's own Share → PGN dialog. It opens the
 * dialog, picks the PGN tab, reads the PGN text box and closes the dialog again.
 * Unofficial and the most fragile method: it depends on Chess.com's markup (the selectors
 * below), which this extension can't see change.
 */
export const CHESSCOM_SHARE_METHOD = 'chesscom-share-pgn';

export const SHARE_SELECTORS = {
  button: [
    'button[aria-label="Share"]',
    '[data-cy="share-button"]',
    '.share-button-component',
    'button.share',
    '.icon-font-chess.share',
  ],
  pgnTab: ['[data-tab="pgn"]', '.share-menu-tab-selector-component [data-cy="pgn"]'],
  pgnText: [
    'textarea[name="pgn"]',
    '.share-menu-tab-pgn-textarea',
    'textarea.share-menu-tab-pgn-textarea',
    '[data-cy="share-pgn-textarea"]',
  ],
  close: ['.share-menu-component .icon-font-chess.x', 'button[aria-label="Close"]', '.ui_outside-close-component'],
} as const;

const WAIT_MS = 4000;

function first<T extends Element>(root: ParentNode, selectors: readonly string[]): T | null {
  for (const s of selectors) {
    const el = root.querySelector<T>(s);
    if (el) return el;
  }
  return null;
}

/** A tab or button whose text is exactly "PGN". */
function tabByText(root: ParentNode): HTMLElement | null {
  for (const el of root.querySelectorAll<HTMLElement>('[role="tab"], button, .share-menu-tab-selector-component > *')) {
    if (el.textContent?.trim().toUpperCase() === 'PGN') return el;
  }
  return null;
}

async function waitFor<T>(find: () => T | null, ms: number): Promise<T | null> {
  const start = Date.now();
  for (;;) {
    const v = find();
    if (v) return v;
    if (Date.now() - start > ms) return null;
    await new Promise((r) => setTimeout(r, 100));
  }
}

export const chessComShareExtractor: Extractor = {
  method: CHESSCOM_SHARE_METHOD,
  async extract(ctx: ExtractContext): Promise<ExtractResult> {
    const fail = (reason: string): ExtractResult => ({ ok: false, method: CHESSCOM_SHARE_METHOD, reason });
    const doc = ctx.document;
    if (!doc) return fail('Only works on the game page.');
    let box = first<HTMLTextAreaElement>(doc, SHARE_SELECTORS.pgnText);
    let opened = false;
    if (!box) {
      const share = first<HTMLElement>(doc, SHARE_SELECTORS.button);
      if (!share) return fail('No Share button on the page.');
      share.click();
      opened = true;
      const tab = await waitFor(() => first<HTMLElement>(doc, SHARE_SELECTORS.pgnTab) ?? tabByText(doc), WAIT_MS);
      tab?.click();
      box = await waitFor(() => first<HTMLTextAreaElement>(doc, SHARE_SELECTORS.pgnText), WAIT_MS);
    }
    const text = box?.value ?? box?.textContent ?? '';
    if (opened) {
      const close = first<HTMLElement>(doc, SHARE_SELECTORS.close);
      if (close) close.click();
      else doc.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    }
    if (!box) return fail('The Share dialog has no PGN box.');
    if (!looksLikePgn(text)) return fail('The Share dialog did not show a PGN.');
    return { ok: true, pgn: text.trim(), method: CHESSCOM_SHARE_METHOD };
  },
};
