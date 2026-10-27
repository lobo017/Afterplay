/** Small HTML builders for the app's form controls; behaviour is wired by the caller. */

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export interface Choice {
  value: string;
  label: string;
  /** A second line under the label (chips). */
  sub?: string;
  title?: string;
}

/**
 * A segmented control (radio group): one button per choice, `aria-checked` on the chosen one.
 * Buttons are `${testIdPrefix}-${value}`.
 */
export function segmentedHtml(
  name: string,
  testIdPrefix: string,
  choices: readonly Choice[],
  selected: string,
  label: string,
): string {
  return `<div class="wc-seg" role="radiogroup" aria-label="${esc(label)}" data-seg="${name}">${choices
    .map(
      (c) =>
        `<button type="button" role="radio" class="wc-seg-item" data-value="${esc(c.value)}" data-testid="${testIdPrefix}-${esc(c.value)}" aria-checked="${c.value === selected}"${
          c.title ? ` title="${esc(c.title)}"` : ''
        }>${esc(c.label)}</button>`,
    )
    .join('')}</div>`;
}

/** Chips (radio group) with an optional second line. */
export function chipsHtml(
  name: string,
  testIdPrefix: string,
  choices: readonly Choice[],
  selected: string,
  label: string,
): string {
  return `<div class="wc-chips" role="radiogroup" aria-label="${esc(label)}" data-seg="${name}">${choices
    .map(
      (c) =>
        `<button type="button" role="radio" class="wc-chip" data-value="${esc(c.value)}" data-testid="${testIdPrefix}-${esc(c.value)}" aria-checked="${c.value === selected}"${
          c.title ? ` title="${esc(c.title)}"` : ''
        }><span class="wc-chip-main">${esc(c.label)}</span>${c.sub ? `<span class="wc-chip-sub">${esc(c.sub)}</span>` : ''}</button>`,
    )
    .join('')}</div>`;
}

/** Marks `value` chosen in a segmented control or chip group written by the builders above. */
export function setChoice(group: Element | null, value: string): void {
  if (!group) return;
  for (const el of group.querySelectorAll<HTMLElement>('[role="radio"]')) {
    el.setAttribute('aria-checked', String(el.dataset.value === value));
  }
}

/**
 * Calls `onPick` when a choice in any radio group with `data-seg` inside `root` is picked, and
 * moves the checked mark. Arrow keys move along a group.
 */
export function bindChoiceGroups(root: HTMLElement, onPick: (name: string, value: string) => void): void {
  root.addEventListener('click', (e) => {
    const item = (e.target as HTMLElement).closest<HTMLElement>('[role="radio"]');
    const group = item?.closest<HTMLElement>('[data-seg]');
    if (!item || !group || !root.contains(group)) return;
    setChoice(group, item.dataset.value ?? '');
    onPick(group.dataset.seg ?? '', item.dataset.value ?? '');
  });
  root.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const item = (e.target as HTMLElement).closest<HTMLElement>('[role="radio"]');
    const group = item?.closest<HTMLElement>('[data-seg]');
    if (!item || !group) return;
    const items = [...group.querySelectorAll<HTMLElement>('[role="radio"]')];
    const next = items[(items.indexOf(item) + (e.key === 'ArrowRight' ? 1 : -1) + items.length) % items.length];
    if (!next) return;
    e.preventDefault();
    e.stopPropagation();
    next.focus();
    next.click();
  });
}

/** A labelled switch row (a real checkbox styled as a switch). */
export function switchRowHtml(testId: string, label: string, checked: boolean, hint = ''): string {
  return `<label class="wc-setting-row">
    <span class="wc-setting-label">${label}${hint ? `<span class="wc-setting-hint">${hint}</span>` : ''}</span>
    <input type="checkbox" role="switch" class="wc-switch-input" data-testid="${testId}"${checked ? ' checked' : ''} />
  </label>`;
}

/** A labelled select row. */
export function selectRowHtml(testId: string, label: string, choices: readonly Choice[], selected: string): string {
  return `<label class="wc-setting-row">
    <span class="wc-setting-label">${label}</span>
    <select class="wc-select wc-setting-select" data-testid="${testId}">${choices
      .map((c) => `<option value="${esc(c.value)}"${c.value === selected ? ' selected' : ''}>${esc(c.label)}</option>`)
      .join('')}</select>
  </label>`;
}

/** A labelled slider with its value shown on the right. */
export function sliderRowHtml(
  testId: string,
  label: string,
  opts: { min: number; max: number; step: number; value: number; valueText: string; valueTestId?: string },
): string {
  return `<label class="wc-slider-row">
    <span class="wc-setting-label">${label}</span>
    <span class="wc-slider-value"${opts.valueTestId ? ` data-testid="${opts.valueTestId}"` : ''}>${opts.valueText}</span>
    <input type="range" class="wc-range" min="${opts.min}" max="${opts.max}" step="${opts.step}" value="${opts.value}" data-testid="${testId}" aria-label="${label}" />
  </label>`;
}
