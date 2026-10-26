/**
 * One visually hidden live region for the whole app: moves, game results and the board cursor
 * are spoken to screen readers through it. Polite, so it never cuts the reader off mid-sentence.
 */
let region: HTMLElement | null = null;
let flip = false;

function ensure(): HTMLElement | null {
  if (typeof document === 'undefined') return null;
  if (region && region.isConnected) return region;
  region = document.createElement('div');
  region.className = 'wc-sr-only wc-announcer';
  region.setAttribute('role', 'status');
  region.setAttribute('aria-live', 'polite');
  region.setAttribute('aria-atomic', 'true');
  region.setAttribute('data-testid', 'announcer');
  document.body.appendChild(region);
  return region;
}

/** Says `text` to screen readers (and keeps it in the region for tests). */
export function announce(text: string): void {
  const el = ensure();
  if (!el) return;
  // Saying the same thing twice in a row still needs a change to be read again
  flip = !flip;
  el.textContent = flip ? text : text + String.fromCharCode(0x200b);
  el.setAttribute('data-last', text);
}
