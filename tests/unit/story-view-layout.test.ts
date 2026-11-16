import { describe, expect, it } from 'vitest';
import { glue, packSpans } from '../../src/story/view';

describe('the Story’s wide layout', () => {
  it('fills every row of 12 columns', () => {
    for (const weights of [[4], [4, 4], [4, 4, 4], [4, 4, 4, 4], [4, 4, 6], [6, 6, 6], [4, 4, 4, 4, 6], [6, 6, 4, 4]]) {
      const spans = packSpans(weights);
      expect(spans).toHaveLength(weights.length);
      // Cards of a row follow each other; a row ends when 12 columns are used
      let used = 0;
      for (const s of spans) {
        used += s;
        expect(used).toBeLessThanOrEqual(12);
        if (used === 12) used = 0;
      }
      expect(used).toBe(0);
    }
  });

  it('shares four cards in two rows and keeps a lone card whole', () => {
    expect(packSpans([4, 4, 4, 4])).toEqual([6, 6, 6, 6]);
    expect(packSpans([4])).toEqual([12]);
    expect(packSpans([4, 4, 4])).toEqual([4, 4, 4]);
  });
});

describe('glue', () => {
  it('keeps a number with its unit and a month with its year', () => {
    expect(glue('15 W · 9 L · 119 D.')).toBe('15 W · 9 L · 119 D.');
    expect(glue('1,790 against your 1,287')).toBe('1,790 against your 1,287');
    expect(glue('peak 1,708, Nov 2026')).toBe('peak 1,708, Nov 2026');
    expect(glue('44% won')).toBe('44% won');
    expect(glue('Rapid · 3,180 games')).toBe('Rapid · 3,180 games');
  });
});
