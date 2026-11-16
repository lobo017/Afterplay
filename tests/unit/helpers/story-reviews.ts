import type { GameAnalysisSummary, SideAnalysisSummary, StoredGameRecord } from '../../../src/storage/db';
import type { PhaseNumbers } from '../../../src/review/phase-numbers';
import { ME, run, type GameSpec } from './story-games';

/** Review numbers for an invented game. Defaults: a batch summary, 30 moves, 60 plies, accuracy 80. */
export interface ReviewSpec {
  accuracy?: number;
  moves?: number;
  plies?: number;
  inaccuracy?: number;
  mistake?: number;
  blunder?: number;
  brilliant?: number;
  great?: number;
  low?: number | null;
  /** A batch summary (default) or a review made on this device. */
  advance?: boolean;
  /** A device review holds both sides; the opponent's side gets other numbers. */
  bothSides?: boolean;
  preset?: 'quick' | null;
  /** My numbers by game phase (opening, middlegame, endgame); none by default, as in an older record. */
  phases?: PhaseNumbers;
}

export function side(n: ReviewSpec): SideAnalysisSummary {
  return {
    moves: n.moves ?? 30,
    acpl: 40,
    inaccuracy: n.inaccuracy ?? 2,
    mistake: n.mistake ?? 1,
    blunder: n.blunder ?? 1,
    miss: 0,
    brilliant: n.brilliant ?? 0,
    great: n.great ?? 0,
    low: n.low === undefined ? 40 : n.low,
    drop: 20,
    dropPly: 11,
    ...(n.phases ? { phases: n.phases } : {}),
  };
}

/** A copy of the record with a review summary, written for the side I actually sit on in it. */
export function reviewed(record: StoredGameRecord, n: ReviewSpec = {}): StoredGameRecord {
  const mineIsBlack = record.black === ME;
  const accuracy = n.accuracy ?? 80;
  const advance = n.advance ?? true;
  const sides: GameAnalysisSummary['sides'] = {};
  sides[mineIsBlack ? 'b' : 'w'] = side(n);
  if (n.bothSides) sides[mineIsBlack ? 'w' : 'b'] = side({ blunder: 9, moves: 31 });
  const theirs = n.bothSides ? 55 : null;
  const analysis: GameAnalysisSummary = {
    preset: n.preset ?? null,
    savedAt: 5,
    whiteAccuracy: mineIsBlack ? theirs : accuracy,
    blackAccuracy: mineIsBlack ? accuracy : theirs,
    ...(advance ? { depth: 18, summaryOnly: true } : {}),
    plies: n.plies ?? 60,
    sides,
  };
  return { ...record, analysis, accuracy };
}

/** `count` invented games six hours apart from 1 January 2026, each with a review. */
export function batch(
  count: number,
  prefix: string,
  make: (i: number) => { game?: Partial<GameSpec>; review?: ReviewSpec } = () => ({}),
): StoredGameRecord[] {
  return run(count, prefix, (i) => make(i).game ?? {}).map((r, i) => reviewed(r, make(i).review));
}
