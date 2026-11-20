import { describe, expect, it } from 'vitest';
import { checkPgnText } from '../../src/capture/pgn-games';
import { localDateTime } from '../../src/capture/pgn-time';
import { buildGameRecord } from '../../src/library/game-record';
import { gameDay, libraryPlayedOf, sortRows, sortTime, toRow } from '../../src/library/game-rows';
import type { StoredGameRecord } from '../../src/storage/db';

// The Library places a daily game (TimeControl 1/N) by its end: EndDate + EndTime, when that is later than the start.
// The stored playedAt and the start-based reading (playedAtDetail) are not changed; Story still buckets by the start.
const MOVES = '1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7';
const ACCOUNTS = [{ site: 'chesscom' as const, username: 'Me' }];

interface Tags {
  start?: [date: string, time: string];
  end?: [date: string, time?: string];
  timeControl?: string;
  white?: string;
}

function record(tags: Tags): StoredGameRecord {
  const lines = [
    '[Event "T"]',
    `[White "${tags.white ?? 'Me'}"]`,
    '[Black "Bob"]',
    '[Result "1-0"]',
    `[Date "${(tags.start?.[0] ?? tags.end?.[0] ?? '2026.01.01').replace(/-/g, '.')}"]`,
  ];
  if (tags.start) lines.push(`[UTCDate "${tags.start[0]}"]`, `[UTCTime "${tags.start[1]}"]`);
  if (tags.timeControl) lines.push(`[TimeControl "${tags.timeControl}"]`);
  if (tags.end) {
    lines.push(`[EndDate "${tags.end[0]}"]`);
    if (tags.end[1]) lines.push(`[EndTime "${tags.end[1]}"]`);
  }
  const valid = checkPgnText(`${lines.join('\n')}\n\n${MOVES} 1-0`).games[0]!;
  return { ...buildGameRecord(valid), schemaVersion: 4, createdAt: 1, updatedAt: 1 };
}

const localDay = (iso: string): string => localDateTime(Date.parse(iso)).date;

describe('Library dates a daily game by its end', () => {
  const longDaily = () =>
    record({
      start: ['2026.10.04', '10:00:00'],
      end: ['2026.11.08', '03:15:00'],
      timeControl: '1/259200',
    });

  it('shows the end date, in my time zone, for a daily that ended later than it started', () => {
    const r = longDaily();
    expect(gameDay(r)).toBe(localDay('2026-11-08T03:15:00Z'));
    expect(gameDay(r)).not.toBe(localDay('2026-10-04T10:00:00Z'));
    const placed = libraryPlayedOf(r)!;
    expect(placed).toEqual({ ms: Date.parse('2026-11-08T03:15:00Z'), hasTime: true, isEnd: true });
    expect(sortTime(r)).toBe(Date.parse('2026-11-08T03:15:00Z'));
  });

  it('leaves the stored start time alone', () => {
    const r = longDaily();
    expect(r.playedAt).toBe(Date.parse('2026-10-04T10:00:00Z'));
    gameDay(r);
    sortTime(r);
    expect(r.playedAt).toBe(Date.parse('2026-10-04T10:00:00Z'));
  });

  it('a daily that started 2026-10-04 and ended 2026-11-08 sorts first under Newest first, last under Oldest first', () => {
    const daily = toRow(longDaily(), ACCOUNTS);
    const liveBetween = toRow(
      record({ start: ['2026.10.20', '12:00:00'], timeControl: '180+0', white: 'Al' }),
      ACCOUNTS,
    );
    const liveAfterStart = toRow(
      record({ start: ['2026.10.05', '12:00:00'], timeControl: '600+0', white: 'Cy' }),
      ACCOUNTS,
    );
    const rows = [liveAfterStart, liveBetween, daily];
    expect(sortRows([...rows], 'newest').map((r) => r.record.white)).toEqual(['Me', 'Al', 'Cy']);
    expect(sortRows([...rows], 'oldest').map((r) => r.record.white)).toEqual(['Cy', 'Al', 'Me']);
  });

  it('a daily with no EndDate falls back to the start', () => {
    const r = record({ start: ['2026.10.04', '10:00:00'], timeControl: '1/172800' });
    expect(libraryPlayedOf(r)).toEqual({ ms: Date.parse('2026-10-04T10:00:00Z'), hasTime: true, isEnd: false });
    expect(gameDay(r)).toBe(localDay('2026-10-04T10:00:00Z'));
    expect(sortTime(r)).toBe(Date.parse('2026-10-04T10:00:00Z'));
  });

  it('a daily with an EndDate but no usable EndTime falls back to the start', () => {
    const r = record({ start: ['2026.10.04', '10:00:00'], end: ['2026.11.08'], timeControl: '1/259200' });
    expect(sortTime(r)).toBe(Date.parse('2026-10-04T10:00:00Z'));
    expect(gameDay(r)).toBe(localDay('2026-10-04T10:00:00Z'));
  });

  it('a daily whose end is not later than its start keeps the start', () => {
    const r = record({
      start: ['2026.10.04', '10:00:00'],
      end: ['2026.10.04', '09:00:00'],
      timeControl: '1/86400',
    });
    expect(sortTime(r)).toBe(Date.parse('2026-10-04T10:00:00Z'));
  });

  it('a daily that started and ended the same day is unchanged (the end is a few hours later, on the same UTC day)', () => {
    const r = record({
      start: ['2026.10.04', '10:00:00'],
      end: ['2026.10.04', '15:30:00'],
      timeControl: '1/86400',
    });
    // Only the moment moves, to the end; the day is the same as the start's
    expect(gameDay(r)).toBe(localDay('2026-10-04T15:30:00Z'));
    expect(sortTime(r)).toBe(Date.parse('2026-10-04T15:30:00Z'));
  });

  it('live games are unchanged, even with an EndDate and EndTime', () => {
    const r = record({
      start: ['2026.10.04', '10:00:00'],
      end: ['2026.11.08', '03:15:00'],
      timeControl: '180+2',
    });
    expect(libraryPlayedOf(r)).toEqual({ ms: Date.parse('2026-10-04T10:00:00Z'), hasTime: true, isEnd: false });
    expect(gameDay(r)).toBe(localDay('2026-10-04T10:00:00Z'));
    expect(sortTime(r)).toBe(r.playedAt);
  });

  it('a game with no time control is unchanged', () => {
    const r = record({ start: ['2026.10.04', '10:00:00'], end: ['2026.11.08', '03:15:00'] });
    expect(sortTime(r)).toBe(Date.parse('2026-10-04T10:00:00Z'));
  });

  it('a daily with only an end (no start of its own) keeps what it had', () => {
    const r = record({ end: ['2026.11.08', '03:15:00'], timeControl: '1/259200' });
    const placed = libraryPlayedOf(r)!;
    expect(placed.isEnd).toBe(true);
    expect(placed.ms).toBe(Date.parse('2026-11-08T03:15:00Z'));
    expect(sortTime(r)).toBe(r.playedAt);
  });
});
