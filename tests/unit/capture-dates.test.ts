import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { chessComCallbackToPgn, type ChessComCallback } from '../../extension/src/extractors/chesscom-callback';
import { CaptureQueue, MemoryStore } from '../../extension/src/queue';
import {
  formatPlayedAt,
  localDateTime,
  playedAtDetail,
  playedAtFromHeaders,
  readPgnHeaders,
} from '../../src/capture/pgn-time';

const FIX = path.join(__dirname, '..', 'fixtures', 'capture');

describe('Phase 5b — game dates and times', () => {
  it("reads when a game was played from the PGN's UTC headers, in order of preference", () => {
    // Lichess: UTCDate + UTCTime
    expect(playedAtDetail({ Date: '2026.10.04', UTCDate: '2026.10.04', UTCTime: '05:33:38' })).toEqual({
      ms: Date.UTC(2026, 9, 4, 5, 33, 38),
      hasTime: true,
      isEnd: false,
    });
    // Chess.com archive: UTCTime wins over EndTime
    expect(
      playedAtFromHeaders({ UTCDate: '2026.10.03', UTCTime: '16:35:21', EndDate: '2026.10.03', EndTime: '16:37:15' }),
    ).toBe(Date.UTC(2026, 9, 3, 16, 35, 21));
    expect(playedAtFromHeaders({ Date: '2026.10.18', StartTime: '09:28:20' })).toBe(Date.UTC(2026, 9, 18, 9, 28, 20));
    // Chess.com game data: only the end, possibly with "GMT+0000"
    expect(playedAtDetail({ Date: '2026.10.03', EndTime: '9:34:36 GMT+0000' })).toEqual({
      ms: Date.UTC(2026, 9, 3, 9, 34, 36),
      hasTime: true,
      isEnd: true,
    });
    expect(playedAtDetail({ Date: '2026.10.02', EndDate: '2026.10.03', EndTime: '00:01:02' })?.ms).toBe(
      Date.UTC(2026, 9, 3, 0, 1, 2),
    );
    // A date alone; unknown parts
    expect(playedAtDetail({ Date: '2026.10.12' })).toEqual({ ms: Date.UTC(2026, 9, 12), hasTime: false, isEnd: false });
    expect(playedAtFromHeaders({ Date: '2026.??.??' })).toBeNull();
    expect(playedAtDetail({ UTCDate: '2026.10.04', UTCTime: '??:??:??' })).toMatchObject({ hasTime: false });
    expect(playedAtDetail({ Date: '2026.10.04', EndTime: '9:34:36 GMT-0500' })).toMatchObject({ hasTime: false });
  });

  it('shows the time in the given time zone (the viewer’s by default), and a date alone as written', () => {
    const ms = Date.UTC(2026, 9, 17, 20, 30, 0);
    expect(localDateTime(ms, 'UTC')).toEqual({ date: '2026-10-17', time: '20:30', timeZone: 'UTC' });
    expect(localDateTime(ms, 'Asia/Tokyo')).toMatchObject({ date: '2026-10-18', time: '05:30' });
    expect(localDateTime(ms, 'America/Los_Angeles')).toMatchObject({ date: '2026-10-17', time: '13:30' });
    // Daylight saving: 1 Nov 2026 is still summer time in New York at 05:00 UTC, winter time at 07:00 UTC
    expect(localDateTime(Date.UTC(2026, 10, 1, 5, 0), 'America/New_York').time).toBe('01:00');
    expect(localDateTime(Date.UTC(2026, 10, 1, 7, 0), 'America/New_York').time).toBe('02:00');
    expect(localDateTime(Date.UTC(2026, 0, 1, 0, 5), 'Asia/Kolkata')).toMatchObject({
      date: '2026-01-01',
      time: '05:35',
    });
    expect(formatPlayedAt({ ms, hasTime: true, isEnd: false }, 'Asia/Tokyo')).toBe('2026-10-18 05:30');
    expect(formatPlayedAt({ ms: Date.UTC(2026, 9, 12), hasTime: false, isEnd: false }, 'America/Los_Angeles')).toBe(
      '2026-10-12',
    );
    expect(localDateTime(ms).timeZone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
  });

  it('reads PGN headers without parsing the moves (escapes undone, first value wins)', () => {
    expect(readPgnHeaders('[White "A \\"q\\" B"]\n[White "x"]\n[Black "C\\\\D"]\n\n1. e4 *')).toEqual({
      White: 'A "q" B',
      Black: 'C\\D',
    });
  });

  it("the PGN built from Chess.com's game data carries the end (UTC) as EndDate / EndTime", () => {
    const data = JSON.parse(
      fs.readFileSync(path.join(FIX, 'chesscom', 'callback-live-185358990103.json'), 'utf8'),
    ) as ChessComCallback;
    const pgn = chessComCallbackToPgn(data, { site: 'chesscom', gameId: 'live-185358990103' })!;
    const h = readPgnHeaders(pgn);
    expect(h.EndDate).toBe('2026.10.03');
    expect(h.EndTime).toBe('16:37:15');
    expect(playedAtDetail(h)).toEqual({ ms: data.game.endTime! * 1000, hasTime: true, isEnd: true });
  });

  it('queue entries keep when the game was played (with a time only) and how it was captured', async () => {
    const queue = new CaptureQueue(new MemoryStore(), () => 1);
    const lichess = fs.readFileSync(path.join(FIX, 'lichess', 'export-ids-Bjl39T9x.pgn'), 'utf8');
    await queue.addReady([
      { key: 'lichess:Bjl39T9x', source: 'lichess', pgn: lichess, method: 'lichess-sync', trigger: 'sync' },
      {
        key: 'paste:0000000000000001',
        source: 'paste',
        pgn: '[Date "2026.10.12"]\n\n1. e4 *',
        method: 'pasted-pgn',
        trigger: 'paste',
      },
    ]);
    expect(await queue.get('lichess:Bjl39T9x')).toMatchObject({
      playedAt: Date.UTC(2026, 9, 4, 5, 33, 38),
      trigger: 'sync',
    });
    expect(await queue.get('paste:0000000000000001')).toMatchObject({
      playedAt: null,
      date: '2026.10.12',
      trigger: 'paste',
    });
    // A pending game that resolves later keeps what first captured it
    await queue.addPending({
      key: 'chesscom:live-9',
      source: 'chesscom',
      url: null,
      error: 'x',
      nextRetryAt: null,
      trigger: 'left-page',
    });
    await queue.addReady([
      {
        key: 'chesscom:live-9',
        source: 'chesscom',
        pgn: '[White "a"]\n\n1. e4 *',
        method: 'chesscom-archive',
        trigger: 'link',
      },
    ]);
    expect(await queue.get('chesscom:live-9')).toMatchObject({ status: 'ready', trigger: 'left-page' });
  });
});
