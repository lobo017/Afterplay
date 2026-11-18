import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_POSITION, RulesAdapter } from '../../src/core/rules';
import { ChessBot } from '../../src/engine/bot';
import { buildBook } from '../../src/engine/bot-profile';
import type { EngineLine } from '../../src/engine/cache';
import { record, seeded } from './helpers/book-games';

function line(multipv: number, evalCp: number, pv: string[]): EngineLine {
  const score = { type: 'cp', value: evalCp } as const;
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

/** An engine that answers every search with the same MultiPV lines, counting the calls. */
function fakeEngine(lines: EngineLine[]) {
  const analyze = vi.fn(async (request: { fen: string }) => ({
    fen: request.fen,
    normalizedFen: request.fen,
    depth: 10,
    multipv: lines.length,
    bestMove: lines[0]?.pv[0] ?? null,
    ponder: null,
    lines,
    nodes: 1000,
    nps: 100000,
    timeMs: 10,
    cached: false,
  }));
  return { analyze, engine: { analyze } as unknown as ConstructorParameters<typeof ChessBot>[0] };
}

const AFTER_D4 = (() => {
  const adapter = new RulesAdapter();
  adapter.move('d4');
  return adapter.fen();
})();

describe('ChessBot.chooseMove with personal books', () => {
  const personalBook = buildBook([record(['e4', 'e5', 'Nf3'])], { side: 'own' }).book;

  it('without `personal` behaves as before: the engine is searched and nothing is marked as a book move', async () => {
    const { analyze, engine } = fakeEngine([line(1, 30, ['e2e4']), line(2, 10, ['d2d4'])]);
    const bot = new ChessBot(engine, { rating: 1400, style: 'solid', rng: seeded(3) });
    const decision = await bot.chooseMove(DEFAULT_POSITION);
    expect(analyze).toHaveBeenCalledTimes(1);
    expect(decision.fromBook).toBeUndefined();
    expect(['e2e4', 'd2d4']).toContain(decision.uci);
    // an absent `personal` and an empty options object take the same path
    const same = await new ChessBot(engine, { rating: 1400, style: 'solid', rng: seeded(3) }).chooseMove(
      DEFAULT_POSITION,
      {
        personal: undefined,
      },
    );
    expect(same.uci).toBe(decision.uci);
  });

  it('a book hit returns the move without any engine call', async () => {
    const { analyze, engine } = fakeEngine([line(1, 30, ['d2d4'])]);
    const bot = new ChessBot(engine, { rating: 1400, style: 'solid', rng: seeded(1) });
    const decision = await bot.chooseMove(DEFAULT_POSITION, { personal: { books: personalBook } });
    expect(analyze).not.toHaveBeenCalled();
    expect(decision.uci).toBe('e2e4');
    expect(decision.san).toBe('e4');
    expect(decision.executedMove).toMatchObject({ from: 'e2', to: 'e4', san: 'e4', color: 'w' });
    expect(decision.fromBook).toBe(true);
    expect(decision.params.rating).toBe(1400);
    // the placeholder evaluation: depth 0, no nodes, 0 cp, the move as the whole line
    expect(decision.selectedLine).toMatchObject({
      depth: 0,
      nodes: 0,
      evalCp: 0,
      score: { type: 'cp', value: 0 },
      pv: ['e2e4'],
    });
    expect(decision.candidates).toEqual([
      expect.objectContaining({ uci: 'e2e4', probability: 1, evalCp: 0, dropCp: 0 }),
    ]);
  });

  it('uses the books in order and takes the rng from the options', async () => {
    const { analyze, engine } = fakeEngine([]);
    const peak = buildBook([record(['d4'])], { side: 'own' }).book;
    const bot = new ChessBot(engine, { rating: 1400, rng: seeded(1) });
    const decision = await bot.chooseMove(DEFAULT_POSITION, {
      personal: { books: [peak, personalBook] },
      rng: () => 0,
    });
    expect(decision.uci).toBe('d2d4');
    expect(analyze).not.toHaveBeenCalled();
  });

  it('a miss falls through to the existing path, with the same result as without books', async () => {
    const lines = [line(1, 30, ['d7d5']), line(2, 5, ['g8f6'])];
    const withBooks = fakeEngine(lines);
    const plain = fakeEngine(lines);
    const a = await new ChessBot(withBooks.engine, { rating: 1000, rng: seeded(7) }).chooseMove(AFTER_D4, {
      personal: { books: personalBook },
    });
    const b = await new ChessBot(plain.engine, { rating: 1000, rng: seeded(7) }).chooseMove(AFTER_D4);
    expect(withBooks.analyze).toHaveBeenCalledTimes(1);
    expect(plain.analyze).toHaveBeenCalledTimes(1);
    expect(a.uci).toBe(b.uci);
    expect(a.fromBook).toBeUndefined();
    expect(a.candidates).toEqual(b.candidates);
  });

  it('a book move that is not legal in the position is a miss, not an error', async () => {
    const { analyze, engine } = fakeEngine([line(1, 30, ['d2d4'])]);
    const broken = {
      v: 1 as const,
      pliesCap: 36,
      entries: { 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -': [['e2e5', 9]] as [string, number][] },
    };
    const decision = await new ChessBot(engine, { rating: 1400, rng: seeded(1) }).chooseMove(DEFAULT_POSITION, {
      personal: { books: broken },
    });
    expect(analyze).toHaveBeenCalledTimes(1);
    expect(decision.fromBook).toBeUndefined();
  });
});
