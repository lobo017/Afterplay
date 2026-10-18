import { describe, expect, it } from 'vitest';
import { GameTree } from '../../src/core/game-tree';
import {
  EngineCancelledError,
  type EngineAnalysisResult,
  type EngineAnalyzeRequest,
} from '../../src/engine/engine-client';
import { buildGameReview, mainLinePlies } from '../../src/review/review-game';
import { ReviewRunner, type ReviewEngine } from '../../src/review/review-runner';
import type { GameReview } from '../../src/review/types';
import {
  classificationFixtures,
  isBookFen,
  recordedLine,
  resolveStartFen,
} from '../helpers/review-fixtures';

/** Replays the recorded fixture results, keyed by the number of moves played. */
class RecordedEngine implements ReviewEngine {
  public requests: EngineAnalyzeRequest[] = [];
  constructor(
    private readonly fixtureId: string,
    private readonly onAnalyze?: (index: number) => void,
  ) {}

  async analyze(request: EngineAnalyzeRequest): Promise<EngineAnalysisResult> {
    this.requests.push(request);
    const index = request.moves?.length ?? 0;
    this.onAnalyze?.(index);
    if (request.signal?.aborted) throw new EngineCancelledError(`t${index}`);
    const fixture = classificationFixtures.find((f) => f.id === this.fixtureId)!;
    const p = recordedLine(fixture)!.positions.find((x) => x.ply === index)!;
    return {
      fen: request.fen ?? '',
      normalizedFen: '',
      depth: p.depth,
      multipv: 2,
      bestMove: p.lines[0]?.pv[0] ?? null,
      ponder: null,
      lines: p.lines.map((l) => ({
        ...l,
        depth: p.depth,
        seldepth: p.depth,
        scoreWhite: l.score,
        evalCp: 0,
        nodes: 0,
        nps: 0,
        timeMs: 0,
      })),
      nodes: 1000,
      nps: 0,
      timeMs: 5,
      cached: false,
    };
  }
}

function fixtureTree(id: string): GameTree {
  const fixture = classificationFixtures.find((f) => f.id === id)!;
  const tree = new GameTree(resolveStartFen(fixture));
  for (const uci of fixture.moves) tree.addMove(uci);
  return tree;
}

describe('Phase 5 — review runner', () => {
  it('searches every position in order with MultiPV 2, the preset movetime and the move history', async () => {
    const engine = new RecordedEngine('miss-ignores-hanging-knight');
    const tree = fixtureTree('miss-ignores-hanging-knight');
    const progress: GameReview[] = [];
    const result = await new ReviewRunner(engine).run({
      tree,
      preset: 'standard',
      isBookPosition: isBookFen,
      onProgress: (r) => progress.push(r),
    });

    // Nd4 (Blunder) and h6 (Miss) each trigger a verification search of the positions
    // around them, every position at most once (no mate before them: no same-root search)
    expect(engine.requests.map((r) => [r.moves, r.movetime, r.searchMoves ?? null])).toEqual([
      [[], 600, null],
      [['f3d4'], 600, null],
      [[], 2000, null],
      [['f3d4'], 2000, null],
      [['f3d4', 'h7h6'], 600, null],
      [['f3d4', 'h7h6'], 2000, null],
    ]);
    for (const [i, r] of engine.requests.entries()) {
      expect(r.fen).toBe(tree.root.fen);
      expect(r.multipv).toBe(r.searchMoves ? 1 : 2);
      expect(r.depth).toBeUndefined();
      expect(r.priority).toBe('review');
      expect(r.useCache).toBe(false);
      expect(r.resetGame).toBe(i === 0);
    }
    expect(result.cancelled).toBe(false);
    expect(result.review.preset).toBe('standard');
    expect(result.review.complete).toBe(true);
    expect(result.review.moves.map((m) => m.classification)).toEqual(['Blunder', 'Miss']);
    expect(result.stats).toMatchObject({
      searches: 3,
      verifiedPositions: 3,
      meanDepth: 18,
      minDepth: 18,
    });

    // Progress fills in live: one update per position
    expect(progress.map((r) => r.analyzedPositions)).toEqual([1, 2, 3]);
    expect(progress.map((r) => r.moves.length)).toEqual([0, 1, 2]);

    // The streamed result equals a review built in one go from the same positions
    const direct = buildGameReview({
      preset: 'standard',
      budget: { movetimeMs: 600 },
      startFen: tree.root.fen,
      plies: mainLinePlies(tree),
      positions: result.positions,
      isBookPosition: isBookFen,
    });
    expect(result.review).toEqual(direct);
  });

  it('a verification search overturns a false blunder from a short search', async () => {
    // Short search: the mate seen before 1.d4 is missed after it (+3 only), so d4 looks
    // like a 25-point drop. The longer search finds White still mates.
    const scripted = (movetime: number | undefined, moves: number) => {
      const quick = movetime === 200;
      if (moves === 0) {
        return [
          { multipv: 1, score: { type: 'mate' as const, value: 3 }, pv: ['e2e4'] },
          { multipv: 2, score: quick ? { type: 'cp' as const, value: 100 } : { type: 'mate' as const, value: 4 }, pv: ['d2d4'] },
        ];
      }
      return [
        { multipv: 1, score: quick ? { type: 'cp' as const, value: -300 } : { type: 'mate' as const, value: -3 }, pv: ['g8f6'] },
      ];
    };
    const requests: EngineAnalyzeRequest[] = [];
    const engine: ReviewEngine = {
      analyze: async (request) => {
        requests.push(request);
        const lines = scripted(request.movetime, request.moves?.length ?? 0);
        return {
          fen: '',
          normalizedFen: '',
          depth: request.movetime === 200 ? 10 : 16,
          multipv: 2,
          bestMove: lines[0]!.pv[0]!,
          ponder: null,
          lines: lines.map((l) => ({ ...l, depth: 10, seldepth: 10, scoreWhite: l.score, evalCp: 0, nodes: 0, nps: 0, timeMs: 0 })),
          nodes: 0,
          nps: 0,
          timeMs: 0,
          cached: false,
        };
      },
    };
    const tree = new GameTree();
    tree.addMove('d2d4');
    const result = await new ReviewRunner(engine).run({
      tree,
      preset: 'quick',
      isBookPosition: () => false,
    });
    // A mate in 3 before the move: the same-root search goes to depth 2·3 + 6
    expect(requests.map((r) => [r.moves?.length, r.movetime ?? r.depth, r.searchMoves ?? null])).toEqual([
      [0, 200, null],
      [1, 200, null],
      [0, 1000, null],
      [1, 1000, null],
      [0, 12, ['d2d4']],
    ]);
    expect(result.positions.map((p) => p?.depth)).toEqual([16, 16]);
    expect(result.review.moves[0]!.classification).toBe('Excellent');
    expect(result.review.moves[0]!.winDrop).toBe(0);
    expect(result.stats.verifiedPositions).toBe(2);
  });

  it('the played move searched from before overturns a false blunder the after search keeps', async () => {
    // Even the longer search after 1.d4 misses the mate (+3 only), but searching 1.d4 itself
    // from the start position, on the same budget as the best line, finds mate in 4
    const requests: EngineAnalyzeRequest[] = [];
    const reply = (lines: Array<{ score: { type: 'cp' | 'mate'; value: number }; pv: string[] }>, depth: number) => ({
      fen: '',
      normalizedFen: '',
      depth,
      multipv: lines.length,
      bestMove: lines[0]!.pv[0]!,
      ponder: null,
      lines: lines.map((l, i) => ({ multipv: i + 1, ...l, depth, seldepth: depth, scoreWhite: l.score, evalCp: 0, nodes: 0, nps: 0, timeMs: 0 })),
      nodes: 0,
      nps: 0,
      timeMs: 0,
      cached: false,
    });
    const engine: ReviewEngine = {
      analyze: async (request) => {
        requests.push(request);
        if (request.searchMoves) {
          return reply([{ score: { type: 'mate', value: 4 }, pv: ['d2d4', 'g8f6', 'c1g5'] }], 14);
        }
        if ((request.moves?.length ?? 0) === 0) {
          return reply([{ score: { type: 'mate', value: 3 }, pv: ['e2e4'] }], request.movetime === 200 ? 10 : 16);
        }
        return reply([{ score: { type: 'cp', value: -300 }, pv: ['g8f6'] }], request.movetime === 200 ? 10 : 16);
      },
    };
    const tree = new GameTree();
    tree.addMove('d2d4');
    const result = await new ReviewRunner(engine).run({ tree, preset: 'quick', isBookPosition: () => false });
    expect(requests.at(-1)).toMatchObject({ searchMoves: ['d2d4'], depth: 12, multipv: 1 });
    // After 1.d4 Black is mated in 3 (White's mate in 4 counted the move itself)
    expect(result.positions[1]!.lines[0]!.score).toEqual({ type: 'mate', value: -3 });
    expect(result.positions[1]!.lines[0]!.pv).toEqual(['g8f6', 'c1g5']);
    expect(result.review.moves[0]!.winDrop).toBe(0);
    expect(['Excellent', 'Best']).toContain(result.review.moves[0]!.classification);
  });

  it('uses a fixed depth when given a custom budget', async () => {
    const engine = new RecordedEngine('blunder-nd4-hangs-knight');
    const result = await new ReviewRunner(engine).run({
      tree: fixtureTree('blunder-nd4-hangs-knight'),
      budget: { depth: 18 },
      isBookPosition: isBookFen,
    });
    // Fixed-depth reviews are not verified: one search per position
    expect(engine.requests.every((r) => r.depth === 18 && r.movetime === undefined)).toBe(true);
    expect(engine.requests).toHaveLength(2);
    expect(result.review.preset).toBeNull();
    expect(result.review.moves[0]!.classification).toBe('Blunder');
  });

  it('does not search a checkmate position', async () => {
    const engine = new RecordedEngine('best-second-mate-in-one');
    const result = await new ReviewRunner(engine).run({
      tree: fixtureTree('best-second-mate-in-one'),
      preset: 'quick',
      isBookPosition: isBookFen,
    });
    expect(engine.requests).toHaveLength(1);
    expect(result.positions[1]?.terminal).toBe('checkmate');
    expect(result.review.moves[0]!.classification).toBe('Best');
  });

  it('cancelling keeps the partial review', async () => {
    const ac = new AbortController();
    const engine = new RecordedEngine('miss-ignores-hanging-knight', (index) => {
      if (index === 1) ac.abort();
    });
    const result = await new ReviewRunner(engine).run({
      tree: fixtureTree('miss-ignores-hanging-knight'),
      preset: 'quick',
      isBookPosition: isBookFen,
      signal: ac.signal,
    });
    expect(result.cancelled).toBe(true);
    expect(result.review.complete).toBe(false);
    expect(result.review.analyzedPositions).toBe(1);
    expect(result.review.whiteWinSeries).toEqual([expect.any(Number), null, null]);
  });
});
