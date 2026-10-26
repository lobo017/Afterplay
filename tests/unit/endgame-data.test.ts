import path from 'node:path';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import endgamesJson from '../../data/endgames.json';
import type { EndgamePositionEntry } from '../../src/core/datasets';
import { RulesAdapter } from '../../src/core/rules';
import { SINGLE_THREADED_STOCKFISH_FILE } from '../../src/engine/engine-client';
import { endgameGoal } from '../../src/trainers/endgames';
import { ensureOracle, exactMateDistance, longestMate } from '../helpers/dtm-oracle';

/**
 * Every endgame position is checked with Stockfish 17.1 (the same single-threaded lite build
 * the app uses, in Node):
 *  - the target result is achievable: a won position scores a forced mate or at least +3.00 for the
 *    side to move, the drawn one scores about 0.00 (neither side can do better);
 *  - `optimalMoves` is the engine's mate distance, searched to a depth where it has settled (and
 *    again 10 plies deeper). That depth is deep: K+Q v K reads 8 at depth 44 and 7 from 50, K+R v K
 *    16 at 36, 15 at 44 and 14 from 52, K+P v K 14 at 40, 13 at 44, 12 at 50-80 and 11 from 100. The
 *    first draft of the file had K+Q v K as 10 and K+R v K as 16, the worst cases over all positions,
 *    not these ones. So the engine's number is also compared with an exact one from a retrograde
 *    solver (tests/helpers/dtm-oracle.ts), which agrees with it at those depths;
 *  - a position without `optimalMoves` (Lucena, Philidor, R+P v R) is checked for its result only.
 */
const ENDGAMES = endgamesJson as EndgamePositionEntry[];
/** The depth each mate distance has settled at (see above), and how much deeper it is checked again. */
const MATE_DEPTH: Record<string, number> = { 'kq-vs-k': 60, 'kr-vs-k': 70, 'kp-opposition': 110 };
const MATE_RECHECK_EXTRA = 10;
/** The decisive threshold for won positions that aren't mate drills, in centipawns. */
const WON_CP = 300;
/** A drawn position scores within this of zero. */
const DRAW_CP = 40;
const WON_DEPTH = 24;
const DRAW_DEPTH = 32;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const stockfishJsPath = path.resolve(__dirname, '..', '..', 'node_modules', 'stockfish', 'src', SINGLE_THREADED_STOCKFISH_FILE);

interface Score {
  type: 'cp' | 'mate';
  value: number;
}

/**
 * Hard limits, so a hung or dead engine fails the test in about a minute instead of waiting out the
 * per-test timeout (and leaving the shared engine mid-search for the next test to misread). A healthy
 * run is 80 s for the whole file: the longest search is ~25 s and the longest gap between two lines of
 * engine output (reported at the end of the run) a few seconds.
 */
/** No output at all from the engine for this long: it is hung (the deepest searches print a line per depth). */
const ENGINE_SILENCE_MS = 45_000;
/** One question (a whole search) must be answered within this. */
const ENGINE_CALL_MS = 120_000;

/** One Stockfish process, asked one question at a time. */
class Engine {
  private readonly proc: ChildProcessWithoutNullStreams;
  private buffer = '';
  private lines: string[] = [];
  private waiter: (() => void) | null = null;
  /** Why the engine was stopped (hung, crashed or finished): once set, every later question fails at once. */
  private stopped: string | null = null;
  /** The longest wait between two lines of output while a question was pending. */
  public maxGapMs = 0;
  private readonly killOnExit = () => this.proc.kill();

  constructor() {
    this.proc = spawn(process.execPath, [stockfishJsPath], { stdio: 'pipe' });
    // The engine must not outlive this test process, whatever ends it
    process.once('exit', this.killOnExit);
    this.proc.stdin.on('error', () => undefined); // writing to a dead engine is reported by the next question
    this.proc.on('exit', (code, signal) => {
      this.stopped ??= `the engine process exited (${signal ?? `code ${code}`})`;
      this.waiter?.();
    });
    this.proc.on('error', (err) => {
      this.stopped ??= `the engine process failed: ${err.message}`;
      this.waiter?.();
    });
    const feed = (chunk: Buffer) => {
      this.buffer += chunk.toString('utf8');
      let i: number;
      while ((i = this.buffer.indexOf('\n')) !== -1) {
        this.lines.push(this.buffer.slice(0, i).replace(/\r$/, ''));
        this.buffer = this.buffer.slice(i + 1);
      }
      this.waiter?.();
    };
    this.proc.stdout.on('data', feed);
    this.proc.stderr.on('data', feed);
  }

  private stop(reason: string): void {
    this.stopped ??= reason;
    this.proc.kill();
  }

  public send(command: string): void {
    if (this.stopped) throw new Error(`cannot send "${command}": ${this.stopped}`);
    this.proc.stdin.write(`${command}\n`);
  }

  /** Output lines up to and including the first that satisfies `predicate`; fails fast when the engine is silent, too slow or gone. */
  private async until(predicate: (line: string) => boolean, what: string): Promise<string[]> {
    const seen: string[] = [];
    const startedAt = performance.now();
    let lastAt = startedAt;
    for (;;) {
      while (this.lines.length > 0) {
        const line = this.lines.shift()!;
        const now = performance.now();
        this.maxGapMs = Math.max(this.maxGapMs, now - lastAt);
        lastAt = now;
        seen.push(line);
        if (predicate(line)) return seen;
      }
      if (this.stopped) throw new Error(`${what}: ${this.stopped}`);
      const budgetLeft = ENGINE_CALL_MS - (performance.now() - startedAt);
      if (budgetLeft <= 0) {
        this.stop(`no answer within ${ENGINE_CALL_MS / 1000} s, so the engine was stopped`);
        continue;
      }
      await new Promise<void>((resolve) => {
        const silence = Math.min(ENGINE_SILENCE_MS, budgetLeft);
        const timer = setTimeout(() => {
          this.stop(
            silence < ENGINE_SILENCE_MS
              ? `no answer within ${ENGINE_CALL_MS / 1000} s, so the engine was stopped`
              : `no output for ${ENGINE_SILENCE_MS / 1000} s (hung?), so the engine was stopped`,
          );
          resolve();
        }, silence);
        this.waiter = () => {
          clearTimeout(timer);
          resolve();
        };
        // lines may have arrived between the check and the assignment
        if (this.lines.length > 0 || this.stopped) this.waiter();
      });
      this.waiter = null;
    }
  }

  public async ready(): Promise<void> {
    this.send('uci');
    await this.until((l) => l === 'uciok', 'waiting for uciok');
    this.send('setoption name Hash value 128');
    this.send('isready');
    await this.until((l) => l === 'readyok', 'waiting for readyok');
  }

  /** The side to move's score at the end of a fixed-depth search, with the best move. */
  public async search(fen: string, depth: number, searchMoves?: string): Promise<{ score: Score; bestMove: string; depth: number }> {
    this.send('ucinewgame');
    this.send('isready');
    await this.until((l) => l === 'readyok', `readyok before searching ${fen}`);
    this.send(`position fen ${fen}`);
    this.send(`go depth ${depth}${searchMoves ? ` searchmoves ${searchMoves}` : ''}`);
    const out = await this.until((l) => l.startsWith('bestmove'), `search to depth ${depth} of ${fen}`);
    let last: { score: Score; depth: number } | null = null;
    for (const line of out) {
      const m = /^info depth (\d+) .*?score (cp|mate) (-?\d+)(?: (?:lowerbound|upperbound))? .* pv /.exec(line);
      if (m && !/(lowerbound|upperbound)/.test(line)) last = { depth: Number(m[1]), score: { type: m[2] as 'cp' | 'mate', value: Number(m[3]) } };
    }
    if (!last) throw new Error(`no score for ${fen}`);
    return { ...last, bestMove: out[out.length - 1]!.split(' ')[1]! };
  }

  /** Stops the engine for good; the tests after it fail at once instead of misreading its output. */
  public abort(reason: string): void {
    this.stop(reason);
  }

  public quit(): void {
    process.off('exit', this.killOnExit);
    this.stopped ??= 'the engine was quit';
    this.proc.kill();
  }
}

const engine = new Engine();
afterAll(() => {
  console.log(`[endgame-data] longest wait between two lines of engine output: ${(engine.maxGapMs / 1000).toFixed(1)} s (limit ${ENGINE_SILENCE_MS / 1000} s)`);
  engine.quit();
});

describe('the endgame positions (checked with the engine)', () => {
  // A test that timed out leaves the engine mid-search; the next test would read its stale output.
  // (The engine's own failures, hung or dead, already stop it; a wrong answer leaves it healthy.)
  afterEach(({ task }) => {
    if (task.result?.errors?.some((e) => /timed out/i.test(e.message))) engine.abort('an earlier test timed out while the engine was busy');
  });

  it('has the six positions of the spec, each a legal position with the player to move', () => {
    expect(ENDGAMES.map((e) => e.category)).toEqual(['K+Q v K', 'K+R v K', 'K+P opposition', 'Lucena', 'Philidor', 'R+P v R']);
    expect(new Set(ENDGAMES.map((e) => e.id)).size).toBe(ENDGAMES.length);
    for (const e of ENDGAMES) {
      const adapter = new RulesAdapter(e.fen);
      expect(adapter.turn(), e.id).toBe(e.sideToMove);
      expect(adapter.isGameOver(), e.id).toBe(false);
      // The side with the move is the side that has the target: a win for it, or the draw it holds
      if (e.targetResult === '1-0') expect(e.sideToMove, e.id).toBe('w');
      if (e.targetResult === '0-1') expect(e.sideToMove, e.id).toBe('b');
      expect(Number.isInteger(e.optimalMoves ?? 0), e.id).toBe(true);
      // A mate count only for a won position
      if (e.optimalMoves !== null) expect(e.targetResult, e.id).not.toBe('1/2-1/2');
    }
    // Lucena, Philidor and R+P v R track the result only; the others count moves
    expect(ENDGAMES.filter((e) => e.optimalMoves === null).map((e) => e.category)).toEqual(['Lucena', 'Philidor', 'R+P v R']);
  });

  it('the retrograde solver is right: the longest mates are the known ones (10, 16 and 28 moves)', async () => {
    await ensureOracle();
    expect(longestMate('q')).toBe(10);
    expect(longestMate('r')).toBe(16);
    expect(longestMate('p')).toBe(28);
  }, 120_000);

  it('is ready to search', async () => {
    await engine.ready();
  });

  for (const e of ENDGAMES) {
    const goal = endgameGoal(e);
    if (goal === 'mate') {
      const depth = MATE_DEPTH[e.id]!;
      it(
        `${e.title}: the engine's mate distance is optimalMoves (${e.optimalMoves}), and stays there deeper`,
        async () => {
          expect(depth, `a search depth for ${e.id}`).toBeGreaterThan(0);
          const deep = await engine.search(e.fen, depth);
          expect(deep.score, `${e.id} at depth ${depth}`).toEqual({ type: 'mate', value: e.optimalMoves });
          const deeper = await engine.search(e.fen, depth + MATE_RECHECK_EXTRA);
          expect(deeper.score, `${e.id} at depth ${depth + MATE_RECHECK_EXTRA}`).toEqual({ type: 'mate', value: e.optimalMoves });
          // The target result is achievable, and for the side with the move
          expect(e.targetResult === '1-0' ? e.sideToMove === 'w' : e.sideToMove === 'b').toBe(true);
        },
        150_000,
      );
      it(`${e.title}: optimalMoves is also the exact distance to mate (retrograde analysis)`, async () => {
        await ensureOracle();
        expect(exactMateDistance(e.fen), e.id).toBe(e.optimalMoves);
      });
    } else if (goal === 'convert') {
      it(
        `${e.title}: the win is achievable (a mate or at least +${WON_CP / 100} for the player)`,
        async () => {
          const r = await engine.search(e.fen, WON_DEPTH);
          const cp = r.score.type === 'mate' ? Math.sign(r.score.value) * 100_000 : r.score.value;
          expect(cp, `${e.id}: ${r.score.type} ${r.score.value}`).toBeGreaterThanOrEqual(WON_CP);
        },
        90_000,
      );
    } else {
      it(
        `${e.title}: the draw is achievable and the position is no worse (within ±${DRAW_CP / 100})`,
        async () => {
          const r = await engine.search(e.fen, DRAW_DEPTH);
          expect(r.score.type, e.id).toBe('cp');
          expect(Math.abs(r.score.value), `${e.id}: ${r.score.value}`).toBeLessThanOrEqual(DRAW_CP);
        },
        90_000,
      );
    }
  }

  it('Philidor: the move the description names (1...Ra6) holds the draw', async () => {
    const philidor = ENDGAMES.find((e) => e.category === 'Philidor')!;
    const r = await engine.search(philidor.fen, DRAW_DEPTH, 'a3a6');
    expect(r.bestMove).toBe('a3a6');
    expect(Math.abs((r.score as Score).value)).toBeLessThanOrEqual(DRAW_CP);
  }, 120_000);
});
