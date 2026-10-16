import { DevOverlayController } from './ui/dev-overlay';

export interface AppShellEnvironment {
  crossOriginIsolated: boolean;
  hardwareConcurrency: number;
  offlineReady: boolean;
}

export function detectEnvironment(): AppShellEnvironment {
  const isIsolated =
    typeof window !== 'undefined' && Boolean(window.crossOriginIsolated);
  const threads =
    typeof navigator !== 'undefined' && navigator.hardwareConcurrency
      ? navigator.hardwareConcurrency
      : 1;

  return {
    crossOriginIsolated: isIsolated,
    hardwareConcurrency: threads,
    offlineReady: true,
  };
}

export function mountAppShell(container: HTMLElement): {
  devOverlay: DevOverlayController;
  env: AppShellEnvironment;
} {
  const env = detectEnvironment();
  const threadModeLabel = env.crossOriginIsolated
    ? `Multi-threaded Capable (${env.hardwareConcurrency} cores)`
    : 'Single-threaded Fallback';

  container.innerHTML = `
    <div class="wc-shell" data-testid="app-shell">
      <header class="wc-header">
        <div class="wc-brand">
          <div class="wc-brand-mark" aria-hidden="true">♛</div>
          <div>
            <h1 class="wc-brand-title">Wizard's Chess</h1>
            <div class="wc-brand-subtitle">Offline Chess Learning &amp; Stockfish Analysis</div>
          </div>
        </div>
        <div class="wc-status-bar">
          <span class="wc-badge" data-testid="isolation-badge">
            <span class="wc-dot ${env.crossOriginIsolated ? '' : 'wc-dot-warn'}"></span>
            <span>${env.crossOriginIsolated ? 'COOP/COEP Isolated' : 'Single-Thread Mode'}</span>
          </span>
          <span class="wc-badge" data-testid="network-badge">
            <span class="wc-dot"></span>
            <span>Zero-Network Offline Shell</span>
          </span>
          <button
            type="button"
            class="wc-badge wc-badge-button"
            data-testid="toggle-dev-overlay"
            aria-pressed="false"
            title="Toggle Developer Performance Overlay (Backtick key)"
          >
            <span>Dev Overlay</span>
            <span class="wc-kbd">\`</span>
          </button>
        </div>
      </header>

      <main class="wc-main">
        <section class="wc-card" aria-labelledby="shell-heading">
          <h2 id="shell-heading" class="wc-card-title">Phase 0 — Architecture &amp; Offline Foundation</h2>
          <p class="wc-card-desc">
            Engine, rules, opening book, 20,000 stratified Lichess puzzles, and curated endgame positions are bundled locally with zero runtime network requests. Press <kbd class="wc-kbd">\`</kbd> at any time to inspect live frame timing and engine telemetry.
          </p>
          <div class="wc-grid">
            <div class="wc-stat">
              <div class="wc-stat-label">Engine Threading</div>
              <div class="wc-stat-value" data-testid="stat-threading">${threadModeLabel}</div>
            </div>
            <div class="wc-stat">
              <div class="wc-stat-label">Runtime Network</div>
              <div class="wc-stat-value" data-testid="stat-network">0 External Requests</div>
            </div>
            <div class="wc-stat">
              <div class="wc-stat-label">Bundled Datasets</div>
              <div class="wc-stat-value" data-testid="stat-datasets">Openings · 20k Puzzles · Endgames</div>
            </div>
          </div>
        </section>
      </main>
    </div>
  `;

  const shellEl = container.querySelector('.wc-shell') as HTMLElement;
  const devOverlay = new DevOverlayController(shellEl);

  const toggleBtn = container.querySelector(
    '[data-testid="toggle-dev-overlay"]',
  ) as HTMLButtonElement | null;

  if (toggleBtn) {
    toggleBtn.addEventListener('click', () => {
      devOverlay.toggle();
    });
    devOverlay.onToggle((visible) => {
      toggleBtn.setAttribute('aria-pressed', String(visible));
    });
  }

  return { devOverlay, env };
}
