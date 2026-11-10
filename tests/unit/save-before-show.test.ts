import { afterEach, describe, expect, it, vi } from 'vitest';
import { SAVE_WAIT_MS, saveBeforeShow } from '../../src/trainers/trainer-kit';

// A drill's result is shown only after its save has finished, but never later than SAVE_WAIT_MS: a phone app closed as
// the result appears has already stored it, and a blocked database cannot freeze the screen.
describe('saveBeforeShow', () => {
  afterEach(() => vi.useRealTimers());

  it('gives the stored value when the save finishes in time', async () => {
    expect(await saveBeforeShow(Promise.resolve({ newBest: true }))).toEqual({ saved: { newBest: true } });
  });

  it('reports a failed save instead of throwing', async () => {
    const boom = new Error('disk full');
    expect(await saveBeforeShow(Promise.reject(boom))).toEqual({ error: boom });
  });

  it('stops waiting after the limit and hands back the save still running', async () => {
    vi.useFakeTimers();
    let finish: (v: string) => void = () => undefined;
    const slow = new Promise<string>((resolve) => {
      finish = resolve;
    });
    const waiting = saveBeforeShow(slow);
    await vi.advanceTimersByTimeAsync(SAVE_WAIT_MS + 1);
    const outcome = await waiting;
    expect('pending' in outcome).toBe(true);
    finish('stored late');
    if ('pending' in outcome) expect(await outcome.pending).toBe('stored late');
  });

  it('does not wait the whole limit when the save is quick, and leaves no timer behind', async () => {
    vi.useFakeTimers();
    const outcome = await saveBeforeShow(Promise.resolve(7));
    expect(outcome).toEqual({ saved: 7 });
    expect(vi.getTimerCount()).toBe(0);
  });
});
