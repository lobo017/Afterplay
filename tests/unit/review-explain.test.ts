import { describe, expect, it } from 'vitest';
import { classifyMove, isErrorClass } from '../../src/review/classification';
import { explainMove } from '../../src/review/explain';
import type { PositionAnalysis } from '../../src/review/types';
import { classificationFixtures, classifyInputFor } from '../helpers/review-fixtures';

function explainFixture(id: string) {
  const fixture = classificationFixtures.find((f) => f.id === id);
  if (!fixture) throw new Error(`no fixture ${id}`);
  const input = classifyInputFor(fixture);
  const result = classifyMove(input)!;
  return explainMove({
    classification: result.classification,
    fenBefore: input.fenBefore,
    uci: input.uci,
    winBefore: result.winBefore,
    winAfter: result.winAfter,
    before: input.before,
    after: input.after,
  });
}

describe('Phase 5 — explanations from the classification fixtures', () => {
  for (const fixture of classificationFixtures.filter((f) => isErrorClass(f.expected))) {
    it(`${fixture.id} gets one sentence`, () => {
      const { explanation } = explainFixture(fixture.id);
      expect(explanation, fixture.id).toBeTruthy();
      expect(explanation!.endsWith('.'), explanation!).toBe(true);
      // One sentence: no full stop before the end (SAN never contains one)
      expect(explanation!.slice(0, -1).includes('. '), explanation!).toBe(false);
      if (fixture.explanation) expect(explanation).toBe(fixture.explanation);
      if (fixture.explanationPrefix) {
        expect(explanation!.startsWith(fixture.explanationPrefix), explanation!).toBe(true);
      }
    });
  }

  it('gives no sentence for moves that are not errors', () => {
    for (const fixture of classificationFixtures.filter((f) => !isErrorClass(f.expected))) {
      expect(explainFixture(fixture.id).explanation, fixture.id).toBeNull();
    }
  });

  it('explains a discovered attack in the refutation', () => {
    // Nh4 lets ...Nxe4 uncover the d8 queen against the loose knight on h4
    expect(explainFixture('mistake-nh4').explanation).toBe(
      'Allows Nxe4, a discovered attack on the knight on h4.',
    );
  });

  it('describes an unsound sacrifice as material given up', () => {
    expect(explainFixture('blunder-unsound-sacrifice-bxf7').explanation).toMatch(
      /^Gives up the bishop on f7 for a pawn; [RK]xf7 takes it\.$/,
    );
  });

  it('tags motifs with whose move they belong to', () => {
    const hangs = explainFixture('blunder-nd4-hangs-knight');
    expect(hangs.motifs).toContainEqual(
      expect.objectContaining({ kind: 'hanging-piece', square: 'd4', role: 'played' }),
    );
    const mate = explainFixture('blunder-throws-away-mate-entirely');
    expect(mate.motifs).toContainEqual(
      expect.objectContaining({ kind: 'missed-mate', mateIn: 1, role: 'missed' }),
    );
    const backRank = explainFixture('decided-winning-allows-back-rank-mate');
    expect(backRank.motifs).toContainEqual(
      expect.objectContaining({ kind: 'back-rank', square: 'g1', role: 'refutation' }),
    );
  });
});

describe('Phase 5 — explanation rules (hand-set engine scores)', () => {
  const analysis = (
    fen: string,
    lines: Array<[string[], { type: 'cp' | 'mate'; value: number }]>,
  ): PositionAnalysis => ({
    fen,
    depth: 20,
    lines: lines.map(([pv, score], i) => ({ multipv: i + 1, score, pv })),
  });

  it('names a fork in the refutation', () => {
    // Qa3?? steps onto a square the d4 knight can fork with the king: ...Nc2+
    const before = '4k3/8/8/8/3n4/7Q/8/4K3 w - - 0 1';
    const result = explainMove({
      classification: 'Blunder',
      fenBefore: before,
      uci: 'h3a3',
      winBefore: 98,
      winAfter: 50,
      before: analysis(before, [[['h3h5'], { type: 'cp', value: 700 }]]),
      after: analysis('4k3/8/8/8/3n4/Q7/8/4K3 b - - 1 1', [
        [['d4c2', 'e1d2', 'c2a3'], { type: 'cp', value: 0 }],
      ]),
    });
    expect(result.explanation).toBe('Allows Nc2+, forking the king and queen.');
    expect(result.motifs).toContainEqual(
      expect.objectContaining({ kind: 'fork', square: 'c2', role: 'refutation' }),
    );
  });

  it('says a piece that was already attacked was left hanging', () => {
    // The rook on d3 is attacked by the b5 bishop and undefended; Kf1 ignores it
    const before = '4k3/8/8/1b6/8/3R4/8/4K3 w - - 0 1';
    const result = explainMove({
      classification: 'Blunder',
      fenBefore: before,
      uci: 'e1f1',
      winBefore: 60,
      winAfter: 20,
      before: analysis(before, [[['d3d5'], { type: 'cp', value: 100 }]]),
      after: analysis('4k3/8/8/1b6/8/3R4/8/5K2 b - - 1 1', [
        [['b5d3'], { type: 'cp', value: 400 }],
      ]),
    });
    expect(result.explanation).toBe('Leaves the rook on d3 hanging to Bxd3+.');
  });

  it('falls back to the evaluation when there is no tactic', () => {
    const fen = 'r1bq1rk1/ppp2ppp/2np1n2/2b1p3/2B1P3/2PP1N2/PP3PPP/RNBQ1RK1 w - - 0 7';
    const after = 'r1bq1rk1/ppp2ppp/2np1n2/2b1p3/2B1P3/P1PP1N2/1P3PPP/RNBQ1RK1 b - - 0 7';
    const explain = (winBefore: number, winAfter: number) =>
      explainMove({
        classification: 'Inaccuracy',
        fenBefore: fen,
        uci: 'a2a3',
        winBefore,
        winAfter,
        before: analysis(fen, [[['a2a4'], { type: 'cp', value: 25 }]]),
        after: analysis(after, [[['a7a6'], { type: 'cp', value: 40 }]]),
      }).explanation;
    expect(explain(54, 40)).toBe('Hands the opponent the advantage; a4 was better.');
    expect(explain(80, 70)).toBe('Lets part of the advantage slip; a4 was better.');
    expect(explain(45, 37)).toBe('Loses ground; a4 was better.');
  });
});
