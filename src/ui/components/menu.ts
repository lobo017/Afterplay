import { icon, type IconName } from './icons';

export interface MenuItem {
  id: string;
  label: string;
  testId: string;
  icon?: IconName;
  danger?: boolean;
  /** A divider goes above this item. */
  separatorBefore?: boolean;
  onSelect: () => void;
}

/**
 * A ⋯ menu: the button opens a popover list (`role=menu`). Arrow keys move between items,
 * Escape or a click outside closes it, and focus returns to the button.
 */
export class Menu {
  public readonly button: HTMLButtonElement;
  private readonly popover: HTMLElement;
  private readonly itemEls = new Map<string, HTMLButtonElement>();

  constructor(
    host: HTMLElement,
    private readonly items: readonly MenuItem[],
    opts: { testId: string; label: string; buttonClass?: string; align?: 'left' | 'right' } = {
      testId: 'menu',
      label: 'More',
    },
  ) {
    const wrap = document.createElement('div');
    wrap.className = 'wc-menu-wrap';
    this.button = document.createElement('button');
    this.button.type = 'button';
    this.button.className = opts.buttonClass ?? 'wc-btn wc-btn-icon';
    this.button.setAttribute('data-testid', opts.testId);
    this.button.setAttribute('aria-label', opts.label);
    this.button.setAttribute('aria-haspopup', 'menu');
    this.button.setAttribute('aria-expanded', 'false');
    this.button.title = opts.label;
    this.button.innerHTML = icon('more');

    this.popover = document.createElement('div');
    this.popover.className = `wc-menu wc-menu-${opts.align ?? 'right'}`;
    this.popover.setAttribute('role', 'menu');
    this.popover.setAttribute('aria-label', opts.label);
    this.popover.setAttribute('data-testid', `${opts.testId}-list`);
    this.popover.hidden = true;
    for (const item of items) {
      if (item.separatorBefore) {
        const sep = document.createElement('div');
        sep.className = 'wc-menu-sep';
        sep.setAttribute('role', 'separator');
        this.popover.appendChild(sep);
      }
      const el = document.createElement('button');
      el.type = 'button';
      el.className = `wc-menu-item${item.danger ? ' wc-menu-item-danger' : ''}`;
      el.setAttribute('role', 'menuitem');
      el.setAttribute('data-testid', item.testId);
      el.tabIndex = -1;
      el.innerHTML = `${item.icon ? icon(item.icon) : '<span class="wc-icon-gap"></span>'}<span>${item.label}</span>`;
      el.addEventListener('click', () => {
        if (el.disabled) return;
        this.close(true);
        item.onSelect();
      });
      this.itemEls.set(item.id, el);
      this.popover.appendChild(el);
    }
    wrap.append(this.button, this.popover);
    host.appendChild(wrap);

    this.button.addEventListener('click', () => (this.isOpen() ? this.close(true) : this.open()));
    this.popover.addEventListener('keydown', this.handleKeyDown);
  }

  public isOpen(): boolean {
    return !this.popover.hidden;
  }

  public setDisabled(id: string, disabled: boolean): void {
    const el = this.itemEls.get(id);
    if (el) el.disabled = disabled;
  }

  public setLabel(id: string, label: string): void {
    const span = this.itemEls.get(id)?.querySelector('span:last-child');
    if (span && span.textContent !== label) span.textContent = label;
  }

  public open(): void {
    this.popover.hidden = false;
    this.button.setAttribute('aria-expanded', 'true');
    this.enabledItems()[0]?.focus();
    // Close on the next outside press
    setTimeout(() => document.addEventListener('pointerdown', this.handleOutside, true), 0);
  }

  public close(returnFocus = false): void {
    if (this.popover.hidden) return;
    this.popover.hidden = true;
    this.button.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', this.handleOutside, true);
    if (returnFocus) this.button.focus();
  }

  private enabledItems(): HTMLButtonElement[] {
    return [...this.itemEls.values()].filter((el) => !el.disabled);
  }

  private readonly handleOutside = (e: PointerEvent): void => {
    const target = e.target as Node | null;
    if (target && (this.popover.contains(target) || this.button.contains(target))) return;
    this.close(false);
  };

  private readonly handleKeyDown = (e: KeyboardEvent): void => {
    const items = this.enabledItems();
    const i = items.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      this.close(true);
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      e.stopPropagation();
      const n = items.length;
      items[(i + (e.key === 'ArrowDown' ? 1 : -1) + n) % n]?.focus();
    } else if (e.key === 'Tab') {
      this.close(false);
    }
  };

  public destroy(): void {
    document.removeEventListener('pointerdown', this.handleOutside, true);
  }

  public getItems(): readonly MenuItem[] {
    return this.items;
  }
}
