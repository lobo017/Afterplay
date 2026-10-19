import { describe, expect, it } from 'vitest';
import { CaptureQueue, MemoryStore, pgnHeaderValues } from '../../extension/src/queue';

const pgn = (white: string, black: string, extra = '') =>
  `[Event "Test"]\n[White "${white}"]\n[Black "${black}"]\n[Result "1-0"]\n[UTCDate "2026.10.04"]${extra}\n\n1. e4 e5 1-0`;

function setup() {
  let now = 1000;
  const store = new MemoryStore();
  const queue = new CaptureQueue(store, () => now);
  return { store, queue, tick: (ms: number) => (now += ms) };
}

describe('Phase 5b — capture queue', () => {
  it('reads PGN header values without parsing moves', () => {
    expect(pgnHeaderValues(pgn('A \\"the\\" B', 'C'))).toMatchObject({ White: 'A "the" B', Black: 'C', Result: '1-0' });
    expect(pgnHeaderValues('[White "A \\"q\\""]\n1. e4')).toEqual({ White: 'A "q"' });
  });

  it('adds ready games once, keeps their PGN apart from the index, and counts them', async () => {
    const { store, queue, tick } = setup();
    expect(await queue.addReady([{ key: 'lichess:Bjl39T9x', source: 'lichess', pgn: pgn('GEU3', 'Lobo017'), method: 'm' }])).toEqual([
      'added',
    ]);
    tick(10);
    expect(
      await queue.addReady([
        { key: 'lichess:Bjl39T9x', source: 'lichess', pgn: pgn('GEU3', 'Lobo017'), method: 'm' },
        { key: 'chesscom:live-1', source: 'chesscom', pgn: pgn('X', 'Y'), method: 'n', url: 'https://www.chess.com/game/live/1' },
      ]),
    ).toEqual(['already-queued', 'added']);
    expect(await queue.counts()).toEqual({ pending: 0, ready: 2, delivered: 0, rejected: 0 });
    const index = store.data.get('queue:index') as Record<string, { white: string; date: string }>;
    expect(index['lichess:Bjl39T9x']).toMatchObject({ white: 'GEU3', date: '2026.10.04' });
    expect(JSON.stringify(index)).not.toContain('1. e4');
    expect(store.data.get('queue:pgn:chesscom:live-1')).toContain('1. e4');
    const list = await queue.list();
    expect(list.map((e) => e.key)).toEqual(['chesscom:live-1', 'lichess:Bjl39T9x']);
  });

  it('hands out batches oldest first, skipping excluded keys', async () => {
    const { queue, tick } = setup();
    for (let i = 0; i < 5; i++) {
      await queue.addReady([{ key: `chesscom:live-${i}`, source: 'chesscom', pgn: pgn(`W${i}`, 'B'), method: 'm' }]);
      tick(1);
    }
    const first = await queue.takeBatch(2);
    expect(first.games.map((g) => g.key)).toEqual(['chesscom:live-0', 'chesscom:live-1']);
    expect(first.remaining).toBe(3);
    expect(first.games[0]).toMatchObject({ source: 'chesscom', method: 'm', capturedAt: 1000 });
    const skipping = await queue.takeBatch(2, new Set(['chesscom:live-0']));
    expect(skipping.games.map((g) => g.key)).toEqual(['chesscom:live-1', 'chesscom:live-2']);
  });

  it('marks only ready games delivered, drops their PGN and never re-queues them', async () => {
    const { store, queue } = setup();
    await queue.addReady([
      { key: 'lichess:aaaaaaaa', source: 'lichess', pgn: pgn('A', 'B'), method: 'm' },
      { key: 'lichess:bbbbbbbb', source: 'lichess', pgn: pgn('C', 'D'), method: 'm' },
    ]);
    expect(await queue.markDelivered(['lichess:aaaaaaaa', 'lichess:unknown1', 'lichess:aaaaaaaa'])).toBe(1);
    expect(store.data.has('queue:pgn:lichess:aaaaaaaa')).toBe(false);
    expect(store.data.has('queue:pgn:lichess:bbbbbbbb')).toBe(true);
    expect((await queue.get('lichess:aaaaaaaa'))?.status).toBe('delivered');
    expect(await queue.markDelivered(['lichess:aaaaaaaa'])).toBe(0);
    expect(await queue.addReady([{ key: 'lichess:aaaaaaaa', source: 'lichess', pgn: pgn('A', 'B'), method: 'm' }])).toEqual([
      'already-delivered',
    ]);
    expect((await queue.takeBatch(50)).games.map((g) => g.key)).toEqual(['lichess:bbbbbbbb']);
    expect(await queue.counts()).toEqual({ pending: 0, ready: 1, delivered: 1, rejected: 0 });
  });

  it('keeps pending games until their PGN arrives, with retry times', async () => {
    const { queue, tick } = setup();
    expect(
      await queue.addPending({ key: 'chesscom:live-9', source: 'chesscom', url: 'u', error: 'not yet', nextRetryAt: 2000 }),
    ).toBe('added');
    expect(await queue.dueRetries()).toEqual([]);
    tick(1000);
    expect((await queue.dueRetries()).map((e) => e.key)).toEqual(['chesscom:live-9']);
    await queue.addPending({ key: 'chesscom:live-9', source: 'chesscom', url: 'u', error: 'still not', nextRetryAt: 9000 });
    expect(await queue.get('chesscom:live-9')).toMatchObject({ attempts: 1, error: 'still not', capturedAt: 1000 });
    expect((await queue.takeBatch(50)).games).toEqual([]);
    expect(await queue.addReady([{ key: 'chesscom:live-9', source: 'chesscom', pgn: pgn('A', 'B'), method: 'archive' }])).toEqual([
      'updated',
    ]);
    expect(await queue.get('chesscom:live-9')).toMatchObject({ status: 'ready', error: null, nextRetryAt: null, url: 'u' });
    expect(await queue.remove('chesscom:live-9')).toBe(true);
    expect(await queue.counts()).toEqual({ pending: 0, ready: 0, delivered: 0, rejected: 0 });
  });

  it('runs concurrent operations one at a time, so no write is lost', async () => {
    const { queue } = setup();
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        queue.addReady([{ key: `chesscom:live-${i}`, source: 'chesscom', pgn: pgn(`W${i}`, 'B'), method: 'm' }]),
      ),
    );
    expect((await queue.counts()).ready).toBe(20);
  });
});
