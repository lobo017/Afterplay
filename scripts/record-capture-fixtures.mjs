// Records the page data and API responses the capture extension's extractors are tested
// against (tests/fixtures/capture/). Dev-time only: the tests never touch the network.
//
//   node scripts/record-capture-fixtures.mjs [out-dir] [--live-stream]
//
// --live-stream also records the official game stream of a live game (Lichess TV's current
// UltraBullet game, until it ends: under a minute or two) as lichess/stream-<id>-live.ndjson.
// Which game that is depends on the moment; the tests only rely on its shape.
//
// The games are fixed (the tests refer to them by ID), so a re-recording fetches the same
// set. One request at a time, with a pause between requests. Player records in Chess.com's
// callback JSON are trimmed to the fields the extractor reads (name, color, rating); the
// game objects are kept as recorded. Archive months are trimmed to the games listed below
// plus up to 40 others (promotions and long castling first), to keep the files small.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// An output folder can be given (e.g. to compare a fresh recording with the committed one)
const args = process.argv.slice(2);
const LIVE_STREAM = args.includes('--live-stream');
const outArg = args.find((a) => !a.startsWith('--'));
const OUT = outArg ? path.resolve(outArg) : path.resolve(__dirname, '..', 'tests', 'fixtures', 'capture');

// lichess.org and www.chess.com game pages serve a reduced page to non-browser agents
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
// api.chess.com refuses requests without a User-Agent
const SCRIPT_UA = 'wizard-chess-fixture-recorder';

const LICHESS_USER = 'lobo017';
/** The reference game (Phase 5) and a second one with both kinds of castling. */
const LICHESS_GAMES = ['Bjl39T9x', 'iTIXmTZF'];
/** The history fixture: the 4 games up to and including iTIXmTZF (createdAt 1792077093083). */
const LICHESS_HISTORY_UNTIL = 1792077093084;

const CHESSCOM_LIVE = { player: 'hikaru', month: '2026/10', games: ['185518487990', '185358990103'] };
/** A daily Chess960 game and a daily standard game. */
const CHESSCOM_DAILY = { player: 'erik', month: '2026/10', games: ['1036320138', '1033338800'] };

async function request(url, init = {}, ua = BROWSER_UA) {
  await sleep(1200);
  const res = await fetch(url, {
    redirect: 'manual',
    ...init,
    headers: { 'User-Agent': ua, ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(30_000),
  });
  const body = await res.text();
  console.log(`${res.status} ${init.method ?? 'GET'} ${url} (${body.length} bytes)`);
  if (res.status >= 400 && res.status !== 401) throw new Error(`${url} answered ${res.status}`);
  return { res, body };
}

function write(rel, content) {
  const file = path.join(OUT, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function trimPlayers(players) {
  const out = {};
  for (const [slot, p] of Object.entries(players ?? {})) {
    out[slot] = { username: p.username, color: p.color, rating: p.rating, isComputer: p.isComputer };
  }
  return out;
}

async function recordLichess() {
  for (const id of LICHESS_GAMES) {
    // The game page (finished game): the page-init-data JSON the page boots from
    const page = await request(`https://lichess.org/${id}`);
    write(`lichess/page-${id}.html`, page.body);
    // Export by IDs (POST): works without a session
    const ids = await request('https://lichess.org/api/games/export/_ids?clocks=true&evals=false&opening=true', {
      method: 'POST',
      body: id,
      headers: { 'Content-Type': 'text/plain' },
    });
    write(`lichess/export-ids-${id}.pgn`, ids.body);
  }

  // The single-game export, anonymous: answers with a login wall
  const id = LICHESS_GAMES[0];
  const anon = await request(`https://lichess.org/game/export/${id}?clocks=true&evals=false`);
  const anonJson = await request(`https://lichess.org/game/export/${id}?clocks=true&evals=false`, {
    headers: { Accept: 'application/json' },
  });
  write(
    'lichess/export-anonymous.json',
    `${JSON.stringify(
      {
        note: 'GET /game/export/{id} without a session',
        pgnRequest: { status: anon.res.status, location: anon.res.headers.get('location') },
        jsonRequest: { status: anonJson.res.status, body: anonJson.body },
      },
      null,
      2,
    )}\n`,
  );

  // The user's game history (backfill): NDJSON with the PGN in each line
  const hist = await request(
    `https://lichess.org/api/games/user/${LICHESS_USER}?until=${LICHESS_HISTORY_UNTIL}&max=4&clocks=true&evals=false&opening=true&pgnInJson=true&sort=dateDesc`,
    { headers: { Accept: 'application/x-ndjson' } },
  );
  write('lichess/user-games.ndjson', hist.body);

  // The official game stream of a finished game: the description, every position, the final line
  const stream = await request(`https://lichess.org/api/stream/game/${LICHESS_GAMES[0]}`, {
    headers: { Accept: 'application/x-ndjson' },
  });
  write(`lichess/stream-${LICHESS_GAMES[0]}-finished.ndjson`, stream.body);
  if (LIVE_STREAM) await recordLiveStream();
}

/** The stream of a game while it is played, read until Lichess closes it at the end. */
async function recordLiveStream() {
  const tv = JSON.parse((await request('https://lichess.org/api/tv/channels')).body);
  const id = tv.ultraBullet?.gameId ?? tv.bullet?.gameId;
  if (!id) throw new Error('No TV game to record');
  console.log(`Recording the live stream of ${id} until the game ends…`);
  const res = await fetch(`https://lichess.org/api/stream/game/${id}`, {
    headers: { 'User-Agent': BROWSER_UA, Accept: 'application/x-ndjson' },
    signal: AbortSignal.timeout(10 * 60_000),
  });
  if (!res.ok) throw new Error(`The stream answered ${res.status}`);
  const body = await res.text();
  const last = body.trim().split('\n').pop() ?? '';
  if (!/"status"/.test(last)) throw new Error('The stream closed before the game ended');
  write(`lichess/stream-${id}-live.ndjson`, body);
}

function pickArchiveGames(games, mustInclude, extra) {
  const keep = new Map();
  for (const g of games) if (mustInclude.some((id) => g.url.endsWith(`/${id}`))) keep.set(g.url, g);
  for (const g of games) {
    if (keep.size >= extra) break;
    if (/=[QRBN]/.test(g.pgn) || /O-O-O/.test(g.pgn) || keep.size < extra / 2) keep.set(g.url, g);
  }
  return [...keep.values()];
}

async function recordChessCom() {
  const archives = await request(`https://api.chess.com/pub/player/${CHESSCOM_LIVE.player}/games/archives`, {}, SCRIPT_UA);
  write(
    `chesscom/archives-${CHESSCOM_LIVE.player}.json`,
    `${JSON.stringify({ archives: JSON.parse(archives.body).archives.slice(-3) }, null, 2)}\n`,
  );

  for (const { player, month, games, type } of [
    { ...CHESSCOM_LIVE, type: 'live' },
    { ...CHESSCOM_DAILY, type: 'daily' },
  ]) {
    const monthUrl = `https://api.chess.com/pub/player/${player}/games/${month}`;
    const m = await request(monthUrl, {}, SCRIPT_UA);
    const all = JSON.parse(m.body).games;
    write(
      `chesscom/archive-${player}-${month.replace('/', '-')}.json`,
      `${JSON.stringify(
        {
          recorded: {
            url: monthUrl,
            etag: m.res.headers.get('etag'),
            lastModified: m.res.headers.get('last-modified'),
            totalGames: all.length,
          },
          games: type === 'live' ? pickArchiveGames(all, games, 40) : all.filter((g) => games.some((id) => g.url.endsWith(`/${id}`))),
        },
        null,
        2,
      )}\n`,
    );
    for (const id of games) {
      const cb = await request(`https://www.chess.com/callback/${type}/game/${id}`);
      const json = JSON.parse(cb.body);
      json.players = trimPlayers(json.players);
      write(`chesscom/callback-${type}-${id}.json`, `${JSON.stringify(json, null, 2)}\n`);
    }
  }
}

await recordLichess();
await recordChessCom();
console.log(`Fixtures written to ${OUT}`);
