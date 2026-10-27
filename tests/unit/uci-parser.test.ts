import { describe, expect, it } from 'vitest';
import { formatScore, parseUciLine, scoreForWhite, scoreToCentipawns } from '../../src/engine/uci-parser';

describe('Phase 2 — UCI Output Parser', () => {
  it('parses id, uciok, readyok, and option lines accurately', () => {
    expect(parseUciLine('   ')).toBeNull();
    expect(parseUciLine('uciok')).toEqual({ type: 'uciok' });
    expect(parseUciLine('readyok')).toEqual({ type: 'readyok' });

    expect(parseUciLine('id name Stockfish 17.1 Lite WASM Multithreaded')).toEqual({
      type: 'id',
      field: 'name',
      value: 'Stockfish 17.1 Lite WASM Multithreaded',
    });

    expect(parseUciLine('id author the Stockfish developers (see AUTHORS file)')).toEqual({
      type: 'id',
      field: 'author',
      value: 'the Stockfish developers (see AUTHORS file)',
    });

    expect(parseUciLine('option name Threads type spin default 1 min 1 max 32')).toEqual({
      type: 'option',
      name: 'Threads',
      optionType: 'spin',
      defaultValue: 1,
      min: 1,
      max: 32,
    });

    expect(parseUciLine('option name UCI_Chess960 type check default false')).toEqual({
      type: 'option',
      name: 'UCI_Chess960',
      optionType: 'check',
      defaultValue: false,
    });

    expect(parseUciLine('option name Clear Hash type button')).toEqual({
      type: 'option',
      name: 'Clear Hash',
      optionType: 'button',
    });

    expect(parseUciLine('option name EvalFile type string default nn-9067e33176e8.nnue')).toEqual({
      type: 'option',
      name: 'EvalFile',
      optionType: 'string',
      defaultValue: 'nn-9067e33176e8.nnue',
    });

    expect(parseUciLine('option name EvalFileSmall type string default <empty>')).toEqual({
      type: 'option',
      name: 'EvalFileSmall',
      optionType: 'string',
      defaultValue: '',
    });

    expect(parseUciLine('option name Style type combo default Normal var Solid var Normal var Risky')).toEqual({
      type: 'option',
      name: 'Style',
      optionType: 'combo',
      defaultValue: 'Normal',
      vars: ['Solid', 'Normal', 'Risky'],
    });
  });

  it('parses MultiPV info lines with centipawns, mate scores, bounds, WDL, and PV', () => {
    const cpLine = parseUciLine(
      'info depth 12 seldepth 18 multipv 1 score cp 34 wdl 450 500 50 nodes 25410 nps 564666 hashfull 12 tbhits 0 time 45 currmove e2e4 currmovenumber 1 pv e2e4 e7e5 g1f3 b8c6',
    );
    expect(cpLine).toEqual({
      type: 'info',
      depth: 12,
      seldepth: 18,
      multipv: 1,
      score: { type: 'cp', value: 34 },
      wdl: [450, 500, 50],
      nodes: 25410,
      nps: 564666,
      hashfull: 12,
      tbhits: 0,
      timeMs: 45,
      currmove: 'e2e4',
      currmovenumber: 1,
      pv: ['e2e4', 'e7e5', 'g1f3', 'b8c6'],
    });

    const mateLine = parseUciLine(
      'info depth 16 seldepth 24 multipv 2 score mate -3 lowerbound nodes 81200 nps 610000 time 133 pv f7f6 d1h5 g7g6',
    );
    expect(mateLine).toEqual({
      type: 'info',
      depth: 16,
      seldepth: 24,
      multipv: 2,
      score: { type: 'mate', value: -3, bound: 'lowerbound' },
      nodes: 81200,
      nps: 610000,
      timeMs: 133,
      pv: ['f7f6', 'd1h5', 'g7g6'],
    });

    const infoStr = parseUciLine('info string NNUE evaluation using nn-9067e33176e8.nnue');
    expect(infoStr).toEqual({
      type: 'info_string',
      message: 'NNUE evaluation using nn-9067e33176e8.nnue',
    });
  });

  it('parses bestmove and perft output lines', () => {
    expect(parseUciLine('bestmove e2e4 ponder e7e5')).toEqual({
      type: 'bestmove',
      bestMove: 'e2e4',
      ponder: 'e7e5',
    });

    expect(parseUciLine('bestmove g1f3')).toEqual({
      type: 'bestmove',
      bestMove: 'g1f3',
      ponder: null,
    });

    expect(parseUciLine('bestmove (none)')).toEqual({
      type: 'bestmove',
      bestMove: null,
      ponder: null,
    });

    expect(parseUciLine('e2e4: 600')).toEqual({
      type: 'perft_divide',
      move: 'e2e4',
      nodes: 600,
    });

    expect(parseUciLine('Nodes searched: 197281')).toEqual({
      type: 'perft_total',
      nodes: 197281,
    });
  });

  it('normalizes scores to White perspective and centipawns', () => {
    expect(scoreForWhite({ type: 'cp', value: 45 }, 'w')).toEqual({
      type: 'cp',
      value: 45,
    });
    expect(scoreForWhite({ type: 'cp', value: 45, bound: 'lowerbound' }, 'b')).toEqual({
      type: 'cp',
      value: -45,
      bound: 'upperbound',
    });
    expect(scoreForWhite({ type: 'mate', value: 2 }, 'b')).toEqual({
      type: 'mate',
      value: -2,
    });

    expect(scoreToCentipawns({ type: 'cp', value: 120 })).toBe(120);
    expect(scoreToCentipawns({ type: 'mate', value: 1 })).toBeGreaterThan(
      scoreToCentipawns({ type: 'mate', value: 2 }),
    );
    expect(scoreToCentipawns({ type: 'mate', value: -1 })).toBeLessThan(scoreToCentipawns({ type: 'mate', value: -2 }));

    expect(formatScore({ type: 'cp', value: 35 })).toBe('+0.35');
    expect(formatScore({ type: 'cp', value: -120 })).toBe('-1.20');
    expect(formatScore({ type: 'mate', value: 2 })).toBe('#2');
    expect(formatScore({ type: 'mate', value: -3 })).toBe('#-3');
  });
});
