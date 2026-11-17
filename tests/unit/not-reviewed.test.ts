import { describe, expect, it } from 'vitest';
import {
  countUnreviewed,
  isNotReviewed,
  isReviewed,
  matchesFilter,
  NO_FILTER,
  toRow,
} from '../../src/library/game-rows';
import { isStandardGame } from '../../src/library/game-record';
import type { StoredGameRecord } from '../../src/storage/db';

const STANDARD = '[White "Ada"]\n[Black "Ben"]\n[Result "1-0"]\n\n1. e4 e5 2. Nf3 Nc6 1-0';
const CHESS960 = '[White "Ada"]\n[Black "Ben"]\n[Variant "Chess960"]\n\n1. g3 g6 1-0';
const SET_UP = '[White "Ada"]\n[Black "Ben"]\n[SetUp "1"]\n[FEN "8/8/8/4k3/8/4K3/4P3/8 w - - 0 1"]\n\n1. e4 *';
const SUMMARY = { preset: null, savedAt: 1, whiteAccuracy: 80, blackAccuracy: null, summaryOnly: true };
const DEVICE = { preset: 'quick' as const, savedAt: 1, whiteAccuracy: 70, blackAccuracy: 60 };

function record(pgn: string, analysis: StoredGameRecord['analysis'] = null): StoredGameRecord {
  return {
    id: `chesscom:${Math.random()}`,
    white: 'Ada',
    black: 'Ben',
    playerColor: 'w',
    result: '1-0',
    date: '2026.10.01',
    openingEco: '',
    openingName: '',
    accuracy: null,
    pgn,
    tags: [],
    schemaVersion: 1,
    createdAt: 1,
    updatedAt: 1,
    source: 'chesscom',
    analysis,
  };
}

describe('one meaning of "not reviewed"', () => {
  it('a game is reviewed with a summary stored in advance or a review made here', () => {
    expect(isReviewed(record(STANDARD, SUMMARY))).toBe(true);
    expect(isReviewed(record(STANDARD, DEVICE))).toBe(true);
    expect(isReviewed(record(STANDARD))).toBe(false);
  });

  it('counts standard games with no review, and no variant game', () => {
    expect(isNotReviewed(record(STANDARD))).toBe(true);
    expect(isNotReviewed(record(CHESS960))).toBe(false);
    expect(isNotReviewed(record(SET_UP))).toBe(false);
    expect(isNotReviewed(record(STANDARD, SUMMARY))).toBe(false);
    expect(isNotReviewed(record(STANDARD, DEVICE))).toBe(false);
    expect(countUnreviewed([record(STANDARD), record(STANDARD), record(CHESS960), record(STANDARD, SUMMARY)])).toBe(2);
  });

  it('a variant game that is reviewed stays reviewed', () => {
    expect(isReviewed(record(CHESS960, SUMMARY))).toBe(true);
    expect(isNotReviewed(record(CHESS960, SUMMARY))).toBe(false);
  });

  it('the Games list filters use the same meaning', () => {
    const me = [{ site: 'chesscom' as const, username: 'Ada' }];
    const rows = [
      record(STANDARD),
      record(STANDARD, SUMMARY),
      record(STANDARD, DEVICE),
      record(CHESS960),
      record(SET_UP),
    ].map((r) => toRow(r, me));
    const count = (analyzed: 'all' | 'analyzed' | 'not-analyzed') =>
      rows.filter((r) => matchesFilter(r, { ...NO_FILTER, analyzed })).length;
    expect(count('analyzed')).toBe(2);
    expect(count('not-analyzed')).toBe(1);
    expect(count('all')).toBe(5);
    expect(count('not-analyzed')).toBe(countUnreviewed(rows.map((r) => r.record)));
  });

  it('standard games are told from variants by the Variant, SetUp and FEN headers', () => {
    expect(isStandardGame({})).toBe(true);
    expect(isStandardGame({ Variant: 'Standard' })).toBe(true);
    expect(isStandardGame({ Variant: 'Chess960' })).toBe(false);
    expect(isStandardGame({ SetUp: '1' })).toBe(false);
    expect(isStandardGame({ FEN: '8/8/8/8/8/8/8/K6k w - - 0 1' })).toBe(false);
  });
});
