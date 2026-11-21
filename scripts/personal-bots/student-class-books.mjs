// One "Your Student" bot whose rating and book follow the time class: measures candidate book recipes and builds the
// preset copy (the bot has `classes` {bullet, blitz, rapid}; its top-level rating and book references are the Rapid ones). Nothing is embedded or written in
// the repo: the preset copy and the numbers go to --out (a git-ignored folder). No username, game id or PGN text is logged
// or written: counts, ratings and ply numbers only.
//
//   node scripts/personal-bots/student-class-books.mjs --measure --student-dirs <dirA>,<dirB> --out <dir>
//   node scripts/personal-bots/student-class-books.mjs --build   --student-dirs <dirA>,<dirB> --out <dir> \
//        --preset <current preset.json> [--recipes bullet=ii,blitz=iii,rapid=iv]
//
// Student dirs: each has player.txt and raw/ (monthly Chess.com archives, read only; nothing is downloaded here). The first
// folder is "account A". The books are built with the app's own code (src/engine/bot-profile.ts, loaded through Vite).
//
// --measure   leave-one-out over the first MEASURE_PLIES plies of the student's own moves: every game is taken out of its
//             own books, then each recipe answers the position of each of the student's moves. "known" = the recipe has a
//             move for the position; "plays" = the chance that the bot's weighted draw is the student's move (a position
//             that is not known counts 0, the bot would go to the engine). Writes measure.json (winners included).
// --build     builds the books (recipe (ii) for every class: its own class book, then the pooled all-time book), replaces the
//             old single student bot of the preset copy with ONE student bot with classes, sets `botsRevision`, and
//             writes <out>/preset.json and <out>/sizes.json. The preset file is only read; apart from the bots, their
//             books and `botsRevision` the copy is the preset file as it was, byte for byte in every other field.
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { readPlayer, readRawArchives, writeWhole } from '../../hpc/history/lib/files.mjs';
import { buildRestorePayload, collectGames } from '../../hpc/history/lib/history.mjs';

// ---------------------------------------------------------------------------------------------------- configuration
/**
 * THE rating line. A student bot's rating is computed, never typed:
 *   'latest'   account A's latest rating in that Chess.com time class (the rating in its most recent game)
 *   'median20' the median of the last 20 rated games of the class, both accounts merged
 */
const RATING_MODE = 'latest';

const CLASSES = ['bullet', 'blitz', 'rapid'];
const BOT_STYLE = 'solid';
/** The one student bot keeps the name the current preset gives it; it replaces that bot at the same place in the list. */
const OLD_BOT_NAME = 'Your Student';
/** The bot list's revision (`botsRevision` in the preset): an app that already applied the preset takes a higher one. */
const BOTS_REVISION = 1;
/** Every class uses recipe (ii): its own class book, then the pooled all-time book (`student`). */
const DEFAULT_RECIPE = 'ii';
const OLD_BOOK = 'student';
const MEASURE_PLIES = 10;
const PLIES_CAP = 36;
const CLASS_MIN_COUNT = 2;
const WINDOW_MONTHS = 24;
const RECENT_MONTHS = 12;
const HALF_LIFE_YEARS = 0.5;
/** Weighted counts are whole numbers (a book holds integers): a game weighs round(WEIGHT_SCALE * 0.5^(age / half-life)), at least 1. */
const WEIGHT_SCALE = 1000;

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const RECIPES = [
  { id: 'i', label: '(i) pooled all-time', class: false, pooled: 'all' },
  { id: 'ii', label: '(ii) class, then pooled all-time', class: true, pooled: 'all' },
  { id: 'iii', label: '(iii) class, then pooled last 24 months', class: true, pooled: 'win' },
  { id: 'iv', label: '(iv) class, then pooled recency-weighted', class: true, pooled: 'rec' },
];
const POOLED_BOOK = { all: OLD_BOOK, win: 'student-24m', rec: 'student-recent' };

// --------------------------------------------------------------------------------------------------------- arguments
function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  if (v === undefined || v.startsWith('--')) throw new Error(`${name} needs a value`);
  return v;
}
const flag = (name) => process.argv.includes(name);
const log = (line) => console.log(line);

// ----------------------------------------------------------------------------------------------------------- helpers
/** Chess.com's classes from a PGN TimeControl: base + 40 x increment seconds (the same rule as build-gift-books.mjs). */
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

/** The numeric game id of a Chess.com game link (the raw archive's url and the PGN's Link header carry the same one). */
const linkId = (text) => /\/game\/(?:live|daily)\/(\d+)/.exec(String(text ?? ''))?.[1] ?? null;

const monthsBefore = (ms, months) => {
  const d = new Date(ms);
  d.setUTCMonth(d.getUTCMonth() - months);
  return d.getTime();
};
const pct = (x) => (x * 100).toFixed(1);

// ---------------------------------------------------------------------------------------------------------- loading
async function loadModules(vite) {
  return {
    profile: await vite.ssrLoadModule('/src/engine/bot-profile.ts'),
    record: await vite.ssrLoadModule('/src/library/game-record.ts'),
    pgnGames: await vite.ssrLoadModule('/src/capture/pgn-games.ts'),
    db: await vite.ssrLoadModule('/src/storage/db.ts'),
    preset: await vite.ssrLoadModule('/src/preset/preset.ts'),
    rules: await vite.ssrLoadModule('/src/core/rules.ts'),
    pgn: await vite.ssrLoadModule('/src/core/pgn.ts'),
  };
}

/** Both accounts' records (through the app's own import path), merged, deduplicated, own-vs-own dropped; account tagged A, B. */
function loadStudent(dirs, M) {
  const deps = {
    checkPgnText: M.pgnGames.checkPgnText,
    importProblemOf: M.pgnGames.importProblemOf,
    buildGameRecord: M.record.buildGameRecord,
    schemaVersion: M.db.LATEST_SCHEMA_VERSION,
  };
  const classByLink = new Map();
  const parts = dirs.map((dir) => {
    const player = readPlayer(dir).toLowerCase();
    const { archives, unreadable, files } = readRawArchives(dir);
    if (files === 0 || unreadable.length > 0) throw new Error('a student folder has no readable monthly files');
    const { games } = collectGames(archives);
    for (const raw of games) {
      const id = linkId(raw.url);
      if (id && raw.rules === 'chess' && typeof raw.time_class === 'string') classByLink.set(id, raw.time_class);
    }
    return { player, records: buildRestorePayload(games, player, deps, Date.now()).payload.games };
  });
  const own = new Set(parts.map((p) => p.player));
  const merged = new Map();
  parts.forEach((part, i) => {
    for (const g of part.records) {
      if (own.has(String(g.white).toLowerCase()) && own.has(String(g.black).toLowerCase())) continue;
      if (!merged.has(g.id)) merged.set(g.id, { g, acct: 'AB'[i] });
    }
  });
  const accounts = parts.map((p) => ({ site: 'chesscom', username: p.player }));
  const colorOf = (g) => M.record.myColor(g, accounts);
  // Chess.com's own class of a game (a 10-minute game was "blitz" there in the early years); the base + increment rule is
  // only the fallback for a game the raw archives do not name
  const classOf = (g) => classByLink.get(linkId(/\[Link "([^"]*)"\]/.exec(g.pgn)?.[1])) ?? timeClassOf(g.timeControl);
  return { entries: [...merged.values()].filter((e) => colorOf(e.g) !== null), colorOf, classOf };
}

/**
 * Per game: the student's own moves of the first PLIES_CAP plies as [ply, position key, move], parsed once. Games the app's
 * buildBook would skip (set-up starts, Chess960, unparsable) are skipped the same way.
 */
function prepare(M, entries, colorOf, classOf) {
  const { parsePgn } = M.pgn;
  const { positionKey } = M.profile;
  const startKey = positionKey(M.rules.DEFAULT_POSITION);
  const games = [];
  for (const { g, acct } of entries) {
    const col = colorOf(g);
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
    for (let ply = 0; ply < Math.min(line.length, PLIES_CAP); ply++) {
      if ((ply % 2 === 0 ? 'w' : 'b') !== col) continue;
      const uci = line[ply].uci.toLowerCase();
      if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(uci)) continue;
      items.push([ply, positionKey(ply === 0 ? tree.root.fen : line[ply - 1].fen), uci]);
    }
    games.push({
      g,
      acct,
      col,
      cls: classOf(g),
      t: typeof g.playedAt === 'number' ? g.playedAt : null,
      items,
    });
  }
  return games;
}

// ----------------------------------------------------------------------------------------------------------- books
/** The same counting, pruning order and output as the app's buildBook, from the parsed items, optionally with weights. */
function buildFromItems(games, { include, weightOf, minCountByPly, maxEntries, protectedPlies = 12 }) {
  const counts = new Map();
  const minPly = new Map();
  for (const game of games) {
    if (include && !include(game)) continue;
    const w = weightOf ? weightOf(game) : 1;
    for (const [ply, key, uci] of game.items) {
      let m = counts.get(key);
      if (!m) counts.set(key, (m = new Map()));
      const cell = m.get(uci) ?? { n: 0, w: 0 };
      cell.n += 1;
      cell.w += w;
      m.set(uci, cell);
      const seen = minPly.get(key);
      if (seen === undefined || ply < seen) minPly.set(key, ply);
    }
  }
  const kept = [];
  for (const [key, moves] of counts) {
    const ply = minPly.get(key);
    const need = Math.max(1, minCountByPly(ply));
    for (const [uci, cell] of moves)
      if (cell.n >= need) kept.push({ key, uci, count: weightOf ? cell.w : cell.n, ply });
  }
  let survivors = kept;
  let pruned = 0;
  if (maxEntries !== undefined && kept.length > maxEntries) {
    const order = (a, b) =>
      a.count - b.count ||
      b.ply - a.ply ||
      (a.key < b.key ? -1 : a.key > b.key ? 1 : 0) ||
      (a.uci < b.uci ? -1 : a.uci > b.uci ? 1 : 0);
    const prunable = kept.filter((c) => c.ply >= protectedPlies).sort(order);
    const drop = new Set(prunable.slice(0, kept.length - Math.max(0, maxEntries)));
    pruned = drop.size;
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
  return { book: { v: 1, pliesCap: PLIES_CAP, entries }, pruned, moves: survivors.length };
}

const defaultMin = (ply) => (ply < 20 ? 1 : 2);
const classMin = () => CLASS_MIN_COUNT;

// --------------------------------------------------------------------------------------------------- measurement
/** key -> uci -> { n: games, w: summed weights } over the games `keep` accepts. */
function tally(games, keep, weightOf) {
  const m = new Map();
  for (const game of games) {
    if (!keep(game)) continue;
    const w = weightOf(game);
    for (const [, key, uci] of game.items) {
      let moves = m.get(key);
      if (!moves) m.set(key, (moves = new Map()));
      const cell = moves.get(uci) ?? { n: 0, w: 0 };
      cell.n += 1;
      cell.w += w;
      moves.set(uci, cell);
    }
  }
  return m;
}

/** The moves a tally holds for a position once `game` is taken out (when `contributes`), with at least `minN` games. */
function without(t, key, game, contributes, weight, minN) {
  const moves = t.get(key);
  const out = [];
  if (!moves) return out;
  for (const [uci, cell] of moves) {
    let n = cell.n;
    let w = cell.w;
    if (contributes) {
      const mult = game.items.filter((x) => x[1] === key && x[2] === uci).length;
      n -= mult;
      w -= mult * weight;
    }
    if (n >= minN && n > 0) out.push([uci, n, w]);
  }
  return out;
}

function makeMeasurer(games, ref) {
  const ageYears = (g) => (ref - g.t) / (365.25 * 86_400_000);
  const weightOf = (g) =>
    g.t === null ? 1 : Math.max(1, Math.round(WEIGHT_SCALE * Math.pow(0.5, ageYears(g) / HALF_LIFE_YEARS)));
  const windowStart = monthsBefore(ref, WINDOW_MONTHS);
  const inWindow = (g) => g.t !== null && g.t >= windowStart;
  const all = tally(games, () => true, weightOf);
  const win = tally(games, inWindow, weightOf);
  const byClass = Object.fromEntries(CLASSES.map((c) => [c, tally(games, (g) => g.cls === c, weightOf)]));

  /** [known, probability that the weighted draw is `move`] for one position of one game under a recipe. */
  function answer(game, key, move, recipe) {
    const own = weightOf(game);
    let moves = [];
    if (recipe.class) {
      moves = without(byClass[game.cls], key, game, true, own, CLASS_MIN_COUNT).map(([u, n]) => [u, n]);
    }
    if (moves.length === 0) {
      if (recipe.pooled === 'all') moves = without(all, key, game, true, own, 1).map(([u, n]) => [u, n]);
      else if (recipe.pooled === 'win') moves = without(win, key, game, inWindow(game), own, 1).map(([u, n]) => [u, n]);
      else moves = without(all, key, game, true, own, 1).map(([u, , w]) => [u, Math.max(1, w)]);
    }
    if (moves.length === 0) return [0, 0];
    const total = moves.reduce((a, [, c]) => a + c, 0);
    const mine = moves.find(([u]) => u === move);
    return [1, mine ? mine[1] / total : 0];
  }
  return { answer, weightOf, inWindow, windowStart };
}

function measure(games, ref) {
  const m = makeMeasurer(games, ref);
  const recentStart = monthsBefore(ref, RECENT_MONTHS);
  const sets = {
    all: () => true,
    recent: (g) => g.t !== null && g.t >= recentStart,
  };
  // acc[set][cls][col|both][recipe] = { positions, known, plays }
  const acc = {};
  for (const set of Object.keys(sets)) {
    acc[set] = {};
    for (const c of CLASSES) {
      acc[set][c] = {};
      for (const col of ['w', 'b', 'both']) {
        acc[set][c][col] = Object.fromEntries(RECIPES.map((r) => [r.id, { positions: 0, known: 0, plays: 0 }]));
      }
    }
  }
  for (const game of games) {
    if (!CLASSES.includes(game.cls)) continue;
    for (const [ply, key, uci] of game.items) {
      if (ply >= MEASURE_PLIES) continue;
      for (const recipe of RECIPES) {
        const [known, plays] = m.answer(game, key, uci, recipe);
        for (const [set, inSet] of Object.entries(sets)) {
          if (!inSet(game)) continue;
          for (const col of [game.col, 'both']) {
            const cell = acc[set][game.cls][col][recipe.id];
            cell.positions += 1;
            cell.known += known;
            cell.plays += plays;
          }
        }
      }
    }
  }
  return { acc, m, recentStart };
}

/** Taking a game out by brute force (a rebuild without it) must give the same answers as the subtraction. */
function spotCheck(games, m) {
  let checked = 0;
  const sample = games.filter((g) => CLASSES.includes(g.cls) && g.t !== null);
  for (const idx of [3, Math.floor(sample.length / 2), sample.length - 7]) {
    const game = sample[idx];
    const others = (g) => g !== game;
    const bf = {
      all: buildFromItems(games, { include: others, minCountByPly: () => 1 }).book,
      win: buildFromItems(games, { include: (g) => others(g) && m.inWindow(g), minCountByPly: () => 1 }).book,
      rec: buildFromItems(games, { include: others, weightOf: m.weightOf, minCountByPly: () => 1 }).book,
      cls: buildFromItems(games, { include: (g) => others(g) && g.cls === game.cls, minCountByPly: classMin }).book,
    };
    for (const recipe of RECIPES) {
      for (const [ply, key, uci] of game.items) {
        if (ply >= MEASURE_PLIES) continue;
        const fast = m.answer(game, key, uci, recipe);
        let entries = recipe.class ? (bf.cls.entries[key] ?? []) : [];
        if (entries.length === 0) entries = bf[recipe.pooled].entries[key] ?? [];
        const total = entries.reduce((a, [, c]) => a + c, 0);
        const mine = entries.find(([u]) => u === uci);
        const slow = entries.length === 0 ? [0, 0] : [1, mine ? mine[1] / total : 0];
        if (slow[0] !== fast[0] || Math.abs(slow[1] - fast[1]) > 1e-12)
          throw new Error(`leave-one-out spot check failed (recipe ${recipe.id}, ply ${ply})`);
        checked++;
      }
    }
  }
  return checked;
}

function printTable(acc, setName, title) {
  const w = 14;
  log(title);
  const head = ['class/colour'.padEnd(14), ...RECIPES.map((r) => `(${r.id}) known/plays`.padEnd(w + 6))];
  log(head.join(' '));
  for (const c of CLASSES) {
    for (const [col, label] of [
      ['w', 'white'],
      ['b', 'black'],
      ['both', 'both'],
    ]) {
      const cells = RECIPES.map((r) => {
        const x = acc[setName][c][col][r.id];
        const k = x.positions === 0 ? 0 : x.known / x.positions;
        const p = x.positions === 0 ? 0 : x.plays / x.positions;
        return `${pct(k).padStart(5)} / ${pct(p).padStart(5)}`.padEnd(w + 6);
      });
      log(`${(c + ' ' + label).padEnd(14)} ${cells.join(' ')}`);
    }
  }
}

/** Recipes whose "plays my move" is within this many points of the best count as tied. */
const TIE_POINTS = 0.2;

/**
 * The rule that picks a recipe per class: the best "plays my move" over all games of the class (thousands of positions per
 * class; the last-12-month set is only a few dozen games in blitz and rapid, so it informs but does not decide). Recipes
 * within TIE_POINTS of the best are tied and the simplest of them wins (fewest books: i, then ii, then iii and iv). The
 * baseline (i) is kept for a class that no recipe beats by more than TIE_POINTS.
 */
function winners(acc, setName) {
  const out = {};
  for (const c of CLASSES) {
    const score = (r) => {
      const x = acc[setName][c].both[r.id];
      return x.positions === 0 ? 0 : (100 * x.plays) / x.positions;
    };
    const top = Math.max(...RECIPES.map(score));
    const best = RECIPES.find((r) => score(r) >= top - TIE_POINTS) ?? RECIPES[0];
    out[c] = { recipe: best.id, plays: Number(score(best).toFixed(1)), baseline: Number(score(RECIPES[0]).toFixed(1)) };
  }
  return out;
}

// ------------------------------------------------------------------------------------------------------ ratings
function ratingsOf(games) {
  const mine = (g) => (g.col === 'w' ? g.g.whiteElo : g.g.blackElo);
  const sorted = [...games]
    .filter((g) => typeof mine(g) === 'number' && mine(g) > 0)
    .sort((a, b) => (a.t ?? 0) - (b.t ?? 0));
  const out = { latest: {}, median20: {}, median20ByRule: {}, latestOfB: {} };
  for (const cls of ['bullet', 'blitz', 'rapid', 'daily']) {
    const inClass = sorted.filter((g) => g.cls === cls);
    const a = inClass.filter((g) => g.acct === 'A');
    const b = inClass.filter((g) => g.acct === 'B');
    out.latest[cls] = a.length ? mine(a[a.length - 1]) : null;
    out.latestOfB[cls] = b.length ? mine(b[b.length - 1]) : null;
    out.median20[cls] = median(inClass.slice(-20).map(mine));
    out.median20ByRule[cls] = median(
      sorted
        .filter((g) => timeClassOf(g.g.timeControl) === cls)
        .slice(-20)
        .map(mine),
    );
  }
  return out;
}

// ----------------------------------------------------------------------------------------------------- measure mode
async function runMeasure(M, prepared, out) {
  const ref = Math.max(...prepared.filter((g) => g.t !== null).map((g) => g.t));
  const undated = prepared.filter((g) => g.t === null).length;
  log(
    `games used ${prepared.length} (account A ${prepared.filter((g) => g.acct === 'A').length}, account B ${prepared.filter((g) => g.acct === 'B').length}); undated ${undated}`,
  );
  log(`reference = the date of the last game in the data (${new Date(ref).toISOString().slice(0, 10)})`);
  for (const c of [...CLASSES, 'daily', 'unknown']) log(`  ${c}: ${prepared.filter((g) => g.cls === c).length} games`);

  // The cached builder must equal the app's own buildBook, byte for byte, or nothing below can be trusted
  const { buildBook, serializeBook } = M.profile;
  const records = prepared.map((g) => g.g);
  const colorByRecord = new Map(prepared.map((g) => [g.g, g.col]));
  const clsByRecord = new Map(prepared.map((g) => [g.g, g.cls]));
  const ownColor = (g) => colorByRecord.get(g) ?? null;
  const realAll = serializeBook(buildBook(records, { side: 'own', ownColor }).book);
  const mineAll = serializeBook(buildFromItems(prepared, { minCountByPly: defaultMin }).book);
  if (realAll !== mineAll) throw new Error('the cached build differs from buildBook (pooled)');
  const realCls = serializeBook(
    buildBook(records, {
      side: 'own',
      ownColor,
      minCount: CLASS_MIN_COUNT,
      include: (g) => clsByRecord.get(g) === 'blitz',
    }).book,
  );
  const mineCls = serializeBook(
    buildFromItems(prepared, { include: (g) => g.cls === 'blitz', minCountByPly: classMin }).book,
  );
  if (realCls !== mineCls) throw new Error('the cached build differs from buildBook (class)');
  log('cached builder equals the app buildBook byte for byte (pooled and a class book)');

  const { acc, m } = measure(prepared, ref);
  const checked = spotCheck(prepared, m);
  log(
    `leave-one-out by subtraction equals a rebuild without the game (3 games, ${checked} position answers, all 4 recipes)`,
  );
  log('');
  log(
    `Leave-one-out, the student's own first ${MEASURE_PLIES} plies. Cells: "position known % / bot plays my move %".`,
  );
  log(
    `Pooled-only (i) is the baseline. Evaluation: all games of the class, and the games of the last ${RECENT_MONTHS} months.`,
  );
  log('');
  printTable(acc, 'all', 'A. all games of the class (all time)');
  log('');
  printTable(acc, 'recent', `B. games of the last ${RECENT_MONTHS} months only`);
  const winAll = winners(acc, 'all');
  const winRecent = winners(acc, 'recent');
  log('');
  log(`Best recipe per class by "plays my move", both colours: all-time ${JSON.stringify(winAll)}`);
  log(
    `                                                        last ${RECENT_MONTHS} months ${JSON.stringify(winRecent)}`,
  );
  const ratings = ratingsOf(prepared);
  log(`latest rating of account A per class: ${JSON.stringify(ratings.latest)}`);
  log(`median of the last 20 per class (both accounts merged): ${JSON.stringify(ratings.median20)}`);
  log(
    `  (the same median with the base + increment rule instead of Chess.com's class: ${JSON.stringify(ratings.median20ByRule)})`,
  );
  fs.mkdirSync(out, { recursive: true });
  writeWhole(
    path.join(out, 'measure.json'),
    JSON.stringify(
      {
        reference: new Date(ref).toISOString().slice(0, 10),
        acc,
        winnersAll: winAll,
        winnersRecent: winRecent,
        ratings,
      },
      null,
      2,
    ),
  );
  return { winRecent, winAll, ratings, ref };
}

// ------------------------------------------------------------------------------------------------------- build mode
function brotli(text) {
  return zlib.brotliCompressSync(text, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } }).length;
}

async function runBuild(M, prepared, out, presetPath, chosen, ratingMode, ratings, ref) {
  const { PRESET_LIMITS, parsePreset } = M.preset;
  const { buildBook, serializeBook, parseBook } = M.profile;
  const records = prepared.map((g) => g.g);
  const colorByRecord = new Map(prepared.map((g) => [g.g, g.col]));
  const clsByRecord = new Map(prepared.map((g) => [g.g, g.cls]));
  const ownColor = (g) => colorByRecord.get(g) ?? null;
  const source = JSON.parse(fs.readFileSync(path.resolve(presetPath), 'utf8'));
  const sourceText = fs.readFileSync(path.resolve(presetPath), 'utf8');
  const failures = [];
  const m = makeMeasurer(prepared, ref);

  // Ratings: computed here, from the data
  const ratingOf = {};
  for (const c of CLASSES) {
    const v = (ratingMode === 'median20' ? ratings.median20 : ratings.latest)[c];
    if (!Number.isInteger(v) || v < 100 || v > 3500) failures.push(`no usable ${ratingMode} rating for ${c}`);
    ratingOf[c] = v;
  }

  // Books
  const table = {};
  const pruneLog = {};
  const need = new Set();
  for (const c of CLASSES) {
    if (chosen[c].class) table[`student-${c}`] = null;
    need.add(chosen[c].pooled);
  }
  const buildPooled = (kind, maxEntries) => {
    if (kind === 'all') {
      const r = buildBook(records, { side: 'own', ownColor, ...(maxEntries ? { maxEntries } : {}) });
      return { text: serializeBook(r.book), pruned: r.stats.pruned };
    }
    if (kind === 'win') {
      const r = buildBook(records, {
        side: 'own',
        ownColor,
        include: (g) => typeof g.playedAt === 'number' && g.playedAt >= m.windowStart,
        ...(maxEntries ? { maxEntries } : {}),
      });
      return { text: serializeBook(r.book), pruned: r.stats.pruned };
    }
    const r = buildFromItems(prepared, {
      weightOf: m.weightOf,
      minCountByPly: defaultMin,
      ...(maxEntries ? { maxEntries } : {}),
    });
    return { text: serializeBook(r.book), pruned: r.pruned };
  };
  for (const c of CLASSES) {
    if (!chosen[c].class) continue;
    const r = buildBook(records, {
      side: 'own',
      ownColor,
      minCount: CLASS_MIN_COUNT,
      include: (g) => clsByRecord.get(g) === c,
    });
    table[`student-${c}`] = serializeBook(r.book);
    log(
      `  student-${c}: ${r.stats.gamesUsed} games, ${r.stats.entries} moves, ${table[`student-${c}`].length} characters`,
    );
  }
  const pooledMaxEntries = {};
  for (const kind of need) {
    const t = buildPooled(kind);
    table[POOLED_BOOK[kind]] = t.text;
    log(`  ${POOLED_BOOK[kind]}: ${t.text.length} characters`);
  }

  // The books that stay as they are
  const keep = Object.fromEntries(Object.entries(source.books ?? {}).filter(([name]) => name !== OLD_BOOK));
  const oldStudentText = (source.books ?? {})[OLD_BOOK];
  if (
    oldStudentText !== undefined &&
    table[POOLED_BOOK.all] !== undefined &&
    oldStudentText !== table[POOLED_BOOK.all]
  ) {
    log('  note: the pooled all-time book differs from the current preset student book');
  } else if (oldStudentText !== undefined && table[POOLED_BOOK.all] !== undefined) {
    log('  the pooled all-time book is identical to the current preset student book');
  }

  // Fit the limits: prune the pooled books beyond ply 12, fewest games first (the first 12 plies are never pruned)
  const totalOf = () => Object.values({ ...keep, ...table }).reduce((a, t) => a + t.length, 0);
  let tries = 0;
  while (
    (totalOf() > PRESET_LIMITS.bookTableTotalChars ||
      Object.values(table).some((t) => t.length > PRESET_LIMITS.bookTableChars)) &&
    tries < 30
  ) {
    tries++;
    const kinds = [...need].sort((a, b) => table[POOLED_BOOK[b]].length - table[POOLED_BOOK[a]].length);
    const kind = kinds[0];
    const cur = parseBook(table[POOLED_BOOK[kind]]);
    const moves = Object.values(cur.entries).reduce((n, l) => n + l.length, 0);
    const target = Math.floor(moves * 0.9);
    pooledMaxEntries[kind] = target;
    const t = buildPooled(kind, target);
    table[POOLED_BOOK[kind]] = t.text;
    pruneLog[POOLED_BOOK[kind]] = { maxEntries: target, pruned: t.pruned };
  }

  // Bots
  const refsOf = (c) =>
    chosen[c].class ? [`student-${c}`, POOLED_BOOK[chosen[c].pooled]] : [POOLED_BOOK[chosen[c].pooled]];
  // One bot: the top-level rating and book references are the Rapid ones (what an older app plays), plus the classes
  const student = {
    name: OLD_BOT_NAME,
    rating: ratingOf.rapid,
    style: BOT_STYLE,
    bookRefs: refsOf('rapid'),
    classes: Object.fromEntries(CLASSES.map((c) => [c, { rating: ratingOf[c], bookRefs: refsOf(c) }])),
  };
  const oldIndex = (source.bots ?? []).findIndex((b) => String(b.name) === OLD_BOT_NAME);
  if (oldIndex === -1) failures.push(`the preset has no bot named ${OLD_BOT_NAME}`);
  const sourceBots = source.bots ?? [];
  const nextBots = [...sourceBots.slice(0, Math.max(0, oldIndex)), student, ...sourceBots.slice(oldIndex + 1)];
  if (source.botsRevision !== undefined && !(source.botsRevision < BOTS_REVISION))
    failures.push('the preset already has a botsRevision that is not lower than the new one');
  // Key order as in the source (botsRevision goes last: it is the only key the source does not have)
  const copy = { ...source, bots: nextBots, books: { ...keep, ...table }, botsRevision: BOTS_REVISION };
  // A book no bot lists is dead weight in the table
  const used = new Set(
    nextBots.flatMap((b) => [
      ...(b.bookRefs ?? []),
      ...Object.values(b.classes ?? {}).flatMap((c) => c.bookRefs ?? []),
    ]),
  );
  for (const name of Object.keys(copy.books)) {
    if (!used.has(name)) {
      log(`  book ${name} is listed by no bot: dropped from the table`);
      delete copy.books[name];
    }
  }

  // Checks with the app's own parser
  if (nextBots.length > PRESET_LIMITS.bots) failures.push(`${nextBots.length} bots, over ${PRESET_LIMITS.bots}`);
  // One rating, one bot: no rating of a bot (its own or a class's) is a rating of another bot
  const owner = new Map();
  nextBots.forEach((b, i) => {
    for (const r of [b.rating, ...Object.values(b.classes ?? {}).map((c) => c.rating)]) {
      if (owner.has(r) && owner.get(r) !== i) failures.push(`two bots share the rating ${r}`);
      owner.set(r, i);
    }
  });
  const parsed = parsePreset(copy);
  const parsedSource = parsePreset(source);
  if (parsed.problems.length > 0) failures.push(...parsed.problems.map((p) => `preset parser: ${p}`));
  if (!parsed.preset || parsed.preset.bots.length !== nextBots.length) {
    failures.push(`preset parser kept ${parsed.preset?.bots.length ?? 0} of ${nextBots.length} bots`);
  } else {
    parsed.preset.bots.forEach((b, i) => {
      if (JSON.stringify(b.bookRefs ?? []) !== JSON.stringify(nextBots[i].bookRefs ?? []))
        failures.push(`preset parser changed the book references of bot ${i}`);
      if (JSON.stringify(b.classes ?? null) !== JSON.stringify(nextBots[i].classes ?? null))
        failures.push(`preset parser changed the classes of bot ${i}`);
    });
    for (const [name, text] of Object.entries(copy.books)) {
      if (parsed.preset.books?.[name] !== text) failures.push(`preset parser changed or dropped book ${name}`);
    }
    if (parsed.preset.botsRevision !== BOTS_REVISION) failures.push('preset parser did not keep botsRevision');
    for (const field of ['welcome', 'settings', 'profile', 'usernames']) {
      if (JSON.stringify(parsed.preset[field]) !== JSON.stringify(parsedSource.preset?.[field]))
        failures.push(`${field} changed`);
    }
  }
  // Everything but the student bot and its book is as it was
  const others = (p) =>
    JSON.stringify(
      Object.fromEntries(Object.entries(p).filter(([k]) => k !== 'bots' && k !== 'books' && k !== 'botsRevision')),
    );
  if (others(copy) !== others(source))
    failures.push('a top-level field other than bots, books and botsRevision changed');
  for (const b of sourceBots) {
    if (String(b.name) === OLD_BOT_NAME) continue;
    const now = nextBots.find((x) => x.name === b.name);
    if (!now || JSON.stringify(now) !== JSON.stringify(b)) failures.push('a bot other than the student bot changed');
  }
  for (const [name, text] of Object.entries(keep)) {
    if (name !== OLD_BOOK && copy.books[name] !== text) failures.push(`book ${name} changed`);
  }
  const perBook = Object.fromEntries(Object.entries(copy.books).map(([n, t]) => [n, t.length]));
  const total = Object.values(perBook).reduce((a, b) => a + b, 0);
  for (const [n, len] of Object.entries(perBook))
    if (len > PRESET_LIMITS.bookTableChars)
      failures.push(`book ${n}: ${len} characters, over ${PRESET_LIMITS.bookTableChars}`);
  if (total > PRESET_LIMITS.bookTableTotalChars)
    failures.push(`books table ${total} characters, over ${PRESET_LIMITS.bookTableTotalChars}`);
  if (failures.length > 0) {
    for (const f of failures) console.error(`FAIL ${f}`);
    process.exitCode = 1;
    return;
  }
  const text = `${JSON.stringify(copy, null, 2)}\n`;
  fs.mkdirSync(out, { recursive: true });
  writeWhole(path.join(out, 'preset.json'), text);
  const sizes = {
    bots: nextBots.length,
    botRatings: nextBots.map((b) => b.rating),
    studentClassRatings: Object.fromEntries(CLASSES.map((c) => [c, ratingOf[c]])),
    botsRevision: BOTS_REVISION,
    ratingMode,
    chosenRecipes: Object.fromEntries(CLASSES.map((c) => [c, chosen[c].id])),
    bookChars: perBook,
    totalBookChars: total,
    limits: {
      bots: PRESET_LIMITS.bots,
      perBook: PRESET_LIMITS.bookTableChars,
      table: PRESET_LIMITS.bookTableTotalChars,
    },
    prunedPooled: pruneLog,
    presetBytes: Buffer.byteLength(text),
    presetBrotli11: brotli(text),
    currentPresetBytes: Buffer.byteLength(sourceText),
    currentPresetBrotli11: brotli(sourceText),
  };
  writeWhole(path.join(out, 'sizes.json'), JSON.stringify(sizes, null, 2));
  log(
    `preset copy written: ${nextBots.length} bots (one student bot with classes), ${Object.keys(copy.books).length} books, ${total} book characters`,
  );
  log(JSON.stringify(sizes, null, 2));
}

// --------------------------------------------------------------------------------------------------------- main
async function main() {
  const dirs = (arg('--student-dirs') ?? '')
    .split(',')
    .filter(Boolean)
    .map((d) => path.resolve(d));
  const out = path.resolve(arg('--out', 'gift.local/bots2'));
  if (dirs.length !== 2)
    throw new Error('usage: --student-dirs <dirA>,<dirB> --out <dir> (--measure | --build --preset <file>)');
  if (!flag('--measure') && !flag('--build')) throw new Error('give --measure or --build');
  const ratingMode = arg('--rating-mode', RATING_MODE);
  if (ratingMode !== 'latest' && ratingMode !== 'median20') throw new Error("--rating-mode is 'latest' or 'median20'");

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
    const student = loadStudent(dirs, M);
    const prepared = prepare(M, student.entries, student.colorOf, student.classOf);
    const result = await runMeasure(M, prepared, out);
    if (flag('--build')) {
      const presetPath = arg('--preset');
      if (!presetPath) throw new Error('--build needs --preset <preset.json> (read only)');
      const given = arg('--recipes');
      const chosen = {};
      for (const c of CLASSES) {
        let id = DEFAULT_RECIPE;
        if (given) {
          const hit = given.split(',').find((p) => p.startsWith(`${c}=`));
          if (hit) id = hit.split('=')[1];
        }
        const recipe = RECIPES.find((r) => r.id === id);
        if (!recipe) throw new Error(`unknown recipe ${id}`);
        chosen[c] = recipe;
      }
      log('');
      log(
        `building with recipes ${JSON.stringify(Object.fromEntries(CLASSES.map((c) => [c, chosen[c].id])))}; rating mode ${ratingMode}`,
      );
      await runBuild(M, prepared, out, presetPath, chosen, ratingMode, result.ratings, result.ref);
    }
  } finally {
    await vite.close();
  }
}

main().catch((err) => {
  // A message here never carries a name or a game: only count and file problems are thrown above
  console.error(`student-class-books failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
