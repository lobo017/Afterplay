/**
 * Exact distance to mate for K+Q v K, K+R v K and K+P v K (White has the extra piece), by
 * retrograde analysis, and from it the exact defence: the Black move that keeps the mate as far
 * away as it can be (or takes an unprotected piece, which draws). The endgame trainer uses it as
 * the defender, so "moves against the best possible" is measured against a perfect opponent.
 *
 * A queen promotion is looked up in the K+Q v K table and a rook promotion in K+R v K; bishop and
 * knight promotions never win. The count is White's moves to checkmate against the best defence,
 * as in a tablebase's DTM. Known maxima, checked by the tests: K+Q v K 10, K+R v K 16, K+P v K 28.
 *
 * The solver is pure (no DOM, no worker globals) so Node tests can run it; the app runs it in a
 * worker (`endgame-tables.worker.ts`) because solving all three takes a second or two.
 */

export type TableKind = 'q' | 'r' | 'p';

/** Moves to mate with White to move, by (wk, bk, piece); -1 where White doesn't win. */
interface Table {
  white: Int8Array;
  black: Int8Array;
}

const file = (s: number) => s & 7;
const rank = (s: number) => s >> 3;
const index = (wk: number, bk: number, x: number) => (wk * 64 + bk) * 64 + x;
const adjacent = (a: number, b: number) =>
  a !== b && Math.abs(file(a) - file(b)) <= 1 && Math.abs(rank(a) - rank(b)) <= 1;

const KING_STEPS: number[][] = Array.from({ length: 64 }, (_, s) => {
  const out: number[] = [];
  for (let df = -1; df <= 1; df++) {
    for (let dr = -1; dr <= 1; dr++) {
      const f = file(s) + df;
      const r = rank(s) + dr;
      if ((df !== 0 || dr !== 0) && f >= 0 && f < 8 && r >= 0 && r < 8) out.push(f + 8 * r);
    }
  }
  return out;
});

const ROOK_DIRS: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];
const QUEEN_DIRS: ReadonlyArray<readonly [number, number]> = [...ROOK_DIRS, [1, 1], [1, -1], [-1, 1], [-1, -1]];

/** For each square, its rays (nearest square first) in the given directions. */
function buildRays(dirs: ReadonlyArray<readonly [number, number]>): number[][][] {
  return Array.from({ length: 64 }, (_, s) =>
    dirs.map(([df, dr]) => {
      const out: number[] = [];
      let f = file(s) + df;
      let r = rank(s) + dr;
      while (f >= 0 && f < 8 && r >= 0 && r < 8) {
        out.push(f + 8 * r);
        f += df;
        r += dr;
      }
      return out;
    }),
  );
}

const RAYS: Record<'q' | 'r', number[][][]> = { q: buildRays(QUEEN_DIRS), r: buildRays(ROOK_DIRS) };

/**
 * Squares the extra piece attacks with only the White king in the way (the Black king is not a
 * blocker: it cannot step back along the line of a check). Indexed [(wk * 64 + x) * 64 + target].
 */
function attackTable(kind: TableKind): Uint8Array {
  const out = new Uint8Array(64 * 64 * 64);
  for (let wk = 0; wk < 64; wk++) {
    for (let x = 0; x < 64; x++) {
      if (wk === x) continue;
      const base = (wk * 64 + x) * 64;
      if (kind === 'p') {
        if (rank(x) < 7) {
          for (const df of [-1, 1]) {
            const f = file(x) + df;
            if (f >= 0 && f < 8) out[base + f + 8 * (rank(x) + 1)] = 1;
          }
        }
        continue;
      }
      for (const ray of RAYS[kind][x]!) {
        for (const s of ray) {
          out[base + s] = 1;
          if (s === wk) break;
        }
      }
    }
  }
  return out;
}

function solve(kind: TableKind, promotions: Partial<Record<'q' | 'r', Table>> = {}): Table {
  const white = new Int8Array(64 * 64 * 64).fill(-1);
  const black = new Int8Array(64 * 64 * 64).fill(-1);
  const attacks = attackTable(kind);
  const attacked = (wk: number, x: number, target: number) => attacks[(wk * 64 + x) * 64 + target] === 1;

  const whiteTodo: number[] = [];
  const blackTodo: number[] = [];
  // Every legal position (kings apart, three different squares) with its coordinates packed in the index
  for (let wk = 0; wk < 64; wk++) {
    for (let bk = 0; bk < 64; bk++) {
      if (wk === bk || adjacent(wk, bk)) continue;
      for (let x = 0; x < 64; x++) {
        if (x === wk || x === bk) continue;
        if (kind === 'p' && (rank(x) < 1 || rank(x) > 6)) continue;
        const i = index(wk, bk, x);
        blackTodo.push(i);
        if (!attacked(wk, x, bk)) whiteTodo.push(i); // with White to move, Black can't be in check
      }
    }
  }

  const decode = (i: number): [number, number, number] => [i >> 12, (i >> 6) & 63, i & 63];

  // Checkmates: Black to move, in check, with no reply
  const stillBlack: number[] = [];
  for (const i of blackTodo) {
    const [wk, bk, x] = decode(i);
    let moves = 0;
    for (const to of KING_STEPS[bk]!) {
      if (to === wk || adjacent(to, wk)) continue;
      if (to === x || !attacked(wk, x, to)) moves++;
    }
    if (moves === 0 && attacked(wk, x, bk)) black[i] = 0;
    else if (moves > 0) stillBlack.push(i);
    // else: stalemate, never won
  }

  let whiteList = whiteTodo;
  let blackList = stillBlack;
  for (let n = 1; n < 100; n++) {
    let changed = 0;
    const nextWhite: number[] = [];
    for (const i of whiteList) {
      const [wk, bk, x] = decode(i);
      let won = false;
      for (const to of KING_STEPS[wk]!) {
        if (to === x || adjacent(to, bk)) continue;
        if (black[index(to, bk, x)] === n - 1) {
          won = true;
          break;
        }
      }
      if (!won) {
        if (kind === 'p') {
          const one = x + 8;
          if (one !== wk && one !== bk) {
            if (rank(one) === 7) {
              for (const table of [promotions.q, promotions.r]) {
                if (table && table.black[index(wk, bk, one)] === n - 1) won = true;
              }
            } else {
              if (black[index(wk, bk, one)] === n - 1) won = true;
              const two = x + 16;
              if (!won && rank(x) === 1 && two !== wk && two !== bk && black[index(wk, bk, two)] === n - 1) won = true;
            }
          }
        } else {
          for (const ray of RAYS[kind][x]!) {
            for (const to of ray) {
              if (to === wk || to === bk) break;
              if (black[index(wk, bk, to)] === n - 1) {
                won = true;
                break;
              }
            }
            if (won) break;
          }
        }
      }
      if (won) {
        white[i] = n;
        changed++;
      } else {
        nextWhite.push(i);
      }
    }
    whiteList = nextWhite;

    const nextBlack: number[] = [];
    for (const i of blackList) {
      const [wk, bk, x] = decode(i);
      let worst = 0;
      let wins = true;
      for (const to of KING_STEPS[bk]!) {
        if (to === wk || adjacent(to, wk)) continue;
        if (to === x) {
          wins = false; // takes the unprotected piece: a draw
          break;
        }
        if (attacked(wk, x, to)) continue;
        const v = white[index(wk, to, x)]!;
        if (v === -1) {
          wins = false;
          break;
        }
        if (v > worst) worst = v;
      }
      if (wins) {
        black[i] = worst;
        changed++;
      } else {
        nextBlack.push(i);
      }
    }
    blackList = nextBlack;
    if (changed === 0) break;
  }
  return { white, black };
}

/** The squares of a position with White's K, the piece and Black's K alone, or null for anything else. */
interface Parsed {
  kind: TableKind;
  wk: number;
  bk: number;
  x: number;
  turn: 'w' | 'b';
}

function parse(fen: string): Parsed | null {
  const [board = '', turn] = fen.split(' ');
  if (turn !== 'w' && turn !== 'b') return null;
  let wk = -1;
  let bk = -1;
  let x = -1;
  let kind: TableKind | null = null;
  let ok = true;
  board.split('/').forEach((row, i) => {
    let f = 0;
    for (const ch of row) {
      if (/\d/.test(ch)) {
        f += Number(ch);
        continue;
      }
      const s = f + 8 * (7 - i);
      if (ch === 'K' && wk < 0) wk = s;
      else if (ch === 'k' && bk < 0) bk = s;
      else if ((ch === 'Q' || ch === 'R' || ch === 'P') && kind === null) {
        kind = ch.toLowerCase() as TableKind;
        x = s;
      } else ok = false;
      f++;
    }
  });
  if (!ok || wk < 0 || bk < 0 || x < 0 || kind === null) return null;
  return { kind, wk, bk, x, turn };
}

const squareName = (s: number) => `${'abcdefgh'[file(s)]}${rank(s) + 1}`;

export interface Defence {
  /** Black's reply in UCI. */
  move: string;
  /** White still wins after it (false: the reply takes the piece or the position is not a win). */
  stillWon: boolean;
  /** White's moves to mate after the reply (null when White no longer wins). */
  mateIn: number | null;
}

/** The three solved tables; `solve` is lazy per kind (K+P needs the other two for its promotions). */
export class EndgameTables {
  private tables: Partial<Record<TableKind, Table>> = {};
  private readonly attacks: Partial<Record<TableKind, Uint8Array>> = {};

  /** Solves what `kind` needs (K+P v K needs all three). */
  public ensure(kind: TableKind): void {
    if (!this.tables.q) this.tables.q = solve('q');
    if (kind === 'q') return;
    if (!this.tables.r) this.tables.r = solve('r');
    if (kind === 'r') return;
    if (!this.tables.p) this.tables.p = solve('p', { q: this.tables.q, r: this.tables.r });
  }

  public has(kind: TableKind): boolean {
    return this.tables[kind] !== undefined;
  }

  /** The longest mate over all positions of the ending (a check on the solver itself). */
  public longestMate(kind: TableKind): number {
    this.ensure(kind);
    return this.tables[kind]!.white.reduce((a, b) => (b > a ? b : a), 0);
  }

  /** Exact moves to mate with White to move, or null when the position is another kind or not won. */
  public mateDistance(fen: string): number | null {
    const p = parse(fen);
    if (!p || p.turn !== 'w') return null;
    this.ensure(p.kind);
    const v = this.tables[p.kind]!.white[index(p.wk, p.bk, p.x)]!;
    return v === -1 ? null : v;
  }

  /** Whether `defend` can answer this position (Black to move; White has a king and a queen, rook or pawn). */
  public covers(fen: string): TableKind | null {
    const p = parse(fen);
    return p && p.turn === 'b' ? p.kind : null;
  }

  /**
   * Black's best reply: the one that takes the piece if it can (a draw), else keeps the position
   * unwon, else puts the mate as far away as possible. Null when the position is not one of the
   * three endings, or Black has no legal move.
   */
  public defend(fen: string): Defence | null {
    const p = parse(fen);
    if (!p || p.turn !== 'b') return null;
    this.ensure(p.kind);
    const { wk, bk, x, kind } = p;
    if (wk === bk || adjacent(wk, bk) || x === wk || x === bk) return null;
    const table = this.tables[kind]!;
    const attacks = (this.attacks[kind] ??= attackTable(kind));
    let best: { to: number; value: number } | null = null;
    for (const to of KING_STEPS[bk]!) {
      if (to === wk || adjacent(to, wk)) continue;
      let value: number;
      if (to === x)
        value = 1000; // takes the piece
      else if (attacks[(wk * 64 + x) * 64 + to] === 1) continue;
      else {
        const v = table.white[index(wk, to, x)]!;
        value = v === -1 ? 999 : v; // an unwon position beats any mate
      }
      if (!best || value > best.value) best = { to, value };
    }
    if (!best) return null;
    const stillWon = best.value < 999;
    return { move: `${squareName(bk)}${squareName(best.to)}`, stillWon, mateIn: stillWon ? best.value : null };
  }
}
