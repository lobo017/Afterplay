import { applyUpdate, watchUpdate } from '../pwa';

/**
 * "New version available": shown when a newer build is waiting while something is in progress
 * (a game, a drill, a review). With nothing in progress the build is applied by itself instead
 * (pwa.ts), so this banner never interrupts; Reload takes the new build, Later keeps the old one.
 */
export function mountUpdateBanner(parent: HTMLElement): void {
  const el = document.createElement('div');
  el.className = 'wc-update-banner';
  el.setAttribute('data-testid', 'update-banner');
  el.setAttribute('role', 'status');
  el.hidden = true;
  el.innerHTML = `
    <span>New version available.</span>
    <button type="button" class="wc-btn wc-btn-primary wc-btn-sm" data-testid="btn-update-reload">Reload</button>
    <button type="button" class="wc-btn wc-btn-ghost wc-btn-sm" data-testid="btn-update-later">Later</button>`;
  parent.appendChild(el);
  el.querySelector('[data-testid="btn-update-reload"]')!.addEventListener('click', () => applyUpdate());
  el.querySelector('[data-testid="btn-update-later"]')!.addEventListener('click', () => {
    el.hidden = true;
  });
  watchUpdate((waiting) => {
    el.hidden = !waiting;
  });
}
