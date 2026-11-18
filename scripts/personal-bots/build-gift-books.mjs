// Builds the personal opening books offline and measures them (nothing is embedded in the preset by this script):
//
//   node scripts/personal-bots/build-gift-books.mjs --gift-dir <dir with restore.json> \
//        --student-dirs <dirA>,<dirB> --out gift.local/bots [--games 2000] [--seed 20261117]
//   node scripts/personal-bots/build-gift-books.mjs --check --config <bots.config.json> --gift-dir ... --student-dirs ...
//
// Inputs
//   --gift-dir      a folder with restore.json (hpc/history/build-restore.mjs); the owner is the name that is White or Black
//                   in nearly all of its games (found in memory, never printed).
//   --student-dirs  two folders, each with player.txt and raw/ (a missing raw/ is downloaded with hpc/history/download.mjs,
//                   which asks only the public Chess.com archive API, one request a second).
//   --out           where the books and stats.json go (gift.local/bots, which git ignores).
//
// The books are built with the app's own code (src/engine/bot-profile.ts, loaded through Vite). No username, game id or PGN
// text is written to any output or to the log: counts, ratings and ply numbers only.
//
// --assemble --config <file> --preset <preset.json> --out <dir>
//   the same checks, then writes <dir>/preset.personal-bots.json: a COPY of the preset (read only) with the config's bots
//   added after its own, and <dir>/personal-bots.sizes.json (counts only). Fails, writing nothing, over 8 bots, a duplicate
//   rating and style, or when the real preset parser would drop anything. A bot of the preset with the same name as a new
//   one stops it too, unless --replace-same-name: then the new bot replaces it in place.
//
// --assemble-v2 --config <file> --preset <preset.json> --out <dir> [--replace-same-name] [--measure]
//   the v2 form: the books go once into a top-level "books" table and each bot lists "bookRefs" (see checkConfigV2 for the
//   config). Writes <dir>/preset.personal-bots-v2.json (a COPY; the preset is only read) and <dir>/personal-bots-v2.sizes.json;
//   with --measure also <dir>/v2-measure.json (parse times, sizes raw/gzip/brotli, coverage). --check on a config with
//   "format": "v2" runs the same checks without writing a preset.
//
// --check config (JSON); "name" and "style" are optional (the style defaults to the app's New game default):
//   { "bots": [ { "rating": 1500, "style": "solid", "books": ["me"] },
//               { "rating": 1700, "style": "solid", "books": ["peak", "me"] },
//               { "rating": 1200, "style": "solid", "books": ["student"] } ],
//     "books": { "me": { "maxEntries": 6000 }, "student": { "minCountFromPly": 8 } } }   (both settings optional)
// It rebuilds each book with its maxEntries, lays the bots out as the preset would hold them (a book used by two bots is
// written twice), and fails with exit code 1 when a preset limit is exceeded, when two bots share rating and style, or when
// the real preset parser would drop anything.
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { readPlayer, readRawArchives, writeWhole } from '../../hpc/history/lib/files.mjs';
import { buildRestorePayload, collectGames } from '../../hpc/history/lib/history.mjs';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
// Largest first: below the floor of unprunable moves (plies 0-11) every size gives the same book, so it is built once
const SIZES = [null, 20000, 10000, 6000, 3000];
const sizeLabel = (n) => (n === null ? 'none' : String(n));

// ---------------------------------------------------------------------------------------------------------- arguments
function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  if (v === undefined || v.startsWith('--')) throw new Error(`${name} needs a value`);
  return v;
}
const flag = (name) => process.argv.includes(name);

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ------------------------------------------------------------------------------------------------------------ helpers
/** Chess.com's classes from a PGN TimeControl: base + 40 x increment seconds. */
function timeClassOf(tc) {
  const v = typeof tc === 'string' ? tc.trim() : '';
  if (/^1\/\d+$/.test(v)) return 'daily';
  const m = /^(\d+)(?:\+(\d+))?$/.exec(v);
  if (!m) return 'unknown';
  const est = Number(m[1]) + 40 * Number(m[2] ?? 0);
  return est < 180 ? 'bullet' : est < 600 ? 'blitz' : 'rapid';
}

function median(values) {
  const s = [...values].sort((a, b) => a - b);
  if (s.length === 0) return null;
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

/** Per time class: games with a rating, the median of the last 20, and the highest. */
function ratingStats(games, colorOf) {
  const byClass = new Map();
  const sorted = [...games].sort((a, b) => (a.playedAt ?? 0) - (b.playedAt ?? 0));
  for (const g of sorted) {
    const color = colorOf(g);
    const rating = color === 'w' ? g.whiteElo : color === 'b' ? g.blackElo : null;
    if (typeof rating !== 'number' || !(rating > 0)) continue;
    const cls = timeClassOf(g.timeControl);
    if (!byClass.has(cls)) byClass.set(cls, []);
    byClass.get(cls).push(rating);
  }
  const out = {};
  for (const [cls, list] of byClass) {
    out[cls] = { games: list.length, current: median(list.slice(-20)), peak: Math.max(...list) };
  }
  return out;
}

function ensureRaw(dir) {
  const raw = path.join(dir, 'raw');
  if (fs.existsSync(raw) && fs.readdirSync(raw).some((n) => /^\d{4}-\d{2}\.json$/.test(n))) return false;
  const r = spawnSync(process.execPath, [path.join(rootDir, 'hpc', 'history', 'download.mjs'), '--dir', dir], {
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 25 * 60_000,
    encoding: 'utf8',
  });
  if (r.status !== 0) throw new Error('a student download failed (see its download-summary.txt in the scratch folder)');
  return true;
}

function clock() {
  const t = Date.now();
  return () => `${((Date.now() - t) / 1000).toFixed(1)} s`;
}
const log = (line) => console.log(line);

// ------------------------------------------------------------------------------------------------------------- loading
async function loadModules(vite) {
  return {
    profile: await vite.ssrLoadModule('/src/engine/bot-profile.ts'),
    record: await vite.ssrLoadModule('/src/library/game-record.ts'),
    pgnGames: await vite.ssrLoadModule('/src/capture/pgn-games.ts'),
    db: await vite.ssrLoadModule('/src/storage/db.ts'),
    preset: await vite.ssrLoadModule('/src/preset/preset.ts'),
    rules: await vite.ssrLoadModule('/src/core/rules.ts'),
    pgn: await vite.ssrLoadModule('/src/core/pgn.ts'),
    appSettings: await vite.ssrLoadModule('/src/ui/app-settings.ts'),
  };
}

/** The gift records and the owner's colour resolver. The owner's name never leaves this function's closure. */
function loadGift(giftDir, M) {
  const file = path.join(path.resolve(giftDir), 'restore.json');
  const payload = JSON.parse(fs.readFileSync(file, 'utf8'));
  const all = Array.isArray(payload.games) ? payload.games : [];
  const counts = new Map();
  for (const g of all) {
    for (const n of new Set([String(g.white).toLowerCase(), String(g.black).toLowerCase()])) {
      counts.set(n, (counts.get(n) ?? 0) + 1);
    }
  }
  let owner = null;
  let best = 0;
  for (const [n, c] of counts) {
    if (c > best) {
      best = c;
      owner = n;
    }
  }
  const share = all.length === 0 ? 0 : best / all.length;
  if (owner === null || share < 0.95) {
    throw new Error(`no single name is in 95% of the gift games (the most common is in ${(share * 100).toFixed(1)}%)`);
  }
  const accounts = [{ site: 'chesscom', username: owner }];
  const colorOf = (g) => M.record.myColor(g, accounts);
  const skippedNotMine = all.filter((g) => colorOf(g) === null).length;
  const games = all.filter((g) => colorOf(g) !== null);
  return { games, colorOf, read: all.length, skippedNotMine, ownerShare: share };
}

/** Both student accounts: records through the app's own import path, merged, deduplicated, own-vs-own dropped. */
function loadStudent(dirs, M) {
  const names = [];
  const perDir = [];
  let downloaded = 0;
  const deps = {
    checkPgnText: M.pgnGames.checkPgnText,
    importProblemOf: M.pgnGames.importProblemOf,
    buildGameRecord: M.record.buildGameRecord,
    schemaVersion: M.db.LATEST_SCHEMA_VERSION,
  };
  for (const dir of dirs) {
    if (ensureRaw(dir)) downloaded++;
    const player = readPlayer(dir);
    names.push(player.toLowerCase());
    const { archives, unreadable, files } = readRawArchives(dir);
    if (files === 0 || unreadable.length > 0) throw new Error('a student folder has no readable monthly files');
    const { games, duplicates } = collectGames(archives);
    const built = buildRestorePayload(games, player, deps, Date.now());
    perDir.push({
      months: files,
      archiveGames: games.length,
      archiveDuplicates: duplicates,
      records: built.payload.games,
      skipped: built.skipped,
      notMine: built.notMine,
    });
  }
  const own = new Set(names);
  const merged = new Map();
  const ownVsOwnIds = new Set();
  let duplicates = 0;
  for (const part of perDir) {
    for (const g of part.records) {
      if (own.has(String(g.white).toLowerCase()) && own.has(String(g.black).toLowerCase())) {
        ownVsOwnIds.add(g.id);
        continue;
      }
      if (merged.has(g.id)) {
        duplicates++;
        continue;
      }
      merged.set(g.id, g);
    }
  }
  const accounts = names.map((username) => ({ site: 'chesscom', username }));
  const colorOf = (g) => M.record.myColor(g, accounts);
  const games = [...merged.values()].filter((g) => colorOf(g) !== null);
  return {
    games,
    colorOf,
    downloaded,
    perAccount: perDir.map((p) => ({
      months: p.months,
      archiveGames: p.archiveGames,
      archiveDuplicates: p.archiveDuplicates,
      records: p.records.length,
      skipped: p.skipped,
      notMine: p.notMine,
    })),
    ownVsOwnDropped: ownVsOwnIds.size,
    duplicatesDropped: duplicates,
    notMineDropped: merged.size - games.length,
  };
}

// ------------------------------------------------------------------------------------------------------------ building
function buildAll(M, gift, student, timings) {
  const { buildBook, peakWindow, serializeBook } = M.profile;
  const mk = (label, games, opts) => {
    const done = clock();
    const r = buildBook(games, opts);
    timings[label] = done();
    return r;
  };
  const peakInclude = peakWindow(gift.games, { within: 100, ownColor: gift.colorOf });
  const minRule = (from) => (from === undefined ? {} : { minCountByPly: (p) => (p < from ? 1 : 2) });
  const specs = {
    me: (extra, from) =>
      mk('me' + sizeLabel(extra ?? null), gift.games, {
        side: 'own',
        ownColor: gift.colorOf,
        ...minRule(from),
        ...(extra ? { maxEntries: extra } : {}),
      }),
    peak: (extra, from) =>
      mk('peak' + sizeLabel(extra ?? null), gift.games, {
        side: 'own',
        ownColor: gift.colorOf,
        include: peakInclude,
        ...minRule(from),
        ...(extra ? { maxEntries: extra } : {}),
      }),
    student: (extra, from) =>
      mk('student' + sizeLabel(extra ?? null), student.games, {
        side: 'own',
        ownColor: student.colorOf,
        ...minRule(from),
        ...(extra ? { maxEntries: extra } : {}),
      }),
  };
  const withSize = (label, r) => ({
    label,
    ...r,
    chars: serializeBook(r.book).length,
  });
  return { specs, withSize, peakInclude };
}

/** The first book that has a position answers: the chain as one book (every recorded move is legal in its position). */
function chainBooks(first, second) {
  const entries = { ...second.entries, ...first.entries };
  return { v: 1, pliesCap: Math.max(first.pliesCap, second.pliesCap), entries };
}

function fmtCov(c) {
  const l = c.botLeavesAtPly;
  return {
    outcomes: c.outcomes,
    leavesAtPly: l ? { p10: l.p10, median: l.median, p90: l.p90 } : null,
    shareBefore: {
      ply10: Number(c.shareLeavingBefore.ply10.toFixed(3)),
      ply16: Number(c.shareLeavingBefore.ply16.toFixed(3)),
      ply24: Number(c.shareLeavingBefore.ply24.toFixed(3)),
    },
    distinctSequences: c.distinctSequences,
  };
}

/**
 * The same walk as bookCoverage (src/engine/bot-profile.ts) with the legal moves of a position and the position after a
 * move remembered, so thousands of playouts do not set up a board at every ply. One rng draw per book move, as there.
 */
function makeFastCoverage(M) {
  const { positionKey } = M.profile;
  const { RulesAdapter, DEFAULT_POSITION } = M.rules;
  const legalCache = new Map();
  const nextCache = new Map();
  const legalOf = (fen) => {
    let v = legalCache.get(fen);
    if (!v) {
      v = new Set(new RulesAdapter(fen).verboseMoves().map((m) => m.uci.toLowerCase()));
      legalCache.set(fen, v);
    }
    return v;
  };
  const after = (fen, uci) => {
    const k = fen + '|' + uci;
    let v = nextCache.get(k);
    if (!v) {
      const a = new RulesAdapter(fen);
      a.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), ...(uci.length === 5 ? { promotion: uci[4] } : {}) });
      v = a.fen();
      nextCache.set(k, v);
    }
    return v;
  };
  const pick = (book, fen, rng) => {
    const recorded = Object.hasOwn(book.entries, positionKey(fen)) ? book.entries[positionKey(fen)] : undefined;
    if (!recorded || recorded.length === 0) return null;
    const legal = legalOf(fen);
    const usable = recorded.filter(([uci]) => legal.has(uci));
    if (usable.length === 0) return null;
    const weights = usable.map(([, c]) => Math.max(1, c));
    const total = weights.reduce((a, b) => a + b, 0);
    const point = Math.min(Math.max(rng(), 0), 0.999999999) * total;
    let cum = 0;
    for (let i = 0; i < usable.length; i++) {
      cum += weights[i];
      if (point < cum) return usable[i][0];
    }
    return usable[usable.length - 1][0];
  };
  return (botBook, oppBook, games, rng) => {
    const leaves = [];
    const sequences = new Set();
    const outcomes = { botLeft: 0, opponentLeft: 0, capReached: 0 };
    for (let game = 0; game < games; game++) {
      const botIsWhite = game % 2 === 0;
      let fen = DEFAULT_POSITION;
      const played = [];
      let ended = false;
      for (let ply = 0; ply < botBook.pliesCap; ply++) {
        const botToMove = (fen.split(' ')[1] === 'w') === botIsWhite;
        const uci = pick(botToMove ? botBook : oppBook, fen, rng);
        if (uci === null) {
          if (botToMove) {
            outcomes.botLeft++;
            leaves.push(ply);
          } else outcomes.opponentLeft++;
          ended = true;
          break;
        }
        fen = after(fen, uci);
        played.push(uci);
      }
      if (!ended) outcomes.capReached++;
      sequences.add(played.join(' '));
    }
    leaves.sort((a, b) => a - b);
    const pct = (p) => leaves[Math.min(leaves.length - 1, Math.max(0, Math.ceil(p * leaves.length) - 1))];
    const before = (ply) => (games === 0 ? 0 : leaves.filter((x) => x < ply).length / games);
    return {
      games,
      outcomes,
      botLeavesAtPly: leaves.length === 0 ? null : { min: leaves[0], p10: pct(0.1), median: pct(0.5), p90: pct(0.9) },
      shareLeavingBefore: { ply10: before(10), ply16: before(16), ply24: before(24) },
      distinctSequences: sequences.size,
    };
  };
}

// ----------------------------------------------------------------------------------------------------------- explore
/**
 * Own-side moves of every game parsed once (ply, position key, move), so many book configurations can be tried without
 * parsing 5,000 games each time. A configuration is built with the same rules as buildBook (counting, the least count by
 * ply, pruning by count then depth with the first PROTECTED plies kept); the first call is checked against the real
 * buildBook output so a difference is never silent.
 */
function parseOnce(M, games, colorOf, include) {
  const { parsePgn } = M.pgn;
  const { positionKey } = M.profile;
  const startKey = positionKey(M.rules.DEFAULT_POSITION);
  const per = [];
  for (const g of games) {
    if (include && !include(g)) continue;
    const own = colorOf(g);
    if (!own) continue;
    let tree;
    try {
      tree = parsePgn(g.pgn);
    } catch {
      continue;
    }
    const h = tree.getHeaders();
    if (tree.isChess960() || h.FEN !== undefined || h.SetUp === '1' || positionKey(tree.root.fen) !== startKey)
      continue;
    const line = tree.getMainLine();
    if (line.length === 0) continue;
    const items = [];
    for (let ply = 0; ply < Math.min(line.length, 36); ply++) {
      const mover = ply % 2 === 0 ? 'w' : 'b';
      if (mover !== own) continue;
      const uci = line[ply].uci.toLowerCase();
      if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(uci)) continue;
      items.push([ply, positionKey(ply === 0 ? tree.root.fen : line[ply - 1].fen), uci]);
    }
    per.push(items);
  }
  return per;
}

function buildFromParsed(per, { pliesCap, minCountByPly, maxEntries, protectedPlies = 12 }) {
  const counts = new Map();
  const minPly = new Map();
  for (const items of per) {
    for (const [ply, key, uci] of items) {
      if (ply >= pliesCap) break;
      let m = counts.get(key);
      if (!m) counts.set(key, (m = new Map()));
      m.set(uci, (m.get(uci) ?? 0) + 1);
      const seen = minPly.get(key);
      if (seen === undefined || ply < seen) minPly.set(key, ply);
    }
  }
  const kept = [];
  for (const [key, moves] of counts) {
    const ply = minPly.get(key);
    const need = Math.max(1, minCountByPly(ply));
    for (const [uci, count] of moves) if (count >= need) kept.push({ key, uci, count, ply });
  }
  let survivors = kept;
  if (maxEntries !== undefined && kept.length > maxEntries) {
    const order = (a, b) =>
      a.count - b.count ||
      b.ply - a.ply ||
      (a.key < b.key ? -1 : a.key > b.key ? 1 : 0) ||
      (a.uci < b.uci ? -1 : a.uci > b.uci ? 1 : 0);
    const prunable = kept.filter((c) => c.ply >= protectedPlies).sort(order);
    const drop = new Set(prunable.slice(0, kept.length - Math.max(0, maxEntries)));
    survivors = kept.filter((c) => !drop.has(c));
  }
  const byKey = new Map();
  for (const c of survivors) {
    if (!byKey.has(c.key)) byKey.set(c.key, []);
    byKey.get(c.key).push([c.uci, c.count]);
  }
  const entries = {};
  for (const key of [...byKey.keys()].sort()) {
    entries[key] = byKey.get(key).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  }
  return { v: 1, pliesCap, entries };
}

const RULES = {
  'default (1 before ply 20, 2 after)': (p) => (p < 20 ? 1 : 2),
  '2 from ply 12': (p) => (p < 12 ? 1 : 2),
  '2 from ply 8': (p) => (p < 8 ? 1 : 2),
  '2 from ply 4': (p) => (p < 4 ? 1 : 2),
  '2 from ply 12, 3 from ply 20': (p) => (p < 12 ? 1 : p < 20 ? 2 : 3),
};

function explore(M, gift, student, out, gamesPerRun, seed) {
  const { serializeBook } = M.profile;
  const fast = makeFastCoverage(M);
  const cov = (a, b) => fmtCov(fast(a, b, gamesPerRun, mulberry32(seed)));
  const giftOpp = parseOnce(M, gift.games, (g) => ({ w: 'b', b: 'w' })[gift.colorOf(g)] ?? null, null);
  const studentOpp = parseOnce(M, student.games, (g) => ({ w: 'b', b: 'w' })[student.colorOf(g)] ?? null, null);
  const give = (per, o) =>
    buildFromParsed(per, { pliesCap: 36, minCountByPly: RULES['default (1 before ply 20, 2 after)'], ...o });
  const oppGiftBook = give(giftOpp, {});
  const oppStudentBook = give(studentOpp, {});
  const meParsed = parseOnce(M, gift.games, gift.colorOf, null);
  const studentParsed = parseOnce(M, student.games, student.colorOf, null);
  const check = serializeBook(give(meParsed, {}));
  const real = fs.readFileSync(path.join(out, 'me.book.json'), 'utf8');
  if (check !== real) throw new Error('the cached build differs from buildBook (me, default)');
  log('cached build equals the real buildBook output for the me book (byte for byte)');
  const meDefault = give(meParsed, {});
  const rows = [];
  for (const [id, per, oppBook, other] of [
    ['me', meParsed, oppGiftBook, null],
    ['student', studentParsed, oppStudentBook, meDefault],
  ]) {
    for (const cap of [16, 20, 24, 28, 36]) {
      for (const [rname, rule] of Object.entries(RULES)) {
        for (const size of [undefined, 6000]) {
          const book = buildFromParsed(per, {
            pliesCap: cap,
            minCountByPly: rule,
            ...(size ? { maxEntries: size } : {}),
          });
          const moves = Object.values(book.entries).reduce((n, l) => n + l.length, 0);
          const chars = serializeBook(book).length;
          const row = { book: id, pliesCap: cap, minCount: rname, maxEntries: size ?? 'none', moves, chars };
          if (chars <= 520_000) {
            row.vsOpponents = cov(book, oppBook);
            row.vsSelf = cov(book, id === 'me' ? book : other);
          }
          rows.push(row);
        }
      }
    }
    log(`explored ${id}`);
  }
  writeWhole(path.join(out, 'explore.json'), JSON.stringify(rows, null, 2));
  return rows;
}

// ------------------------------------------------------------------------------------------------------------- check
function checkConfig(M, configPath, built) {
  const { PRESET_LIMITS, parsePreset } = M.preset;
  const { serializeBook, parseBook } = M.profile;
  const config = JSON.parse(fs.readFileSync(path.resolve(configPath), 'utf8'));
  const failures = [];
  const bots = Array.isArray(config.bots) ? config.bots : [];
  if (bots.length === 0) failures.push('the config has no bots');
  const texts = {};
  for (const id of ['me', 'peak', 'student']) {
    const size = config.books?.[id]?.maxEntries;
    const from = config.books?.[id]?.minCountFromPly;
    const r = built.specs[id](size ?? undefined, from);
    texts[id] = serializeBook(r.book);
    log(`  ${id}: ${r.stats.entries} moves, ${texts[id].length} characters, pruned ${r.stats.pruned}`);
    if (!parseBook(texts[id])) failures.push(`book ${id}: does not parse`);
  }
  const seen = new Set();
  let total = 0;
  const presetBots = [];
  bots.forEach((b, i) => {
    const ids = Array.isArray(b.books) ? b.books : [];
    if (ids.length === 0 || ids.length > PRESET_LIMITS.booksPerBot) {
      failures.push(`bot ${i}: needs 1 to ${PRESET_LIMITS.booksPerBot} books, has ${ids.length}`);
    }
    const style = b.style ?? M.appSettings.DEFAULT_NEW_GAME.botStyle;
    const key = `${b.rating}/${style}`;
    if (seen.has(key))
      failures.push(`bot ${i}: same rating and style as an earlier bot (${key}): the preset would drop it`);
    seen.add(key);
    const bookTexts = [];
    for (const id of ids) {
      const text = texts[id];
      if (text === undefined) {
        failures.push(`bot ${i}: unknown book "${id}"`);
        continue;
      }
      if (text.length > PRESET_LIMITS.bookChars) {
        failures.push(`bot ${i}: book ${id} has ${text.length} characters, over ${PRESET_LIMITS.bookChars} each`);
      }
      total += text.length;
      bookTexts.push(text);
    }
    presetBots.push({ name: b.name ?? `Bot ${i + 1}`, rating: b.rating, style, books: bookTexts });
  });
  log(`  total in the preset: ${total} characters (limit ${PRESET_LIMITS.booksTotalChars})`);
  if (total > PRESET_LIMITS.booksTotalChars)
    failures.push(`all books together: ${total} characters, over ${PRESET_LIMITS.booksTotalChars}`);
  const parsed = parsePreset({ version: 1, bots: presetBots });
  if (parsed.problems.length > 0) failures.push(...parsed.problems.map((p) => `preset parser: ${p}`));
  if (parsed.preset && parsed.preset.bots.length !== bots.length) {
    failures.push(`preset parser kept ${parsed.preset.bots.length} of ${bots.length} bots`);
  }
  if (parsed.preset) {
    parsed.preset.bots.forEach((b, i) => {
      if ((b.books?.length ?? 0) !== presetBots[i].books.length)
        failures.push(`preset parser changed the books of bot ${i}`);
    });
  }
  return { failures, presetBots, total, texts };
}

/**
 * A COPY of the given preset with the config's bots added (the given file is only read). Fails, writing nothing, when the
 * result would have more bots than the preset allows, when a new bot has the rating and style of another, or when the
 * real preset parser (src/preset/preset.ts) would drop or change anything. A bot of the preset with the same name as a
 * new one is an error, unless `replaceSameName`: then the new bot takes its place in the list (the old one is gone).
 */
function assemblePreset(M, presetPath, presetBots, out, replaceSameName) {
  const { PRESET_LIMITS, parsePreset } = M.preset;
  const failures = [];
  const source = JSON.parse(fs.readFileSync(path.resolve(presetPath), 'utf8'));
  const sameName = (e, b) => String(e.name).toLowerCase() === String(b.name).toLowerCase();
  const all = Array.isArray(source.bots) ? source.bots : [];
  const replaced = replaceSameName ? all.filter((e) => presetBots.some((b) => sameName(e, b))).length : 0;
  const existing = replaceSameName ? all.filter((e) => !presetBots.some((b) => sameName(e, b))) : all;
  const defaultStyle = M.appSettings.DEFAULT_NEW_GAME.botStyle;
  if (existing.length + presetBots.length > PRESET_LIMITS.bots) {
    failures.push(
      `assemble: ${existing.length} bots there and ${presetBots.length} to add is over the ${PRESET_LIMITS.bots} the preset allows`,
    );
  }
  for (const b of presetBots) {
    if (existing.some((e) => e.rating === b.rating && (e.style ?? defaultStyle) === b.style)) {
      failures.push(`assemble: a bot of rating ${b.rating} and style ${b.style} is already in the preset`);
    }
    if (existing.some((e) => sameName(e, b))) {
      failures.push('assemble: a bot with the same name is already in the preset (--replace-same-name replaces it)');
    }
    if (existing.some((e) => Array.isArray(e.books) && e.books.length > 0)) {
      failures.push('assemble: the preset already has books; their size would count too (not handled)');
    }
  }
  // A replaced bot's place in the list goes to the new bot of that name; the others follow the preset's own bots
  const placed = new Set();
  const bots = all.map((e) => {
    const mine = replaceSameName ? presetBots.find((b) => sameName(e, b)) : undefined;
    if (!mine) return e;
    placed.add(mine);
    return mine;
  });
  const copy = { ...source, bots: [...bots, ...presetBots.filter((b) => !placed.has(b))] };
  const parsed = parsePreset(copy);
  if (parsed.problems.length > 0) failures.push(...parsed.problems.map((p) => `preset parser: ${p}`));
  if (!parsed.preset || parsed.preset.bots.length !== copy.bots.length) {
    failures.push(`preset parser kept ${parsed.preset?.bots.length ?? 0} of ${copy.bots.length} bots`);
  } else {
    parsed.preset.bots.forEach((b, i) => {
      const want = copy.bots[i].books ?? [];
      const got = b.books ?? [];
      if (want.length !== got.length || want.some((t, j) => t !== got[j])) {
        failures.push(`preset parser changed the books of bot ${i}`);
      }
    });
  }
  const bookChars = copy.bots.flatMap((b) => b.books ?? []).map((t) => t.length);
  const total = bookChars.reduce((a, b) => a + b, 0);
  if (total >= PRESET_LIMITS.booksTotalChars) failures.push(`all books together: ${total} characters`);
  if (failures.length > 0) return failures;
  const text = `${JSON.stringify(copy, null, 2)}\n`;
  writeWhole(path.join(out, 'preset.personal-bots.json'), text);
  // What the app writes to localStorage for this preset: the profile as JSON (the books are escaped inside it)
  const profileChars = JSON.stringify({ bots: parsed.preset.bots }).length;
  writeWhole(
    path.join(out, 'personal-bots.sizes.json'),
    JSON.stringify(
      {
        botsInPreset: copy.bots.length,
        bookCharsPerBot: copy.bots.map((b) => (b.books ?? []).map((t) => t.length)),
        totalBookChars: total,
        limit: PRESET_LIMITS.booksTotalChars,
        profileBotsJsonChars: profileChars,
        presetFileChars: text.length,
      },
      null,
      2,
    ),
  );
  if (replaced > 0) log(`  ${replaced} bot(s) of the preset with the same name as a new one replaced in place`);
  log(
    `  preset copy written: ${copy.bots.length} bots, books ${total} characters, bots part of the profile ${profileChars} characters`,
  );
  return failures;
}

// ------------------------------------------------------------------------------------------------------- v2: by reference
/**
 * The v2 form of the preset's bots: a books table (name to book text) and, on a bot, `bookRefs`. The checks are the v2
 * limits (src/preset/preset.ts: per book, table total, refs per bot, bots), a shared rating and style, and the real
 * parser: it must keep every bot, every reference and every book exactly. Config (JSON):
 *   { "format": "v2",
 *     "bots": [ { "name": "…", "rating": 1500, "books": ["me"] }, … ],      "style" optional (the New game default)
 *     "books": { "me": {}, "peak": {}, "student": {} },                      per book "maxEntries" / "minCountFromPly", optional
 *     "newGameDefault": "<name of the bot the New game card opens on>" }     optional
 */
function checkConfigV2(M, configPath, built) {
  const { PRESET_LIMITS, parsePreset, isBookName } = M.preset;
  const { serializeBook, parseBook } = M.profile;
  const config = JSON.parse(fs.readFileSync(path.resolve(configPath), 'utf8'));
  const failures = [];
  const bots = Array.isArray(config.bots) ? config.bots : [];
  if (bots.length === 0) failures.push('the config has no bots');
  if (bots.length > PRESET_LIMITS.bots)
    failures.push(`${bots.length} bots, over the ${PRESET_LIMITS.bots} the preset allows`);
  const used = [...new Set(bots.flatMap((b) => (Array.isArray(b.books) ? b.books : [])))];
  const table = {};
  for (const id of used) {
    if (!built.specs[id]) {
      failures.push(`unknown book "${id}"`);
      continue;
    }
    if (!isBookName(id)) failures.push(`book "${id}" is not a valid book name`);
    const r = built.specs[id](config.books?.[id]?.maxEntries, config.books?.[id]?.minCountFromPly);
    table[id] = serializeBook(r.book);
    log(`  ${id}: ${r.stats.entries} moves, ${table[id].length} characters, pruned ${r.stats.pruned}`);
    if (table[id].length > PRESET_LIMITS.bookTableChars) {
      failures.push(`book ${id}: ${table[id].length} characters, over ${PRESET_LIMITS.bookTableChars} each`);
    }
    if (!parseBook(table[id])) failures.push(`book ${id}: does not parse`);
  }
  const total = Object.values(table).reduce((n, t) => n + t.length, 0);
  log(`  books table: ${total} characters (limit ${PRESET_LIMITS.bookTableTotalChars})`);
  if (total > PRESET_LIMITS.bookTableTotalChars) {
    failures.push(`books table: ${total} characters, over ${PRESET_LIMITS.bookTableTotalChars}`);
  }
  const defaultStyle = M.appSettings.DEFAULT_NEW_GAME.botStyle;
  const seen = new Set();
  const presetBots = bots.map((b, i) => {
    const ids = Array.isArray(b.books) ? b.books : [];
    if (ids.length === 0 || ids.length > PRESET_LIMITS.bookRefsPerBot) {
      failures.push(`bot ${i}: needs 1 to ${PRESET_LIMITS.bookRefsPerBot} books, has ${ids.length}`);
    }
    const style = b.style ?? defaultStyle;
    const key = `${b.rating}/${style}`;
    if (seen.has(key))
      failures.push(`bot ${i}: same rating and style as an earlier bot (${key}): the preset would drop it`);
    seen.add(key);
    return { name: b.name ?? `Bot ${i + 1}`, rating: b.rating, style, bookRefs: ids };
  });
  const parsed = parsePreset({ version: 1, books: table, bots: presetBots });
  if (parsed.problems.length > 0) failures.push(...parsed.problems.map((p) => `preset parser: ${p}`));
  if (!parsed.preset || parsed.preset.bots.length !== presetBots.length) {
    failures.push(`preset parser kept ${parsed.preset?.bots.length ?? 0} of ${presetBots.length} bots`);
  } else {
    parsed.preset.bots.forEach((b, i) => {
      if (JSON.stringify(b.bookRefs ?? []) !== JSON.stringify(presetBots[i].bookRefs)) {
        failures.push(`preset parser changed the book references of bot ${i}`);
      }
    });
    for (const id of used) {
      if (parsed.preset.books?.[id] !== table[id]) failures.push(`preset parser changed or dropped book ${id}`);
    }
  }
  return { failures, presetBots, table, total, config };
}

/** A COPY of the preset with the v2 bots (by reference) and the table; the given file is only read. */
function assemblePresetV2(M, presetPath, v2, out, replaceSameName) {
  const { PRESET_LIMITS, parsePreset } = M.preset;
  const failures = [];
  const source = JSON.parse(fs.readFileSync(path.resolve(presetPath), 'utf8'));
  const sameName = (e, b) => String(e.name).toLowerCase() === String(b.name).toLowerCase();
  const all = Array.isArray(source.bots) ? source.bots : [];
  const existing = replaceSameName ? all.filter((e) => !v2.presetBots.some((b) => sameName(e, b))) : all;
  const replaced = all.length - existing.length;
  const defaultStyle = M.appSettings.DEFAULT_NEW_GAME.botStyle;
  if (source.books !== undefined) failures.push('assemble: the preset already has a books table (not handled)');
  if (existing.some((e) => Array.isArray(e.books) && e.books.length > 0)) {
    failures.push('assemble: the preset already has bots with inline books (not handled)');
  }
  if (existing.length + v2.presetBots.length > PRESET_LIMITS.bots) {
    failures.push(
      `assemble: ${existing.length} bots there and ${v2.presetBots.length} to add is over the ${PRESET_LIMITS.bots} the preset allows`,
    );
  }
  for (const b of v2.presetBots) {
    if (existing.some((e) => e.rating === b.rating && (e.style ?? defaultStyle) === b.style)) {
      failures.push(`assemble: a bot of rating ${b.rating} and style ${b.style} is already in the preset`);
    }
    if (existing.some((e) => sameName(e, b))) {
      failures.push('assemble: a bot with the same name is already in the preset (--replace-same-name replaces it)');
    }
  }
  const placed = new Set();
  const bots = all.map((e) => {
    const mine = replaceSameName ? v2.presetBots.find((b) => sameName(e, b)) : undefined;
    if (!mine) return e;
    placed.add(mine);
    return mine;
  });
  const copy = { ...source, bots: [...bots, ...v2.presetBots.filter((b) => !placed.has(b))], books: v2.table };
  // The New game card opens on the bot the config names
  const open = v2.config.newGameDefault ? v2.presetBots.find((b) => b.name === v2.config.newGameDefault) : undefined;
  if (v2.config.newGameDefault && !open) failures.push('assemble: newGameDefault names no bot of the config');
  if (open) {
    copy.settings = {
      ...source.settings,
      newGame: { ...source.settings?.newGame, botRating: open.rating, botStyle: open.style },
    };
  }
  const parsed = parsePreset(copy);
  if (parsed.problems.length > 0) failures.push(...parsed.problems.map((p) => `preset parser: ${p}`));
  if (!parsed.preset || parsed.preset.bots.length !== copy.bots.length) {
    failures.push(`preset parser kept ${parsed.preset?.bots.length ?? 0} of ${copy.bots.length} bots`);
  } else {
    parsed.preset.bots.forEach((b, i) => {
      if (JSON.stringify(b.bookRefs ?? []) !== JSON.stringify(copy.bots[i].bookRefs ?? [])) {
        failures.push(`preset parser changed the book references of bot ${i}`);
      }
    });
    for (const [id, text] of Object.entries(v2.table)) {
      if (parsed.preset.books?.[id] !== text) failures.push(`preset parser changed or dropped book ${id}`);
    }
    if (open) {
      const ng = parsed.preset.settings.newGame;
      if (ng?.botRating !== open.rating || ng?.botStyle !== open.style)
        failures.push('preset parser changed the New game default');
    }
    if (JSON.stringify(parsed.preset.welcome) !== JSON.stringify(M.preset.parsePreset(source).preset?.welcome)) {
      failures.push('the welcome text changed');
    }
  }
  if (failures.length > 0) return { failures };
  const text = `${JSON.stringify(copy, null, 2)}\n`;
  writeWhole(path.join(out, 'preset.personal-bots-v2.json'), text);
  if (replaced > 0) log(`  ${replaced} bot(s) of the preset with the same name as a new one replaced in place`);
  log(
    `  preset copy written: ${copy.bots.length} bots, ${Object.keys(v2.table).length} books, ${v2.total} book characters`,
  );
  return {
    failures,
    text,
    summary: {
      botsInPreset: copy.bots.length,
      bookChars: Object.fromEntries(Object.entries(v2.table).map(([id, t]) => [id, t.length])),
      totalBookChars: v2.total,
      limits: { perBook: PRESET_LIMITS.bookTableChars, table: PRESET_LIMITS.bookTableTotalChars },
      presetFileChars: text.length,
    },
  };
}

/** Node measurements of the v2 preset: parse times, sizes raw and compressed, and coverage of the final books. */
function measureV2(M, gift, student, v2, presetText, summary, out, gamesPerRun, seed, timings) {
  const { parseBook, buildBook } = M.profile;
  const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
  const timeIt = (fn, times = 5) => {
    const xs = [];
    for (let i = 0; i < times; i++) {
      const t = performance.now();
      fn();
      xs.push(performance.now() - t);
    }
    return Number(median(xs).toFixed(1));
  };
  const parseMs = {};
  for (const [id, text] of Object.entries(v2.table)) {
    parseMs[id] = { jsonParseMs: timeIt(() => JSON.parse(text)), parseBookMs: timeIt(() => parseBook(text)) };
  }
  const raw = Buffer.byteLength(presetText);
  const sizes = {
    rawBytes: raw,
    gzipBytes: zlib.gzipSync(presetText, { level: 6 }).length,
    brotliBytes: zlib.brotliCompressSync(presetText, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 6 } }).length,
  };
  const firstRunMs = {
    jsonParseWholeFile: timeIt(() => JSON.parse(presetText), 3),
    jsonParseAndParsePreset: timeIt(() => M.preset.parsePreset(JSON.parse(presetText)), 3),
  };
  const fast = makeFastCoverage(M);
  const cov = (a, b) => fmtCov(fast(a, b, gamesPerRun, mulberry32(seed)));
  const book = (id) => M.profile.parseBook(v2.table[id]);
  const done = clock();
  const oppGift = buildBook(gift.games, { side: 'opponent', ownColor: gift.colorOf }).book;
  const oppStudent = buildBook(student.games, { side: 'opponent', ownColor: student.colorOf }).book;
  timings.opponentBooks = done();
  const me = book('me');
  const peak = book('peak');
  const studentBook = book('student');
  const chain = chainBooks(peak, me);
  const coverage = {
    me: { vsRealOpponents: cov(me, oppGift), vsOwnMe: cov(me, me), vsStudent: cov(me, studentBook) },
    peakThenMe: { vsRealOpponents: cov(chain, oppGift), vsOwnMe: cov(chain, me), vsStudent: cov(chain, studentBook) },
    student: { vsStudentOpponents: cov(studentBook, oppStudent), vsGiftMe: cov(studentBook, me) },
  };
  const result = { coverageGames: gamesPerRun, seed, parseMs, sizes, firstRunMs, coverage, preset: summary };
  writeWhole(path.join(out, 'v2-measure.json'), JSON.stringify(result, null, 2));
  log(
    `  parse (JSON.parse / parseBook, median ms): ${Object.entries(parseMs)
      .map(([id, p]) => `${id} ${p.jsonParseMs}/${p.parseBookMs}`)
      .join(', ')}`,
  );
  log(
    `  preset ${sizes.rawBytes} bytes raw, ${sizes.gzipBytes} gzip, ${sizes.brotliBytes} brotli; whole-file JSON.parse ${firstRunMs.jsonParseWholeFile} ms, with parsePreset ${firstRunMs.jsonParseAndParsePreset} ms`,
  );
  return result;
}

const configFormat = (file) => (file ? JSON.parse(fs.readFileSync(path.resolve(file), 'utf8')).format : undefined);

// -------------------------------------------------------------------------------------------------------------- main
async function main() {
  const giftDir = arg('--gift-dir');
  const studentDirs = (arg('--student-dirs') ?? '')
    .split(',')
    .filter(Boolean)
    .map((d) => path.resolve(d));
  const out = path.resolve(arg('--out', 'gift.local/bots'));
  const assemble = flag('--assemble');
  const assembleV2 = flag('--assemble-v2');
  const check = flag('--check');
  const gamesPerRun = Number(arg('--games', '2000'));
  const seed = Number(arg('--seed', '20261117'));
  if (!giftDir || studentDirs.length !== 2)
    throw new Error(
      'usage: --gift-dir <dir> --student-dirs <dirA>,<dirB> [--out <dir>] [--check|--assemble|--assemble-v2 --config <file> [--preset <file>]]',
    );
  if (!check && !assemble && !assembleV2) {
    fs.mkdirSync(out, { recursive: true });
  }

  const vite = await createServer({
    root: rootDir,
    configFile: false,
    logLevel: 'error',
    server: { middlewareMode: true, hmr: false, watch: null },
    appType: 'custom',
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  try {
    const M = await loadModules(vite);
    const { buildBook, serializeBook, bookCoverage } = M.profile;

    const gift = loadGift(giftDir, M);
    const student = loadStudent(studentDirs, M);
    log(`gift games read ${gift.read}, used ${gift.games.length}, owner is neither side ${gift.skippedNotMine}`);
    log(
      `student games used ${student.games.length}; own-vs-own dropped ${student.ownVsOwnDropped}; duplicates dropped ${student.duplicatesDropped}`,
    );

    if (flag('--explore')) {
      explore(M, gift, student, out, gamesPerRun, seed);
      return;
    }

    const timings = {};
    const built = buildAll(M, gift, student, timings);

    if (assembleV2 || (check && configFormat(arg('--config')) === 'v2')) {
      const cfg = arg('--config');
      if (!cfg) throw new Error('--check and --assemble-v2 need --config <file>');
      log(assembleV2 ? 'assemble-v2:' : 'check (v2):');
      const v2 = checkConfigV2(M, cfg, built);
      const failures = [...v2.failures];
      if (assembleV2 && failures.length === 0) {
        const presetPath = arg('--preset');
        if (!presetPath) throw new Error('--assemble-v2 needs --preset <preset.json> (read only)');
        fs.mkdirSync(out, { recursive: true });
        const r = assemblePresetV2(M, presetPath, v2, out, flag('--replace-same-name'));
        failures.push(...r.failures);
        if (failures.length === 0) {
          writeWhole(path.join(out, 'personal-bots-v2.sizes.json'), JSON.stringify(r.summary, null, 2));
          if (flag('--measure')) measureV2(M, gift, student, v2, r.text, r.summary, out, gamesPerRun, seed, timings);
        }
      }
      if (failures.length > 0) {
        for (const f of failures) console.error(`FAIL ${f}`);
        process.exitCode = 1;
      } else {
        log('check passed');
      }
      return;
    }

    if (check || assemble) {
      const cfg = arg('--config');
      if (!cfg) throw new Error('--check and --assemble need --config <file>');
      log(assemble ? 'assemble:' : 'check:');
      const result = checkConfig(M, cfg, built);
      const failures = [...result.failures];
      if (assemble && failures.length === 0) {
        const presetPath = arg('--preset');
        if (!presetPath) throw new Error('--assemble needs --preset <preset.json> (read only)');
        fs.mkdirSync(out, { recursive: true });
        failures.push(...assemblePreset(M, presetPath, result.presetBots, out, flag('--replace-same-name')));
      }
      if (failures.length > 0) {
        for (const f of failures) console.error(`FAIL ${f}`);
        process.exitCode = 1;
      } else {
        log('check passed');
      }
      return;
    }

    // ---- ratings (D)
    const giftRatings = ratingStats(gift.games, gift.colorOf);
    const studentRatings = ratingStats(student.games, student.colorOf);
    const equalPairs = [];
    for (const cls of Object.keys(giftRatings)) {
      const cands = [
        ['gift current', giftRatings[cls]?.current],
        ['gift peak', giftRatings[cls]?.peak],
        ['student current', studentRatings[cls]?.current],
      ].filter(([, v]) => typeof v === 'number');
      for (let i = 0; i < cands.length; i++) {
        for (let j = i + 1; j < cands.length; j++) {
          if (cands[i][1] === cands[j][1])
            equalPairs.push({ timeClass: cls, a: cands[i][0], b: cands[j][0], rating: cands[i][1] });
        }
      }
    }
    // The peak window mixes time classes (peakWindow with no timeControl): say which class it comes from
    const windowByClass = {};
    for (const g of gift.games) {
      if (!built.peakInclude(g)) continue;
      const c = timeClassOf(g.timeControl);
      windowByClass[c] = (windowByClass[c] ?? 0) + 1;
    }

    // ---- books, sizes and coverage (E)
    const rows = [];
    const unpruned = {};
    const books = {};
    const opp = {
      gift: (() => {
        const done = clock();
        const r = buildBook(gift.games, { side: 'opponent', ownColor: gift.colorOf });
        timings.oppGift = done();
        return r;
      })(),
      student: (() => {
        const done = clock();
        const r = buildBook(student.games, { side: 'opponent', ownColor: student.colorOf });
        timings.oppStudent = done();
        return r;
      })(),
    };
    log(`opponent books: gift ${opp.gift.stats.entries} moves, student ${opp.student.stats.entries} moves`);

    const fast = makeFastCoverage(M);
    const coverageOf = (bot, opponent) => fmtCov(fast(bot, opponent, gamesPerRun, mulberry32(seed)));
    {
      // The memoised routine must give exactly what the app's bookCoverage gives
      const a = bookCoverage(unpruned.peak?.book ?? opp.gift.book, opp.gift.book, { games: 200, rng: mulberry32(7) });
      const b = fast(unpruned.peak?.book ?? opp.gift.book, opp.gift.book, 200, mulberry32(7));
      if (JSON.stringify(fmtCov(a)) !== JSON.stringify(fmtCov(b)))
        throw new Error('fast coverage differs from bookCoverage');
      log('coverage routine cross-checked against bookCoverage: identical (200 games)');
    }
    const floors = {};
    for (const id of ['me', 'peak', 'student']) {
      for (const size of SIZES) {
        const floor = floors[id];
        let r;
        if (floor && size !== null && size < floor.stats.entries) r = floor;
        else r = built.withSize(id, built.specs[id](size ?? undefined));
        if (size !== null && r.stats.pruned > 0 && r.stats.entries > size) floors[id] = r;
        books[`${id}:${sizeLabel(size)}`] = r.book;
        if (size === null) {
          unpruned[id] = r;
        }
        const row = {
          book: id,
          maxEntries: sizeLabel(size),
          gamesUsed: r.stats.gamesUsed,
          skipped: r.stats.skipped,
          positions: r.stats.positions,
          moves: r.stats.entries,
          chars: r.chars,
          pruned: r.stats.pruned,
          ...(r.stats.prunedByCount ? { prunedByCount: r.stats.prunedByCount } : {}),
          coverage: {},
        };
        if (id === 'me' || id === 'peak') {
          row.coverage.vsRealOpponents = coverageOf(r.book, opp.gift.book);
          row.coverage.vsOwnMe = coverageOf(r.book, books[`me:${sizeLabel(size)}`] ?? r.book);
          row.coverage.vsStudent = null; // filled once the student book of this size exists
        } else {
          row.coverage.vsStudentOpponents = coverageOf(r.book, opp.student.book);
          row.coverage.vsGiftMe = coverageOf(r.book, unpruned.me.book);
        }
        rows.push(row);
        log(
          `${id} max ${sizeLabel(size)}: ${r.stats.entries} moves, ${r.chars} chars, pruned ${r.stats.pruned} (build ${timings[id + sizeLabel(size)]})`,
        );
      }
    }
    // The student book is built last, so the two cross checks that need it come now
    for (const row of rows) {
      if (row.book === 'student') continue;
      const studentBook = books[`student:${row.maxEntries}`];
      const botBook = books[`${row.book}:${row.maxEntries}`];
      row.coverage.vsStudent = coverageOf(botBook, studentBook);
    }
    // The chain "Peak you" will use: peak first, then me
    const chain = [];
    for (const size of SIZES) {
      const merged = chainBooks(books[`peak:${sizeLabel(size)}`], books[`me:${sizeLabel(size)}`]);
      chain.push({
        maxEntries: sizeLabel(size),
        vsRealOpponents: coverageOf(merged, opp.gift.book),
        vsOwnMe: coverageOf(merged, books[`me:${sizeLabel(size)}`]),
        vsStudent: coverageOf(merged, books[`student:${sizeLabel(size)}`]),
      });
    }

    // ---- files (F)
    for (const id of ['me', 'peak', 'student']) {
      writeWhole(path.join(out, `${id}.book.json`), serializeBook(unpruned[id].book));
    }
    const stats = {
      generatedBy: 'scripts/personal-bots/build-gift-books.mjs',
      coverageGames: gamesPerRun,
      seed,
      gift: {
        read: gift.read,
        used: gift.games.length,
        skippedOwnerNotASide: gift.skippedNotMine,
        ownerShareOfGames: Number(gift.ownerShare.toFixed(4)),
        ratingsByTimeClass: giftRatings,
        peakWindowGamesByTimeClass: windowByClass,
      },
      student: {
        downloaded: student.downloaded,
        used: student.games.length,
        ownVsOwnDropped: student.ownVsOwnDropped,
        duplicatesDropped: student.duplicatesDropped,
        notMineDropped: student.notMineDropped,
        perAccount: student.perAccount,
        ratingsByTimeClass: studentRatings,
      },
      equalRatingPairs: equalPairs,
      buildSeconds: timings,
      books: rows,
      chainPeakThenMe: chain,
    };
    writeWhole(path.join(out, 'stats.json'), JSON.stringify(stats, null, 2));
    log(`wrote me/peak/student books and stats.json to the output folder`);
  } finally {
    await vite.close();
  }
}

main().catch((err) => {
  // A message here never carries a name or a game: only file or count problems are thrown above
  console.error(`build-gift-books failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
