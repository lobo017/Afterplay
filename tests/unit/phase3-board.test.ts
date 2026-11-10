import { describe, expect, it } from 'vitest';
import { RulesAdapter } from '../../src/core/rules';
import { CathedralAudio } from '../../src/render/audio';
import { computePremoveTargets } from '../../src/render/board-renderer';
import { squareToBoardCoords } from '../../src/render/overlay';
import { PARTICLE_POOL_SIZE, SHARDS_PER_CAPTURE } from '../../src/render/particles';
import { getPieceSvgMarkup } from '../../src/render/piece-sets';
import { BOARD_THEMES, PIECE_SETS } from '../../src/render/themes';
import { ChessClock, TIME_CONTROL_PRESETS, formatClockMs } from '../../src/ui/clock';
import { computeCapturedAndMaterial } from '../../src/ui/play-controller';

describe('Phase 3 — 2D Board, Themes, Audio, Clocks & Legacy Regression Unit Tests', () => {
  it('provides 4 board themes (including marble-obsidian, green and high-contrast) and 4 SVG piece sets', () => {
    expect(Object.keys(BOARD_THEMES)).toEqual(['marble-obsidian', 'imperial-walnut', 'green', 'high-contrast']);
    expect(BOARD_THEMES['marble-obsidian'].lightSquareBase).toBe('#f2ede4');
    expect(BOARD_THEMES['marble-obsidian'].darkSquareBase).toBe('#121620');
    expect(BOARD_THEMES['high-contrast'].lightSquareBase).toBe('#ffffff');

    // Phase 11: the flat green board (no veins or chamfer) and the Classic set (ready-made drawings, 45-unit box)
    expect(BOARD_THEMES.green.lightSquareBase).toBe('#edeed4');
    expect(BOARD_THEMES.green.darkSquareBase).toBe('#6f9654');
    expect(BOARD_THEMES.green.lightSquareVein).toBe('transparent');

    expect(Object.keys(PIECE_SETS)).toEqual(['cathedral', 'staunton', 'classic', 'high-contrast']);
    expect(getPieceSvgMarkup('classic', 'w', 'k')).toContain('viewBox="0 0 45 45"');
    expect(getPieceSvgMarkup('classic', 'w', 'k')).not.toBe(getPieceSvgMarkup('classic', 'b', 'k'));
    expect(getPieceSvgMarkup('cathedral', 'w', 'k')).toContain('viewBox="0 0 100 100"');

    const pieces = ['p', 'n', 'b', 'r', 'q', 'k'] as const;
    const colors = ['w', 'b'] as const;
    for (const setId of Object.keys(PIECE_SETS) as Array<keyof typeof PIECE_SETS>) {
      for (const color of colors) {
        for (const piece of pieces) {
          const svg1 = getPieceSvgMarkup(setId, color, piece);
          const svg2 = getPieceSvgMarkup(setId, color, piece);
          expect(svg1).toContain('<svg');
          expect(svg1).toBe(svg2); // Cached reference equality
        }
      }
    }
  });

  it('computes accurate 800x800 SVG board coordinates in both standard and flipped orientations', () => {
    const a8 = squareToBoardCoords('a8', false);
    expect(a8).toEqual({ col: 0, row: 0, x: 0, y: 0, cx: 50, cy: 50 });

    const e2 = squareToBoardCoords('e2', false);
    expect(e2).toEqual({ col: 4, row: 6, x: 400, y: 600, cx: 450, cy: 650 });

    const e2Flipped = squareToBoardCoords('e2', true);
    expect(e2Flipped).toEqual({
      col: 3,
      row: 1,
      x: 300,
      y: 100,
      cx: 350,
      cy: 150,
    });
  });

  it('computes pseudo-legal premove targets including empty-square pawn diagonals and castling squares', () => {
    const adapter = new RulesAdapter();
    const e2Targets = computePremoveTargets(adapter, 'e2', 'w');
    expect(e2Targets.sort()).toEqual(['d3', 'e3', 'e4', 'f3']);

    const g1Targets = computePremoveTargets(adapter, 'g1', 'w');
    expect(g1Targets.sort()).toEqual(['e2', 'f3', 'h3']);

    const e1Targets = computePremoveTargets(adapter, 'e1', 'w');
    expect(e1Targets).toContain('g1');
    expect(e1Targets).toContain('c1');
  });

  it('tracks high-precision ChessClock time controls with Fischer increment and flag detection', () => {
    let now = 1000;
    const flagged: string[] = [];
    const clock = new ChessClock({
      config: TIME_CONTROL_PRESETS['3+2'],
      nowFn: () => now,
      onFlag: (c) => flagged.push(c),
    });

    const initial = clock.getSnapshot();
    expect(initial.whiteMs).toBe(180_000);
    expect(initial.blackMs).toBe(180_000);
    expect(initial.whiteFormatted).toBe('3:00');

    // Start White's clock at t=1000
    clock.start('w', now);
    // White thinks for 4.5s and moves at t=5500 -> gets +2.0s increment (180 - 4.5 + 2 = 177.5s)
    now = 5500;
    const afterWhite = clock.switchTurn('w', now);
    expect(afterWhite.whiteMs).toBe(177_500);
    expect(afterWhite.activeColor).toBe('b');

    // Black thinks for 10s and moves at t=15500 -> gets +2.0s increment (180 - 10 + 2 = 172s)
    now = 15_500;
    const afterBlack = clock.switchTurn('b', now);
    expect(afterBlack.blackMs).toBe(172_000);
    expect(afterBlack.activeColor).toBe('w');

    // Format under 10 seconds shows tenths
    expect(formatClockMs(8_420, false)).toBe('0:08.4');
    expect(formatClockMs(0, true)).toBe('∞');

    // Simulate White flagging
    now = 200_000;
    const flaggedSnap = clock.tick(now);
    expect(flaggedSnap.whiteMs).toBe(0);
    expect(flaggedSnap.flaggedColor).toBe('w');
    expect(flagged).toEqual(['w']);
    clock.destroy();
  });

  it('Legacy Hotspot #4 Regression: CathedralAudio initializes lazily and reuses a single cached noise AudioBuffer across stone slides', () => {
    let createBufferCalls = 0;
    const mockCtx = {
      state: 'running',
      sampleRate: 44100,
      currentTime: 0,
      destination: {},
      resume: async () => {},
      createBuffer: (_channels: number, length: number) => {
        createBufferCalls++;
        return {
          getChannelData: () => new Float32Array(length),
        };
      },
      createBufferSource: () => ({
        buffer: null,
        connect: () => {},
        start: () => {},
      }),
      createBiquadFilter: () => ({
        type: 'bandpass',
        frequency: {
          setValueAtTime: () => {},
          linearRampToValueAtTime: () => {},
        },
        Q: { value: 0 },
        connect: () => {},
      }),
      createGain: () => ({
        gain: {
          value: 1,
          setValueAtTime: () => {},
          linearRampToValueAtTime: () => {},
          exponentialRampToValueAtTime: () => {},
        },
        connect: () => {},
      }),
      createOscillator: () => ({
        type: 'sine',
        frequency: {
          setValueAtTime: () => {},
          exponentialRampToValueAtTime: () => {},
        },
        connect: () => {},
        start: () => {},
        stop: () => {},
      }),
    } as unknown as AudioContext;

    const audio = new CathedralAudio({
      volume: 0.8,
      contextFactory: () => mockCtx,
    });

    // Not initialized before first user sound/gesture
    expect(audio.isInitialized()).toBe(false);
    expect(createBufferCalls).toBe(0);

    // Trigger 10 grounded stone slide moves + select + shatter + check + gameOver
    for (let i = 0; i < 10; i++) {
      audio.playSlide(false);
    }
    audio.playSlide(true);
    audio.playSelect();
    audio.playShatter();
    audio.playCheck();
    audio.playGameOver(true);

    expect(audio.isInitialized()).toBe(true);
    // White-noise buffer was allocated exactly ONCE and reused across all 10 stone slides
    expect(createBufferCalls).toBe(1);
    expect(audio.getNoiseBufferAllocationCount()).toBe(1);

    // Volume slider clamping
    audio.setVolume(0.35);
    expect(audio.getVolume()).toBe(0.35);
    audio.setVolume(2.0);
    expect(audio.getVolume()).toBe(1.0);
    audio.setVolume(-1.0);
    expect(audio.getVolume()).toBe(0.0);
  });

  it('Legacy Bug #5 Regression: computeCapturedAndMaterial never miscounts a promoted pawn as captured by the opponent', () => {
    // Position where White promotes a pawn on a8 without capturing anything, and then Black captures that promoted Queen
    const adapter = new RulesAdapter('1rb1kbnr/Pppppppp/8/8/8/8/1PPPPPPP/RNBQKBNR w KQk - 0 1');
    const move1 = adapter.move({ from: 'a7', to: 'a8', promotion: 'q' }); // a8=Q

    // After White promotes a7->a8=Q, Black has captured ZERO White pawns!
    const afterPromotion = computeCapturedAndMaterial([move1]);
    expect(afterPromotion.capturedByBlack).toEqual([]);
    expect(afterPromotion.capturedByWhite).toEqual([]);
    expect(afterPromotion.netAdvantageWhite).toBe(8); // +9 Queen - 1 Pawn = +8 material advantage for White

    // Now Black captures the promoted Queen on a8 with Rxa8
    const move2 = adapter.move({ from: 'b8', to: 'a8' }); // Rxa8
    const afterRecapture = computeCapturedAndMaterial([move1, move2]);
    // Black captured a Queen ('q'), NOT a phantom pawn, and net advantage is -1 (White lost the promoted pawn)
    expect(afterRecapture.capturedByBlack).toEqual(['q']);
    expect(afterRecapture.netAdvantageWhite).toBe(-1);
  });

  it('constants for fixed capture particle pool match legacy specification (180 pool, 54 per capture)', () => {
    expect(PARTICLE_POOL_SIZE).toBe(180);
    expect(SHARDS_PER_CAPTURE).toBe(54);
  });
});
