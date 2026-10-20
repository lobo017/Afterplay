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
 * A modal panel that slides in from the right (full screen on phones). Escape, the backdrop
 * and the close button close it; focus moves into it on open, stays inside while open, and
 * returns to whatever opened it.
 */
export class Sheet {
  public readonly body: HTMLElement;
  private readonly root: HTMLElement;
  private readonly panel: HTMLElement;
  private returnFocus: HTMLElement | null = null;

  constructor(parent: HTMLElement, private readonly options: SheetOptions) {
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
    this.root
      .querySelector(`[data-testid="${options.testId}-close"]`)
      ?.addEventListener('click', () => this.close());
    this.root.addEventListener('keydown', this.handleKeyDown);
  }

  public isOpen(): boolean {
    return !this.root.hidden;
  }

  public open(): void {
    if (this.isOpen()) return;
    const active = document.activeElement;
    this.returnFocus = active instanceof HTMLElement ? active : null;
    this.root.hidden = false;
    document.documentElement.classList.add('wc-sheet-open');
    (this.panel.querySelector(FOCUSABLE) as HTMLElement | null)?.focus();
    this.options.onToggle?.(true);
  }

  public close(): void {
    if (!this.isOpen()) return;
    this.root.hidden = true;
    document.documentElement.classList.remove('wc-sheet-open');
    this.returnFocus?.focus();
    this.returnFocus = null;
    this.options.onToggle?.(false);
  }

  public toggle(): void {
    if (this.isOpen()) this.close();
    else this.open();
  }

  private readonly handleKeyDown = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      this.close();
      return;
    }
    if (e.key !== 'Tab') return;
    // Keep focus inside the sheet
    const items = [...this.panel.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
      (el) => el.offsetParent !== null,
    );
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
