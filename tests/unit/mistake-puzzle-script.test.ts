import { describe, expect, it } from 'vitest';
import { isStandardGame } from '../../src/library/game-record';
import { parsePgn } from '../../src/core/pgn';
import { CLASS_THRESHOLDS, classFromWinDrop } from '../../src/review/classification';
import { winPercentFromScore } from '../../src/review/formulas';
import { applyUci, lineToSan } from '../../src/review/board';
import {
  DROP_REASONS,
  PUZZLE_FORMAT,
  PUZZLE_SHARDS,
  PUZZLE_VERSION,
  SELECTION_REASONS,
  dropLine,
  finishPuzzle,
  headerLine,
  isTrivialRecapture,
  judgeBefore,
  mergeParts,
  parsePart,
  puzzleLine,
  replayToPly,
  resumePlan,
  selectGame,
  selectGames,
  shardOf,
  sha256Hex,
  type Deps,
  type Entry,
  type HeaderMeta,
  type Line,
  type Plan,
} from '../../hpc/puzzles/lib/positions.mjs';
import { chunkIds } from '../../hpc/history/lib/reviews.mjs';

// Every game, name and id here is invented.
const deps: Deps = {
  parsePgn,
  isStandardGame,
  applyUci,
  lineToSan,
  winPercentFromScore,
  CLASS_THRESHOLDS,
  classFromWinDrop,
};

const MOVES =
  '1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7 6. Re1 b5 7. Bb3 d6 8. c3 O-O 9. h3 Na5 10. Bc2 c5 *';
const pgnOf = (extra = '', moves = MOVES) => `[Event "Casual"]\n[White "Ann"]\n[Black "Ben"]\n${extra}\n${moves}`;

function record(over: Record<string, unknown> = {}, side: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'chesscom:g1',
    source: 'chesscom',
    result: '1-0',
    playerColor: 'w',
    pgn: pgnOf('[Result "1-0"]\n'),
    analysis: { plies: 20, summaryOnly: true, sides: { w: { dropPly: 9, drop: 30, ...side } } },
    ...over,
  };
}

const line = (multipv: number, score: Line['score'], pv: string[]): Line => ({ multipv, score, pv });
const cp = (value: number): Line['score'] => ({ type: 'cp', value });

function planOf(pgn: string, ply: number): Plan {
  const replay = replayToPly(parsePgn(pgn), ply)!;
  return { id: 'chesscom:g1', color: replay.playedColor, ply, storedDrop: 30, ...replay };
}
const plan9 = () => planOf(pgnOf('[Result "1-0"]\n'), 9);

describe('replaying a game to a ply', () => {
  const tree = parsePgn(pgnOf('[Result "1-0"]\n'));
  const main = tree.getMainLine();

  it('finds the move, the position before it and the position before the opponent’s last move', () => {
    const r = replayToPly(tree, 9)!;
    expect(r.playedSan).toBe('O-O');
    expect(r.playedUci).toBe('e1g1');
    expect(r.playedColor).toBe('w');
    expect(r.ucis).toHaveLength(9);
    expect(r.fenBefore).toBe(main[7]!.fen);
    expect(r.fenSetup).toBe(main[6]!.fen);
    expect(r.setupUci).toBe(main[7]!.uci);
    expect(r.plies).toBe(20);
  });

  it('starts from the first position at ply 2, and has no setup move before that', () => {
    const r = replayToPly(tree, 2)!;
    expect(r.fenSetup).toBe(tree.root.fen);
    expect(r.setupUci).toBe('e2e4');
    expect(replayToPly(tree, 1)).toBeNull();
    expect(replayToPly(tree, 0)).toBeNull();
  });

  it('gives nothing past the last move or for a ply that is not a whole number', () => {
    expect(replayToPly(tree, 21)).toBeNull();
    expect(replayToPly(tree, 2.5)).toBeNull();
  });
});

describe('choosing the games', () => {
  it('chooses a standard, finished game of 10 plies or more with a stored worst move of 20 win% or more', () => {
    const r = selectGame(record(), deps);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.plan.ply).toBe(9);
      expect(r.plan.color).toBe('w');
      expect(r.plan.storedDrop).toBe(30);
    }
  });

  const reason = (rec: Record<string, unknown>, d: Deps = deps) => {
    const r = selectGame(rec, d);
    return r.ok ? 'chosen' : r.reason;
  };

  it('leaves out each kind of game with its own reason', () => {
    expect(reason(record({ source: 'paste' }))).toBe('not a site game');
    expect(reason(record({ result: '*' }))).toBe('not finished');
    expect(reason(record({ playerColor: null }))).toBe('no player colour');
    expect(reason(record({ analysis: { plies: 8, sides: { w: { dropPly: 3, drop: 40 } } } }))).toBe('under 10 plies');
    expect(reason(record({ analysis: null }))).toBe('no stored worst move');
    expect(reason(record({ analysis: { plies: 20, sides: { b: { dropPly: 10, drop: 40 } } } }))).toBe(
      'no stored worst move',
    );
    expect(reason(record({}, { dropPly: null }))).toBe('no stored worst move');
    expect(reason(record({}, { dropPly: 1 }))).toBe('worst move before ply 2');
    expect(reason(record({}, { drop: 19.9 }))).toBe('stored drop under 20');
    expect(reason(record({}, { drop: 20 }))).toBe('chosen');
    expect(reason(record({}, { dropPly: 10 }))).toBe('worst move is not the player move');
    expect(reason(record({}, { dropPly: 99 }))).toBe('worst move is not the player move');
  });

  it('leaves out variants and set-up positions, and a game that cannot be read', () => {
    expect(reason(record({ pgn: pgnOf('[Result "1-0"]\n[Variant "Chess960"]\n') }))).toBe('not standard chess');
    expect(reason(record({ pgn: pgnOf('[Result "1-0"]\n[SetUp "1"]\n') }))).toBe('not standard chess');
    const throwing: Deps = {
      ...deps,
      parsePgn: () => {
        throw new Error('bad');
      },
    };
    expect(reason(record(), throwing)).toBe('game could not be read');
  });

  it('a game that is 9 plies long is left out even when its summary says nothing about its length', () => {
    const short = pgnOf('[Result "1-0"]\n', '1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 *');
    expect(reason(record({ pgn: short, analysis: { sides: { w: { dropPly: 5, drop: 30 } } } }))).toBe('under 10 plies');
  });

  it('counts every game once and lists the chosen ones by id', () => {
    const games = [
      record({ id: 'chesscom:b' }),
      record({ id: 'chesscom:a' }),
      record({ id: 'chesscom:c', source: 'paste' }),
      record({ id: 'chesscom:d' }, { drop: 5 }),
    ];
    const s = selectGames(games, deps);
    expect(s.games).toBe(4);
    expect(s.candidates.map((c) => c.id)).toEqual(['chesscom:a', 'chesscom:b']);
    expect(s.reasons['not a site game']).toBe(1);
    expect(s.reasons['stored drop under 20']).toBe(1);
    expect(Object.keys(s.reasons)).toEqual(SELECTION_REASONS);
    expect(Object.values(s.reasons).reduce((a, b) => a + b, 0) + s.candidates.length).toBe(4);
  });
});

describe('judging the position before the move', () => {
  const plan = plan9();
  const judge = (lines: Line[]) => judgeBefore(plan, { lines }, deps);
  const reasonOf = (lines: Line[]) => {
    const r = judge(lines);
    return r.keep ? 'kept' : r.reason;
  };
  const GOOD = [line(1, cp(300), ['d2d4', 'e5d4']), line(2, cp(-100), ['a2a3'])];

  it('keeps a clear best move and gives its short line in SAN and its win% before', () => {
    const r = judge(GOOD);
    expect(r.keep).toBe(true);
    if (r.keep) {
      expect(r.kept.bestUci).toBe('d2d4');
      expect(r.kept.bestLineSan.slice(0, 2)).toEqual(['d4', 'exd4']);
      expect(r.kept.winBefore).toBeCloseTo(winPercentFromScore(cp(300)), 5);
      expect(r.kept.mateIn).toBeNull();
    }
  });

  it('gives no more than 6 plies of the line', () => {
    const pv = ['d2d3', 'b7b5', 'a4b3', 'f8e7', 'c2c3', 'e8g8', 'h2h3'];
    const r = judge([line(1, cp(300), pv), line(2, cp(-100), ['a2a3'])]);
    expect(r.keep && r.kept.bestLineSan.length).toBe(6);
  });

  it('drops a position the engine could not evaluate', () => {
    expect(reasonOf([])).toBe('no evaluation');
    expect(judgeBefore(plan, null, deps)).toEqual({ keep: false, reason: 'no evaluation' });
  });

  it('drops a position where the played move is the best move', () => {
    expect(reasonOf([line(1, cp(300), ['e1g1']), line(2, cp(-100), ['a2a3'])])).toBe('played move is the best move');
  });

  it('keeps the win% before between 25 and 90 only', () => {
    expect(reasonOf([line(1, cp(-700), ['d2d4']), line(2, cp(-900), ['a2a3'])])).toBe('win% before outside 25 to 90');
    expect(reasonOf([line(1, cp(900), ['d2d4']), line(2, cp(-100), ['a2a3'])])).toBe('win% before outside 25 to 90');
    expect(reasonOf([line(1, cp(-170), ['d2d4']), line(2, cp(-600), ['a2a3'])])).toBe('kept');
    expect(winPercentFromScore(cp(-170))).toBeGreaterThan(25);
    expect(winPercentFromScore(cp(-190))).toBeLessThan(35);
  });

  it('keeps a forced mate up to mate in 5, above the 90 limit, and drops a longer one', () => {
    const mate = (n: number) => [line(1, { type: 'mate', value: n }, ['d2d4']), line(2, cp(0), ['a2a3'])];
    const r = judge(mate(3));
    expect(r.keep && r.kept.mateIn).toBe(3);
    expect(reasonOf(mate(5))).toBe('kept');
    expect(reasonOf(mate(6))).toBe('mate longer than 5');
    // Being mated is a lost position, not a puzzle
    expect(reasonOf([line(1, { type: 'mate', value: -2 }, ['d2d4']), line(2, cp(-900), ['a2a3'])])).toBe(
      'win% before outside 25 to 90',
    );
  });

  it('drops a position with one legal move and one where the second best is nearly as good', () => {
    expect(reasonOf([line(1, cp(300), ['d2d4'])])).toBe('only one legal move');
    expect(reasonOf([line(1, cp(100), ['d2d4']), line(2, cp(80), ['a2a3'])])).toBe('best move not clearly best');
    // The gap is in win%: 100 cp against 0 cp is about 9 points, 150 against 0 about 14
    expect(reasonOf([line(1, cp(100), ['d2d4']), line(2, cp(0), ['a2a3'])])).toBe('best move not clearly best');
    expect(reasonOf([line(1, cp(150), ['d2d4']), line(2, cp(0), ['a2a3'])])).toBe('kept');
  });

  it('sorts the lines by their number first', () => {
    const r = judge([line(2, cp(-100), ['a2a3']), line(1, cp(300), ['d2d4'])]);
    expect(r.keep && r.kept.bestUci).toBe('d2d4');
  });
});

describe('a trivial recapture', () => {
  // 1. e4 d5 2. exd5: Black to move, and the pawn on d5 was just taken
  const pgn = '[Result "*"]\n\n1. e4 d5 2. exd5 Nf6 *';
  const recapturePlan = planOf(pgn, 4);

  it('is a best move that takes on the square the opponent just took on', () => {
    expect(recapturePlan.setupCaptured).toBe(true);
    expect(recapturePlan.setupTo).toBe('d5');
    expect(isTrivialRecapture(recapturePlan, 'd8d5', deps)).toBe(true);
    const r = judgeBefore(
      recapturePlan,
      { lines: [line(1, cp(0), ['d8d5', 'b1c3']), line(2, cp(-300), ['e7e6'])] },
      deps,
    );
    expect(r).toEqual({ keep: false, reason: 'trivial recapture' });
  });

  it('is not a capture elsewhere, a quiet move, or any move after a quiet one', () => {
    expect(isTrivialRecapture(recapturePlan, 'e7e6', deps)).toBe(false);
    expect(isTrivialRecapture(recapturePlan, 'g8f6', deps)).toBe(false);
    const quiet = planOf('[Result "*"]\n\n1. e4 d5 2. Nf3 Nf6 *', 4);
    expect(quiet.setupCaptured).toBe(false);
    expect(isTrivialRecapture(quiet, 'd5e4', deps)).toBe(false);
  });

  it('is a capture on the same square only: another capture after a capture is a puzzle', () => {
    // 3. exd5 and Black's best takes the bishop on b5 instead of the pawn
    const other = planOf('[Result "*"]\n\n1. e4 d5 2. exd5 Nf6 *', 4);
    expect(isTrivialRecapture(other, 'd8d5', deps)).toBe(true);
    expect(isTrivialRecapture(other, 'c8g4', deps)).toBe(false);
  });
});

describe('measuring the loss after the move', () => {
  const plan = plan9();
  const kept = { bestUci: 'd2d4', winBefore: 60, mateIn: null, bestLineSan: ['d4', 'exd4'] };
  // The after score is the opponent's: +X for them is a loss for the player
  const afterFor = (cpForOpponent: number) => finishPuzzle(plan, kept, cp(cpForOpponent), deps);

  it('keeps a move that lost at least the Mistake threshold, with its class, loss and win% numbers', () => {
    const r = afterFor(400);
    expect(r.keep).toBe(true);
    if (r.keep) {
      const after = 100 - winPercentFromScore(cp(400));
      expect(r.entry.after).toBeCloseTo(after, 2);
      expect(r.entry.before).toBe(60);
      expect(r.entry.loss).toBeCloseTo(60 - after, 2);
      expect(r.entry.class).toBe(classFromWinDrop(60 - after));
      expect(r.entry.class).toBe('Blunder');
      expect(r.entry.moves).toEqual([plan.setupUci, 'd2d4']);
      expect(r.entry.fen).toBe(plan.fenSetup);
      expect(r.entry.playedSan).toBe('O-O');
      expect(r.entry.ply).toBe(9);
    }
  });

  it('labels the class from the review’s thresholds: a Mistake from 10, a Blunder from 15', () => {
    expect(CLASS_THRESHOLDS.mistake).toBe(10);
    expect(CLASS_THRESHOLDS.blunder).toBe(15);
    const mistake = finishPuzzle(plan, { ...kept, winBefore: 60 }, cp(20), deps);
    expect(mistake.keep && mistake.entry.loss).toBeGreaterThanOrEqual(10);
    expect(mistake.keep && mistake.entry.loss).toBeLessThan(15);
    expect(mistake.keep && mistake.entry.class).toBe('Mistake');
  });

  it('drops a move that lost less than a Mistake, or that has no evaluation', () => {
    expect(afterFor(-100)).toEqual({ keep: false, reason: 'measured loss under Mistake' });
    expect(finishPuzzle(plan, kept, null, deps)).toEqual({ keep: false, reason: 'no evaluation' });
  });
});

// ---------------------------------------------------------------------------------------------- part files and merge

const META: HeaderMeta = {
  input: sha256Hex('input'),
  engine: 'Stockfish test',
  commit: 'a'.repeat(40),
  shard: 0,
  shards: 2,
};
const entry = (id: string, over: Partial<Entry> = {}): Entry => ({
  id,
  ply: 9,
  fen: 'fen',
  moves: ['e2e4', 'e7e5'],
  bestLineSan: ['e5'],
  playedSan: 'a6',
  class: 'Blunder',
  loss: 30,
  before: 60,
  after: 30,
  mateIn: null,
  ...over,
});
const IDS = ['g:a', 'g:b', 'g:c', 'g:d', 'g:e'];
const candidates = IDS.map((id) => ({ id }));
const selection = {
  games: 9,
  reasons: Object.fromEntries(SELECTION_REASONS.map((r) => [r, r === 'stored drop under 20' ? 4 : 0])),
};
const partText = (shard: number, lines: string[]) => [headerLine({ ...META, shard }), ...lines].join('\n') + '\n';

describe('the shard split', () => {
  it('gives every chosen game to exactly one shard, by its place in the sorted list, in a fixed order', () => {
    const plans = IDS.map((id) => ({ id })) as Plan[];
    const all = [0, 1].flatMap((k) => shardOf(plans, k, 2).map((p) => p.id));
    expect(all.sort()).toEqual(IDS);
    expect(shardOf(plans, 0, 2).map((p) => p.id)).toEqual(['g:a', 'g:c', 'g:e']);
    expect(shardOf(plans, 1, 2).map((p) => p.id)).toEqual(['g:b', 'g:d']);
    expect(shardOf([...plans].reverse(), 0, 2).map((p) => p.id)).toEqual(['g:e', 'g:c', 'g:a']);
    expect(shardOf(plans, 0, 2).map((p) => p.id)).toEqual(chunkIds(IDS, 0, 2));
  });

  it('is balanced to within one game across the job’s 8 shards', () => {
    expect(PUZZLE_SHARDS).toBe(8);
    const plans = Array.from({ length: 2366 }, (_, i) => ({ id: `g:${String(i).padStart(5, '0')}` })) as Plan[];
    const sizes = Array.from({ length: PUZZLE_SHARDS }, (_, k) => shardOf(plans, k, PUZZLE_SHARDS).length);
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(2366);
    expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(1);
  });
});

describe('reading and resuming a part file', () => {
  it('reads the header, puzzles and drops', () => {
    const p = parsePart(partText(0, [puzzleLine(entry('g:a')), dropLine('g:c', 'trivial recapture')]));
    expect(p.header?.format).toBe(PUZZLE_FORMAT);
    expect(p.header?.version).toBe(PUZZLE_VERSION);
    expect(p.entries.map((e) => e.id)).toEqual(['g:a']);
    expect(p.drops).toEqual([{ id: 'g:c', reason: 'trivial recapture' }]);
    expect([...p.ids]).toEqual(['g:a', 'g:c']);
    expect(p.rewrite).toBe(false);
  });

  it('drops a last line that a stop cut short, and refuses a broken line elsewhere', () => {
    const text = partText(0, [puzzleLine(entry('g:a'))]) + '{"kind":"puzzle","id":"g:c","pl';
    const p = parsePart(text);
    expect(p.rewrite).toBe(true);
    expect(p.entries).toHaveLength(1);
    expect(p.cleanText.endsWith('\n')).toBe(true);
    expect(parsePart(p.cleanText).rewrite).toBe(false);
    expect(() => parsePart(partText(0, ['not json', puzzleLine(entry('g:a'))]))).toThrow(/not JSON/);
  });

  it('refuses a drop with an unknown reason, a game listed twice and a line of no known kind', () => {
    expect(() => parsePart(partText(0, [dropLine('g:a', 'because')]))).toThrow(/valid drop/);
    expect(() => parsePart(partText(0, [puzzleLine(entry('g:a')), puzzleLine(entry('g:a'))]))).toThrow(/twice/);
    expect(() => parsePart(partText(0, ['{"kind":"other"}']))).toThrow(/known kind/);
    expect(() => parsePart('{"format":"x","version":1}\n')).toThrow(/not a part file/);
  });

  it('starts a new file with its header, and continues an old one with only the games not done', () => {
    const ids = ['g:a', 'g:c', 'g:e'];
    const fresh = resumePlan({ text: '', expected: META, ids });
    expect(fresh).toMatchObject({ resumed: false, rewrite: true, todo: ids });
    expect(fresh.cleanText).toBe(`${headerLine(META)}\n`);

    const text = partText(0, [puzzleLine(entry('g:a')), dropLine('g:c', 'best move not clearly best')]);
    const resumed = resumePlan({ text, expected: META, ids });
    expect(resumed.resumed).toBe(true);
    expect(resumed.todo).toEqual(['g:e']);
    expect([...resumed.done]).toEqual(['g:a', 'g:c']);
    expect(resumed.rewrite).toBe(false);

    const cut = resumePlan({ text: `${text}{"kind":"dr`, expected: META, ids });
    expect(cut.todo).toEqual(['g:e']);
    expect(cut.rewrite).toBe(true);
    expect(cut.cleanText).toBe(text);
  });

  it('refuses another run’s file: another input, commit, shard or settings, or a game from another shard', () => {
    const ids = ['g:a', 'g:c', 'g:e'];
    const ok = partText(0, []);
    expect(() => resumePlan({ text: ok, expected: { ...META, input: sha256Hex('other') }, ids })).toThrow(/input/);
    expect(() => resumePlan({ text: ok, expected: { ...META, commit: 'b'.repeat(40) }, ids })).toThrow(/commit/);
    expect(() => resumePlan({ text: ok, expected: { ...META, shard: 1 }, ids })).toThrow(/shard/);
    expect(() => resumePlan({ text: ok.replace('"depth":18', '"depth":20'), expected: META, ids })).toThrow(/settings/);
    expect(() => resumePlan({ text: partText(0, [puzzleLine(entry('g:b'))]), expected: META, ids })).toThrow(
      /not in this shard/,
    );
  });
});

describe('merging the shards', () => {
  const part0 = partText(0, [
    puzzleLine(entry('g:e', { ply: 11 })),
    puzzleLine(entry('g:a')),
    dropLine('g:c', 'trivial recapture'),
  ]);
  const part1 = partText(1, [
    puzzleLine(entry('g:b', { class: 'Mistake', mateIn: 2 })),
    dropLine('g:d', 'mate longer than 5'),
  ]);
  const merge = (parts: string[], extra: Record<string, unknown> = {}) =>
    mergeParts({ parts, candidates, selection, input: META.input, shards: 2, ...extra });

  it('writes the schema: format, version, a short hash of the input and the entries by game id', () => {
    const { text } = merge([part0, part1]);
    const file = JSON.parse(text) as {
      format: string;
      version: number;
      input: string;
      count: number;
      entries: Entry[];
    };
    expect(file.format).toBe(PUZZLE_FORMAT);
    expect(file.version).toBe(1);
    expect(file.input).toBe(META.input.slice(0, 12));
    expect(file.count).toBe(3);
    expect(file.entries.map((e) => e.id)).toEqual(['g:a', 'g:b', 'g:e']);
    expect(Object.keys(file.entries[0]!)).toEqual([
      'id',
      'ply',
      'fen',
      'moves',
      'bestLineSan',
      'playedSan',
      'class',
      'loss',
      'before',
      'after',
      'mateIn',
    ]);
    expect(text.endsWith('\n')).toBe(true);
    expect(text.trim().split('\n')).toHaveLength(1);
  });

  it('gives the same file whatever order the parts arrive in, and the same file twice', () => {
    const a = merge([part0, part1]);
    expect(merge([part1, part0]).text).toBe(a.text);
    expect(merge([part0, part1]).text).toBe(a.text);
  });

  it('counts only: games, left out by reason, chosen, kept, dropped by reason, classes, mates, bytes', () => {
    const { counts, countsText } = merge([part0, part1]);
    expect(counts).toMatchObject({
      games: 9,
      selected: 5,
      kept: 3,
      left: 0,
      classes: { Mistake: 1, Blunder: 2 },
      mates: 1,
    });
    const dropped = counts.dropped as Record<string, number>;
    expect(dropped['trivial recapture']).toBe(1);
    expect(dropped['mate longer than 5']).toBe(1);
    expect(Object.keys(dropped)).toEqual(DROP_REASONS);
    expect((counts.leftOut as Record<string, number>)['stored drop under 20']).toBe(4);
    expect(countsText).not.toContain('g:');
    expect(countsText).not.toContain('fen');
  });

  it('refuses a missing part, a game with no line, another input and another run’s parts, writing nothing', () => {
    expect(() => merge([part0])).toThrow(/missing/);
    expect(() => merge([part0, partText(1, [puzzleLine(entry('g:b'))])])).toThrow(/no line/);
    expect(() => merge([part0, part1], { input: sha256Hex('other') })).toThrow(/another input/);
    const other = partText(1, [puzzleLine(entry('g:b'))]).replace(META.commit, 'c'.repeat(40));
    expect(() => merge([part0, other])).toThrow(/not from one run/);
    expect(() => merge([part0, part0])).toThrow(/two part files/);
    expect(() => merge([partText(0, [puzzleLine(entry('g:b'))]), part1])).toThrow(/not in its shard/);
  });

  it('with allowPartial counts the games with no line as left', () => {
    const r = merge([part0, partText(1, [puzzleLine(entry('g:b'))])], { allowPartial: true });
    expect(r.counts.left).toBe(1);
    expect(r.counts.kept).toBe(3);
    const missing = merge([part0], { allowPartial: true });
    expect(missing.counts.left).toBe(2);
  });

  it('a resumed run gives the same merged file as an uninterrupted one', () => {
    const lines0 = [
      puzzleLine(entry('g:a')),
      dropLine('g:c', 'trivial recapture'),
      puzzleLine(entry('g:e', { ply: 11 })),
    ];
    const whole = partText(0, lines0);
    // stopped after the first game, cut in the middle of the next, then continued
    const stopped = partText(0, [lines0[0]!]) + lines0[1]!.slice(0, 10);
    const plan = resumePlan({ text: stopped, expected: META, ids: ['g:a', 'g:c', 'g:e'] });
    expect(plan.todo).toEqual(['g:c', 'g:e']);
    const continued = plan.cleanText + lines0.slice(1).join('\n') + '\n';
    expect(merge([continued, part1]).text).toBe(merge([whole, part1]).text);
  });
});
