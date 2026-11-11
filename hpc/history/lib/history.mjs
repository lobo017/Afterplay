// The logic of the history import (hpc/history/*.mjs), free of file access so the unit tests can run it: which archive
// months exist, the download loop, the statistics of one player's games, the opponent shortlist and the restore file's
// payload. Nothing here knows a player's name: it is given at run time and never logged.

export const USER_AGENT = 'Afterplay/0.1 (open-source chess study app; one-off game history import)';
export const API_ROOT = 'https://api.chess.com/pub/player';
/** What the app's backup import recognises a file by (src/storage/db.ts). */
export const BACKUP_FORMAT = 'wizards-chess-backup';
/** The capture method the extension's "Import my history" gives archive games (extension/src/backfill.ts). */
export const HISTORY_METHOD = 'chesscom-archive-history';

export function isValidUsername(name) {
  return typeof name === 'string' && /^[A-Za-z0-9_-]{3,25}$/.test(name);
}

/** "2024-03" for a monthly archive address of this player, null for anything else. */
export function archiveMonth(url, username) {
  if (typeof url !== 'string') return null;
  const prefix = `${API_ROOT}/${username.toLowerCase()}/games/`;
  if (!url.toLowerCase().startsWith(prefix)) return null;
  const m = /^(\d{4})\/(\d{2})$/.exec(url.slice(prefix.length));
  if (!m) return null;
  const month = Number(m[2]);
  return month >= 1 && month <= 12 ? `${m[1]}-${m[2]}` : null;
}

export function archiveUrl(username, month) {
  return `${API_ROOT}/${username.toLowerCase()}/games/${month.slice(0, 4)}/${month.slice(5, 7)}`;
}

// --- Download ----------------------------------------------------------------------------------------------------

/**
 * Fetches the archive list, then every month, one request at a time with `delayMs` before each. A month that fails is
 * tried once more after the others; if it fails again it is listed and the rest is kept. Month addresses are rebuilt
 * from their labels, so only the API host is ever asked, whatever the list holds. A failure of the list itself ends
 * the run (`ok: false`): no other route is tried.
 */
export async function downloadArchives({
  username,
  fetchImpl,
  sleep,
  save,
  log = () => {},
  delayMs = 1000,
  timeoutMs = 30_000,
}) {
  const headers = { 'User-Agent': USER_AGENT, Accept: 'application/json' };
  const get = async (url) => {
    try {
      const res = await fetchImpl(url, { headers, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
      if (res.status !== 200) return { ok: false, reason: `HTTP ${res.status}` };
      return { ok: true, text: await res.text() };
    } catch (err) {
      // Never the error's own message: it can quote the address, and the address holds the player's name
      const name = err && typeof err === 'object' ? err.name : '';
      if (name === 'TimeoutError' || name === 'AbortError') return { ok: false, reason: 'timed out' };
      const code = err && typeof err === 'object' && err.cause && typeof err.cause === 'object' ? err.cause.code : '';
      return { ok: false, reason: typeof code === 'string' && code ? `request failed (${code})` : 'request failed' };
    }
  };

  const empty = { months: [], saved: [], failed: [], retried: [], ignored: 0 };
  const list = await get(`${API_ROOT}/${username.toLowerCase()}/games/archives`);
  if (!list.ok) return { ok: false, reason: list.reason, ...empty };
  let urls = null;
  try {
    urls = JSON.parse(list.text).archives;
  } catch {
    urls = null;
  }
  if (!Array.isArray(urls)) return { ok: false, reason: 'the archive list is not in the expected form', ...empty };

  const months = [];
  let ignored = 0;
  for (const url of urls) {
    const month = archiveMonth(url, username);
    if (month && !months.includes(month)) months.push(month);
    else ignored++;
  }
  months.sort();

  const saved = [];
  const fetchMonth = async (month) => {
    await sleep(delayMs);
    const res = await get(archiveUrl(username, month));
    if (!res.ok) return res.reason;
    let games = null;
    try {
      games = JSON.parse(res.text).games;
    } catch {
      return 'not JSON';
    }
    if (!Array.isArray(games)) return 'no games list';
    const bytes = await save(month, res.text);
    saved.push({ month, bytes, games: games.length });
    log(`${month}: ok, ${games.length} games, ${formatBytes(bytes)}`);
    return null;
  };

  const firstPass = [];
  for (const month of months) {
    const reason = await fetchMonth(month);
    if (reason) {
      log(`${month}: ${reason}`);
      firstPass.push(month);
    }
  }
  const failed = [];
  for (const month of firstPass) {
    const reason = await fetchMonth(month);
    if (reason) {
      log(`${month} (second try): ${reason}`);
      failed.push({ month, reason });
    }
  }
  saved.sort((a, b) => (a.month < b.month ? -1 : 1));
  return { ok: true, reason: null, months, saved, failed, retried: firstPass, ignored };
}

export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatDownloadSummary(result) {
  const lines = ['History download', ''];
  if (!result.ok) {
    lines.push(`The archive list could not be fetched: ${result.reason}.`, 'Nothing was downloaded.');
    return lines.join('\n') + '\n';
  }
  const { months, saved, failed, retried, ignored } = result;
  const range = months.length > 0 ? `, ${months[0]} to ${months[months.length - 1]}` : '';
  lines.push(`Monthly archives listed: ${months.length}${range}`);
  if (ignored > 0) lines.push(`Entries of the list that are not a month of this player (ignored): ${ignored}`);
  lines.push(`Files saved: ${saved.length} (${formatBytes(saved.reduce((n, s) => n + s.bytes, 0))})`);
  lines.push(`Games in the files: ${saved.reduce((n, s) => n + s.games, 0)}`);
  lines.push(`Months tried a second time: ${retried.length > 0 ? retried.join(', ') : 'none'}`);
  lines.push(
    `Failed months: ${failed.length > 0 ? failed.map((f) => `${f.month} (${f.reason})`).join(', ') : 'none'}`,
    '',
    'Per month (games, size):',
    ...saved.map((s) => `  ${s.month}  ${String(s.games).padStart(5)}  ${formatBytes(s.bytes)}`),
  );
  return lines.join('\n') + '\n';
}

// --- Reading the games -------------------------------------------------------------------------------------------

/** Every game of the monthly files once (the game's address, else its uuid, tells two copies apart). */
export function collectGames(archives) {
  const seen = new Set();
  const games = [];
  let duplicates = 0;
  let malformed = 0;
  const ordered = [...archives].sort((a, b) => (a.month < b.month ? -1 : a.month > b.month ? 1 : 0));
  for (const archive of ordered) {
    for (const game of Array.isArray(archive.games) ? archive.games : []) {
      if (!game || typeof game !== 'object') {
        malformed++;
        continue;
      }
      const key = typeof game.url === 'string' ? game.url : typeof game.uuid === 'string' ? game.uuid : null;
      if (key !== null) {
        if (seen.has(key)) {
          duplicates++;
          continue;
        }
        seen.add(key);
      }
      games.push(game);
    }
  }
  return { games, duplicates, malformed };
}

/** Header values of a PGN without reading its moves (the first value of a repeated tag wins). */
export function readHeaders(pgn) {
  const out = {};
  if (typeof pgn !== 'string') return out;
  const re = /^\s*\[([A-Za-z0-9_]+)\s+"((?:[^"\\]|\\.)*)"\s*\]\s*$/gm;
  let m;
  while ((m = re.exec(pgn)) !== null) {
    if (!(m[1] in out)) out[m[1]] = m[2].replace(/\\(["\\])/g, '$1');
  }
  return out;
}

const DRAW_CODES = new Set(['agreed', 'repetition', 'stalemate', 'insufficient', '50move', 'timevsinsufficient']);
const LOSS_CODES = new Set([
  'checkmated',
  'timeout',
  'resigned',
  'lose',
  'abandoned',
  'kingofthehill',
  'threecheck',
  'bughousepartnerlose',
]);

/** A player's result code in the archive ("win", "resigned", "agreed", ...) as win / loss / draw / other. */
export function outcomeOf(code) {
  if (code === 'win') return 'win';
  if (DRAW_CODES.has(code)) return 'draw';
  if (LOSS_CODES.has(code)) return 'loss';
  return 'other';
}

/** "Sicilian Defense Open" from an opening address: the last part, without the moves some addresses end in. */
export function openingNameFromUrl(url) {
  if (typeof url !== 'string' || url === '') return '';
  let last = url.split(/[?#]/)[0].replace(/\/+$/, '').split('/').pop() ?? '';
  try {
    last = decodeURIComponent(last);
  } catch {
    // kept as written
  }
  const words = [];
  for (const word of last.split('-')) {
    if (/^\d+\./.test(word)) break;
    if (word !== '') words.push(word);
  }
  return words.join(' ');
}

/** "10+0", "3+2", "30s+0", "1 day per move" from an archive time control ("600", "180+2", "30", "1/86400"). */
export function timeControlLabel(tc) {
  const v = typeof tc === 'string' ? tc.trim() : '';
  const daily = /^1\/(\d+)$/.exec(v);
  if (daily) {
    const days = Math.round(Number(daily[1]) / 86400);
    return days === 1 ? '1 day per move' : `${days} days per move`;
  }
  const live = /^(\d+)(?:\+(\d+))?$/.exec(v);
  if (live) {
    const base = Number(live[1]);
    const minutes = base % 60 === 0 ? String(base / 60) : (base / 60).toFixed(1);
    return `${base < 60 ? `${base}s` : minutes}+${live[2] ?? '0'}`;
  }
  return v === '' ? 'unknown' : v;
}

function pgnDateMs(value) {
  const m = /^(\d{4})\.(\d{2})\.(\d{2})$/.exec(typeof value === 'string' ? value : '');
  return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
}

/** One game as the player saw it, or null when the player is not exactly one of its two sides. */
export function playerView(game, player) {
  const me = player.toLowerCase();
  const white = String(game.white?.username ?? '');
  const black = String(game.black?.username ?? '');
  const isWhite = white.toLowerCase() === me;
  const isBlack = black.toLowerCase() === me;
  if (isWhite === isBlack) return null;
  const mine = isWhite ? game.white : game.black;
  const theirs = isWhite ? game.black : game.white;
  const headers = readHeaders(game.pgn);
  const at =
    typeof game.end_time === 'number' && Number.isFinite(game.end_time) && game.end_time > 0
      ? game.end_time * 1000
      : (pgnDateMs(headers.EndDate) ?? pgnDateMs(headers.UTCDate) ?? pgnDateMs(headers.Date));
  const rules = typeof game.rules === 'string' && game.rules !== '' ? game.rules : 'chess';
  const timeClass = typeof game.time_class === 'string' && game.time_class !== '' ? game.time_class : 'unknown';
  const rating = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v) : null);
  return {
    colour: isWhite ? 'white' : 'black',
    opponent: isWhite ? black : white,
    outcome: outcomeOf(mine?.result),
    at,
    year: at === null ? null : new Date(at).getUTCFullYear(),
    rules,
    timeClass,
    timeControl: typeof game.time_control === 'string' ? game.time_control : (headers.TimeControl ?? ''),
    rated: game.rated === true,
    pool: rules === 'chess' ? timeClass : `${rules} ${timeClass}`,
    myRating: rating(mine?.rating),
    opponentRating: rating(theirs?.rating),
    eco: /^[A-E]\d{2}$/.test(headers.ECO ?? '') ? headers.ECO : '',
    opening: openingNameFromUrl(headers.ECOUrl ?? (typeof game.eco === 'string' ? game.eco : '')),
  };
}

// --- Statistics --------------------------------------------------------------------------------------------------

function tally() {
  return { games: 0, win: 0, loss: 0, draw: 0, other: 0 };
}

function count(t, outcome) {
  t.games++;
  t[outcome]++;
}

function bump(map, key, outcome, make = tally) {
  let t = map.get(key);
  if (!t) {
    t = make();
    map.set(key, t);
  }
  count(t, outcome);
  return t;
}

const byGames = (a, b) => b.games - a.games || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

/** Everything the report says, from the player's side. `games` are the unique games (collectGames). */
export function computeStats(games, player) {
  const views = [];
  let notMine = 0;
  for (const game of games) {
    const view = playerView(game, player);
    if (view) views.push(view);
    else notMine++;
  }
  // Oldest first, so "first" and "last" are what they say (games without a date go last)
  views.sort((a, b) => (a.at ?? Infinity) - (b.at ?? Infinity));

  const results = tally();
  const colour = { white: tally(), black: tally() };
  const years = new Map();
  const rules = new Map();
  const timeClasses = new Map();
  const timeControls = new Map();
  const openings = new Map();
  const opponents = new Map();
  const pools = new Map();
  let rated = 0;

  for (const v of views) {
    count(results, v.outcome);
    count(colour[v.colour], v.outcome);
    bump(years, v.year ?? 'unknown', v.outcome);
    bump(rules, v.rules, v.outcome);
    bump(timeClasses, v.timeClass, v.outcome);
    bump(timeControls, v.timeControl, v.outcome);
    if (v.rated) rated++;

    const opening = bump(openings, v.eco || 'none', v.outcome, () => ({ ...tally(), names: new Map() }));
    if (v.opening) opening.names.set(v.opening, (opening.names.get(v.opening) ?? 0) + 1);

    const opp = bump(opponents, v.opponent.toLowerCase(), v.outcome, () => ({
      ...tally(),
      name: v.opponent,
      firstAt: null,
      lastAt: null,
    }));
    if (v.at !== null) {
      if (opp.firstAt === null) opp.firstAt = v.at;
      opp.lastAt = v.at;
    }

    // A rating belongs to one pool (bullet, blitz, rapid, daily; variants have their own), and only rated games move it
    if (v.rated && v.myRating !== null) {
      let pool = pools.get(v.pool);
      if (!pool) {
        pool = { name: v.pool, games: 0, first: null, last: null, peak: null, lowest: null, years: new Map() };
        pools.set(v.pool, pool);
      }
      const point = { rating: v.myRating, at: v.at };
      pool.games++;
      if (!pool.first) pool.first = point;
      pool.last = point;
      if (!pool.peak || point.rating > pool.peak.rating) pool.peak = point;
      if (!pool.lowest || point.rating < pool.lowest.rating) pool.lowest = point;
      if (v.year !== null) pool.years.set(v.year, point.rating);
    }
  }

  const named = (map) => [...map.entries()].map(([name, t]) => ({ name: String(name), ...t })).sort(byGames);
  const dated = views.filter((v) => v.at !== null);
  return {
    total: games.length,
    mine: views.length,
    notMine,
    rated,
    unrated: views.length - rated,
    firstAt: dated.length > 0 ? dated[0].at : null,
    lastAt: dated.length > 0 ? dated[dated.length - 1].at : null,
    results,
    colour,
    years: named(years).sort((a, b) => (a.name < b.name ? -1 : 1)),
    rules: named(rules),
    timeClasses: named(timeClasses),
    timeControls: named(timeControls).map((t) => ({ ...t, label: timeControlLabel(t.name) })),
    openings: [...openings.entries()]
      .map(([eco, o]) => {
        const { names, ...rest } = o;
        const top = [...names.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0];
        return { name: eco, opening: top ? top[0] : '', ...rest };
      })
      .sort(byGames),
    ratings: [...pools.values()]
      .map((p) => ({
        ...p,
        years: [...p.years.entries()].map(([year, rating]) => ({ year, rating })).sort((a, b) => a.year - b.year),
      }))
      .sort(byGames),
    opponents: [...opponents.values()].sort(
      (a, b) => b.games - a.games || (b.lastAt ?? 0) - (a.lastAt ?? 0) || byGames(a, b),
    ),
  };
}

/**
 * The opponents played most often: at most `max`, most games first (then the most recent). When five or more were
 * played at least twice, only those are listed.
 */
export function shortlistOpponents(opponents, max = 10) {
  const repeat = opponents.filter((o) => o.games >= 2);
  return (repeat.length >= 5 ? repeat : opponents).slice(0, max);
}

// --- Text --------------------------------------------------------------------------------------------------------

const day = (ms) => (ms === null ? 'unknown' : new Date(ms).toISOString().slice(0, 10));
const yearOf = (ms) => (ms === null ? '?' : String(new Date(ms).getUTCFullYear()));
const record = (t) => `${t.win} won, ${t.loss} lost, ${t.draw} drawn${t.other > 0 ? `, ${t.other} other` : ''}`;
const percent = (part, whole) => (whole > 0 ? `${Math.round((100 * part) / whole)}%` : '-');

function table(rows, label = (r) => r.name) {
  const width = Math.max(4, ...rows.map((r) => label(r).length));
  return rows.map((r) => `  ${label(r).padEnd(width)}  ${String(r.games).padStart(6)}   ${record(r)}`);
}

function summaryLines(stats, { openings = 10, timeControls = 8 } = {}) {
  const lines = [
    `Games: ${stats.mine}`,
    `From ${day(stats.firstAt)} to ${day(stats.lastAt)}`,
    `Rated ${stats.rated}, unrated ${stats.unrated}`,
  ];
  if (stats.notMine > 0)
    lines.push(`Games in the files where the player is not one of the two sides: ${stats.notMine}`);
  lines.push(
    '',
    "Results (the player's side)",
    `  ${record(stats.results)}  (${percent(stats.results.win, stats.mine)} won)`,
    '',
    'Colour',
    `  White  ${String(stats.colour.white.games).padStart(6)}   ${record(stats.colour.white)}`,
    `  Black  ${String(stats.colour.black.games).padStart(6)}   ${record(stats.colour.black)}`,
    '',
    'Games per year',
    ...table(stats.years),
    '',
    'Rules',
    ...table(stats.rules),
    '',
    'Time classes',
    ...table(stats.timeClasses),
    '',
    `Time controls${stats.timeControls.length > timeControls ? ` (the ${timeControls} most played of ${stats.timeControls.length})` : ''}`,
    ...table(stats.timeControls.slice(0, timeControls), (r) => `${r.label} (${r.name})`),
    '',
    `Openings${stats.openings.length > openings ? ` (the ${openings} most played of ${stats.openings.length} ECO codes)` : ''}`,
    ...table(stats.openings.slice(0, openings), (r) => `${r.name} ${r.opening}`.trim()),
    '',
    'Ratings (rated games; each pool has its own rating)',
  );
  if (stats.ratings.length === 0) lines.push('  none');
  for (const pool of stats.ratings) {
    lines.push(
      `  ${pool.name}: ${pool.games} games, lowest ${pool.lowest.rating}, peak ${pool.peak.rating}`,
      `    first ${pool.first.rating} (${day(pool.first.at)}), last ${pool.last.rating} (${day(pool.last.at)}), peak ${pool.peak.rating} (${day(pool.peak.at)})`,
      `    at the end of each year: ${pool.years.map((y) => `${y.year} ${y.rating}`).join(', ') || 'unknown'}`,
    );
  }
  lines.push('', `Opponents: ${stats.opponents.length} different`);
  return lines;
}

/** Totals only: no opponent's name, no move. */
export function formatSummary(stats) {
  return ['History summary', '', ...summaryLines(stats)].join('\n') + '\n';
}

function opponentLine(o, i) {
  const span =
    yearOf(o.firstAt) === yearOf(o.lastAt) ? yearOf(o.firstAt) : `${yearOf(o.firstAt)} to ${yearOf(o.lastAt)}`;
  return `${String(i + 1).padStart(4)}. ${o.name}: ${o.games} ${o.games === 1 ? 'game' : 'games'}, ${record(o)} (${span})`;
}

/** The whole report: the summary with every opening and time control, then every opponent. */
export function formatReport(stats) {
  return (
    [
      'History report',
      '',
      ...summaryLines(stats, { openings: Infinity, timeControls: Infinity }),
      '',
      "Games by opponent (the record is the player's)",
      ...stats.opponents.map(opponentLine),
    ].join('\n') + '\n'
  );
}

export function formatShortlist(list) {
  return ["Opponents played most often (the record is the player's)", '', ...list.map(opponentLine)].join('\n') + '\n';
}

// --- Restore file ------------------------------------------------------------------------------------------------

/**
 * The backup-format payload for the app's own import, built with the app's code (`deps`: importProblemOf and
 * checkPgnText from src/capture/pgn-games.ts, buildGameRecord from src/library/game-record.ts, the schema version from
 * src/storage/db.ts). A game is kept exactly when the app's import would keep it; the others are counted by reason.
 * Games only: no settings, reviews or puzzles.
 */
export function buildRestorePayload(games, player, deps, now) {
  const me = player.toLowerCase();
  const skipped = { noPgn: 0, variant: 0, noMoves: 0, invalid: 0, duplicate: 0 };
  let withoutSiteId = 0;
  let notMine = 0;
  const byId = new Map();
  for (const game of games) {
    const pgn = game && typeof game.pgn === 'string' ? game.pgn : '';
    if (pgn.trim() === '') {
      skipped.noPgn++;
      continue;
    }
    const problem = deps.importProblemOf(pgn);
    if (problem) {
      if (problem.kind === 'variant') skipped.variant++;
      else skipped.noMoves++;
      continue;
    }
    let checked;
    try {
      checked = deps.checkPgnText(pgn);
    } catch {
      skipped.invalid++;
      continue;
    }
    if (checked.games.length !== 1) {
      if (checked.games.length === 0 && checked.errors[0] === 'no moves.') skipped.noMoves++;
      else skipped.invalid++;
      continue;
    }
    const valid = checked.games[0];
    const built = deps.buildGameRecord(valid, { capturedAt: null, method: HISTORY_METHOD });
    if (byId.has(built.id)) {
      skipped.duplicate++;
      continue;
    }
    if (valid.source !== 'chesscom') withoutSiteId++;
    const isWhite = built.white.toLowerCase() === me;
    const isBlack = built.black.toLowerCase() === me;
    if (isWhite === isBlack) notMine++;
    byId.set(built.id, {
      ...built,
      playerColor: isBlack && !isWhite ? 'b' : 'w',
      schemaVersion: deps.schemaVersion,
      createdAt: now,
      updatedAt: now,
    });
  }
  const list = [...byId.values()].sort(
    (a, b) => (a.playedAt ?? 0) - (b.playedAt ?? 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  return {
    payload: {
      format: BACKUP_FORMAT,
      schemaVersion: deps.schemaVersion,
      exportedAt: now,
      games: list,
      settings: [],
      puzzles: [],
      srsCards: [],
      repertoires: [],
      endgameProgress: [],
      reviews: [],
    },
    read: games.length,
    written: list.length,
    skipped,
    withoutSiteId,
    notMine,
  };
}

export function formatRestoreSummary(result, bytes) {
  const s = result.skipped;
  const left = s.noPgn + s.variant + s.noMoves + s.invalid + s.duplicate;
  const lines = [
    'Restore file',
    '',
    `Format: ${result.payload.format}, schema version ${result.payload.schemaVersion}`,
    `Games read from the raw files: ${result.read}`,
    `Games written: ${result.written} (${formatBytes(bytes)})`,
    `Games left out: ${left}`,
    `  a variant the app does not play: ${s.variant}`,
    `  no moves: ${s.noMoves}`,
    `  rejected by the app's PGN check: ${s.invalid}`,
    `  no PGN in the file: ${s.noPgn}`,
    `  the same game twice: ${s.duplicate}`,
  ];
  if (result.withoutSiteId > 0)
    lines.push(`Written without a site game id (stored like a pasted game): ${result.withoutSiteId}`);
  if (result.notMine > 0) lines.push(`Written although the player is not one of the two sides: ${result.notMine}`);
  lines.push('Everything else in the file (settings, puzzles, reviews, repertoires, drills) is empty.');
  return lines.join('\n') + '\n';
}
