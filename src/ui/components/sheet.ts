import { icon } from './icons';

export interface SheetOptions {
  /** Shown as the sheet's heading and accessible name. */
  title: string;
  testId: string;
  /** Called after the sheet opens or closes. */
  onToggle?: (open: boolean) => void;
}

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Safari does not focus a button that is clicked or tapped, so `document.activeElement` is still the page when a
 * click opens a sheet. The control pressed last stands in for it (pressed just now, still in the page), so focus
 * still goes back to whatever opened the sheet.
 */
const PRESS_MEMORY_MS = 2000;
let lastPressed: { el: HTMLElement; at: number } | null = null;
let pressTrackerInstalled = false;

function trackPresses(): void {
  if (pressTrackerInstalled || typeof document === 'undefined') return;
  pressTrackerInstalled = true;
  document.addEventListener(
    'pointerdown',
    (e) => {
      const target = e.target instanceof Element ? e.target.closest<HTMLElement>(FOCUSABLE) : null;
      lastPressed = target ? { el: target, at: performance.now() } : null;
    },
    { capture: true, passive: true },
  );
}

function currentOpener(): HTMLElement | null {
  const active = document.activeElement;
  if (active instanceof HTMLElement && active !== document.body) return active;
  if (lastPressed && lastPressed.el.isConnected && performance.now() - lastPressed.at < PRESS_MEMORY_MS) {
    return lastPressed.el;
  }
  return null;
}

/**
 * A modal panel that slides in from the right (full screen on phones). Escape, the backdrop
 * and the close button close it; focus moves into it on open, stays inside while open, and
 * returns to whatever opened it.
 */
export class Sheet {
  public readonly body: HTMLElement;
  private readonly root: HTMLElement;
  private readonly panel: HTMLElement;
  private returnFocus: HTMLElement | null = null;

  constructor(
    parent: HTMLElement,
    private readonly options: SheetOptions,
  ) {
    this.root = document.createElement('div');
    this.root.className = 'wc-sheet-root';
    this.root.hidden = true;
    this.root.innerHTML = `
      <div class="wc-sheet-backdrop" data-testid="${options.testId}-backdrop"></div>
      <div class="wc-sheet" role="dialog" aria-modal="true" aria-labelledby="${options.testId}-title" data-testid="${options.testId}">
        <header class="wc-sheet-head">
          <h2 class="wc-sheet-title" id="${options.testId}-title">${options.title}</h2>
          <button type="button" class="wc-icon-btn" data-testid="${options.testId}-close" aria-label="Close ${options.title}">${icon('close')}</button>
        </header>
        <div class="wc-sheet-body" data-testid="${options.testId}-body"></div>
      </div>`;
    parent.appendChild(this.root);
    this.panel = this.root.querySelector('.wc-sheet') as HTMLElement;
    this.body = this.root.querySelector('.wc-sheet-body') as HTMLElement;
    this.root.querySelector('.wc-sheet-backdrop')?.addEventListener('click', () => this.close());
    this.root.querySelector(`[data-testid="${options.testId}-close"]`)?.addEventListener('click', () => this.close());
    this.root.addEventListener('keydown', this.handleKeyDown);
    trackPresses();
  }

  public isOpen(): boolean {
    return !this.root.hidden;
  }

  public open(): void {
    if (this.isOpen()) return;
    this.returnFocus = currentOpener();
    this.root.hidden = false;
    document.documentElement.classList.add('wc-sheet-open');
    // Escape closes it even when focus has left it (e.g. a button inside was just hidden)
    document.addEventListener('keydown', this.handleDocumentKeyDown);
    (this.panel.querySelector(FOCUSABLE) as HTMLElement | null)?.focus();
    this.options.onToggle?.(true);
  }

  public close(): void {
    if (!this.isOpen()) return;
    this.root.hidden = true;
    document.documentElement.classList.remove('wc-sheet-open');
    document.removeEventListener('keydown', this.handleDocumentKeyDown);
    this.returnFocus?.focus();
    this.returnFocus = null;
    this.options.onToggle?.(false);
  }

  public toggle(): void {
    if (this.isOpen()) this.close();
    else this.open();
  }

  private readonly handleDocumentKeyDown = (e: KeyboardEvent): void => {
    if (e.key !== 'Escape' || this.root.contains(e.target as Node | null)) return;
    e.preventDefault();
    e.stopPropagation();
    this.close();
  };

  private readonly handleKeyDown = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      this.close();
      return;
    }
    if (e.key !== 'Tab') return;
    // Keep focus inside the sheet
    const items = [...this.panel.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null);
    const first = items[0];
    const last = items[items.length - 1];
    if (!first || !last) return;
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };
}
