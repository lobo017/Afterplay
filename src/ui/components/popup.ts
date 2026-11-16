import { icon } from './icons';

/**
 * Shared parts of every popup, sheet, menu and overlay that covers the page: the small X that closes it, and the step
 * that keeps an open popup inside the part of the screen the user can see (below the top bar, above the bottom tab bar
 * and the safe areas). A popup stays where it is in the page; what does not fit scrolls inside it.
 */

/** Space kept between a popup and the edge of the visible area, in px. */
const EDGE = 8;
/** A popup is never cut below this height when it is squeezed (it scrolls inside instead). */
const MIN_HEIGHT = 96;

export interface CloseButtonOptions {
  testId: string;
  /** The accessible name: "Close", or "Close <title>" when the popup already has a button named Close. */
  label?: string;
  onClose: () => void;
  /** Extra classes (placement within the popup). */
  className?: string;
}

/** The X close button: top right of its popup, at least 44 × 44 px to touch. */
export function closeButton(options: CloseButtonOptions): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `wc-popup-close${options.className ? ` ${options.className}` : ''}`;
  button.setAttribute('data-testid', options.testId);
  button.setAttribute('aria-label', options.label ?? 'Close');
  button.innerHTML = icon('close');
  button.addEventListener('click', (e) => {
    e.stopPropagation();
    options.onClose();
  });
  return button;
}

/** The same button as markup, for popups written as HTML (the caller wires the click). */
export function closeButtonHtml(testId: string, label = 'Close', className = ''): string {
  return `<button type="button" class="wc-popup-close${className ? ` ${className}` : ''}" data-testid="${testId}" aria-label="${label}">${icon('close')}</button>`;
}

export interface Band {
  top: number;
  bottom: number;
}

/**
 * The part of the screen a popup can use, in viewport px: the visual viewport, less the sticky top bar and a fixed
 * bottom tab bar (whose height already holds the bottom safe area), less any scrolling or clipping box around `el`.
 */
export function visibleBand(el?: Element): Band {
  const vv = window.visualViewport;
  let top = vv?.offsetTop ?? 0;
  let bottom = top + (vv?.height ?? window.innerHeight);
  const bar = document.querySelector<HTMLElement>('.wc-topbar');
  if (bar && bar.offsetParent !== null) {
    const position = getComputedStyle(bar).position;
    if (position === 'sticky' || position === 'fixed') top = Math.max(top, bar.getBoundingClientRect().bottom);
  }
  const nav = document.querySelector<HTMLElement>('.wc-nav');
  if (nav && getComputedStyle(nav).position === 'fixed' && nav.getBoundingClientRect().height > 0) {
    bottom = Math.min(bottom, nav.getBoundingClientRect().top);
  }
  for (let p = el?.parentElement ?? null; p && p !== document.body; p = p.parentElement) {
    const style = getComputedStyle(p);
    if (style.overflowY !== 'visible' || style.overflowX !== 'visible') {
      const r = p.getBoundingClientRect();
      top = Math.max(top, r.top);
      bottom = Math.min(bottom, r.bottom);
    }
  }
  return { top: top + EDGE, bottom: bottom - EDGE };
}

/** The box that scrolls `el` into view: the nearest ancestor that scrolls, else the page. */
function scrollerOf(el: Element): Element {
  for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
    const overflowY = getComputedStyle(p).overflowY;
    if ((overflowY === 'auto' || overflowY === 'scroll') && p.scrollHeight > p.clientHeight) return p;
  }
  return document.scrollingElement ?? document.documentElement;
}

/** Below this much room under its trigger, a popup that may flip opens above the trigger instead, in px. */
const FLIP_BELOW = 240;

export interface FitOptions {
  /**
   * The popup is opened by a tap, click or key: the page may scroll a little so the popup clears the bottom tab bar.
   * Hover and focus only cap its height.
   */
  scroll?: boolean;
  /**
   * The popup normally opens below `anchor` and may open above it instead (`data-place="above"`, placed by its CSS)
   * when the room below is small, or clearly less than the room above, so it is not squeezed.
   */
  flip?: boolean;
  anchor?: Element;
}

/**
 * Fits the popup again when the screen changes size or turns while it is open (no scrolling then). Returns the
 * function that stops watching.
 */
export function watchFit(popup: HTMLElement, options: FitOptions = {}): () => void {
  let frame = 0;
  const refit = (): void => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => fitPopup(popup, { ...options, scroll: false }));
  };
  window.addEventListener('resize', refit);
  window.visualViewport?.addEventListener('resize', refit);
  return () => {
    cancelAnimationFrame(frame);
    window.removeEventListener('resize', refit);
    window.visualViewport?.removeEventListener('resize', refit);
  };
}

/**
 * Keeps an open popup inside the visible area: no taller than the area (it scrolls inside, its header stays), and
 * where a tap opened it, scrolled into view just enough. Call it each time the popup opens or the screen changes size.
 */
export function fitPopup(popup: HTMLElement, options: FitOptions = {}): void {
  popup.style.maxHeight = '';
  if (options.flip) popup.removeAttribute('data-place');
  let band = visibleBand(popup);
  const room = Math.max(MIN_HEIGHT, band.bottom - band.top);
  popup.style.maxHeight = `${Math.floor(room)}px`;
  let r = popup.getBoundingClientRect();
  if (r.height === 0) return;
  if (options.scroll && (r.bottom > band.bottom || r.top < band.top)) {
    // Down by what sticks out at the bottom, but never so far that the top goes out of view
    let dy = r.bottom > band.bottom ? r.bottom - band.bottom : r.top - band.top;
    if (r.top - dy < band.top) dy = r.top - band.top;
    const scroller = scrollerOf(popup);
    if (scroller === document.scrollingElement || scroller === document.documentElement) window.scrollBy(0, dy);
    else scroller.scrollTop += dy;
    band = visibleBand(popup);
    r = popup.getBoundingClientRect();
  }
  // Still sticking out below with little room there: open above the trigger instead
  if (options.flip && options.anchor && r.bottom > band.bottom + 0.5) {
    const below = band.bottom - Math.max(r.top, band.top);
    const above = options.anchor.getBoundingClientRect().top - band.top;
    if (above > below && (below < FLIP_BELOW || below < above * 0.6)) {
      popup.setAttribute('data-place', 'above');
      r = popup.getBoundingClientRect();
    }
  }
  // What still does not fit is cut off at the edge it crosses (the popup scrolls inside)
  if (r.bottom > band.bottom) {
    popup.style.maxHeight = `${Math.floor(Math.max(MIN_HEIGHT, band.bottom - Math.max(r.top, band.top)))}px`;
  } else if (r.top < band.top) {
    popup.style.maxHeight = `${Math.floor(Math.max(MIN_HEIGHT, Math.min(r.bottom, band.bottom) - band.top))}px`;
  }
}
