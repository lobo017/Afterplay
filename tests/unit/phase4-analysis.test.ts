import { describe, expect, it } from 'vitest';
import {
  OPENINGS_BY_EPD,
  formatOpeningBadge,
  lookupGameOpening,
  lookupOpeningByFen,
} from '../../src/analysis/opening-lookup';
import {
  cpToWhiteWinPercent,
  formatEvalBarScore,
  pgnEvalToUciScore,
  scoreToEvalBarPercent,
  scoreToWhiteWinPercent,
} from '../../src/analysis/eval-bar';
import {
  buildNullMoveFen,
  detectOpponentThreat,
} from '../../src/analysis/threat-detector';
import { formatPvMovesToSan } from '../../src/analysis/engine-lines-panel';
import {
  parseFenForEditor,
  serializeEditorBoardToFen,
} from '../../src/analysis/position-editor';
import {
  ANNOTATION_COLOR_HEX,
  hexToAnnotationColor,
  resolveModifierAnnotationColor,
} from '../../src/render/overlay';
import { DEFAULT_POSITION, validateChessFen } from '../../src/core/rules';
import { GameTree } from '../../src/core/game-tree';
import type { EngineAnalysisResult, EngineClient } from '../../src/engine/engine-client';

describe('Phase 4 — Opening Lookup (data/openings.json)', () => {
  it('loads bundled opening dataset and looks up ECO codes and names by FEN', () => {
    expect(Object.keys(OPENINGS_BY_EPD).length).toBeGreaterThan(3000);

    // Italian Game: 1.e4 e5 2.Nf3 Nc6 3.Bc4
    const italianFen =
      'r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 3 3';
    const italian = lookupOpeningByFen(italianFen);
    expect(italian).not.toBeNull();
    expect(italian?.eco).toBe('C50');
    expect(italian?.name).toContain('Italian Game');
    expect(formatOpeningBadge(italian)).toBe(`${italian?.eco} · ${italian?.name}`);

    // Sicilian Defense: 1.e4 c5
    const sicilianFen =
      'rnbqkbnr/pp1ppppp/8/2p5/4P3/8/PPPP1PPP/RNBQKBNR w KQkq c6 0 2';
    const sicilian = lookupOpeningByFen(sicilianFen);
    expect(sicilian).not.toBeNull();
    expect(sicilian?.eco).toBe('B20');
    expect(sicilian?.name).toContain('Sicilian');
  });

  it('retains the deepest known opening along a GameTree variation line', () => {
    const tree = new GameTree();
    tree.addMove('e2e4');
    tree.addMove('e7e5');
    tree.addMove('g1f3');
    tree.addMove('b8c6');
    tree.addMove('f1b5'); // Ruy Lopez (C60)
    const ruyNodeId = tree.currentNodeId;
    const ruyOpening = lookupGameOpening(tree, ruyNodeId);
    expect(ruyOpening?.eco).toBe('C60');
    expect(ruyOpening?.name).toContain('Ruy Lopez');

    // Play several deeper moves that leave the book; lookupGameOpening still returns the deepest book match
    tree.addMove('a7a6');
    tree.addMove('b5a4');
    tree.addMove('g8f6');
    tree.addMove('d2d3');
    tree.addMove('h7h6');
    tree.addMove('c2c3');
    const deepOpening = lookupGameOpening(tree);
    expect(deepOpening).not.toBeNull();
    expect(deepOpening?.name).toContain('Ruy Lopez');
  });
});

describe('Phase 4 — EvalBar Math & Formatting', () => {
  it('maps centipawns and mate scores to bounded White win percentages', () => {
    expect(cpToWhiteWinPercent(0)).toBeCloseTo(50, 5);
    expect(cpToWhiteWinPercent(300)).toBeGreaterThan(70);
    expect(cpToWhiteWinPercent(-300)).toBeLessThan(30);
    expect(cpToWhiteWinPercent(10000)).toBeLessThanOrEqual(100);
    expect(cpToWhiteWinPercent(-10000)).toBeGreaterThanOrEqual(0);

    // Visual fill percentage is clamped to [4%, 96%] for non-mate scores
    expect(scoreToEvalBarPercent({ type: 'cp', value: 10000 })).toBe(96);
    expect(scoreToEvalBarPercent({ type: 'cp', value: -10000 })).toBe(4);

    // Mate scores fill 100% or 0%
    expect(scoreToWhiteWinPercent({ type: 'mate', value: 3 })).toBe(100);
    expect(scoreToWhiteWinPercent({ type: 'mate', value: -2 })).toBe(0);
    expect(scoreToEvalBarPercent({ type: 'mate', value: 2 })).toBe(100);
    expect(scoreToEvalBarPercent({ type: 'mate', value: -2 })).toBe(0);
  });

  it('computes white fill percentage and formats scores cleanly', () => {
    const evenPct = scoreToEvalBarPercent({ type: 'cp', value: 0 });
    expect(evenPct).toBeCloseTo(50, 4);

    expect(formatEvalBarScore({ type: 'cp', value: 145 })).toBe('+1.45');
    expect(formatEvalBarScore({ type: 'cp', value: -80 })).toBe('-0.80');
    expect(formatEvalBarScore({ type: 'mate', value: 4 })).toBe('M4');
    expect(formatEvalBarScore({ type: 'mate', value: -2 })).toBe('-M2');

    expect(pgnEvalToUciScore({ cp: 65 })).toEqual({ type: 'cp', value: 65 });
    expect(pgnEvalToUciScore({ mate: -3 })).toEqual({
      type: 'mate',
      value: -3,
    });
  });
});

describe('Phase 4 — Null-Move Threat Detection', () => {
  it('builds a valid null-move FEN when not in check and rejects in-check positions', () => {
    const startNull = buildNullMoveFen(DEFAULT_POSITION);
    expect(startNull).toBe(
      'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR b KQkq - 1 1',
    );

    // Black to move -> White to move, ep square cleared, fullmove increments
    const afterE4 =
      'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1';
    expect(buildNullMoveFen(afterE4)).toBe(
      'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 1 2',
    );

    // Position where White is in check -> cannot null-move
    const whiteInCheckFen =
      'rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3';
    expect(buildNullMoveFen(whiteInCheckFen)).toBeNull();
  });

  it('detects the opponent threat via null-move search', async () => {
    // Scholar's Mate setup where White threatens Qxf7# if Black passes their turn
    const scholarsSetupFen =
      'r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5Q2/PPPP1PPP/RNB1K1NR b KQkq - 3 3';
    const fakeEngine = {
      analyze: async (req: { fen: string }): Promise<EngineAnalysisResult> => {
        expect(req.fen).toContain(' w KQkq - 4 4');
        return {
          fen: req.fen,
          normalizedFen: req.fen,
          bestMove: 'f3f7',
          ponder: null,
          depth: 10,
          multipv: 1,
          nps: 100000,
          nodes: 2500,
          timeMs: 25,
          cached: false,
          lines: [
            {
              multipv: 1,
              depth: 10,
              seldepth: 14,
              score: { type: 'mate', value: 1 },
              scoreWhite: { type: 'mate', value: 1 },
              evalCp: 99990,
              pv: ['f3f7'],
              nps: 100000,
              nodes: 2500,
              timeMs: 25,
            },
          ],
        };
      },
    } as unknown as EngineClient;

    const threat = await detectOpponentThreat(fakeEngine, scholarsSetupFen, {
      depth: 10,
    });
    expect(threat).not.toBeNull();
    expect(threat?.uci).toBe('f3f7');
    expect(threat?.from).toBe('f3');
    expect(threat?.to).toBe('f7');
    expect(threat?.san).toBe('Qxf7#');
  });
});

describe('Phase 4 — Engine PV Formatting & Ghost Target Calculation', () => {
  it('converts UCI PV sequences into SAN tokens and computes target FEN', () => {
    const pv = ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1b5'];
    const moves = formatPvMovesToSan(DEFAULT_POSITION, pv, 5);
    expect(moves).toHaveLength(5);
    expect(moves.map((m) => m.san)).toEqual(['e4', 'e5', 'Nf3', 'Nc6', 'Bb5']);
    expect(moves[0]?.prefix).toBe('1.');
    expect(moves[1]?.prefix).toBe('');
    expect(moves[2]?.prefix).toBe('2.');
    expect(moves[4]?.fenAfter).toBe(
      'r1bqkbnr/pppp1ppp/2n5/1B2p3/4P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 3 3',
    );
  });
});

describe('Phase 4 — Position Editor FEN Parsing & Validation', () => {
  it('round-trips board state through parseFenForEditor and serializeEditorBoardToFen', () => {
    const parsed = parseFenForEditor(DEFAULT_POSITION);
    expect(parsed).not.toBeNull();
    if (!parsed) return;

    expect(parsed.turn).toBe('w');
    expect(parsed.castling).toBe('KQkq');
    expect(parsed.squares.get('e1')).toEqual({ color: 'w', type: 'k' });
    expect(parsed.squares.get('e8')).toEqual({ color: 'b', type: 'k' });

    const serialized = serializeEditorBoardToFen(parsed);
    expect(serialized).toBe(DEFAULT_POSITION);
    expect(validateChessFen(serialized).ok).toBe(true);

    // Remove White King -> validateChessFen rejects it
    parsed.squares.delete('e1');
    parsed.castling = '-';
    const missingKingFen = serializeEditorBoardToFen(parsed);
    const validation = validateChessFen(missingKingFen);
    expect(validation.ok).toBe(false);
  });
});

describe('Phase 4 — Arrow & Circle Modifier Colors', () => {
  it('resolves modifier keys to G/R/B/Y PGN annotation colors', () => {
    expect(resolveModifierAnnotationColor({}).code).toBe('G');
    expect(resolveModifierAnnotationColor({ shiftKey: true }).code).toBe('R');
    expect(resolveModifierAnnotationColor({ altKey: true }).code).toBe('B');
    expect(resolveModifierAnnotationColor({ ctrlKey: true }).code).toBe('Y');
    expect(
      resolveModifierAnnotationColor({ shiftKey: true, altKey: true }).code,
    ).toBe('Y');

    expect(hexToAnnotationColor(ANNOTATION_COLOR_HEX.G)).toBe('G');
    expect(hexToAnnotationColor(ANNOTATION_COLOR_HEX.R)).toBe('R');
    expect(hexToAnnotationColor(ANNOTATION_COLOR_HEX.B)).toBe('B');
    expect(hexToAnnotationColor(ANNOTATION_COLOR_HEX.Y)).toBe('Y');
  });
});
