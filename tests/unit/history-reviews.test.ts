import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CLASS_LETTERS,
  REVIEW_FORMAT,
  REVIEW_VERSION,
  chunkIds,
  gameLine,
  headerLine,
  headerMismatches,
  makeDirGuard,
  mergeReviews,
  moveHash,
  parsePart,
  partFileName,
  resumePlan,
  sha256Hex,
  skipLine,
  writeThroughRename,
} from '../../hpc/history/lib/reviews.mjs';
import type { HeaderMeta } from '../../hpc/history/lib/reviews.mjs';

const SETTINGS = { depth: 18, multipv: 2, threads: 1, hashMb: 32 };
const INPUT = sha256Hex('invented input');
const meta = (chunk: number, chunks: number, over: Partial<HeaderMeta> = {}): HeaderMeta => ({
  input: INPUT,
  settings: SETTINGS,
  engine: 'Invented Engine 1',
  commit: 'abc1234',
  chunk,
  chunks,
  ...over,
});

interface Game {
  id: string;
  playerColor: 'w' | 'b';
  pgn: string;
  accuracy: number | null;
  analysis: unknown;
}
const movesOf = (g: Game): string[] => g.pgn.split(' ');
const makeGames = (n: number): Game[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `g${String(i).padStart(2, '0')}`,
    playerColor: i % 2 === 0 ? 'w' : 'b',
    pgn: `m${i}a m${i}b m${i}c m${i}d`,
    accuracy: null,
    analysis: null,
  }));

/** What the batch would write for a game: four moves, five positions, the player's side only. */
function entryFor(g: Game) {
  const color = g.playerColor;
  const acc = 70 + Number(g.id.slice(1)) / 10;
  return {
    id: g.id,
    hash: moveHash(movesOf(g)),
    summary: {
      whiteAccuracy: color === 'w' ? acc : null,
      blackAccuracy: color === 'b' ? acc : null,
      depth: 18,
      plies: 4,
      sides: { [color]: { moves: 2, acpl: 12.5, blunder: 1 } },
    },
    win: [50, 52, 49, 40, 41],
    classes: `${CLASS_LETTERS.Good}${CLASS_LETTERS.Best}${CLASS_LETTERS.Blunder}${CLASS_LETTERS.Book}`,
  };
}

/** A task's whole run: header, then a line per game; `stopAfter` cuts it short like a stopped job. */
function runTask(games: Game[], m: HeaderMeta, existing = '', stopAfter = Infinity) {
  const ids = chunkIds(
    games.map((g) => g.id),
    m.chunk,
    m.chunks,
  );
  const plan = resumePlan({ text: existing, expected: m, ids });
  let text = plan.rewrite ? plan.cleanText : existing;
  let n = 0;
  for (const id of plan.todo) {
    if (n++ >= stopAfter) break;
    text += `${gameLine(entryFor(games.find((g) => g.id === id)!))}\n`;
  }
  return text;
}

function fakeFs() {
  const calls: string[] = [];
  return {
    calls,
    writeFileSync: (f: string) => void calls.push(`write ${path.basename(f)}`),
    renameSync: (a: string, b: string) => void calls.push(`rename ${path.basename(a)} ${path.basename(b)}`),
  };
}

describe('Engine review helpers: hashes, paths and chunks', () => {
  it('hashes moves by content and order, not by how they are joined', () => {
    expect(moveHash(['e4', 'e5'])).toBe(moveHash(['e4', 'e5']));
    expect(moveHash(['e4', 'e5'])).not.toBe(moveHash(['e5', 'e4']));
    expect(moveHash(['e4 e5'])).not.toBe(moveHash(['e4', 'e5']));
    expect(moveHash(['e4'])).toMatch(/^[0-9a-f]{64}$/);
    expect(moveHash(['e4', 'e5'])).toBe(sha256Hex(JSON.stringify(['e4', 'e5'])));
  });

  it('uses exactly these class letters', () => {
    expect(Object.values(CLASS_LETTERS).join(' ')).toBe('! G B E O K I M X S');
  });

  it('builds every path inside the folder and rejects the rest', () => {
    const guard = makeDirGuard(path.resolve('scratch-dir'));
    expect(guard(partFileName(3, 8))).toBe(path.resolve('scratch-dir', 'engine', 'part-3-of-8.jsonl'));
    expect(() => guard('..', 'elsewhere')).toThrow('outside');
    expect(() => guard('engine', '..', '..', 'x')).toThrow('outside');
    expect(() => guard(path.resolve('other-dir', 'x'))).toThrow('outside');
    expect(() => guard('.')).toThrow('outside');
    expect(() => guard('')).toThrow('outside');
  });

  it('gives game i of the sorted ids to chunk i mod chunks, so every game has one owner', () => {
    const ids = makeGames(20)
      .map((g) => g.id)
      .reverse();
    const all = [0, 1, 2].flatMap((c) => chunkIds(ids, c, 3));
    expect([...all].sort()).toEqual([...ids].sort());
    expect(chunkIds(ids, 1, 3)).toEqual(['g01', 'g04', 'g07', 'g10', 'g13', 'g16', 'g19']);
  });
});

describe('Engine review helpers: lines and the first-line check', () => {
  it('writes one JSON object per line and rejects a line that does not fit its moves', () => {
    const g = makeGames(1)[0]!;
    const line = gameLine(entryFor(g));
    expect(line).not.toContain('\n');
    expect(JSON.parse(line).kind).toBe('game');
    expect(() => gameLine({ ...entryFor(g), classes: 'OB' })).toThrow('win list');
    expect(() => gameLine({ ...entryFor(g), classes: 'OBXZ' })).toThrow('classes');
    expect(() => gameLine({ ...entryFor(g), hash: 'abc' })).toThrow('hash');
    expect(() => skipLine({ id: 'g00', reason: '' })).toThrow('reason');
    expect(JSON.parse(skipLine({ id: 'g00', reason: 'under 10 plies' }))).toEqual({
      kind: 'skip',
      id: 'g00',
      reason: 'under 10 plies',
    });
  });

  it('compares input, settings, engine, commit and chunking, by name and without values', () => {
    const header = JSON.parse(headerLine(meta(0, 8)));
    const mismatches = (m: HeaderMeta) =>
      headerMismatches(header, { ...m, format: REVIEW_FORMAT, version: REVIEW_VERSION });
    expect(mismatches(meta(0, 8))).toEqual([]);
    expect(mismatches(meta(0, 8, { settings: { hashMb: 32, threads: 1, multipv: 2, depth: 18 } }))).toEqual([]);
    expect(mismatches(meta(0, 8, { input: sha256Hex('another') }))).toEqual(['input']);
    expect(mismatches(meta(0, 8, { settings: { ...SETTINGS, depth: 20 } }))).toEqual(['settings']);
    expect(mismatches(meta(0, 8, { engine: 'Other' }))).toEqual(['engine']);
    expect(mismatches(meta(0, 8, { commit: 'def5678' }))).toEqual(['commit']);
    expect(mismatches(meta(1, 4))).toEqual(['chunk', 'chunks']);
  });
});

describe('Engine review helpers: resume', () => {
  const games = makeGames(16);
  const m = meta(1, 4);
  const ids = () =>
    chunkIds(
      games.map((g) => g.id),
      1,
      4,
    );

  it('starts a new file with its header alone and every game of the chunk to do', () => {
    const plan = resumePlan({ text: '', expected: m, ids: ids() });
    expect(plan.resumed).toBe(false);
    expect(plan.todo).toEqual(['g01', 'g05', 'g09', 'g13']);
    expect(plan.cleanText).toBe(`${headerLine(m)}\n`);
    expect(plan.rewrite).toBe(true);
  });

  it('stop and rerun gives the same bytes as one uninterrupted run', () => {
    const whole = runTask(games, m);
    const stopped = runTask(games, m, '', 2);
    expect(parsePart(stopped).ids.size).toBe(2);
    expect(runTask(games, m, stopped)).toBe(whole);
  });

  it('skips the listed ids and redoes only the rest', () => {
    const stopped = runTask(games, m, '', 3);
    const plan = resumePlan({ text: stopped, expected: m, ids: ids() });
    expect(plan.resumed).toBe(true);
    expect(plan.done.size).toBe(3);
    expect(plan.todo).toEqual(['g13']);
    expect(plan.rewrite).toBe(false);
  });

  it('drops a broken last line, and asks for the file to be rewritten without it', () => {
    const whole = runTask(games, m, '', 2);
    const cut = `${whole}{"kind":"game","id":"g09","hash":"ab`;
    const plan = resumePlan({ text: cut, expected: m, ids: ids() });
    expect(plan.rewrite).toBe(true);
    expect(plan.cleanText).toBe(whole);
    expect(plan.todo).toEqual(['g09', 'g13']);
    expect(runTask(games, m, plan.cleanText)).toBe(runTask(games, m));
  });

  it('keeps a complete last line that only lacks its newline', () => {
    const whole = runTask(games, m, '', 2);
    const plan = resumePlan({ text: whole.slice(0, -1), expected: m, ids: ids() });
    expect(plan.done.size).toBe(2);
    expect(plan.cleanText).toBe(whole);
    expect(plan.rewrite).toBe(true);
  });

  it('treats a file whose only line was cut as new', () => {
    const plan = resumePlan({ text: headerLine(m).slice(0, 30), expected: m, ids: ['g01'] });
    expect(plan.resumed).toBe(false);
    expect(plan.cleanText).toBe(`${headerLine(m)}\n`);
  });

  it('exits with an error when the first line is not this run’s, naming the fields only', () => {
    const text = runTask(games, m, '', 1);
    for (const [field, other] of [
      ['input', meta(1, 4, { input: sha256Hex('changed file') })],
      ['settings', meta(1, 4, { settings: { ...SETTINGS, depth: 12 } })],
      ['engine', meta(1, 4, { engine: 'Other Engine' })],
      ['commit', meta(1, 4, { commit: 'ffff000' })],
    ] as const) {
      expect(() => resumePlan({ text, expected: other, ids: ids() })).toThrow(`(differs: ${field})`);
    }
    let message = '';
    try {
      resumePlan({ text, expected: meta(1, 4, { commit: 'ffff000' }), ids: ids() });
    } catch (e) {
      message = String(e);
    }
    expect(message).not.toMatch(/ffff000|abc1234/);
  });

  it('refuses to reuse a part file made by a different commit, and plans nothing from it', () => {
    const fromOldCommit = runTask(games, meta(1, 4, { commit: 'old0001' }), '', 3);
    expect(parsePart(fromOldCommit).ids.size).toBe(3);
    let plan: unknown = null;
    expect(() => {
      plan = resumePlan({ text: fromOldCommit, expected: m, ids: ids() });
    }).toThrow('differs: commit');
    // No plan came back, so there is nothing to skip, rewrite or append to
    expect(plan).toBeNull();
    // The same file is accepted by the commit that made it
    const same = resumePlan({ text: fromOldCommit, expected: meta(1, 4, { commit: 'old0001' }), ids: ids() });
    expect(same.resumed).toBe(true);
    expect(same.done.size).toBe(3);
  });

  it('fails on damage that is not a cut last line', () => {
    const whole = runTask(games, m);
    const lines = whole.split('\n');
    lines[2] = '{broken';
    expect(() => parsePart(lines.join('\n'))).toThrow('line 3');
    expect(() => parsePart(`${whole}{"kind":"mystery"}\n`)).toThrow('not valid');
    expect(() => parsePart(`${whole}${whole.split('\n')[1]}\n`)).toThrow('repeats');
    expect(() => parsePart(`${JSON.stringify({ hello: 'world' })}\n`)).toThrow('not valid');
    expect(() => resumePlan({ text: '{"x":1}\n', expected: m, ids: ['g01'] })).toThrow();
  });

  it('refuses a part file that lists a game from another chunk', () => {
    const text = `${headerLine(m)}\n${gameLine(entryFor(games[0]!))}\n`;
    expect(() => resumePlan({ text, expected: m, ids: ['g01', 'g05'] })).toThrow('not in this chunk');
  });
});

describe('Engine review helpers: merge', () => {
  const games = makeGames(16);
  const payload = () => ({ format: 'x', exportedAt: 1, games: structuredClone(games), settings: [{ keep: 'me' }] });
  const expected = { input: INPUT, settings: SETTINGS, engine: 'Invented Engine 1' };
  const parts = (chunks = 4, over: Partial<HeaderMeta> = {}) =>
    Array.from({ length: chunks }, (_, c) => ({ text: runTask(games, meta(c, chunks, over)) }));
  const merge = (p: ReturnType<typeof payload>, ps: Array<{ text: string }>, extra = {}) =>
    mergeReviews({ payload: p as never, parts: ps, expected, movesOf: movesOf as never, now: 1700000000000, ...extra });

  it('writes the player’s side only, into analysis and record.accuracy, and leaves the rest alone', () => {
    const p = payload();
    const result = merge(p, parts());
    const out = JSON.parse(result.text);
    expect(result.reviewed).toBe(16);
    expect(result.missing).toBe(0);
    expect(out.settings).toEqual([{ keep: 'me' }]);
    const white = out.games.find((g: Game) => g.id === 'g00');
    expect(white.accuracy).toBe(70);
    expect(white.analysis).toMatchObject({
      preset: null,
      savedAt: 1700000000000,
      whiteAccuracy: 70,
      blackAccuracy: null,
      depth: 18,
      summaryOnly: true,
      plies: 4,
    });
    expect(Object.keys(white.analysis.sides)).toEqual(['w']);
    const black = out.games.find((g: Game) => g.id === 'g01');
    expect(black.analysis.whiteAccuracy).toBeNull();
    expect(black.accuracy).toBe(black.analysis.blackAccuracy);
    expect(Object.keys(black.analysis.sides)).toEqual(['b']);
    expect(out.games.map((g: Game) => g.pgn)).toEqual(games.map((g) => g.pgn));
  });

  it('never changes its input', () => {
    const p = payload();
    const before = JSON.stringify(p);
    merge(p, parts());
    expect(JSON.stringify(p)).toBe(before);
  });

  it('refuses mixed settings, engines, commits, inputs and chunk counts', () => {
    const base = parts();
    const odd = { text: runTask(games, meta(3, 4, { settings: { ...SETTINGS, depth: 12 } })) };
    expect(() => merge(payload(), [...base.slice(0, 3), odd])).toThrow('settings');
    expect(() =>
      merge(payload(), [...base.slice(0, 3), { text: runTask(games, meta(3, 4, { engine: 'Other' })) }]),
    ).toThrow('engine');
    expect(() =>
      merge(payload(), [...base.slice(0, 3), { text: runTask(games, meta(3, 4, { commit: 'ffff000' })) }]),
    ).toThrow('commit');
    expect(() => merge(payload(), [base[0]!, { text: runTask(games, meta(1, 2)) }])).toThrow('chunks');
    expect(() =>
      merge(payload(), [...base.slice(0, 3), { text: runTask(games, meta(3, 4, { input: sha256Hex('mixed') })) }]),
    ).toThrow('input');
  });

  it('refuses parts made for another input or other settings than the run expects', () => {
    expect(() => merge(payload(), parts(4, { settings: { ...SETTINGS, depth: 12 } }))).toThrow('settings');
    expect(() => merge(payload(), parts(4, { input: sha256Hex('another') }))).toThrow('input');
  });

  it('refuses a move-hash mismatch, counting the games and naming none', () => {
    const p = payload();
    p.games[5]!.pgn = 'changed after the review';
    p.games[6]!.pgn = 'also changed';
    const error = (() => {
      try {
        merge(p, parts());
      } catch (e) {
        return String(e);
      }
      return '';
    })();
    expect(error).toContain('2 games do not match');
    expect(error).not.toMatch(/g05|g06/);
  });

  it('lists games with no line, and refuses unless a partial merge is allowed', () => {
    const ps = parts();
    ps[2] = { text: runTask(games, meta(2, 4), '', 1) };
    expect(() => merge(payload(), ps)).toThrow('3 games have no line');
    const result = merge(payload(), ps, { allowPartial: true });
    expect(result.missing).toBe(3);
    expect(result.reviewed).toBe(13);
    const out = JSON.parse(result.text);
    expect(out.games.filter((g: Game) => g.analysis === null)).toHaveLength(3);
  });

  it('counts skipped games by reason and leaves their record as it was', () => {
    const ps = parts();
    const skipText = `${headerLine(meta(0, 4))}\n${['g00', 'g04']
      .map((id) => skipLine({ id, reason: 'under 10 plies' }))
      .join('\n')}\n${['g08', 'g12'].map((id) => gameLine(entryFor(games.find((g) => g.id === id)!))).join('\n')}\n`;
    ps[0] = { text: skipText };
    const result = merge(payload(), ps);
    expect(result.skipped).toEqual({ 'under 10 plies': 2 });
    expect(result.reviewed).toBe(14);
    expect(JSON.parse(result.text).games[0].analysis).toBeNull();
  });

  it('refuses unknown ids, lines in the wrong part and an opponent’s accuracy', () => {
    const ps = parts();
    const stray = entryFor({ ...games[0]!, id: 'zz99' });
    const extra = (i: number, line: string) => ({ text: `${ps[i]!.text}${line}\n` });
    expect(() => merge(payload(), [extra(0, gameLine(stray)), ...ps.slice(1)])).toThrow('not in the input');
    expect(() => merge(payload(), [extra(0, gameLine(entryFor(games[1]!))), ...ps.slice(1)])).toThrow('wrong part');
    const both = entryFor(games[0]!);
    both.summary.blackAccuracy = 60;
    const bad = ps[0]!.text.split('\n');
    bad[1] = gameLine(both);
    expect(() => merge(payload(), [{ text: bad.join('\n') }, ...ps.slice(1)])).toThrow('1 summaries');
  });

  it('refuses a repeated id inside one part file and the same game in two part files', () => {
    const ps = parts();
    const twice = `${ps[0]!.text}${gameLine(entryFor(games[0]!))}\n`;
    expect(() => parsePart(twice)).toThrow('repeats');
    expect(() => merge(payload(), [{ text: twice }, ...ps.slice(1)])).toThrow('repeats');
    // g00 copied into part 1: it is in the wrong part for that chunk
    const dup = { text: `${ps[1]!.text}${gameLine(entryFor(games[0]!))}\n` };
    expect(() => merge(payload(), [ps[0]!, dup, ...ps.slice(2)])).toThrow('wrong part');
  });

  it('fails above the size limit', () => {
    expect(() => merge(payload(), parts(), { maxBytes: 100 })).toThrow('above the limit');
  });
});

describe('Engine review helpers: writing', () => {
  it('writes a temporary file first and renames it, and refuses the protected input', () => {
    const fs = fakeFs();
    const file = path.resolve('scratch-dir', 'restore-reviewed.json');
    expect(writeThroughRename(fs, file, 'abc')).toBe(3);
    expect(fs.calls).toEqual([
      'write restore-reviewed.json.part',
      'rename restore-reviewed.json.part restore-reviewed.json',
    ]);
    const input = path.resolve('scratch-dir', 'restore.json');
    expect(() => writeThroughRename(fs, input, 'x', { protect: [input] })).toThrow('protected');
    expect(fs.calls).toHaveLength(2);
  });
});
