import type { FeelStorage } from './board-feel';

/**
 * The board size, shared by every board and remembered on this device. It is the width of
 * the board frame in CSS pixels, published as `--wc-board-size` on `<html>`; the layouts size
 * their board column from it. No stored size means the layout's default (37.5rem).
 */
export const BOARD_SIZE_RANGE = { min: 280, max: 1100 } as const;
export const BOARD_SIZE_STORAGE_KEY = 'wc.boardSize.v1';
const BOARD_SIZE_VAR = '--wc-board-size';
/** Arrow keys on the handle resize by this much. */
const KEY_STEP_PX = 16;

export function clampBoardSize(px: number): number {
  return Math.round(Math.min(BOARD_SIZE_RANGE.max, Math.max(BOARD_SIZE_RANGE.min, px)));
}

function storage(): FeelStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** The remembered size, or null for the default. */
export function loadBoardSize(store: FeelStorage | null = storage()): number | null {
  try {
    const raw = store?.getItem(BOARD_SIZE_STORAGE_KEY);
    if (!raw) return null;
    const px = Number(raw);
    return Number.isFinite(px) && px > 0 ? clampBoardSize(px) : null;
  } catch {
    return null;
  }
}

export function saveBoardSize(px: number | null, store: FeelStorage | null = storage()): void {
  try {
    if (px === null) store?.removeItem(BOARD_SIZE_STORAGE_KEY);
    else store?.setItem(BOARD_SIZE_STORAGE_KEY, String(clampBoardSize(px)));
  } catch {
    // Storage blocked: the size still applies until the page reloads
  }
}

/** Sets (or, with null, clears) the size every board column uses. */
export function applyBoardSize(px: number | null): void {
  if (typeof document === 'undefined') return;
  const style = document.documentElement.style;
  if (px === null) style.removeProperty(BOARD_SIZE_VAR);
  else style.setProperty(BOARD_SIZE_VAR, `${clampBoardSize(px)}px`);
}

/** Applies the remembered size; call once at start-up, before the first layout. */
export function initBoardSize(): void {
  applyBoardSize(loadBoardSize());
}

/**
 * Adds a resize grip to the bottom-right corner of a board frame. Dragging it resizes every
 * board (diagonally: whichever of the two directions moved further wins); the new size is
 * remembered on release. Arrow keys resize too; a double-click goes back to the default.
 * Returns a function that removes the grip.
 */
export function attachBoardResizeHandle(frameEl: HTMLElement): () => void {
  const handle = document.createElement('div');
  handle.className = 'wc-board-resize-handle';
  handle.setAttribute('data-testid', 'board-resize-handle');
  handle.setAttribute('role', 'slider');
  handle.setAttribute('aria-label', 'Board size');
  handle.setAttribute('aria-valuemin', String(BOARD_SIZE_RANGE.min));
  handle.setAttribute('aria-valuemax', String(BOARD_SIZE_RANGE.max));
  handle.title = 'Drag to resize the board · double-click for the default size';
  handle.tabIndex = 0;
  frameEl.appendChild(handle);

  let drag: { pointerId: number; startX: number; startY: number; startSize: number } | null = null;
  let pending: number | null = null;
  let rafId: number | null = null;

  const currentSize = (): number => frameEl.getBoundingClientRect().width;
  const flush = (): void => {
    rafId = null;
    if (pending !== null) applyBoardSize(pending);
  };

  const onPointerDown = (e: PointerEvent): void => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    drag = { pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, startSize: currentSize() };
    handle.setPointerCapture?.(e.pointerId);
    document.documentElement.classList.add('wc-resizing-board');
  };
  const onPointerMove = (e: PointerEvent): void => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;
    pending = clampBoardSize(drag.startSize + (Math.abs(dx) >= Math.abs(dy) ? dx : dy));
    rafId ??= requestAnimationFrame(flush);
  };
  const onPointerEnd = (e: PointerEvent): void => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    drag = null;
    document.documentElement.classList.remove('wc-resizing-board');
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    if (pending !== null) {
      applyBoardSize(pending);
      saveBoardSize(pending);
      pending = null;
    }
  };
  const onDoubleClick = (e: MouseEvent): void => {
    e.preventDefault();
    applyBoardSize(null);
    saveBoardSize(null);
  };
  const onKeyDown = (e: KeyboardEvent): void => {
    const grow = e.key === 'ArrowRight' || e.key === 'ArrowDown';
    const shrink = e.key === 'ArrowLeft' || e.key === 'ArrowUp';
    if (!grow && !shrink) return;
    e.preventDefault();
    e.stopPropagation();
    const next = clampBoardSize(currentSize() + (grow ? KEY_STEP_PX : -KEY_STEP_PX));
    applyBoardSize(next);
    saveBoardSize(next);
  };

  handle.addEventListener('pointerdown', onPointerDown);
  handle.addEventListener('pointermove', onPointerMove);
  handle.addEventListener('pointerup', onPointerEnd);
  handle.addEventListener('pointercancel', onPointerEnd);
  handle.addEventListener('dblclick', onDoubleClick);
  handle.addEventListener('keydown', onKeyDown);

  return () => {
    if (rafId !== null) cancelAnimationFrame(rafId);
    document.documentElement.classList.remove('wc-resizing-board');
    handle.remove();
  };
}
