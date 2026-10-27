import { describe, expect, it } from 'vitest';
import {
  BOT_STYLE_PRESETS,
  BOT_TIERS,
  ChessBot,
  clampBotRating,
  computeBotEngineParams,
  computeBotThinkTimeMs,
  findPlausibleHumanBlunderCandidates,
  getTierForRating,
  scoreMoveHumanPlausibility,
  selectHumanLikeMove,
} from '../../src/engine/bot';
import { RulesAdapter } from '../../src/core/rules';
import type { EngineLine } from '../../src/engine/cache';

function makeLine(multipv: number, evalCp: number, pv: string[], mate?: number): EngineLine {
  const score =
    mate !== undefined ? ({ type: 'mate', value: mate } as const) : ({ type: 'cp', value: evalCp } as const);
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
    expect(Object.keys(BOT_TIERS)).toEqual(['Novice', 'Casual', 'Club', 'Expert', 'Master']);
    expect(Object.keys(BOT_STYLE_PRESETS)).toEqual(['aggressive', 'solid', 'gambiteer']);

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
    expect(noviceParams.temperatureCp).toBeGreaterThan(masterParams.temperatureCp);
    expect(noviceParams.maxPlausibleDropCp).toBeGreaterThan(masterParams.maxPlausibleDropCp);
  });

  it('weights candidate moves by centipawn drop so weak bots make plausible mistakes while suppressing catastrophic queen blunders', () => {
    // Position where White has:
    // 1. Best move: Nf3 (+40 cp)
    // 2. Plausible inaccuracy: Bc4 (-25 cp, drop = 65 cp)
    // 3. Plausible mistake: a3 (-60 cp, drop = 100 cp)
    // 4. Catastrophic Queen blunder: Qg4 (-850 cp, drop = 890 cp)
    const fen = 'r1bqkbnr/pppp1ppp/2n5/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 2 3';
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

    const nf3Prob = noviceDecision.candidates.find((c) => c.san === 'Nf3')?.probability ?? 0;
    const bc4Prob = noviceDecision.candidates.find((c) => c.san === 'Bc4')?.probability ?? 0;
    const a3Prob = noviceDecision.candidates.find((c) => c.san === 'a3')?.probability ?? 0;
    const qg4Prob = noviceDecision.candidates.find((c) => c.san === 'Qg4')?.probability ?? 0;

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
    const masterNf3Prob = masterDecision.candidates.find((c) => c.san === 'Nf3')?.probability ?? 0;
    expect(masterNf3Prob).toBeGreaterThan(0.99);
    expect(masterDecision.san).toBe('Nf3');
  });

  it('applies style presets (aggressive, solid, gambiteer) to shift move preferences among close candidates', () => {
    // Position: White can castle (O-O, quiet/solid), give check/capture (Bxf7+ or Nxd4), or push a gambit pawn (d4)
    const fen = 'r1bqk1nr/pppp1ppp/2n5/2b1p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4';
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

    const solidCastleProb = solidRes.candidates.find((c) => c.san === 'O-O')?.probability ?? 0;
    const aggCastleProb = aggRes.candidates.find((c) => c.san === 'O-O')?.probability ?? 0;

    const aggCheckProb = aggRes.candidates.find((c) => c.san === 'Bxf7+')?.probability ?? 0;
    const solidCheckProb = solidRes.candidates.find((c) => c.san === 'Bxf7+')?.probability ?? 0;

    const gambitB4Prob = gambitRes.candidates.find((c) => c.san === 'b4')?.probability ?? 0;
    const solidB4Prob = solidRes.candidates.find((c) => c.san === 'b4')?.probability ?? 0;

    expect(solidCastleProb).toBeGreaterThan(aggCastleProb);
    expect(aggCheckProb).toBeGreaterThan(solidCheckProb);
    expect(gambitB4Prob).toBeGreaterThan(solidB4Prob);
  });

  it('locks onto short forced mates for Club+ bots', () => {
    const mateFen = 'r1bqkb1r/pppp1ppp/2n2n2/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR w KQkq - 4 4';
    const lines: EngineLine[] = [makeLine(1, 9990, ['h5f7'], 1), makeLine(2, 50, ['d2d3'], undefined)];

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

  it('scales node limits, Skill Level, MultiPV (6–8 at low levels), and enables UCI_LimitStrength only where UCI_Elo >= 1320', () => {
    const p400 = computeBotEngineParams(400, 'solid');
    const p600 = computeBotEngineParams(600, 'solid');
    const p1000 = computeBotEngineParams(1000, 'solid');
    const p1400 = computeBotEngineParams(1400, 'solid');
    const p1800 = computeBotEngineParams(1800, 'solid');
    const p2200 = computeBotEngineParams(2200, 'solid');
    const p2400 = computeBotEngineParams(2400, 'solid');

    // UCI_Elo has a minimum of 1320, so uciLimitStrength is false below 1320
    expect(p400.uciLimitStrength).toBe(false);
    expect(p600.uciLimitStrength).toBe(false);
    expect(p1000.uciLimitStrength).toBe(false);
    expect(p1400.uciLimitStrength).toBe(true);
    expect(p1800.uciLimitStrength).toBe(true);
    expect(p2200.uciLimitStrength).toBe(true);
    expect(p2400.uciLimitStrength).toBe(false);

    // MultiPV is 6–8 at low/club levels
    expect(p400.multipv).toBe(8);
    expect(p600.multipv).toBe(8);
    expect(p1000.multipv).toBe(7);
    expect(p1400.multipv).toBe(6);

    // Node limits increase strictly from 400 to 2400
    expect(p400.nodes).toBeLessThan(p600.nodes);
    expect(p600.nodes).toBeLessThan(p1000.nodes);
    expect(p1000.nodes).toBeLessThan(p1400.nodes);
    expect(p1400.nodes).toBeLessThan(p1800.nodes);
    expect(p1800.nodes).toBeLessThan(p2200.nodes);
    expect(p2200.nodes).toBeLessThan(p2400.nodes);

    // Blunder chance decreases strictly from 400 to 2400
    expect(p400.blunderChance).toBeGreaterThan(p600.blunderChance);
    expect(p600.blunderChance).toBeGreaterThan(p1000.blunderChance);
    expect(p1000.blunderChance).toBeGreaterThan(p1400.blunderChance);
    expect(p1400.blunderChance).toBeGreaterThan(p1800.blunderChance);
    expect(p1800.blunderChance).toBeGreaterThan(p2200.blunderChance);
    expect(p2400.blunderChance).toBe(0);
  });

  it('identifies plausible human blunders (missed threats or hanging pieces) while rejecting random-looking walks', () => {
    // Black's knight on c6 attacks White's knight on e5 (320 cp).
    // White has a natural developing move (Nc3) that misses that e5 is hanging, vs an absurd King walk Ke2.
    const fen = 'r1bqk1nr/pppp1ppp/2n5/2b1N3/4P3/8/PPPP1PPP/RNBQKB1R w KQkq - 1 4';
    const adapter = new RulesAdapter(fen);
    const legalMoves = adapter.verboseMoves();

    const nc3Move = legalMoves.find((m) => m.san === 'Nc3')!;
    const ke2Move = legalMoves.find((m) => m.san === 'Ke2')!;
    expect(nc3Move).toBeDefined();
    expect(ke2Move).toBeDefined();

    // Developing knight Nc3 is human-plausible; uncastled King walk Ke2 is rejected (0)
    expect(scoreMoveHumanPlausibility(adapter, nc3Move)).toBeGreaterThan(15);
    expect(scoreMoveHumanPlausibility(adapter, ke2Move)).toBe(0);

    // Suppose Nd3 (+40 cp) saves the knight on e5, while Nc3 (-220 cp) leaves e5 hanging to Nxe5
    const nd3Move = legalMoves.find((m) => m.san === 'Nd3')!;
    const blunderCands = findPlausibleHumanBlunderCandidates(adapter, legalMoves, new Set([nd3Move.uci]), nd3Move, 40);
    expect(blunderCands.some((c) => c.move.san === 'Nc3')).toBe(true);
    expect(blunderCands.some((c) => c.move.san === 'Ke2')).toBe(false);

    const lines: EngineLine[] = [
      makeLine(1, 40, ['e5d3', 'c5b6']),
      makeLine(2, -220, ['b1c3', 'c6e5']),
      makeLine(3, -300, ['e1e2', 'c6e5']),
    ];

    const dec = selectHumanLikeMove({
      fen,
      lines,
      ratingOrTier: 600,
      style: 'solid',
      rng: () => 0.99, // High draw samples from the human blunder tail
      enableHumanBlunders: true,
    });
    expect(dec.san).not.toBe('Ke2');
    const chosenCand = dec.candidates.find((c) => c.uci === dec.uci);
    expect(chosenCand?.isHumanBlunder).toBe(true);
  });

  it('computes human-like thinking time varying with forced moves, recaptures, position complexity, game phase, and clock remaining', () => {
    // 1. Forced move (only 1 legal reply: King in check with only 1 escape) -> near minDelayMs
    const forcedCheckFen = '7k/8/8/8/8/8/6q1/7K w - - 0 1';
    const forcedDelay = computeBotThinkTimeMs({
      fen: forcedCheckFen,
      minDelayMs: 500,
      maxDelayMs: 3000,
      unlimitedClock: true,
      rng: () => 0.5,
    });
    expect(forcedDelay).toBe(500);

    // 2. Early opening vs sharp tactical middlegame
    const openingFen = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';
    const sharpMiddlegameFen = 'r1bq1rk1/ppp2ppp/2np1n2/2b1p1B1/2B1P3/2NP1N2/PPP2PPP/R2Q1RK1 b - - 4 7';

    const openingDelay = computeBotThinkTimeMs({
      fen: openingFen,
      ply: 1,
      minDelayMs: 500,
      maxDelayMs: 3000,
      unlimitedClock: true,
      rng: () => 0.5,
    });
    const sharpDelay = computeBotThinkTimeMs({
      fen: sharpMiddlegameFen,
      ply: 14,
      minDelayMs: 500,
      maxDelayMs: 3000,
      unlimitedClock: true,
      rng: () => 0.5,
    });
    expect(sharpDelay).toBeGreaterThan(openingDelay);
    expect(openingDelay).toBeGreaterThanOrEqual(500);
    expect(sharpDelay).toBeLessThanOrEqual(3000);

    // 3. Respects low remaining clock in timed games (< 5 seconds left)
    const timeTroubleDelay = computeBotThinkTimeMs({
      fen: sharpMiddlegameFen,
      ply: 24,
      minDelayMs: 500,
      maxDelayMs: 3000,
      unlimitedClock: false,
      botRemainingMs: 3000,
      incrementMs: 0,
      rng: () => 0.5,
    });
    expect(timeTroubleDelay).toBeLessThanOrEqual(120);
  });
});
