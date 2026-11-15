import { describe, expect, it } from 'vitest';
import { NO_FILTER, gamesSummary, matchesFilter, reviewedInAdvance, toRow } from '../../src/library/game-rows';
import type { UserAccount } from '../../src/review/perspective';
import { hasSavedReview, type StoredGameRecord } from '../../src/storage/db';
import { computeStoryStats } from '../../src/story/stats';
import { ME, game, utc } from './helpers/story-games';
import { reviewed } from './helpers/story-reviews';

const mine: UserAccount[] = [
  { site: 'chesscom', username: ME },
  { site: 'lichess', username: ME },
];

/** What the Games page prints for a library: every record, whatever the list's filters show. */
function summaryOf(records: StoredGameRecord[]): string {
  const rows = records.map((r) => toRow(r, mine));
  return gamesSummary({
    games: records.length,
    analyzed: records.filter((r) => hasSavedReview(r)).length,
    inAdvance: rows.filter(reviewedInAdvance).length,
  });
}
const advance = (id: string, at: number, o: Parameters<typeof reviewed>[1] = {}, extra = {}) =>
  reviewed(game({ id, at, variantSalt: id, ...extra }), o);

describe('gamesSummary', () => {
  it('keeps today’s text when nothing was reviewed in advance', () => {
    expect(gamesSummary({ games: 2, analyzed: 0, inAdvance: 0 })).toBe('2 games · 0 analyzed');
    expect(gamesSummary({ games: 1, analyzed: 1, inAdvance: 0 })).toBe('1 game · 1 analyzed');
    expect(gamesSummary({ games: 0, analyzed: 0, inAdvance: 0 })).toBe('0 games · 0 analyzed');
  });

  it('adds the games reviewed in advance only when there are some, and uses the singular for one game', () => {
    expect(gamesSummary({ games: 1, analyzed: 0, inAdvance: 1 })).toBe('1 game · 0 analyzed · 1 reviewed in advance');
    expect(gamesSummary({ games: 12, analyzed: 3, inAdvance: 9 })).toBe(
      '12 games · 3 analyzed · 9 reviewed in advance',
    );
  });

  it('writes thousands separators', () => {
    expect(gamesSummary({ games: 4623, analyzed: 1, inAdvance: 4579 })).toBe(
      '4,623 games · 1 analyzed · 4,579 reviewed in advance',
    );
  });
});

describe('which games count as reviewed in advance', () => {
  const rowOf = (r: StoredGameRecord) => toRow(r, mine);

  it('is the Story’s reader: a usable summary of my side with at least 10 plies', () => {
    expect(reviewedInAdvance(rowOf(advance('a', utc(2026, 1), { plies: 10 })))).toBe(true);
    expect(reviewedInAdvance(rowOf(advance('b', utc(2026, 1), { plies: 8 })))).toBe(false);
    expect(reviewedInAdvance(rowOf(advance('c', utc(2026, 1), {}, { me: 'someoneelse' })))).toBe(false);
    const old = {
      ...game({ id: 'd' }),
      analysis: { preset: 'quick' as const, savedAt: 1, whiteAccuracy: 90, blackAccuracy: 70 },
    };
    expect(reviewedInAdvance(rowOf(old))).toBe(false);
    expect(reviewedInAdvance(rowOf(game({ id: 'e' })))).toBe(false);
  });

  it('does not count a review made on this device', () => {
    const device = reviewed(game({ id: 'f' }), { advance: false, preset: 'quick' });
    expect(hasSavedReview(device)).toBe(true);
    expect(reviewedInAdvance(rowOf(device))).toBe(false);
  });

  it('counts games from both sites', () => {
    const rs = [
      advance('c1', utc(2026, 1), {}, { source: 'chesscom' }),
      advance('l1', utc(2026, 1), {}, { source: 'lichess' }),
      advance('l2', utc(2026, 2), {}, { source: 'lichess' }),
    ];
    expect(summaryOf(rs)).toBe('3 games · 0 analyzed · 3 reviewed in advance');
  });
});

describe('a game reviewed on this device replaces its summary', () => {
  it('moves from "reviewed in advance" to "analyzed", and counts once', () => {
    const batch = Array.from({ length: 12 }, (_, i) => advance(`g${i}`, utc(2026, 1 + (i % 6), 5)));
    expect(summaryOf(batch)).toBe('12 games · 0 analyzed · 12 reviewed in advance');
    // The same game, now with a full review saved here (what saveReview writes: no summaryOnly)
    const device = reviewed(game({ id: 'g3', at: utc(2026, 4, 5), variantSalt: 'g3' }), {
      advance: false,
      preset: 'quick',
    });
    const after = batch.map((r) => (r.id === device.id ? device : r));
    expect(after).toHaveLength(12);
    expect(summaryOf(after)).toBe('12 games · 1 analyzed · 11 reviewed in advance');
  });
});

describe('the summary covers the whole library, not the filtered list', () => {
  it('does not change with a date range or the accuracy filter, while the filtered rows do', () => {
    // 24 games over six months, 4 a month; accuracy 60 to 83
    const records = Array.from({ length: 24 }, (_, i) =>
      advance(`m${i}`, utc(2026, 1 + Math.floor(i / 4), 10 + (i % 4)), { accuracy: 60 + i }),
    );
    const before = summaryOf(records);
    expect(before).toBe('24 games · 0 analyzed · 24 reviewed in advance');
    const rows = records.map((r) => toRow(r, mine));

    // Two months: February and March (8 games)
    const byDate = rows.filter((r) => matchesFilter(r, { ...NO_FILTER, from: '2026-02-01', to: '2026-03-31' }));
    expect(byDate).toHaveLength(records.filter((r) => /^2026\.0[23]\./.test(r.date)).length);
    expect(byDate).toHaveLength(8);
    // Accuracy of at least 80: the last four games
    const byAccuracy = rows.filter((r) => matchesFilter(r, { ...NO_FILTER, minAccuracy: 80 }));
    expect(byAccuracy).toHaveLength(records.filter((r) => (r.accuracy ?? 0) >= 80).length);
    expect(byAccuracy).toHaveLength(4);

    // The library is the same, so the summary is too
    expect(summaryOf(records)).toBe(before);
    expect(byDate.length).toBeLessThan(records.length);
    expect(byAccuracy.length).toBeLessThan(records.length);
  });
});

describe('against the Story and Insights', () => {
  const NOW = utc(2026, 6, 20);

  it('equals the Story’s count when every game is one the Story counts', () => {
    const rs = Array.from({ length: 25 }, (_, i) => advance(`s${i}`, utc(2026, 1 + (i % 5), 3 + i)));
    const story = computeStoryStats(rs, mine, NOW).all.review.inAdvance;
    expect(story).toBe(25);
    expect(summaryOf(rs)).toBe(`25 games · 0 analyzed · ${story} reviewed in advance`);
  });

  it('is higher by exactly the reviewed games the Story leaves out (unfinished, Chess960)', () => {
    const counted = Array.from({ length: 20 }, (_, i) => advance(`s${i}`, utc(2026, 1 + (i % 5), 3 + i)));
    const left = [
      ...Array.from({ length: 3 }, (_, i) =>
        advance(`open${i}`, utc(2026, 2, 3 + i), {}, { outcome: 'unfinished' as const }),
      ),
      ...Array.from({ length: 2 }, (_, i) =>
        advance(`c960${i}`, utc(2026, 3, 3 + i), {}, { headers: { Variant: 'Chess960' } }),
      ),
    ];
    const rs = [...counted, ...left];
    const story = computeStoryStats(rs, mine, NOW).all.review.inAdvance;
    expect(story).toBe(20);
    expect(summaryOf(rs)).toBe(`25 games · 0 analyzed · ${story + left.length} reviewed in advance`);
  });

  it('is the number the Insights header uses: games of mine passing the same test', () => {
    const rs = [
      ...Array.from({ length: 6 }, (_, i) => advance(`a${i}`, utc(2026, 1, 3 + i))),
      advance('x', utc(2026, 1, 20), {}, { me: 'someoneelse' }),
    ];
    const rows = rs.map((r) => toRow(r, mine));
    const insightsCount = rows.filter((r) => r.color !== null).filter(reviewedInAdvance).length;
    expect(insightsCount).toBe(6);
    expect(summaryOf(rs)).toBe('7 games · 0 analyzed · 6 reviewed in advance');
  });
});
