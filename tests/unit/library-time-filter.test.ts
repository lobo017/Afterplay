import { describe, expect, it } from 'vitest';
import { checkPgnText } from '../../src/capture/pgn-games';
import { buildGameRecord } from '../../src/library/game-record';
import { NO_FILTER, activeFilters, matchesFilter, toRow, type GameFilter } from '../../src/library/game-rows';
import { timeClassOf, TIME_CLASSES } from '../../src/story/stats';
import { CLASS_LABEL } from '../../src/story/text';
import type { StoredGameRecord } from '../../src/storage/db';

// The Library's Time filter uses the Story's own classification (timeClassOf, which uses classOfSeconds): the same game
// is in the same class in both. A 1/N control is Daily; a game whose class cannot be read shows under All only.
const ACCOUNTS = [{ site: 'chesscom' as const, username: 'Me' }];

function game(timeControl: string | null, white = 'Me', result = '1-0') {
  const tc = timeControl === null ? '' : `[TimeControl "${timeControl}"]\n`;
  const pgn = `[Event "T"]\n[White "${white}"]\n[Black "Bob"]\n[Result "${result}"]\n[Date "2026.10.04"]\n${tc}\n1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 ${result}`;
  const valid = checkPgnText(pgn).games[0]!;
  const record: StoredGameRecord = { ...buildGameRecord(valid), schemaVersion: 4, createdAt: 1, updatedAt: 1 };
  return toRow(record, ACCOUNTS);
}

const BY_CLASS = {
  bullet: ['60', '120+1', '179'],
  blitz: ['180', '180+0', '300', '300+5', '599'],
  rapid: ['600', '900+10', '1499'],
  classical: ['1500', '1800', '3600+30'],
  daily: ['1/86400', '1/259200', '1/172800'],
} as const;
const UNKNOWN = [null, '-', '?', 'abc', '40/7200:3600'];

const filtered = (timeClass: GameFilter['timeClass'], extra: Partial<GameFilter> = {}) => ({
  ...NO_FILTER,
  timeClass,
  ...extra,
});

describe('Library Time filter', () => {
  it('has the Story’s five class names, in the Story’s order', () => {
    expect(TIME_CLASSES.map((c) => CLASS_LABEL[c])).toEqual(['Bullet', 'Blitz', 'Rapid', 'Classical', 'Daily']);
  });

  for (const cls of TIME_CLASSES) {
    it(`${CLASS_LABEL[cls]} keeps exactly the ${cls} games`, () => {
      for (const [other, controls] of Object.entries(BY_CLASS)) {
        for (const tc of controls) {
          expect(matchesFilter(game(tc), filtered(cls)), `${tc} under ${cls}`).toBe(other === cls);
        }
      }
      for (const tc of UNKNOWN) expect(matchesFilter(game(tc), filtered(cls)), `${tc} under ${cls}`).toBe(false);
    });
  }

  it('a 1/N time control is Daily, whatever N is', () => {
    for (const tc of BY_CLASS.daily) expect(matchesFilter(game(tc), filtered('daily'))).toBe(true);
    expect(matchesFilter(game('1/86400'), filtered('classical'))).toBe(false);
  });

  it('agrees with the Story’s classification for every control', () => {
    for (const tc of [...Object.values(BY_CLASS).flat(), ...UNKNOWN]) {
      for (const cls of TIME_CLASSES) {
        expect(matchesFilter(game(tc), filtered(cls)), `${tc} under ${cls}`).toBe(timeClassOf(tc ?? undefined) === cls);
      }
    }
  });

  it('a game whose class cannot be determined shows under All only', () => {
    for (const tc of UNKNOWN) {
      expect(matchesFilter(game(tc), NO_FILTER)).toBe(true);
      expect(matchesFilter(game(tc), filtered('all'))).toBe(true);
      for (const cls of TIME_CLASSES) expect(matchesFilter(game(tc), filtered(cls))).toBe(false);
    }
  });

  it('combines with the other filters (both must match)', () => {
    const blitzWin = game('300', 'Me', '1-0');
    const blitzLoss = game('300', 'Me', '0-1');
    const rapidWin = game('900+10', 'Me', '1-0');
    expect(matchesFilter(blitzWin, filtered('blitz', { result: 'win' }))).toBe(true);
    expect(matchesFilter(blitzLoss, filtered('blitz', { result: 'win' }))).toBe(false);
    expect(matchesFilter(rapidWin, filtered('blitz', { result: 'win' }))).toBe(false);
    expect(matchesFilter(rapidWin, filtered('rapid', { color: 'w', from: '2026-10-01', to: '2026-10-31' }))).toBe(true);
    expect(matchesFilter(rapidWin, filtered('rapid', { color: 'b' }))).toBe(false);
    expect(matchesFilter(rapidWin, filtered('rapid', { from: '2026-11-01' }))).toBe(false);
  });

  it('counts as one active filter when set, and not when All', () => {
    expect(activeFilters(NO_FILTER)).toBe(0);
    expect(activeFilters(filtered('daily'))).toBe(1);
    expect(activeFilters(filtered('blitz', { result: 'win' }))).toBe(2);
    expect(activeFilters(filtered('all'))).toBe(0);
  });
});
