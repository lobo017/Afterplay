// The pure part of the mistake-puzzle script: choosing the games, replaying one to a ply, judging the engine's answer,
// the part-file lines, resuming and merging. Nothing here runs an engine or reads a file; the app's own functions (the
// PGN parser, the win% formula, the class thresholds) arrive as `deps`, so a test can hand in the real ones.
//
// What the output is for: one puzzle per game, from the player's stored worst move. The history review kept only
// numbers (the worst move's ply and its win% loss), so this script replays the game to that ply and asks the engine for
// the best move there.
//
// deps: { parsePgn, isStandardGame, applyUci, lineToSan, winPercentFromScore, CLASS_THRESHOLDS, classFromWinDrop }
import { SETTINGS as ENGINE_SETTINGS } from '../../history/lib/settings.mjs';
import { canonicalJson, chunkIds, sha256Hex } from '../../history/lib/reviews.mjs';

export const PUZZLE_FORMAT = 'afterplay-mistake-puzzles';
export const PUZZLE_VERSION = 1;
/** The shards of the Juno job: an array of 8 tasks, one shard each (hpc/puzzles/job.sbatch checks this number). */
export const PUZZLE_SHARDS = 8;
/** The merged file is refused above this size (about 250 bytes a puzzle: 2,500 puzzles are well under 1 MiB). */
export const MAX_PUZZLES_BYTES = 8 * 1024 * 1024;

/**
 * Everything that makes a run repeat: the engine settings of the history review plus this script's own rules. A part
 * file records them in its first line, and the merge refuses parts whose settings differ.
 */
export const SETTINGS = {
  ...ENGINE_SETTINGS,
  minPlies: 10,
  minDropPly: 2,
  minStoredDrop: 20,
  /** The best move must beat the second best by this many win% points. */
  minGap: 10,
  /** The player's win% before the move: a puzzle position is neither lost nor already won. */
  winFrom: 25,
  winTo: 90,
  /** Forced mates are kept up to this many moves (the review's reliable horizon) and may lie above `winTo`. */
  maxMate: 5,
  lineSans: 6,
};

const FINISHED = new Set(['1-0', '0-1', '1/2-1/2']);
const SITES = new Set(['chesscom', 'lichess']);

/** Why a game is not chosen (counted, in the order the checks run), and why a chosen game gives no puzzle. */
export const SELECTION_REASONS = [
  'not a site game',
  'not finished',
  'no player colour',
  'under 10 plies',
  'no stored worst move',
  'worst move before ply 2',
  'stored drop under 20',
  'game could not be read',
  'not standard chess',
  'worst move is not the player move',
];
export const DROP_REASONS = [
  'no evaluation',
  'played move is the best move',
  'win% before outside 25 to 90',
  'mate longer than 5',
  'only one legal move',
  'best move not clearly best',
  'trivial recapture',
  'measured loss under Mistake',
];

const round2 = (n) => Math.round(n * 100) / 100;

// ---------------------------------------------------------------------------------------------------- choosing games

/**
 * Replays the main line of a parsed game to the move at `ply` (1 is White's first move). Returns what the puzzle needs,
 * or null when the game has no such move. `fenSetup` is the position before the opponent's last move (the puzzle's
 * start), `fenBefore` the position before the player's move.
 */
export function replayToPly(tree, ply) {
  const line = tree.getMainLine();
  if (!Number.isInteger(ply) || ply < 2 || line.length < ply) return null;
  const played = line[ply - 1];
  const setup = line[ply - 2];
  return {
    plies: line.length,
    rootFen: tree.root.fen,
    ucis: line.slice(0, ply).map((n) => n.uci),
    fenSetup: ply >= 3 ? line[ply - 3].fen : tree.root.fen,
    fenBefore: setup.fen,
    setupUci: setup.uci,
    setupSan: setup.san,
    setupTo: setup.to ?? null,
    setupCaptured: Boolean(setup.captured),
    playedUci: played.uci,
    playedSan: played.san,
    playedColor: played.moveColor ?? (ply % 2 === 1 ? 'w' : 'b'),
  };
}

/**
 * Whether a game gives a candidate: a standard game of mine that finished, at least 10 plies, with a stored worst move
 * at ply 2 or later that lost at least 20 win%. `record` is a restore-file game. Returns { ok: true, plan } or
 * { ok: false, reason } with a reason from SELECTION_REASONS. The checks that need only the stored record run first, so
 * the PGN (the slow part) is read only for a game that is likely to be chosen.
 */
export function selectGame(record, deps) {
  if (!SITES.has(record.source)) return { ok: false, reason: 'not a site game' };
  if (!FINISHED.has(record.result)) return { ok: false, reason: 'not finished' };
  const color = record.playerColor;
  if (color !== 'w' && color !== 'b') return { ok: false, reason: 'no player colour' };
  const summary = record.analysis;
  if (summary && Number.isInteger(summary.plies) && summary.plies < SETTINGS.minPlies) {
    return { ok: false, reason: 'under 10 plies' };
  }
  const side = summary?.sides?.[color];
  if (!side || !Number.isInteger(side.dropPly) || !Number.isFinite(side.drop)) {
    return { ok: false, reason: 'no stored worst move' };
  }
  if (side.dropPly < SETTINGS.minDropPly) return { ok: false, reason: 'worst move before ply 2' };
  if (side.drop < SETTINGS.minStoredDrop) return { ok: false, reason: 'stored drop under 20' };

  let tree;
  try {
    tree = deps.parsePgn(record.pgn);
  } catch {
    return { ok: false, reason: 'game could not be read' };
  }
  if (!deps.isStandardGame(tree.getHeaders())) return { ok: false, reason: 'not standard chess' };
  if (tree.getMainLine().length < SETTINGS.minPlies) return { ok: false, reason: 'under 10 plies' };
  const replay = replayToPly(tree, side.dropPly);
  if (!replay || replay.playedColor !== color) return { ok: false, reason: 'worst move is not the player move' };
  return { ok: true, plan: { id: record.id, color, ply: side.dropPly, storedDrop: side.drop, ...replay } };
}

/**
 * Every candidate of the input, in a fixed order (by game id), and the counts of why the others are left out.
 * `games` is the restore file's games list.
 */
export function selectGames(games, deps) {
  const reasons = Object.fromEntries(SELECTION_REASONS.map((r) => [r, 0]));
  const picked = [];
  for (const record of games) {
    const r = selectGame(record, deps);
    if (r.ok) picked.push(r.plan);
    else reasons[r.reason]++;
  }
  picked.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { games: games.length, candidates: picked, reasons };
}

/** The candidates of one shard: candidate i of the sorted list belongs to shard i mod `shards`. */
export function shardOf(candidates, shard, shards) {
  const ids = new Set(
    chunkIds(
      candidates.map((c) => c.id),
      shard,
      shards,
    ),
  );
  return candidates.filter((c) => ids.has(c.id));
}

// --------------------------------------------------------------------------------------------------- judging a game

/**
 * A move that only takes back what the opponent's last move took: the opponent captured on a square and the best move
 * captures on that same square. Such a puzzle has a one-move answer everyone sees.
 */
export function isTrivialRecapture(plan, bestUci, deps) {
  if (!plan.setupCaptured || plan.setupTo === null) return false;
  const applied = deps.applyUci(plan.fenBefore, bestUci);
  return Boolean(applied && applied.move.captured && applied.move.to === plan.setupTo);
}

/**
 * First half, from the search before the player's move (2 lines, scores from the player's side): the filters that need
 * only that search. Returns { keep: false, reason } or { keep: true, kept } for `finishPuzzle`.
 */
export function judgeBefore(plan, before, deps) {
  const lines = [...(before?.lines ?? [])].sort((a, b) => a.multipv - b.multipv);
  const best = lines[0];
  if (!best || !best.pv?.[0]) return { keep: false, reason: 'no evaluation' };
  const bestUci = best.pv[0];
  if (bestUci === plan.playedUci) return { keep: false, reason: 'played move is the best move' };

  const winBefore = deps.winPercentFromScore(best.score);
  const mate = best.score.type === 'mate' && best.score.value > 0 ? best.score.value : null;
  if (mate !== null && mate > SETTINGS.maxMate) return { keep: false, reason: 'mate longer than 5' };
  // A forced mate within the horizon is a puzzle even though the position is already "won"
  const aboveRange = winBefore > SETTINGS.winTo && mate === null;
  if (winBefore < SETTINGS.winFrom || aboveRange) return { keep: false, reason: 'win% before outside 25 to 90' };

  const second = lines[1];
  if (!second) return { keep: false, reason: 'only one legal move' };
  if (winBefore - deps.winPercentFromScore(second.score) < SETTINGS.minGap) {
    return { keep: false, reason: 'best move not clearly best' };
  }
  if (isTrivialRecapture(plan, bestUci, deps)) return { keep: false, reason: 'trivial recapture' };

  return {
    keep: true,
    kept: {
      bestUci,
      winBefore,
      mateIn: mate,
      bestLineSan: deps.lineToSan(plan.fenBefore, best.pv, SETTINGS.lineSans),
    },
  };
}

/**
 * Second half, from the search after the played move. `afterScore` is the engine's score of the position after the
 * player's move, from the side to move (the opponent), as the review reads it. Returns the output entry, or a reason.
 */
export function finishPuzzle(plan, kept, afterScore, deps) {
  if (!afterScore) return { keep: false, reason: 'no evaluation' };
  const winAfter = 100 - deps.winPercentFromScore(afterScore);
  const loss = kept.winBefore - winAfter;
  if (loss < deps.CLASS_THRESHOLDS.mistake) return { keep: false, reason: 'measured loss under Mistake' };
  return {
    keep: true,
    entry: {
      id: plan.id,
      ply: plan.ply,
      fen: plan.fenSetup,
      moves: [plan.setupUci, kept.bestUci],
      bestLineSan: kept.bestLineSan,
      playedSan: plan.playedSan,
      class: deps.classFromWinDrop(loss),
      loss: round2(loss),
      before: round2(kept.winBefore),
      after: round2(winAfter),
      mateIn: kept.mateIn,
    },
  };
}

// ------------------------------------------------------------------------------------------------------ part files
//
// engine part: <dir>/parts/part-<shard>-of-<shards>.jsonl
//   line 1                               the header: format, version, input (sha-256 of the input file), settings, engine, commit, shard, shards
//   {"kind":"puzzle", ...entry}          a game that gives a puzzle
//   {"kind":"drop","id":"...","reason":""} a game that gives none, with the reason

export const partFileName = (shard, shards) => `parts/part-${shard}-of-${shards}.jsonl`;

export function headerLine(meta) {
  const { input, engine, commit, shard, shards } = meta;
  return JSON.stringify({
    format: PUZZLE_FORMAT,
    version: PUZZLE_VERSION,
    input,
    settings: SETTINGS,
    engine,
    commit,
    shard,
    shards,
  });
}

export const puzzleLine = (entry) => JSON.stringify({ kind: 'puzzle', ...entry });
export const dropLine = (id, reason) => JSON.stringify({ kind: 'drop', id, reason });

/** The fields of a header that must be equal in every part of one run. */
const HEADER_FIELDS = ['format', 'version', 'input', 'settings', 'engine', 'commit', 'shards'];

function differing(a, b) {
  return HEADER_FIELDS.filter((k) => canonicalJson(a[k]) !== canonicalJson(b[k]));
}

/**
 * Reads a part file's text. A last line that is not JSON (a write cut short) is dropped: `rewrite` is then true and
 * `cleanText` is the text without it. A line that is JSON but not a valid entry is an error.
 */
export function parsePart(text) {
  const raw = text.split('\n');
  const endsClean = text === '' || text.endsWith('\n');
  const lines = endsClean ? raw.slice(0, -1) : raw;
  const out = { header: null, entries: [], drops: [], ids: new Set(), rewrite: false, cleanText: '' };
  const kept = [];
  for (let i = 0; i < lines.length; i++) {
    let value;
    try {
      value = JSON.parse(lines[i]);
    } catch {
      if (i === lines.length - 1) {
        out.rewrite = true;
        break;
      }
      throw new Error(`line ${i + 1} of a part file is not JSON`);
    }
    if (i === 0) {
      if (value?.format !== PUZZLE_FORMAT || value.version !== PUZZLE_VERSION) throw new Error('not a part file');
      out.header = value;
    } else if (value?.kind === 'puzzle') {
      const entry = { ...value };
      delete entry.kind;
      if (typeof entry.id !== 'string' || !Number.isInteger(entry.ply) || !Array.isArray(entry.moves)) {
        throw new Error(`line ${i + 1} of a part file is not a valid puzzle`);
      }
      if (out.ids.has(entry.id)) throw new Error('a part file lists a game twice');
      out.ids.add(entry.id);
      out.entries.push(entry);
    } else if (value?.kind === 'drop') {
      if (typeof value.id !== 'string' || !DROP_REASONS.includes(value.reason)) {
        throw new Error(`line ${i + 1} of a part file is not a valid drop`);
      }
      if (out.ids.has(value.id)) throw new Error('a part file lists a game twice');
      out.ids.add(value.id);
      out.drops.push({ id: value.id, reason: value.reason });
    } else {
      throw new Error(`line ${i + 1} of a part file has no known kind`);
    }
    kept.push(lines[i]);
  }
  out.cleanText = kept.length === 0 ? '' : `${kept.join('\n')}\n`;
  return out;
}

/**
 * What a task does at start-up. `text` is the part file ('' when there is none), `expected` the header fields of this
 * run, `ids` the ids of the shard in order. Throws when the first line is another run's or a listed game is not in the
 * shard. Returns the games still to do; with `rewrite` true the caller first writes `cleanText`.
 */
export function resumePlan({ text, expected, ids }) {
  const parsed = parsePart(text);
  if (parsed.header === null) {
    return { resumed: false, done: new Set(), todo: [...ids], cleanText: `${headerLine(expected)}\n`, rewrite: true };
  }
  const want = JSON.parse(headerLine(expected));
  const bad = differing(parsed.header, want);
  if (parsed.header.shard !== expected.shard) bad.push('shard');
  if (bad.length > 0) throw new Error(`the first line of the part file is not this run's (differs: ${bad.join(', ')})`);
  const inShard = new Set(ids);
  for (const id of parsed.ids) {
    if (!inShard.has(id)) throw new Error('the part file lists a game that is not in this shard');
  }
  return {
    resumed: true,
    done: parsed.ids,
    todo: ids.filter((id) => !parsed.ids.has(id)),
    cleanText: parsed.cleanText,
    rewrite: parsed.rewrite,
  };
}

// ------------------------------------------------------------------------------------------------------------ merge

/**
 * Merges the parts of one run into the output file and its counts. `parts` are the part files' texts, `candidates` the
 * sorted candidate plans of the input, `selection` the counts from `selectGames`, `input` the input's sha-256. Fails when
 * a part is another run's, a shard is missing or doubled, a game has no line or is in the wrong shard, unless
 * `allowPartial` (then games with no line are counted as left).
 */
export function mergeParts({ parts, candidates, selection, input, shards, allowPartial = false }) {
  const parsed = parts.map((text) => parsePart(text));
  if (parsed.some((p) => p.header === null)) throw new Error('a part file has no first line');
  const first = parsed[0]?.header;
  if (!first) throw new Error('no part files');
  for (const p of parsed) {
    const bad = differing(p.header, first);
    if (bad.length > 0) throw new Error(`the part files are not from one run (differ: ${bad.join(', ')})`);
  }
  if (first.input !== input) throw new Error('the part files were made from another input file');
  if (first.shards !== shards) throw new Error('the part files were made with another number of shards');
  const seen = new Set();
  for (const p of parsed) {
    if (!Number.isInteger(p.header.shard) || p.header.shard < 0 || p.header.shard >= shards)
      throw new Error('bad shard');
    if (seen.has(p.header.shard)) throw new Error('a shard is in two part files');
    seen.add(p.header.shard);
  }
  if (!allowPartial && seen.size !== shards) throw new Error(`${shards - seen.size} part file(s) missing`);

  const ids = candidates.map((c) => c.id);
  const byId = new Map();
  for (const p of parsed) {
    const own = new Set(chunkIds(ids, p.header.shard, shards));
    for (const e of p.entries) {
      if (!own.has(e.id)) throw new Error('a part file lists a game that is not in its shard');
      byId.set(e.id, { kind: 'puzzle', entry: e });
    }
    for (const d of p.drops) {
      if (!own.has(d.id)) throw new Error('a part file lists a game that is not in its shard');
      byId.set(d.id, { kind: 'drop', reason: d.reason });
    }
  }
  const dropped = Object.fromEntries(DROP_REASONS.map((r) => [r, 0]));
  const entries = [];
  let left = 0;
  for (const c of candidates) {
    const found = byId.get(c.id);
    if (!found) {
      left++;
      continue;
    }
    if (found.kind === 'puzzle') entries.push(found.entry);
    else dropped[found.reason]++;
  }
  if (left > 0 && !allowPartial) throw new Error(`${left} game(s) have no line in any part file`);

  entries.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : a.ply - b.ply));
  const short = input.slice(0, 12);
  const text = `${JSON.stringify({
    format: PUZZLE_FORMAT,
    version: PUZZLE_VERSION,
    input: short,
    count: entries.length,
    entries,
  })}\n`;
  if (Buffer.byteLength(text) > MAX_PUZZLES_BYTES) throw new Error('the merged file is too large');
  const classes = { Mistake: 0, Blunder: 0 };
  let mates = 0;
  for (const e of entries) {
    classes[e.class]++;
    if (e.mateIn !== null) mates++;
  }
  const counts = {
    format: PUZZLE_FORMAT,
    version: PUZZLE_VERSION,
    input: short,
    games: selection.games,
    leftOut: selection.reasons,
    selected: candidates.length,
    kept: entries.length,
    dropped,
    left,
    classes,
    mates,
    bytes: Buffer.byteLength(text),
  };
  return { text, counts, countsText: `${JSON.stringify(counts, null, 2)}\n` };
}

export { sha256Hex };
