import {
  BOARD_FEEL_KEYS,
  BOARD_FEEL_RANGES,
  DEFAULT_BOARD_FEEL,
  boardFeel as sharedBoardFeel,
  type BoardFeel,
  type BoardFeelKey,
  type BoardFeelStore,
} from '../render/board-feel';
import { applyBoardSize, loadBoardSize, saveBoardSize } from '../render/board-size';
import type { SettingsPanel } from './settings-panel';

/** A feel value as Settings shows it (fixed decimals per range step). */
export function formatFeelValue(key: BoardFeelKey, value: number): string {
  const r = BOARD_FEEL_RANGES[key];
  const decimals = r.step >= 1 ? 0 : r.step >= 0.1 ? 1 : 2;
  return `${value.toFixed(decimals)} ${r.unit}`;
}

const FEEL_HINTS: Record<BoardFeelKey, string> = {
  dragThresholdPx: 'How far a press moves before it counts as a drag (doubled on touch)',
  liftScale: 'How much a picked-up piece grows',
  snapMs: 'How long a dropped piece takes to glide into its square',
  dropTolerance: 'How far past a legal square a drop still lands on it',
  touchOffset: 'How far above your finger a dragged piece is drawn',
  animationMs: 'How long a played move takes to slide',
};

/**
 * Settings › Board feel: the six sliders (live on every board, remembered on this device) and
 * "Reset to defaults"; and the board size with its own reset. Returns an unsubscribe.
 */
export function mountBoardFeelSection(
  panel: SettingsPanel,
  order: number,
  boardOrder: number,
  feel: BoardFeelStore = sharedBoardFeel,
): () => void {
  const body = panel.addSection(
    'board-feel',
    'Board feel',
    order,
    '<button type="button" class="wc-btn wc-btn-secondary wc-btn-sm" data-testid="btn-feel-reset">Reset to defaults</button>',
  );
  body.innerHTML = BOARD_FEEL_KEYS.map((key) => {
    const r = BOARD_FEEL_RANGES[key];
    return `<label class="wc-slider-row" title="Default ${formatFeelValue(key, DEFAULT_BOARD_FEEL[key])}">
      <span class="wc-setting-label">${r.label}<span class="wc-setting-hint">${FEEL_HINTS[key]}</span></span>
      <span class="wc-slider-value" data-testid="feel-value-${key}"></span>
      <input type="range" class="wc-range" min="${r.min}" max="${r.max}" step="${r.step}" data-feel-key="${key}" data-testid="feel-${key}" aria-label="${r.label}" />
    </label>`;
  }).join('');

  const inputs = new Map<BoardFeelKey, HTMLInputElement>();
  const values = new Map<BoardFeelKey, HTMLElement>();
  for (const key of BOARD_FEEL_KEYS) {
    const input = body.querySelector(`[data-feel-key="${key}"]`) as HTMLInputElement;
    inputs.set(key, input);
    values.set(key, body.querySelector(`[data-testid="feel-value-${key}"]`) as HTMLElement);
    input.addEventListener('input', () => feel.set({ [key]: Number(input.value) }));
  }
  const section = body.closest('section');
  section?.querySelector('[data-testid="btn-feel-reset"]')?.addEventListener('click', () => feel.reset());

  const render = (f: BoardFeel): void => {
    for (const key of BOARD_FEEL_KEYS) {
      const input = inputs.get(key);
      if (input && Number(input.value) !== f[key]) input.value = String(f[key]);
      const valueEl = values.get(key);
      if (valueEl) {
        valueEl.textContent = formatFeelValue(key, f[key]);
        valueEl.classList.toggle('wc-feel-changed', f[key] !== DEFAULT_BOARD_FEEL[key]);
      }
    }
  };
  render(feel.get());
  const unsubscribe = feel.subscribe(render);

  // Board size: what it is now, and back to the default
  const board = panel.addSection('board', 'Board', boardOrder);
  const sizeRow = document.createElement('div');
  sizeRow.className = 'wc-setting-row';
  sizeRow.innerHTML = `
    <span class="wc-setting-label">Board size<span class="wc-setting-hint">Drag the grip at the board's corner (wide screens)</span></span>
    <span class="wc-setting-inline">
      <span class="wc-slider-value" data-testid="board-size-value"></span>
      <button type="button" class="wc-btn wc-btn-ghost wc-btn-sm" data-testid="btn-board-size-reset">Reset</button>
    </span>`;
  board.appendChild(sizeRow);
  const sizeValue = sizeRow.querySelector('[data-testid="board-size-value"]') as HTMLElement;
  const resetBtn = sizeRow.querySelector('[data-testid="btn-board-size-reset"]') as HTMLButtonElement;
  const renderSize = (): void => {
    const px = loadBoardSize();
    sizeValue.textContent = px === null ? 'Default' : `${px} px`;
    resetBtn.disabled = px === null;
  };
  renderSize();
  resetBtn.addEventListener('click', () => {
    applyBoardSize(null);
    saveBoardSize(null);
    renderSize();
  });
  window.addEventListener('wc-board-size', renderSize);

  return () => {
    unsubscribe();
    window.removeEventListener('wc-board-size', renderSize);
  };
}
