import { describe, expect, it } from 'vitest';
import {
  BOT_STYLE_PRESETS,
  BOT_TIERS,
  ChessBot,
  clampBotRating,
  computeBotEngineParams,
  getTierForRating,
  selectHumanLikeMove,
} from '../../src/engine/bot';
import type { EngineLine } from '../../src/engine/cache';

function makeLine(
  multipv: number,
  evalCp: number,
  pv: string[],
  mate?: number,
): EngineLine {
  const score =
    mate !== undefined
      ? ({ type: 'mate', value: mate } as const)
      : ({ type: 'cp', value: evalCp } as const);
  return {
    multipv,
    depth: 12,
    seldepth: 16,
    score,
    scoreWhite: score,
    evalCp,
    nodes: 10000,
    nps: 400000,
    timeMs: 25,
    pv,
  };
}

describe('Phase 2 — Human-Like Playing Bot (400–2400 Elo & Style Presets)', () => {
  it('defines all five rating tiers (Novice, Casual, Club, Expert, Master) across 400–2400 and all three style presets', () => {
    expect(Object.keys(BOT_TIERS)).toEqual([
      'Novice',
      'Casual',
      'Club',
      'Expert',
      'Master',
    ]);
    expect(Object.keys(BOT_STYLE_PRESETS)).toEqual([
      'aggressive',
      'solid',
      'gambiteer',
    ]);

    expect(clampBotRating(100)).toBe(400);
    expect(clampBotRating(3000)).toBe(2400);
    expect(getTierForRating(400)).toBe('Novice');
    expect(getTierForRating(600)).toBe('Novice');
    expect(getTierForRating(1000)).toBe('Casual');
    expect(getTierForRating(1400)).toBe('Club');
    expect(getTierForRating(1800)).toBe('Expert');
    expect(getTierForRating(2200)).toBe('Master');
    expect(getTierForRating(2400)).toBe('Master');

    const noviceParams = computeBotEngineParams('Novice', 'solid');
    const masterParams = computeBotEngineParams('Master', 'solid');
    expect(noviceParams.skillLevel).toBeLessThan(masterParams.skillLevel);
    expect(noviceParams.temperatureCp).toBeGreaterThan(
      masterParams.temperatureCp,
    );
    expect(noviceParams.maxPlausibleDropCp).toBeGreaterThan(
      masterParams.maxPlausibleDropCp,
    );
  });

  it('weights candidate moves by centipawn drop so weak bots make plausible mistakes while suppressing catastrophic queen blunders', () => {
    // Position where White has:
    // 1. Best move: Nf3 (+40 cp)
    // 2. Plausible inaccuracy: Bc4 (-25 cp, drop = 65 cp)
    // 3. Plausible mistake: a3 (-60 cp, drop = 100 cp)
    // 4. Catastrophic Queen blunder: Qg4 (-850 cp, drop = 890 cp)
    const fen =
      'r1bqkbnr/pppp1ppp/2n5/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 2 3';
    const lines: EngineLine[] = [
      makeLine(1, 40, ['g1f3', 'g8f6']),
      makeLine(2, -25, ['f1c4', 'g8f6']),
      makeLine(3, -60, ['a2a3', 'g8f6']),
      makeLine(4, -850, ['d1g4', 'd7d5']),
    ];

    const noviceDecision = selectHumanLikeMove({
      fen,
      lines,
      ratingOrTier: 'Novice',
      style: 'solid',
      rng: () => 0.75, // Sample into secondary plausible lines
    });

    const nf3Prob =
      noviceDecision.candidates.find((c) => c.san === 'Nf3')?.probability ?? 0;
    const bc4Prob =
      noviceDecision.candidates.find((c) => c.san === 'Bc4')?.probability ?? 0;
    const a3Prob =
      noviceDecision.candidates.find((c) => c.san === 'a3')?.probability ?? 0;
    const qg4Prob =
      noviceDecision.candidates.find((c) => c.san === 'Qg4')?.probability ?? 0;

    // Plausible inaccuracy/mistake have substantial human-like weight (>15% combined)
    expect(bc4Prob + a3Prob).toBeGreaterThan(0.15);
    // Catastrophic 890cp queen blunder is heavily suppressed (<0.001)
    expect(qg4Prob).toBeLessThan(0.001);
    expect(nf3Prob).toBeGreaterThan(bc4Prob);

    // Master (2400) overwhelmingly picks the best move (>99%)
    const masterDecision = selectHumanLikeMove({
      fen,
      lines,
      ratingOrTier: 2400,
      style: 'solid',
      rng: () => 0.9,
    });
    const masterNf3Prob =
      masterDecision.candidates.find((c) => c.san === 'Nf3')?.probability ?? 0;
    expect(masterNf3Prob).toBeGreaterThan(0.99);
    expect(masterDecision.san).toBe('Nf3');
  });

  it('applies style presets (aggressive, solid, gambiteer) to shift move preferences among close candidates', () => {
    // Position: White can castle (O-O, quiet/solid), give check/capture (Bxf7+ or Nxd4), or push a gambit pawn (d4)
    const fen =
      'r1bqk1nr/pppp1ppp/2n5/2b1p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4';
    const lines: EngineLine[] = [
      // Line 1: O-O (+30 cp, quiet castling)
      makeLine(1, 30, ['e1g1', 'g8f6']),
      // Line 2: b4 (+10 cp, Evans Gambit pawn offer on b4 where bishop on c5 can take!)
      makeLine(2, 10, ['b2b4', 'c5b4']),
      // Line 3: Bxf7+ (-15 cp, aggressive check + capture)
      makeLine(3, -15, ['c4f7', 'e8f7']),
    ];

    const solidRes = selectHumanLikeMove({
      fen,
      lines,
      ratingOrTier: 'Club',
      style: 'solid',
      rng: () => 0.1,
    });
    const aggRes = selectHumanLikeMove({
      fen,
      lines,
      ratingOrTier: 'Club',
      style: 'aggressive',
      rng: () => 0.1,
    });
    const gambitRes = selectHumanLikeMove({
      fen,
      lines,
      ratingOrTier: 'Club',
      style: 'gambiteer',
      rng: () => 0.1,
    });

    const solidCastleProb =
      solidRes.candidates.find((c) => c.san === 'O-O')?.probability ?? 0;
    const aggCastleProb =
      aggRes.candidates.find((c) => c.san === 'O-O')?.probability ?? 0;

    const aggCheckProb =
      aggRes.candidates.find((c) => c.san === 'Bxf7+')?.probability ?? 0;
    const solidCheckProb =
      solidRes.candidates.find((c) => c.san === 'Bxf7+')?.probability ?? 0;

    const gambitB4Prob =
      gambitRes.candidates.find((c) => c.san === 'b4')?.probability ?? 0;
    const solidB4Prob =
      solidRes.candidates.find((c) => c.san === 'b4')?.probability ?? 0;

    expect(solidCastleProb).toBeGreaterThan(aggCastleProb);
    expect(aggCheckProb).toBeGreaterThan(solidCheckProb);
    expect(gambitB4Prob).toBeGreaterThan(solidB4Prob);
  });

  it('locks onto short forced mates for Club+ bots', () => {
    const mateFen =
      'r1bqkb1r/pppp1ppp/2n2n2/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR w KQkq - 4 4';
    const lines: EngineLine[] = [
      makeLine(1, 9990, ['h5f7'], 1),
      makeLine(2, 50, ['d2d3'], undefined),
    ];

    const clubBot = new ChessBot(
      {
        analyze: async () => ({
          fen: mateFen,
          normalizedFen: mateFen,
          depth: 10,
          multipv: 2,
          bestMove: 'h5f7',
          ponder: null,
          lines,
          nodes: 1000,
          nps: 100000,
          timeMs: 10,
          cached: false,
        }),
      } as unknown as ConstructorParameters<typeof ChessBot>[0],
      { rating: 'Club', style: 'solid', rng: () => 0.99 },
    );

    return clubBot.chooseMove(mateFen).then((decision) => {
      expect(decision.san).toBe('Qxf7#');
      expect(decision.uci).toBe('h5f7');
    });
  });
});
