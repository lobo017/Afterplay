import { describe, expect, it } from 'vitest';
import { parsePgn } from '../../src/core/pgn';
import { averageCentipawnLoss, gameAccuracy, winPercentFromCp } from '../../src/review/formulas';
import {
  CLASSIFICATION_NAG,
  buildAnnotatedPgn,
  buildGameReview,
  mainLinePlies,
} from '../../src/review/review-game';
import type { GameTree } from '../../src/core/game-tree';
import {
  lichessGame,
  lichessPositions,
  lichessTree,
  lichessWhiteCps,
} from '../helpers/lichess-fixture';
import { isBookFen } from '../helpers/review-fixtures';

/*
 * Regression against Lichess's own analysis of https://lichess.org/Bjl39T9x
 * (tests/fixtures/review/lichess-Bjl39T9x.json, fetched by scripts/fetch-lichess-game.mjs).
 * Fed Lichess's evaluations, the app's formulas must give Lichess's numbers.
 */

const lichess = lichessGame.game.players;

function reviewWithLichessEvals(tree: GameTree = lichessTree()) {
  const positions = lichessPositions(tree);
  const review = buildGameReview({
    preset: null,
    budget: { depth: 20 },
    startFen: tree.root.fen,
    plies: mainLinePlies(tree),
    positions,
    isBookPosition: isBookFen,
  });
  return { tree, positions, review };
}

describe('Phase 5 — Lichess reference game Bjl39T9x', () => {
  it('is the game the reference numbers belong to', () => {
    expect(lichessGame.game.analysis).toHaveLength(46);
    expect(lichess.white.analysis).toMatchObject({ accuracy: 56, acpl: 149 });
    expect(lichess.black.analysis).toMatchObject({ accuracy: 63, acpl: 104 });
  });

  it("reproduces Lichess's game accuracy: White 56, Black 63", () => {
    const accuracy = gameAccuracy(lichessWhiteCps().map(winPercentFromCp));
    expect(accuracy.white).toBeCloseTo(55.63, 2);
    expect(accuracy.black).toBeCloseTo(63.38, 2);
    expect(Math.round(accuracy.white!)).toBe(lichess.white.analysis.accuracy);
    expect(Math.round(accuracy.black!)).toBe(lichess.black.analysis.accuracy);
  });

  it("reproduces Lichess's ACPL: White 149, Black 104", () => {
    expect(averageCentipawnLoss(lichessWhiteCps())).toEqual({
      white: lichess.white.analysis.acpl,
      black: lichess.black.analysis.acpl,
    });
  });

  it('the review pipeline on Lichess evals gives the same accuracy and ACPL', () => {
    const { review } = reviewWithLichessEvals();
    expect(review.complete).toBe(true);
    expect(Math.round(review.white.accuracy!)).toBe(56);
    expect(Math.round(review.black.accuracy!)).toBe(63);
    expect(Math.round(review.white.acpl!)).toBe(149);
    expect(Math.round(review.black.acpl!)).toBe(104);
  });

  it("labels every move as Lichess judges it (11.Na3 is Lichess's Blunder, here a Miss)", () => {
    const { review } = reviewWithLichessEvals();
    const errors = new Set(['Inaccuracy', 'Mistake', 'Blunder', 'Miss']);
    for (const move of review.moves) {
      const judgment = lichessGame.game.analysis[move.ply - 1]!.judgment?.name;
      const ours = errors.has(move.classification) ? move.classification : undefined;
      if (move.ply === 21) {
        // 11.Na3 leaves Black's hung queen on d6 alone: an unpunished blunder
        expect(judgment).toBe('Blunder');
        expect(ours).toBe('Miss');
        continue;
      }
      expect(ours, `ply ${move.ply} ${move.san}`).toBe(judgment);
    }
    const count = (side: 'white' | 'black') => {
      const c = review[side].counts;
      return { inaccuracy: c.Inaccuracy, mistake: c.Mistake, blunder: c.Blunder + c.Miss };
    };
    for (const side of ['white', 'black'] as const) {
      const { inaccuracy, mistake, blunder } = lichess[side].analysis;
      expect(count(side), side).toEqual({ inaccuracy, mistake, blunder });
    }
  });

  it('reviewing the Lichess-annotated PGN replaces its analysis without duplicates', () => {
    const imported = lichessTree();
    // The export from Lichess carries its own evals, ?!/?/?? NAGs, comments and variations
    expect(lichessGame.pgn).toContain('Inaccuracy. d4 was best.');
    expect(mainLinePlies(imported).length).toBe(46);
    const { positions, review } = reviewWithLichessEvals(imported);
    const pgn = buildAnnotatedPgn(imported, review, positions, 'Stockfish 17.1');
    expect(pgn).not.toMatch(/was best\.|Checkmate is now unavoidable|→/);
    expect(pgn.match(/\[%eval /g)).toHaveLength(45); // every move but the mate itself
    expect(pgn).toContain('[%clk 0:02:00]');

    const exported = parsePgn(pgn);
    const main = exported.getMainLine();
    expect(main).toHaveLength(46);
    main.forEach((node, i) => {
      const move = review.moves[i]!;
      const nag = CLASSIFICATION_NAG[move.classification];
      expect(node.nags, `${i + 1}. ${node.san}`).toEqual(nag === undefined ? [] : [nag]);
      expect((node.comment.match(/Review:/g) ?? []).length).toBeLessThanOrEqual(1);
      // At most one alternative per move, and only the app's best line after its errors
      const siblings = exported.getNode(node.parentId!)!.children;
      const isError = ['Mistake', 'Blunder', 'Miss'].includes(move.classification);
      expect(siblings.length, `${i + 1}. ${node.san}`).toBe(isError && move.bestMoveUci && move.bestMoveUci !== move.uci ? 2 : 1);
    });
    // Idempotent: reviewing the export again gives the same PGN
    const again = reviewWithLichessEvals(parsePgn(pgn));
    expect(buildAnnotatedPgn(parsePgn(pgn), again.review, again.positions, 'Stockfish 17.1')).toBe(pgn);
  });

  it('the bot-level comparison is shown as approximate, and reads far below the players’ ratings', () => {
    const { review } = reviewWithLichessEvals();
    // Recorded so a change is noticed; see BOT_LEVEL_ANCHORS for why this isn't a rating
    expect(review.white.botLevel?.rating).toBeLessThan(lichessGame.game.players.white.rating - 400);
    expect(review.black.botLevel?.rating).toBeLessThan(lichessGame.game.players.black.rating - 400);
  });
});
