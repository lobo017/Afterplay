import { applyUpdate, watchUpdate } from '../pwa';

/**
 * "A new version is ready": shown when a newer build has been downloaded and is waiting. The
 * app never reloads by itself (a game could be under way); Reload takes the new build.
 */
export function mountUpdateBanner(parent: HTMLElement): void {
  const el = document.createElement('div');
  el.className = 'wc-update-banner';
  el.setAttribute('data-testid', 'update-banner');
  el.setAttribute('role', 'status');
  el.hidden = true;
  el.innerHTML = `
    <span>A new version is ready.</span>
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
