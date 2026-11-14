// The pure helpers of the engine review batch (hpc/history/review-games.mjs, merge-reviews.mjs): the checkpoint line
// format, the first-line check, the move hash, resume and the merge rule. No file access except through an `fs` object
// the caller passes, so the unit tests run everything with invented games.
//
// A part file (<dir>/engine/part-<k>-of-<n>.jsonl) is one JSON object per line:
//   line 1   {"kind":"header", format, version, input, settings, engine, commit, chunk, chunks}
//   then     {"kind":"game", id, hash, summary, win, classes}   one finished game
//            {"kind":"skip", id, reason}                        a game that could not be reviewed
// Error messages carry counts and line numbers, never game ids or header values.
import { createHash } from 'node:crypto';
import path from 'node:path';

export const REVIEW_FORMAT = 'afterplay-engine-review';
export const REVIEW_VERSION = 1;
/** The merge fails above this size (the app's restore file is about 13 MiB). */
export const MAX_RESTORE_BYTES = 24 * 1024 * 1024;

/** One letter per move class, so a stored line needs no engine time to change its summary later. */
export const CLASS_LETTERS = {
  Brilliant: '!',
  Great: 'G',
  Best: 'B',
  Excellent: 'E',
  Good: 'O',
  Book: 'K',
  Inaccuracy: 'I',
  Mistake: 'M',
  Blunder: 'X',
  Miss: 'S',
};
const LETTERS = new Set(Object.values(CLASS_LETTERS));
const HEX64 = /^[0-9a-f]{64}$/;
const HEADER_FIELDS = ['format', 'version', 'input', 'settings', 'engine', 'commit', 'chunk', 'chunks'];

export function sha256Hex(data) {
  return createHash('sha256').update(data).digest('hex');
}

/** The hash of a game's moves (an array of strings), so a line is tied to the game it was made from. */
export function moveHash(moves) {
  return sha256Hex(JSON.stringify(moves));
}

/** JSON with sorted keys, so two settings objects compare equal whatever their key order. */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * The one way the scripts build a path: every result is inside `dir`, never `dir` itself.
 * (Symbolic links are not followed or checked; the scripts never make any.)
 */
export function makeDirGuard(dir) {
  const root = path.resolve(dir);
  return (...parts) => {
    const target = path.resolve(root, ...parts);
    const rel = path.relative(root, target);
    if (rel === '' || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
      throw new Error('path outside the history folder');
    }
    return target;
  };
}

/** The part file of one chunk, relative to the history folder. */
export function partFileName(chunk, chunks) {
  return `engine/part-${chunk}-of-${chunks}.jsonl`;
}

/** The ids of one chunk: ids sorted, game i belongs to chunk i mod chunks. */
export function chunkIds(ids, chunk, chunks) {
  return [...ids].sort().filter((_, i) => i % chunks === chunk);
}

// ---------------------------------------------------------------------------------------------------------- lines

export function headerLine(meta) {
  const { input, settings, engine, commit, chunk, chunks } = meta;
  if (!HEX64.test(input)) throw new Error('header: input must be a SHA-256 hex string');
  if (!settings || typeof settings !== 'object') throw new Error('header: settings missing');
  if (typeof engine !== 'string' || engine === '') throw new Error('header: engine name missing');
  if (typeof commit !== 'string' || commit === '') throw new Error('header: commit missing');
  if (!Number.isInteger(chunks) || chunks < 1) throw new Error('header: chunks must be a positive integer');
  if (!Number.isInteger(chunk) || chunk < 0 || chunk >= chunks) throw new Error('header: chunk out of range');
  return JSON.stringify({
    kind: 'header',
    format: REVIEW_FORMAT,
    version: REVIEW_VERSION,
    input,
    settings,
    engine,
    commit,
    chunk,
    chunks,
  });
}

/** Why a game or skip entry is not valid, or null. */
export function entryProblem(e) {
  if (!e || typeof e !== 'object') return 'not an object';
  if (typeof e.id !== 'string' || e.id === '') return 'no id';
  if (e.kind === 'skip') return typeof e.reason === 'string' && e.reason !== '' ? null : 'no reason';
  if (e.kind !== 'game') return 'unknown kind';
  if (!HEX64.test(e.hash)) return 'bad move hash';
  if (!e.summary || typeof e.summary !== 'object' || !e.summary.sides || typeof e.summary.sides !== 'object') {
    return 'no summary';
  }
  if (typeof e.classes !== 'string' || ![...e.classes].every((c) => LETTERS.has(c))) return 'bad classes';
  if (!Array.isArray(e.win) || !e.win.every((n) => Number.isFinite(n))) return 'bad win list';
  if (e.win.length !== e.classes.length + 1) return 'win list does not fit the moves';
  if (e.summary.plies !== e.classes.length) return 'plies do not fit the moves';
  return null;
}

/** One finished game as a checkpoint line (without the newline). */
export function gameLine({ id, hash, summary, win, classes }) {
  const entry = { kind: 'game', id, hash, summary, win, classes };
  const problem = entryProblem(entry);
  if (problem) throw new Error(`game line: ${problem}`);
  return JSON.stringify(entry);
}

export function skipLine({ id, reason }) {
  const entry = { kind: 'skip', id, reason };
  const problem = entryProblem(entry);
  if (problem) throw new Error(`skip line: ${problem}`);
  return JSON.stringify(entry);
}

// ----------------------------------------------------------------------------------------------- first-line check

/** The names of the header fields that differ from what this run expects (empty: the file belongs to this run). */
export function headerMismatches(found, expected) {
  const bad = [];
  for (const f of HEADER_FIELDS) {
    if (canonicalJson(found?.[f]) !== canonicalJson(expected?.[f])) bad.push(f);
  }
  return bad;
}

function headerProblem(h) {
  if (!h || h.kind !== 'header') return 'not a header';
  if (h.format !== REVIEW_FORMAT || h.version !== REVIEW_VERSION) return 'another format or version';
  if (!HEX64.test(h.input) || !h.settings || typeof h.settings !== 'object') return 'incomplete header';
  if (typeof h.engine !== 'string' || typeof h.commit !== 'string') return 'incomplete header';
  if (!Number.isInteger(h.chunks) || !Number.isInteger(h.chunk) || h.chunk < 0 || h.chunk >= h.chunks) {
    return 'bad chunk numbers';
  }
  return null;
}

// ----------------------------------------------------------------------------------------------------- reading

/**
 * Reads a part file. A last line that is not JSON (a write cut short) is dropped; a line that is JSON but not a valid
 * line, a bad line anywhere else, or a repeated id throws. `cleanText` is the file without the dropped line and with a
 * final newline; `rewrite` says it differs from `text`.
 */
export function parsePart(text) {
  const lines = text === '' ? [] : text.split('\n');
  const endsClean = lines.length > 0 && lines[lines.length - 1] === '';
  if (endsClean) lines.pop();
  let header = null;
  const entries = [];
  const ids = new Set();
  const kept = [];
  let dropped = false;
  for (let i = 0; i < lines.length; i++) {
    let obj;
    try {
      obj = JSON.parse(lines[i]);
    } catch {
      if (i === lines.length - 1) {
        dropped = true;
        break;
      }
      throw new Error(`line ${i + 1} of a part file is not JSON`);
    }
    const problem = i === 0 ? headerProblem(obj) : entryProblem(obj);
    if (problem) throw new Error(`line ${i + 1} of a part file is not valid (${problem})`);
    if (i === 0) header = obj;
    else {
      if (ids.has(obj.id)) throw new Error(`line ${i + 1} of a part file repeats an earlier game`);
      ids.add(obj.id);
      entries.push(obj);
    }
    kept.push(lines[i]);
  }
  const cleanText = kept.length === 0 ? '' : `${kept.join('\n')}\n`;
  return { header, entries, ids, dropped, cleanText, rewrite: cleanText !== text };
}

/**
 * What a task does at start-up. `text` is the part file's content ('' when it does not exist), `expected` the header
 * fields of this run, `ids` the ids of this task's chunk. Throws when the first line is not this run's (including a
 * different commit), or a listed game is not in the chunk. Returns the games still to review; when `rewrite` is true the
 * caller first writes `cleanText` (the header alone for a new file) through `writeThroughRename`.
 */
export function resumePlan({ text, expected, ids }) {
  const parsed = parsePart(text);
  if (parsed.header === null) {
    return { resumed: false, done: new Set(), todo: [...ids], cleanText: `${headerLine(expected)}\n`, rewrite: true };
  }
  const bad = headerMismatches(parsed.header, { ...expected, format: REVIEW_FORMAT, version: REVIEW_VERSION });
  if (bad.length > 0) {
    throw new Error(`the first line of the part file is not this run's (differs: ${bad.join(', ')})`);
  }
  const inChunk = new Set(ids);
  for (const id of parsed.ids) {
    if (!inChunk.has(id)) throw new Error('the part file lists a game that is not in this chunk');
  }
  return {
    resumed: true,
    done: parsed.ids,
    todo: ids.filter((id) => !parsed.ids.has(id)),
    cleanText: parsed.cleanText,
    rewrite: parsed.rewrite,
  };
}

// ----------------------------------------------------------------------------------------------------- writing

/**
 * Writes a file through a temporary file and a rename (a reader never sees half of it). `fs` needs `writeFileSync` and
 * `renameSync`. Refuses any path in `protect` (the input file). Deletes nothing.
 */
export function writeThroughRename(fs, file, text, { protect = [] } = {}) {
  const target = path.resolve(file);
  if (protect.some((p) => path.resolve(p) === target)) throw new Error('refusing to write over a protected file');
  const part = `${file}.part`;
  fs.writeFileSync(part, text);
  fs.renameSync(part, file);
  return Buffer.byteLength(text);
}

// ------------------------------------------------------------------------------------------------------- merge

function checkParts(parts, expected) {
  const heads = parts.map((p) => {
    const parsed = parsePart(p.text);
    if (parsed.header === null) throw new Error('a part file has no first line');
    return parsed;
  });
  const first = heads[0].header;
  for (const f of ['input', 'settings', 'engine', 'commit', 'chunks']) {
    for (const h of heads) {
      if (canonicalJson(h.header[f]) !== canonicalJson(first[f])) {
        throw new Error(`the part files do not agree on ${f}: refusing to merge`);
      }
    }
  }
  const bad = headerMismatches(
    { ...first, chunk: 0 },
    { ...first, input: expected.input, settings: expected.settings, engine: expected.engine, chunk: 0 },
  );
  if (bad.length > 0)
    throw new Error(`the part files are not for this input and settings (differs: ${bad.join(', ')})`);
  const chunks = new Set();
  for (const h of heads) {
    if (chunks.has(h.header.chunk)) throw new Error('two part files claim the same chunk');
    chunks.add(h.header.chunk);
  }
  return heads;
}

/**
 * The merge rule. `payload` is the parsed restore file (never changed: the result is a new object), `parts` the part
 * files as `{ text }`, `expected` `{ input, settings, engine }` of this run, `movesOf(game)` the game's moves as an
 * array of strings. Returns the new file's `text`. Throws, with counts only, on mixed settings, an unknown or repeated
 * id, a line in the wrong part, a move-hash mismatch, a missing game (unless `allowPartial`), a bad summary, or a size
 * above `maxBytes`. Games with a skip line, and with no line under `allowPartial`, keep the record they had.
 */
export function mergeReviews({
  payload,
  parts,
  expected,
  movesOf,
  now,
  allowPartial = false,
  maxBytes = MAX_RESTORE_BYTES,
}) {
  if (!payload || !Array.isArray(payload.games)) throw new Error('the input has no games list');
  if (parts.length === 0) throw new Error('no part files');
  const games = payload.games;
  const byId = new Map();
  games.forEach((g) => {
    if (byId.has(g.id)) throw new Error('the input holds a game id twice');
    byId.set(g.id, g);
  });
  const sorted = [...byId.keys()].sort();
  const position = new Map(sorted.map((id, i) => [id, i]));

  const heads = checkParts(parts, expected);
  const lines = new Map();
  for (const h of heads) {
    for (const e of h.entries) {
      if (!byId.has(e.id)) throw new Error('a part file lists a game that is not in the input');
      if (position.get(e.id) % h.header.chunks !== h.header.chunk) throw new Error('a line is in the wrong part file');
      if (lines.has(e.id)) throw new Error('two part files list the same game');
      lines.set(e.id, e);
    }
  }

  let mismatched = 0;
  let invalid = 0;
  const skipped = {};
  const out = games.map((g) => {
    const e = lines.get(g.id);
    if (!e) return g;
    if (e.kind === 'skip') {
      skipped[e.reason] = (skipped[e.reason] ?? 0) + 1;
      return g;
    }
    if (e.hash !== moveHash(movesOf(g))) {
      mismatched++;
      return g;
    }
    const color = g.playerColor;
    const mine = color === 'w' ? e.summary.whiteAccuracy : e.summary.blackAccuracy;
    const theirs = color === 'w' ? e.summary.blackAccuracy : e.summary.whiteAccuracy;
    const sideKeys = Object.keys(e.summary.sides);
    if ((color !== 'w' && color !== 'b') || !Number.isFinite(mine) || theirs !== null) invalid++;
    else if (sideKeys.length !== 1 || sideKeys[0] !== color) invalid++;
    else {
      return {
        ...g,
        accuracy: mine,
        analysis: {
          preset: null,
          savedAt: now,
          whiteAccuracy: e.summary.whiteAccuracy,
          blackAccuracy: e.summary.blackAccuracy,
          ...(e.summary.depth !== undefined ? { depth: e.summary.depth } : {}),
          summaryOnly: true,
          plies: e.summary.plies,
          sides: e.summary.sides,
        },
      };
    }
    return g;
  });
  if (mismatched > 0) throw new Error(`${mismatched} games do not match their move hash: refusing to merge`);
  if (invalid > 0) throw new Error(`${invalid} summaries are not the player's side only: refusing to merge`);

  const missing = games.filter((g) => !lines.has(g.id)).length;
  if (missing > 0 && !allowPartial)
    throw new Error(`${missing} games have no line (use --allow-partial to merge anyway)`);

  const text = JSON.stringify({ ...payload, games: out });
  const bytes = Buffer.byteLength(text);
  if (bytes > maxBytes) throw new Error(`the merged file would be ${bytes} bytes, above the limit of ${maxBytes}`);
  const reviewed = [...lines.values()].filter((e) => e.kind === 'game').length;
  return { text, bytes, reviewed, skipped, missing, parts: parts.length };
}
