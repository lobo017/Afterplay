import { describe, expect, it } from 'vitest';
import { classifyMove, isErrorClass } from '../../src/review/classification';
import {
  STANDING_MIN_WIN,
  explainMove,
  fallbackSentence,
  formatEvalShort,
  standingFromWin,
} from '../../src/review/explain';
import { winPercentFromCp } from '../../src/review/formulas';
import type { MoveClassification, PositionAnalysis } from '../../src/review/types';
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
      if (fixture.explanationNot) expect(explanation).not.toContain(fixture.explanationNot);
    });
  }

  it('gives no sentence for moves that are not errors', () => {
    for (const fixture of classificationFixtures.filter((f) => !isErrorClass(f.expected))) {
      expect(explainFixture(fixture.id).explanation, fixture.id).toBeNull();
    }
  });

  it('explains a discovered attack in the refutation', () => {
    // Nh4 lets ...Nxe4 uncover the d8 queen against the loose knight on h4
    expect(explainFixture('blunder-nh4-drops-e4-pawn').explanation).toBe(
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

  it('a short line that stops before the recapture names nothing (17.Nc4 from the Lichess game)', () => {
    // The in-app Quick review saw only 17...Nxc4 18.Qa4 (dxc4 still to come) and +3.74 →
    // +2.74 for White: the knight is not lost, so no "winning the knight on c4"
    const before = '1k1r1b1r/1pp1pp2/4qnp1/nP6/3p4/N1PP3P/4PPB1/R1BQK2R w KQ - 1 17';
    const result = explainMove({
      classification: 'Inaccuracy',
      fenBefore: before,
      uci: 'a3c4',
      winBefore: 80.8,
      winAfter: 73.2,
      before: analysis(before, [[['d1a4', 'b8c8'], { type: 'cp', value: 374 }]]),
      after: analysis('1k1r1b1r/1pp1pp2/4qnp1/nP6/2Np4/2PP3P/4PPB1/R1BQK2R b KQ - 2 17', [
        [['a5c4', 'd1a4'], { type: 'cp', value: -274 }],
      ]),
    });
    expect(result.explanation).not.toMatch(/knight on c4|Hangs/);
    expect(result.explanation).toBe("Gives back some of White's winning advantage (+3.7 → +2.7); Qa4 was stronger.");
    expect(result.motifs).toEqual([]);
  });

  describe('falls back to the standing, the evaluation change and the move that kept it', () => {
    // A quiet Italian: no capture or tactic for either side, so only rule 7 (or the Miss
    // fallback) can explain the move. White plays a3 (best a4); Black plays ...h6 (best ...a6).
    const whiteFen = 'r1bq1rk1/ppp2ppp/2np1n2/2b1p3/2B1P3/2PP1N2/PP3PPP/RNBQ1RK1 w - - 0 7';
    const blackFen = 'r1bq1rk1/ppp2ppp/2np1n2/2b1p3/2B1P3/P1PP1N2/1P3PPP/RNBQ1RK1 b - - 0 7';
    const afterBlack = 'r1bq1rk1/ppp2pp1/2np1n1p/2b1p3/2B1P3/P1PP1N2/1P3PPP/RNBQ1RK1 w - - 0 8';
    const cp = (value: number) => ({ type: 'cp' as const, value });
    /** `before` / `after` in centipawns from the mover's side. */
    const explain = (side: 'w' | 'b', classification: MoveClassification, before: number, after: number) =>
      explainMove({
        classification,
        fenBefore: side === 'w' ? whiteFen : blackFen,
        uci: side === 'w' ? 'a2a3' : 'h7h6',
        winBefore: winPercentFromCp(before),
        winAfter: winPercentFromCp(after),
        before: analysis(side === 'w' ? whiteFen : blackFen, [[[side === 'w' ? 'a2a4' : 'a7a6'], cp(before)]]),
        after: analysis(side === 'w' ? blackFen : afterBlack, [[[side === 'w' ? 'a7a6' : 'a3a4'], cp(-after)]]),
      }).explanation;

    // [side, class, before, after, sentence]
    const cases: Array<[side: 'w' | 'b', cls: MoveClassification, before: number, after: number, text: string]> = [
      // From winning
      ['w', 'Inaccuracy', 400, 250, "Gives back some of White's winning advantage (+4.0 → +2.5); a4 was stronger."],
      ['w', 'Mistake', 500, 250, "Gives back much of White's winning advantage (+5.0 → +2.5); a4 was stronger."],
      ['w', 'Blunder', 900, 250, "Gives back a large part of White's winning advantage (+9.0 → +2.5); a4 was stronger."],
      ['w', 'Mistake', 300, 100, "Lets White's winning advantage shrink to a small edge (+3.0 → +1.0); a4 kept the win."],
      ['w', 'Blunder', 400, 100, "Throws away most of White's winning advantage (+4.0 → +1.0); a4 kept the win."],
      ['w', 'Blunder', 200, 0, "Throws away White's winning advantage (+2.0 → 0.0); a4 kept it."],
      ['b', 'Blunder', 200, 0, "Throws away Black's winning advantage (−2.0 → 0.0); a6 kept it."],
      [
        'w',
        'Blunder',
        300,
        -100,
        "Throws away White's winning advantage and gives the opponent the better game (+3.0 → −1.0); a4 kept the win.",
      ],
      ['w', 'Blunder', 300, -400, "Turns White's winning position into a losing one (+3.0 → −4.0); a4 kept the win."],
      ['b', 'Blunder', 300, -400, "Turns Black's winning position into a losing one (−3.0 → +4.0); a6 kept the win."],
      // From a smaller advantage
      ['w', 'Inaccuracy', 150, 80, "Gives back some of White's advantage (+1.5 → +0.8); a4 was stronger."],
      ['w', 'Mistake', 150, 0, "Lets White's advantage slip away (+1.5 → 0.0); a4 kept it."],
      // 6...Be6 in https://lichess.org/Bjl39T9x, a Blunder: −1.57 → +0.23, best ...Bf5
      ['b', 'Blunder', 157, -23, "Throws away Black's advantage (−1.6 → +0.2); a6 kept it."],
      ['w', 'Blunder', 150, -100, "Turns White's advantage into the worse position (+1.5 → −1.0); a4 kept the advantage."],
      ['w', 'Blunder', 150, -300, "Turns White's advantage into a losing position (+1.5 → −3.0); a4 kept the advantage."],
      // From a level position
      ['w', 'Inaccuracy', 50, -40, 'Gives the opponent the easier game (+0.5 → −0.4); a4 was stronger.'],
      ['b', 'Mistake', 0, -150, 'Hands the opponent the advantage in a level position (0.0 → +1.5); a6 kept the balance.'],
      ['w', 'Blunder', 0, -300, 'Turns a level position into a losing one for White (0.0 → −3.0); a4 kept the balance.'],
      // From a worse or losing position
      ['w', 'Inaccuracy', -100, -170, "Makes White's difficult position harder (−1.0 → −1.7); a4 defended better."],
      ['w', 'Blunder', -100, -400, "Turns White's difficult position into a losing one (−1.0 → −4.0); a4 held on."],
      ['b', 'Inaccuracy', -300, -450, "Makes Black's losing position worse (+3.0 → +4.5); a6 was the toughest defence."],
      ['w', 'Mistake', -300, -600, "Makes White's losing position much worse (−3.0 → −6.0); a4 was the toughest defence."],
      // Miss: the opponent's mistake went unpunished
      ['w', 'Miss', 300, 50, 'Misses the win for White (+3.0 → +0.5); a4 was winning.'],
      ['b', 'Miss', 150, 0, "Lets the opponent off the hook (−1.5 → 0.0); a6 kept Black's advantage."],
      ['w', 'Miss', 30, -100, "Leaves the opponent's mistake unpunished (+0.3 → −1.0); a4 punished it."],
    ];
    for (const [side, cls, before, after, text] of cases) {
      it(`${cls}, ${side === 'w' ? 'White' : 'Black'} ${before} → ${after} cp`, () => {
        const sentence = explain(side, cls, before, after)!;
        expect(sentence).toBe(text);
        // Still one sentence
        expect(sentence.slice(0, -1).includes('. ')).toBe(false);
      });
    }

    it('every error class has a severity-matched sentence for the same drop', () => {
      const sentences = (['Inaccuracy', 'Mistake', 'Blunder'] as const).map((c) => explain('w', c, 700, 300));
      expect(new Set(sentences).size).toBe(3);
    });

    it('formats evaluations as the eval bar does, one decimal, White’s side', () => {
      expect(formatEvalShort({ type: 'cp', value: -200 })).toBe('−2.0');
      expect(formatEvalShort({ type: 'cp', value: 4 })).toBe('0.0');
      expect(formatEvalShort({ type: 'cp', value: -4 })).toBe('0.0');
      expect(formatEvalShort({ type: 'cp', value: 155 })).toBe('+1.6');
      expect(formatEvalShort({ type: 'mate', value: 3 })).toBe('M3');
      expect(formatEvalShort({ type: 'mate', value: -2 })).toBe('−M2');
    });

    it('leaves the second half out when there is no better move to name', () => {
      expect(
        fallbackSentence({
          classification: 'Mistake',
          side: 'w',
          winBefore: 60,
          winAfter: 50,
          evalChange: '+1.0 → 0.0',
          bestSan: null,
        }),
      ).toBe("Lets White's advantage slip away (+1.0 → 0.0).");
      // An error never reads as an improvement: noise across a band edge stays in the band
      expect(standingFromWin(STANDING_MIN_WIN.winning)).toBe('winning');
      expect(standingFromWin(STANDING_MIN_WIN.equal)).toBe('worse');
    });
  });
});
