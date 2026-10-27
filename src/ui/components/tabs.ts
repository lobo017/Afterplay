export interface TabSpec {
  id: string;
  label: string;
}

/**
 * Tab buttons for a side panel. `testIdPrefix` names them `${prefix}-tab-${id}` and their
 * panels `${prefix}-panel-${id}`; the panels are written by the caller with `tabPanelAttrs`.
 */
export function tabListHtml(testIdPrefix: string, tabs: readonly TabSpec[], selected: string, label: string): string {
  return `<div class="wc-tabs" role="tablist" aria-label="${label}">${tabs
    .map(
      (t) =>
        `<button type="button" class="wc-tab" role="tab" id="${testIdPrefix}-tab-${t.id}" data-tab="${t.id}" data-testid="${testIdPrefix}-tab-${t.id}" aria-controls="${testIdPrefix}-panel-${t.id}" aria-selected="${t.id === selected}" tabindex="${t.id === selected ? 0 : -1}">${t.label}</button>`,
    )
    .join('')}</div>`;
}

export function tabPanelAttrs(testIdPrefix: string, id: string, selected: string): string {
  return `role="tabpanel" id="${testIdPrefix}-panel-${id}" data-tab-panel="${id}" data-testid="${testIdPrefix}-panel-${id}" aria-labelledby="${testIdPrefix}-tab-${id}"${
    id === selected ? '' : ' hidden'
  }`;
}

/** Switches the tabs and panels written by `tabListHtml` / `tabPanelAttrs` inside `root`. */
export class Tabs {
  private current: string;
  private readonly tabs: HTMLButtonElement[];

  constructor(
    private readonly root: HTMLElement,
    private readonly onChange?: (id: string) => void,
  ) {
    this.tabs = [...root.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
    this.current = this.tabs.find((t) => t.getAttribute('aria-selected') === 'true')?.dataset.tab ?? '';
    for (const tab of this.tabs) {
      tab.addEventListener('click', () => this.select(tab.dataset.tab ?? ''));
      tab.addEventListener('keydown', (e) => {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'Home' && e.key !== 'End') return;
        e.preventDefault();
        e.stopPropagation();
        const i = this.tabs.indexOf(tab);
        const n = this.tabs.length;
        const next = e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : (i + (e.key === 'ArrowRight' ? 1 : -1) + n) % n;
        const target = this.tabs[next];
        if (target) {
          this.select(target.dataset.tab ?? '');
          target.focus();
        }
      });
    }
  }

  public getSelected(): string {
    return this.current;
  }

  public select(id: string): void {
    if (id === this.current || !this.tabs.some((t) => t.dataset.tab === id)) return;
    this.current = id;
    for (const tab of this.tabs) {
      const on = tab.dataset.tab === id;
      tab.setAttribute('aria-selected', String(on));
      tab.tabIndex = on ? 0 : -1;
    }
    for (const panel of this.root.querySelectorAll<HTMLElement>('[data-tab-panel]')) {
      panel.hidden = panel.dataset.tabPanel !== id;
    }
    this.onChange?.(id);
  }
}
