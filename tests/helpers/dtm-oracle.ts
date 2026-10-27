/**
 * Exact distance to mate for K+Q v K, K+R v K and K+P v K (White has the extra piece), by
 * retrograde analysis: an independent check of the engine's mate distances, which only settle
 * at depth 50-100 on these positions. A queen promotion is looked up in the K+Q v K table and
 * a rook promotion in K+R v K (bishop and knight promotions never win). The count is the
 * winning side's moves to checkmate against the best defence, as in a tablebase's DTM.
 * Self-checks against the known maxima: K+Q v K 10, K+R v K 16, K+P v K 28.
 */

type Extra = 'q' | 'r' | 'p';

const file = (s: number) => s & 7;
const rank = (s: number) => s >> 3;
const square = (f: number, r: number) => f + 8 * r;
const adjacent = (a: number, b: number) =>
  a !== b && Math.abs(file(a) - file(b)) <= 1 && Math.abs(rank(a) - rank(b)) <= 1;

const KING_STEPS: number[][] = Array.from({ length: 64 }, (_, s) => {
  const out: number[] = [];
  for (let df = -1; df <= 1; df++) {
    for (let dr = -1; dr <= 1; dr++) {
      const f = file(s) + df;
      const r = rank(s) + dr;
      if ((df !== 0 || dr !== 0) && f >= 0 && f < 8 && r >= 0 && r < 8) out.push(square(f, r));
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

/** The squares a slider reaches from `from`, each ray ending at (and including) the first blocker. */
function ray(from: number, dirs: ReadonlyArray<readonly [number, number]>, blocked: (s: number) => boolean): number[] {
  const out: number[] = [];
  for (const [df, dr] of dirs) {
    let f = file(from) + df;
    let r = rank(from) + dr;
    while (f >= 0 && f < 8 && r >= 0 && r < 8) {
      const s = square(f, r);
      out.push(s);
      if (blocked(s)) break;
      f += df;
      r += dr;
    }
  }
  return out;
}

interface Table {
  /** Moves to mate with White to move, by (wk, bk, piece); -1 where White doesn't win. */
  white: Int16Array;
  /** The same with Black to move. */
  black: Int16Array;
}

const index = (wk: number, bk: number, x: number) => (wk * 64 + bk) * 64 + x;

/** Lets the event loop run (a test worker must keep reporting to the runner during a long solve). */
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

async function solve(type: Extra, promotions: Partial<Record<'q' | 'r', Table>> = {}): Promise<Table> {
  const white = new Int16Array(64 * 64 * 64).fill(-1);
  const black = new Int16Array(64 * 64 * 64).fill(-1);
  const positions: Array<[number, number, number]> = [];
  for (let wk = 0; wk < 64; wk++) {
    for (let bk = 0; bk < 64; bk++) {
      for (let x = 0; x < 64; x++) {
        if (wk === bk || wk === x || bk === x || adjacent(wk, bk)) continue;
        if (type === 'p' && (rank(x) < 1 || rank(x) > 6)) continue;
        positions.push([wk, bk, x]);
      }
    }
  }
  const attacks = (wk: number, bk: number, x: number, target: number, ignoreBk: boolean): boolean => {
    if (type === 'p') return rank(target) === rank(x) + 1 && Math.abs(file(target) - file(x)) === 1;
    return ray(x, type === 'q' ? QUEEN_DIRS : ROOK_DIRS, (s) => s === wk || (!ignoreBk && s === bk)).includes(target);
  };
  const blackReplies = (wk: number, bk: number, x: number): Array<number | null> => {
    const out: Array<number | null> = [];
    for (const to of KING_STEPS[bk]!) {
      if (to === wk || adjacent(to, wk)) continue;
      if (to === x)
        out.push(null); // takes the unprotected piece: a draw
      else if (!attacks(wk, bk, x, to, true)) out.push(index(wk, to, x));
    }
    return out;
  };
  const whiteMoves = (wk: number, bk: number, x: number): Array<{ black: number } | { value: number }> => {
    const out: Array<{ black: number } | { value: number }> = [];
    for (const to of KING_STEPS[wk]!) {
      if (to !== x && to !== bk && !adjacent(to, bk)) out.push({ black: index(to, bk, x) });
    }
    if (type === 'p') {
      const one = x + 8;
      if (one !== wk && one !== bk) {
        if (rank(one) === 7) {
          for (const table of [promotions.q, promotions.r]) {
            if (table) out.push({ value: table.black[index(wk, bk, one)]! });
          }
        } else {
          out.push({ black: index(wk, bk, one) });
          const two = x + 16;
          if (rank(x) === 1 && two !== wk && two !== bk) out.push({ black: index(wk, bk, two) });
        }
      }
    } else {
      for (const to of ray(x, type === 'q' ? QUEEN_DIRS : ROOK_DIRS, (s) => s === wk || s === bk)) {
        if (to !== wk && to !== bk) out.push({ black: index(wk, bk, to) });
      }
    }
    return out;
  };

  // Checkmates: Black to move, in check, no move
  for (const [wk, bk, x] of positions) {
    if (attacks(wk, bk, x, bk, false) && blackReplies(wk, bk, x).length === 0) black[index(wk, bk, x)] = 0;
  }
  for (let n = 1; n < 80; n++) {
    await tick();
    let changed = 0;
    for (const [wk, bk, x] of positions) {
      const i = index(wk, bk, x);
      if (white[i] !== -1 || attacks(wk, bk, x, bk, false)) continue; // Black can't be in check with White to move
      for (const m of whiteMoves(wk, bk, x)) {
        const v = 'value' in m ? m.value : black[m.black]!;
        if (v === n - 1) {
          white[i] = n;
          changed++;
          break;
        }
      }
    }
    for (const [wk, bk, x] of positions) {
      const i = index(wk, bk, x);
      if (black[i] !== -1) continue;
      const replies = blackReplies(wk, bk, x);
      if (replies.length === 0) continue; // stalemate (checkmates are set above)
      let worst = 0;
      let wins = true;
      for (const next of replies) {
        if (next === null || white[next] === -1) {
          wins = false;
          break;
        }
        if (white[next]! > worst) worst = white[next]!;
      }
      if (wins) {
        black[i] = worst;
        changed++;
      }
    }
    if (changed === 0) break;
  }
  return { white, black };
}

let tables: Record<Extra, Table> | null = null;
let preparing: Promise<void> | null = null;

/** Solves the three endings (about 10-20 s of work, in slices); await it before using the functions below. */
export function ensureOracle(): Promise<void> {
  preparing ??= (async () => {
    const q = await solve('q');
    const r = await solve('r');
    tables = { q, r, p: await solve('p', { q, r }) };
  })();
  return preparing;
}

function getTables(): Record<Extra, Table> {
  if (!tables) throw new Error('dtm-oracle: await ensureOracle() first');
  return tables;
}

/** The longest mate distance over all positions of the endgame (a check of the solver itself). */
export function longestMate(extra: Extra): number {
  return getTables()[extra].white.reduce((a, b) => (b > a ? b : a), 0);
}

/**
 * Exact moves to mate for a K+Q, K+R or K+P v K position with White to move (the extra piece
 * is White's), or null when the position is another kind or isn't won.
 */
export function exactMateDistance(fen: string): number | null {
  const [board = '', turn] = fen.split(' ');
  if (turn !== 'w') return null;
  let wk: number | null = null;
  let bk: number | null = null;
  let x: { type: Extra; sq: number } | null = null;
  let other = 0;
  board.split('/').forEach((row, i) => {
    let f = 0;
    for (const ch of row) {
      if (/\d/.test(ch)) {
        f += Number(ch);
        continue;
      }
      const s = square(f, 7 - i);
      if (ch === 'K') wk = s;
      else if (ch === 'k') bk = s;
      else if ('QRP'.includes(ch) && x === null) x = { type: ch.toLowerCase() as Extra, sq: s };
      else other++;
      f++;
    }
  });
  if (wk === null || bk === null || x === null || other > 0) return null;
  const found = x as { type: Extra; sq: number };
  const v = getTables()[found.type].white[index(wk, bk, found.sq)]!;
  return v === -1 ? null : v;
}
