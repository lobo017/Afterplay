/**
 * "Tap" on a touch screen, "Click" with a mouse: the verb for captions that tell the reader to press something.
 * Uses the same media query the engine profile reads (`(pointer: coarse)`); a browser without matchMedia says "Click".
 */
export function isTouchScreen(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(pointer: coarse)').matches
    : false;
}

/** "Tap" or "Click", capitalised for the start of a sentence. */
export const tapWord = (): string => (isTouchScreen() ? 'Tap' : 'Click');

/** "tap" or "click", for the middle of a sentence. */
export const tapWordLower = (): string => tapWord().toLowerCase();
