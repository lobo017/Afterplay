export interface DevOverlayMetrics {
  fps: number;
  p95FrameMs: number;
  longTaskCount: number;
  engineDepth: number;
  engineNps: number;
  cacheHitRate: number;
}

/**
 * Performance & Diagnostics Dev Overlay controller.
 * Toggled with the backtick (`) key or the header button.
 * Runs zero rAF callbacks when hidden so idle CPU usage is 0%.
 */
export class DevOverlayController {
  private readonly element: HTMLElement;
  private visible = false;
  private rafId: number | null = null;
  private lastFrameTime = 0;
  private readonly frameSamples: number[] = [];
  private longTaskCount = 0;
  private engineDepth = 0;
  private engineNps = 0;
  private cacheHits = 0;
  private cacheTotal = 0;
  private observer: PerformanceObserver | null = null;
  private readonly onToggleCallbacks: Array<(visible: boolean) => void> = [];

  private readonly fpsValEl: HTMLElement;
  private readonly p95ValEl: HTMLElement;
  private readonly longTaskValEl: HTMLElement;
  private readonly engineValEl: HTMLElement;
  private readonly cacheValEl: HTMLElement;

  constructor(parent: HTMLElement) {
    this.element = document.createElement('aside');
    this.element.className = 'wc-dev-overlay';
    this.element.setAttribute('data-testid', 'dev-overlay');
    this.element.setAttribute('aria-label', 'Developer Performance Overlay');
    this.element.hidden = true;

    this.element.innerHTML = `
      <div class="wc-dev-overlay-title">
        <span>DEV OVERLAY</span>
        <span class="wc-kbd">\`</span>
      </div>
      <div class="wc-dev-row">
        <span>FPS</span>
        <span data-metric="fps">--</span>
      </div>
      <div class="wc-dev-row">
        <span>p95 Frame</span>
        <span data-metric="p95">-- ms</span>
      </div>
      <div class="wc-dev-row">
        <span>Long Tasks (&gt;50ms)</span>
        <span data-metric="longtasks">0</span>
      </div>
      <div class="wc-dev-row">
        <span>Engine (Depth / NPS)</span>
        <span data-metric="engine">d0 / 0 kN/s</span>
      </div>
      <div class="wc-dev-row">
        <span>Cache Hit Rate</span>
        <span data-metric="cache">0.0%</span>
      </div>
    `;

    parent.appendChild(this.element);

    this.fpsValEl = this.element.querySelector('[data-metric="fps"]') as HTMLElement;
    this.p95ValEl = this.element.querySelector('[data-metric="p95"]') as HTMLElement;
    this.longTaskValEl = this.element.querySelector('[data-metric="longtasks"]') as HTMLElement;
    this.engineValEl = this.element.querySelector('[data-metric="engine"]') as HTMLElement;
    this.cacheValEl = this.element.querySelector('[data-metric="cache"]') as HTMLElement;

    this.initLongTaskObserver();
    window.addEventListener('keydown', this.handleKeyDown);
  }

  private initLongTaskObserver(): void {
    if (typeof PerformanceObserver === 'undefined') return;
    try {
      const supported = PerformanceObserver.supportedEntryTypes;
      if (supported && supported.includes('longtask')) {
        this.observer = new PerformanceObserver((list) => {
          this.longTaskCount += list.getEntries().length;
          if (this.visible) {
            this.renderMetrics();
          }
        });
        this.observer.observe({ entryTypes: ['longtask'] });
      }
    } catch {
      // Ignore if longtask observer is unsupported in current browser environment
    }
  }

  private readonly handleKeyDown = (event: KeyboardEvent): void => {
    const target = event.target as HTMLElement | null;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
      return;
    }
    if (event.key === '`' && !event.ctrlKey && !event.altKey && !event.metaKey) {
      event.preventDefault();
      this.toggle();
    }
  };

  public toggle(): boolean {
    this.setVisible(!this.visible);
    return this.visible;
  }

  public isVisible(): boolean {
    return this.visible;
  }

  public onToggle(cb: (visible: boolean) => void): void {
    this.onToggleCallbacks.push(cb);
  }

  public setVisible(next: boolean): void {
    if (this.visible === next) return;
    this.visible = next;
    this.element.hidden = !next;

    if (this.visible) {
      this.lastFrameTime = performance.now();
      this.renderMetrics();
      this.scheduleTick();
    } else if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }

    for (const cb of this.onToggleCallbacks) {
      cb(this.visible);
    }
  }

  public updateEngineStats(depth: number, nps: number): void {
    this.engineDepth = depth;
    this.engineNps = nps;
    if (this.visible) {
      const kNps = (nps / 1000).toFixed(1);
      const nextText = `d${depth} / ${kNps} kN/s`;
      if (this.engineValEl.textContent !== nextText) {
        this.engineValEl.textContent = nextText;
      }
    }
  }

  public recordCacheLookup(hit: boolean): void {
    this.cacheTotal++;
    if (hit) this.cacheHits++;
    if (this.visible) {
      const rate = this.cacheTotal > 0 ? ((this.cacheHits / this.cacheTotal) * 100).toFixed(1) : '0.0';
      const nextText = `${rate}%`;
      if (this.cacheValEl.textContent !== nextText) {
        this.cacheValEl.textContent = nextText;
      }
    }
  }

  private scheduleTick(): void {
    this.rafId = requestAnimationFrame((now) => {
      if (!this.visible) return;
      const dt = now - this.lastFrameTime;
      this.lastFrameTime = now;

      if (dt > 0 && dt < 500) {
        this.frameSamples.push(dt);
        if (this.frameSamples.length > 120) {
          this.frameSamples.shift();
        }
      }

      this.renderMetrics();
      this.scheduleTick();
    });
  }

  public getMetrics(): DevOverlayMetrics {
    let fps = 60;
    let p95FrameMs = 16.7;

    if (this.frameSamples.length > 0) {
      const avg = this.frameSamples.reduce((acc, v) => acc + v, 0) / this.frameSamples.length;
      fps = avg > 0 ? Math.round(1000 / avg) : 60;

      const sorted = [...this.frameSamples].sort((a, b) => a - b);
      const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95));
      p95FrameMs = Number((sorted[idx] ?? 16.7).toFixed(1));
    }

    const cacheHitRate = this.cacheTotal > 0 ? Number(((this.cacheHits / this.cacheTotal) * 100).toFixed(1)) : 0;

    return {
      fps,
      p95FrameMs,
      longTaskCount: this.longTaskCount,
      engineDepth: this.engineDepth,
      engineNps: this.engineNps,
      cacheHitRate,
    };
  }

  private renderMetrics(): void {
    const m = this.getMetrics();
    this.fpsValEl.textContent = `${m.fps}`;
    this.p95ValEl.textContent = `${m.p95FrameMs.toFixed(1)} ms`;
    this.longTaskValEl.textContent = `${m.longTaskCount}`;
    const kNps = (m.engineNps / 1000).toFixed(1);
    this.engineValEl.textContent = `d${m.engineDepth} / ${kNps} kN/s`;
    this.cacheValEl.textContent = `${m.cacheHitRate.toFixed(1)}%`;
  }

  public destroy(): void {
    window.removeEventListener('keydown', this.handleKeyDown);
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    if (this.observer) {
      this.observer.disconnect();
      this.observer = null;
    }
    this.element.remove();
  }
}
