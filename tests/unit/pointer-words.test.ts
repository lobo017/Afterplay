import { afterEach, describe, expect, it, vi } from 'vitest';
import { isTouchScreen, tapWord, tapWordLower } from '../../src/ui/pointer-words';

const withPointer = (coarse: boolean | 'no-matchmedia') => {
  vi.stubGlobal(
    'window',
    coarse === 'no-matchmedia' ? {} : { matchMedia: (q: string) => ({ matches: coarse && q === '(pointer: coarse)' }) },
  );
};

afterEach(() => vi.unstubAllGlobals());

describe('Tap or Click', () => {
  it('says Tap when the pointer is coarse (a finger)', () => {
    withPointer(true);
    expect(isTouchScreen()).toBe(true);
    expect(tapWord()).toBe('Tap');
    expect(tapWordLower()).toBe('tap');
  });

  it('says Click with a mouse', () => {
    withPointer(false);
    expect(isTouchScreen()).toBe(false);
    expect(tapWord()).toBe('Click');
    expect(tapWordLower()).toBe('click');
  });

  it('says Click where there is no window or no matchMedia', () => {
    withPointer('no-matchmedia');
    expect(tapWord()).toBe('Click');
    vi.unstubAllGlobals();
    expect(tapWord()).toBe('Click');
  });
});
