import type { StoredGameRecord } from '../../../src/storage/db';

/** Invented games for the Story tests. Names here exist nowhere else. */
export const ME = 'storytester';
export const OTHER_ME = 'storytester2';
export const FOES = ['Zephyrine', 'Quillon', 'Marbleton', 'Thistlewick'];

const MOVES = [
  'e4',
  'e5',
  'Nf3',
  'Nc6',
  'Bb5',
  'a6',
  'Ba4',
  'Nf6',
  'O-O',
  'Be7',
  'Re1',
  'b5',
  'Bb3',
  'd6',
  'c3',
  'O-O',
  'h3',
  'Nb8',
  'd4',
  'Nbd7',
  'Nbd2',
  'Bb7',
  'Bc2',
  'Re8',
];

export interface GameSpec {
  id: string;
  source?: StoredGameRecord['source'];
  /** My colour; the opponent gets the other seat. */
  color?: 'w' | 'b';
  outcome?: 'win' | 'loss' | 'draw' | 'unfinished';
  /** ms since the epoch (UTC). */
  at?: number | null;
  tc?: string;
  myElo?: number | null;
  foeElo?: number | null;
  opening?: string;
  plies?: number;
  /** Changes the move text, so two games with the same other fields are different games. */
  variantSalt?: string;
  headers?: Record<string, string>;
  me?: string;
  foe?: string;
}

const RESULT = {
  win: ['1-0', '0-1'],
  loss: ['0-1', '1-0'],
  draw: ['1/2-1/2', '1/2-1/2'],
  unfinished: ['*', '*'],
} as const;

export function utc(y: number, m: number, d = 15, h = 12): number {
  return Date.UTC(y, m - 1, d, h);
}

export function game(spec: GameSpec): StoredGameRecord {
  const color = spec.color ?? 'w';
  const outcome = spec.outcome ?? 'win';
  const result = RESULT[outcome][color === 'w' ? 0 : 1];
  const me = spec.me ?? ME;
  const foe = spec.foe ?? FOES[0]!;
  const white = color === 'w' ? me : foe;
  const black = color === 'w' ? foe : me;
  const at = spec.at === undefined ? utc(2026, 3) : spec.at;
  const source = spec.source ?? 'chesscom';
  const date = at === null ? '????.??.??' : new Date(at).toISOString().slice(0, 10).replace(/-/g, '.');
  const plies = spec.plies ?? 30;
  const san = Array.from({ length: plies }, (_, i) => MOVES[i % MOVES.length]!);
  if (spec.variantSalt) san[plies - 1] = `Q${spec.variantSalt}`;
  const text = san.map((m, i) => (i % 2 === 0 ? `${i / 2 + 1}. ${m}` : m)).join(' ');
  const headers: Record<string, string> = {
    Event: 'Live',
    Site: source === 'lichess' ? 'https://lichess.org/abc' : 'Chess.com',
    Date: date,
    White: white,
    Black: black,
    Result: result,
    ...spec.headers,
  };
  const pgn = `${Object.entries(headers)
    .map(([k, v]) => `[${k} "${v}"]`)
    .join('\n')}\n\n${text} {[%clk 0:03:00]} (1... c5 2. Nf3) ${result}`;
  const myElo = spec.myElo === undefined ? 1500 : spec.myElo;
  const foeElo = spec.foeElo === undefined ? 1500 : spec.foeElo;
  return {
    id: `${source}:${spec.id}`,
    white,
    black,
    playerColor: 'w',
    result: result as StoredGameRecord['result'],
    date,
    openingEco: '',
    openingName: spec.opening ?? '',
    accuracy: null,
    pgn,
    tags: [],
    schemaVersion: 4,
    createdAt: 0,
    updatedAt: 0,
    source,
    whiteElo: color === 'w' ? myElo : foeElo,
    blackElo: color === 'w' ? foeElo : myElo,
    timeControl: spec.tc ?? '180+2',
    playedAt: at,
  };
}

/** `count` games six hours apart from 1 January 2026, oldest first, ids `${prefix}${n}`. */
export function run(
  count: number,
  prefix: string,
  make: (i: number) => Partial<GameSpec> = () => ({}),
): StoredGameRecord[] {
  return Array.from({ length: count }, (_, i) =>
    game({ id: `${prefix}${i}`, at: utc(2026, 1, 1, 0) + i * 6 * 3_600_000, ...make(i) }),
  );
}
