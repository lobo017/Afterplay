import { describe, expect, it } from 'vitest';
import { LINE_STEP_MS, LinePlayer, type LinePlayerDeps } from '../../src/review/line-player';

// The refutation line played out on the board, one move at a time. A fake clock and a fake listener list stand in for
// the browser; the board reports each move back to the player the way the review panel does.
function setup(options: { reducedMotion?: boolean } = {}) {
  let now = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  let nextHandle = 1;
  const listeners = new Set<() => void>();
  const shown = { value: true };
  const visited: string[] = [];
  const state: { player: LinePlayer | null } = { player: null };
  const deps: LinePlayerDeps = {
    goTo: (id) => {
      visited.push(id);
      state.player?.noteNavigation(id);
    },
    schedule: (fn, ms) => {
      const h = nextHandle++;
      timers.set(h, { at: now + ms, fn });
      return h;
    },
    cancel: (h) => void timers.delete(h as number),
    reducedMotion: () => options.reducedMotion === true,
    shown: () => shown.value,
    onUserAction: (stop) => {
      listeners.add(stop);
      return () => void listeners.delete(stop);
    },
  };
  const player = new LinePlayer(deps);
  state.player = player;
  /** Moves the clock on, running every timer that comes due. */
  const advance = (ms: number) => {
    const end = now + ms;
    for (;;) {
      const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]);
      now = due[1].at;
      due[1].fn();
    }
    now = end;
  };
  const userActs = () => [...listeners].forEach((l) => l());
  return { player, visited, advance, timers, listeners, shown, userActs };
}

const LINE = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];

describe('playing a line out on the board', () => {
  it('shows the first move at once, then one more every step, ending on the last', () => {
    const t = setup();
    t.player.play(LINE);
    expect(t.visited).toEqual(['a']);
    t.advance(LINE_STEP_MS - 1);
    expect(t.visited).toEqual(['a']);
    t.advance(1);
    expect(t.visited).toEqual(['a', 'b']);
    t.advance(LINE_STEP_MS * 6);
    expect(t.visited).toEqual(LINE);
    expect(t.player.isPlaying()).toBe(false);
  });

  it('leaves no timer and no listener once it has ended', () => {
    const t = setup();
    t.player.play(LINE);
    expect(t.listeners.size).toBe(1);
    t.advance(LINE_STEP_MS * LINE.length);
    expect(t.timers.size).toBe(0);
    expect(t.listeners.size).toBe(0);
    expect(t.visited).toEqual(LINE);
  });

  it('plays a line of any length up to the stored one (a short line too)', () => {
    for (const n of [1, 2, 3, 8]) {
      const t = setup();
      t.player.play(LINE.slice(0, n));
      t.advance(LINE_STEP_MS * 10);
      expect(t.visited, `${n} moves`).toEqual(LINE.slice(0, n));
      expect(t.timers.size).toBe(0);
      expect(t.listeners.size).toBe(0);
    }
  });

  it('a user action stops it: nothing more appears, and nothing is left behind', () => {
    const t = setup();
    t.player.play(LINE);
    t.advance(LINE_STEP_MS * 2);
    expect(t.visited).toEqual(['a', 'b', 'c']);
    t.userActs();
    expect(t.player.isPlaying()).toBe(false);
    expect(t.timers.size).toBe(0);
    expect(t.listeners.size).toBe(0);
    t.advance(LINE_STEP_MS * 20);
    expect(t.visited).toEqual(['a', 'b', 'c']);
  });

  it('a move the board reports that is not the player’s own stops it too (a tapped move, a key)', () => {
    const t = setup();
    t.player.play(LINE);
    t.advance(LINE_STEP_MS);
    t.player.noteNavigation('somewhere-else');
    expect(t.player.isPlaying()).toBe(false);
    expect(t.timers.size).toBe(0);
    expect(t.listeners.size).toBe(0);
    t.advance(LINE_STEP_MS * 20);
    expect(t.visited).toEqual(['a', 'b']);
  });

  it('its own moves are not taken for the user’s', () => {
    const t = setup();
    t.player.play(LINE);
    t.advance(LINE_STEP_MS * 3);
    expect(t.player.isPlaying()).toBe(true);
  });

  it('with reduced motion it goes straight to the last move, with no delay, timer or listener', () => {
    const t = setup({ reducedMotion: true });
    t.player.play(LINE);
    expect(t.visited).toEqual(['h']);
    expect(t.timers.size).toBe(0);
    expect(t.listeners.size).toBe(0);
    expect(t.player.isPlaying()).toBe(false);
  });

  it('a single move is just shown', () => {
    const t = setup();
    t.player.play(['a']);
    expect(t.visited).toEqual(['a']);
    expect(t.timers.size).toBe(0);
    expect(t.listeners.size).toBe(0);
  });

  it('stops when the screen is no longer in view', () => {
    const t = setup();
    t.player.play(LINE);
    t.shown.value = false;
    t.advance(LINE_STEP_MS);
    expect(t.visited).toEqual(['a']);
    expect(t.player.isPlaying()).toBe(false);
    expect(t.timers.size).toBe(0);
    expect(t.listeners.size).toBe(0);
  });

  it('a new line replaces the one being played, with one timer and one listener at any time', () => {
    const t = setup();
    t.player.play(LINE);
    t.advance(LINE_STEP_MS);
    t.player.play(['x', 'y', 'z']);
    expect(t.timers.size).toBe(1);
    expect(t.listeners.size).toBe(1);
    t.advance(LINE_STEP_MS * 10);
    expect(t.visited).toEqual(['a', 'b', 'x', 'y', 'z']);
  });

  it('stopping twice, or with nothing playing, is harmless', () => {
    const t = setup();
    t.player.stop();
    t.player.play(LINE);
    t.player.stop();
    t.player.stop();
    expect(t.timers.size).toBe(0);
    expect(t.listeners.size).toBe(0);
    t.player.play([]);
    expect(t.visited).toEqual(['a']);
  });
});
