import { PRESET_LIMITS } from '../preset/preset';
import type { Profile, ProfileStore } from '../preset/profile';
import type { SettingsPanel } from './settings-panel';

/** Where Profile sits in the Settings sheet (first). */
export const PROFILE_SECTION_ORDER = 5;

/**
 * Profile: the name and title Play shows for me (and writes into the PGN of games played here), and the welcome
 * message again, when a first-run link brought one.
 */
export function mountProfileSection(panel: SettingsPanel, store: ProfileStore, onShowWelcome: () => void): () => void {
  const body = panel.addSection('profile', 'Profile', PROFILE_SECTION_ORDER);
  body.innerHTML = `
    <label class="wc-setting-row">
      <span class="wc-setting-label">Display name<span class="wc-setting-hint">Shown instead of “You” in Play and in your games</span></span>
      <input type="text" class="wc-select wc-setting-text" autocomplete="off" spellcheck="false" maxlength="${PRESET_LIMITS.displayName}" value="" data-testid="input-display-name" />
    </label>
    <label class="wc-setting-row">
      <span class="wc-setting-label">Title<span class="wc-setting-hint">A short badge before your name</span></span>
      <input type="text" class="wc-select wc-setting-text" autocomplete="off" spellcheck="false" maxlength="${PRESET_LIMITS.title}" value="" data-testid="input-profile-title" />
    </label>
    <div class="wc-setting-row" data-testid="row-welcome-message" hidden>
      <span class="wc-setting-label">Welcome message<span class="wc-setting-hint">The message that came with your set-up link</span></span>
      <button type="button" class="wc-btn wc-btn-sm" data-testid="btn-show-welcome">Show again</button>
    </div>`;
  const q = <T extends HTMLElement>(id: string) => body.querySelector(`[data-testid="${id}"]`) as T;
  const name = q<HTMLInputElement>('input-display-name');
  const title = q<HTMLInputElement>('input-profile-title');
  const welcomeRow = q<HTMLElement>('row-welcome-message');
  const render = (profile: Profile): void => {
    if (document.activeElement !== name) name.value = profile.displayName;
    if (document.activeElement !== title) title.value = profile.title;
    welcomeRow.hidden = profile.welcome === null;
  };
  name.addEventListener('change', () => store.set({ displayName: name.value }));
  title.addEventListener('change', () => store.set({ title: title.value }));
  q<HTMLButtonElement>('btn-show-welcome').addEventListener('click', () => onShowWelcome());
  render(store.get());
  return store.subscribe((profile) => render(profile));
}
