import { Sheet } from './components/sheet';
import type { DevOverlayController } from './dev-overlay';

export interface AboutInfo {
  crossOriginIsolated: boolean;
  hardwareConcurrency: number | boolean;
  schemaVersion: number;
  /** The engine profile in a line (engine-profile.ts describeEngineProfile). */
  engineProfile: string;
}

export interface SettingsPanelOptions {
  parent: HTMLElement;
  devOverlay: DevOverlayController;
  about: AboutInfo;
  /** Opens the Add to Home Screen guide (src/ui/install-guide.ts). */
  onShowInstallGuide: () => void;
}

/**
 * The Settings sheet. Each screen adds its own section (`addSection`), in a fixed order;
 * About & diagnostics is always last.
 */
export class SettingsPanel {
  private readonly sheet: Sheet;
  private readonly sections = new Map<string, { el: HTMLElement; order: number }>();

  constructor(private readonly options: SettingsPanelOptions) {
    this.sheet = new Sheet(options.parent, { title: 'Settings', testId: 'settings-sheet' });
    this.mountAbout();
  }

  /** What the service worker says about offline use (shown in About & diagnostics). */
  public setOfflineStatus(text: string): void {
    const el = this.sheet.body.querySelector('[data-testid="stat-offline"]');
    if (el) el.textContent = text;
  }

  /** Whether saved data is protected from being cleared (shown in About & diagnostics). */
  public setStorageStatus(text: string): void {
    const el = this.sheet.body.querySelector('[data-testid="stat-persistence"]');
    if (el) el.textContent = text;
  }

  public open(): void {
    this.sheet.open();
  }

  public close(): void {
    this.sheet.close();
  }

  public toggle(): void {
    this.sheet.toggle();
  }

  public isOpen(): boolean {
    return this.sheet.isOpen();
  }

  /**
   * Adds a section (or returns the existing one) and gives back its body to fill.
   * Lower `order` comes first.
   */
  public addSection(id: string, title: string, order: number, headExtra = ''): HTMLElement {
    const existing = this.sections.get(id);
    if (existing) return existing.el.querySelector('.wc-settings-sec-body') as HTMLElement;
    const el = document.createElement('section');
    el.className = 'wc-settings-sec';
    el.setAttribute('data-testid', `settings-${id}`);
    el.setAttribute('aria-labelledby', `settings-${id}-title`);
    el.innerHTML = `
      <div class="wc-settings-sec-head">
        <h3 class="wc-settings-sec-title" id="settings-${id}-title">${title}</h3>${headExtra}
      </div>
      <div class="wc-settings-sec-body"></div>`;
    const after = [...this.sections.values()].filter((s) => s.order > order).sort((a, b) => a.order - b.order)[0];
    if (after) this.sheet.body.insertBefore(el, after.el);
    else this.sheet.body.appendChild(el);
    this.sections.set(id, { el, order });
    return el.querySelector('.wc-settings-sec-body') as HTMLElement;
  }

  private mountAbout(): void {
    const { about, devOverlay } = this.options;
    const isolated = about.crossOriginIsolated;
    const threadMode = isolated
      ? `Multi-threaded Capable (${about.hardwareConcurrency} cores)`
      : 'Single-threaded Fallback';
    const body = this.addSection('about', 'About &amp; diagnostics', 1000);
    body.innerHTML = `
      <div class="wc-about-badges">
        <span class="wc-badge" data-testid="isolation-badge">
          <span class="wc-dot ${isolated ? '' : 'wc-dot-warn'}"></span>
          <span>${isolated ? 'COOP/COEP Isolated' : 'Single-Thread Mode'}</span>
        </span>
        <span class="wc-badge" data-testid="network-badge"><span class="wc-dot"></span><span>Offline shell · network only for the Chess.com sync</span></span>
        <span class="wc-badge" data-testid="core-badge"><span class="wc-dot"></span><span>Core Rules · PGN · IDB v${about.schemaVersion}</span></span>
        <span class="wc-badge" data-testid="engine-badge"><span class="wc-dot"></span><span>Stockfish 17.1 WASM · Bot 400–2400</span></span>
      </div>
      <dl class="wc-about-stats">
        ${[
          ['threading', 'Engine threading', threadMode],
          ['network', 'Runtime network', 'Only the Chess.com sync, when you press it'],
          ['offline', 'Offline use', 'Checking…'],
          ['datasets', 'Bundled datasets', 'Openings · 20k Puzzles · Endgames'],
          ['rules', 'Rules &amp; variants', 'Standard + Chess960 (Perft Verified)'],
          ['pgn', 'PGN &amp; game tree', 'RAVs · NAGs · [%eval/%cal/%csl]'],
          ['storage', 'Local storage', `IndexedDB Schema v${about.schemaVersion}`],
          ['persistence', 'Saved data', 'Checking…'],
          ['engine-profile', 'Engine profile', about.engineProfile],
          ['engine', 'Stockfish engine', 'Stockfish 17.1 Lite NNUE (MultiPV 1–5)'],
          ['bot', 'Playing bot', '400–2400 Elo · Aggressive / Solid / Gambiteer'],
        ]
          .map(
            ([id, label, value]) =>
              `<div class="wc-about-stat"><dt>${label}</dt><dd data-testid="stat-${id}">${value}</dd></div>`,
          )
          .join('')}
      </dl>
      <div class="wc-setting-row">
        <span class="wc-setting-label">Add to Home Screen
          <span class="wc-setting-hint">How to install the app on an iPhone or iPad, so Safari keeps your data</span></span>
        <button type="button" class="wc-btn wc-btn-sm" data-testid="btn-install-guide">Show how</button>
      </div>
      <div class="wc-setting-row">
        <span class="wc-setting-label">Performance overlay <span class="wc-kbd">\`</span>
          <span class="wc-setting-hint">FPS, frame time, long tasks, engine speed</span></span>
        <button type="button" class="wc-switch" role="switch" data-testid="toggle-dev-overlay" aria-checked="false" aria-pressed="false" aria-label="Performance overlay"></button>
      </div>`;
    body
      .querySelector('[data-testid="btn-install-guide"]')
      ?.addEventListener('click', () => this.options.onShowInstallGuide());
    const toggle = body.querySelector('[data-testid="toggle-dev-overlay"]') as HTMLButtonElement;
    toggle.addEventListener('click', () => devOverlay.toggle());
    devOverlay.onToggle((visible) => {
      toggle.setAttribute('aria-checked', String(visible));
      toggle.setAttribute('aria-pressed', String(visible));
    });
  }
}
