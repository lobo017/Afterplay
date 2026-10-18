// Records the page data and API responses the capture extension's extractors are tested
// against (tests/fixtures/capture/). Dev-time only: the tests never touch the network.
//
//   node scripts/record-capture-fixtures.mjs
//
// One request at a time, with a pause between requests. Player records in Chess.com's
// callback JSON are trimmed to the fields the extractor reads (name, color, rating); the
// game objects are kept as recorded.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(__dirname, '..', 'tests', 'fixtures', 'capture');

// www.chess.com and lichess.org game pages serve a reduced page to non-browser agents
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const SCRIPT_UA = 'wizard-chess-fixture-recorder';

const LICHESS_GAME = 'Bjl39T9x';
const LICHESS_USER = 'lobo017';
const CHESSCOM_LIVE_PLAYER = 'hikaru';
const CHESSCOM_DAILY_PLAYER = 'erik';

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
  // The game page (finished game): the page-init-data JSON the page boots from
  const page = await request(`https://lichess.org/${LICHESS_GAME}`);
  write(`lichess/page-${LICHESS_GAME}.html`, page.body);

  // The single-game export, anonymous: answers with a login wall
  const anon = await request(`https://lichess.org/game/export/${LICHESS_GAME}?clocks=true&evals=false`);
  const anonJson = await request(`https://lichess.org/game/export/${LICHESS_GAME}?clocks=true&evals=false`, {
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

  // Export by IDs (POST): works without a session
  const ids = await request(`https://lichess.org/api/games/export/_ids?clocks=true&evals=false&opening=true`, {
    method: 'POST',
    body: LICHESS_GAME,
    headers: { 'Content-Type': 'text/plain' },
  });
  write(`lichess/export-ids-${LICHESS_GAME}.pgn`, ids.body);

  // The user's game history (backfill): NDJSON with the PGN in each line
  const hist = await request(
    `https://lichess.org/api/games/user/${LICHESS_USER}?max=4&clocks=true&evals=false&opening=true&pgnInJson=true&sort=dateDesc`,
    { headers: { Accept: 'application/x-ndjson' } },
  );
  write('lichess/user-games.ndjson', hist.body);

  // A second game page, picked from the history for castling and a promotion if there is one
  const games = hist.body
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  const second = games.find((g) => g.id !== LICHESS_GAME && /=[QRBN]/.test(g.pgn)) ?? games.find((g) => g.id !== LICHESS_GAME);
  if (second) {
    const p2 = await request(`https://lichess.org/${second.id}`);
    write(`lichess/page-${second.id}.html`, p2.body);
    const e2 = await request(`https://lichess.org/api/games/export/_ids?clocks=true&evals=false&opening=true`, {
      method: 'POST',
      body: second.id,
      headers: { 'Content-Type': 'text/plain' },
    });
    write(`lichess/export-ids-${second.id}.pgn`, e2.body);
  }
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
  const archives = await request(`https://api.chess.com/pub/player/${CHESSCOM_LIVE_PLAYER}/games/archives`, {}, SCRIPT_UA);
  const list = JSON.parse(archives.body).archives;
  const monthUrl = list.at(-1);
  const month = await request(monthUrl, {}, SCRIPT_UA);
  const monthJson = JSON.parse(month.body);

  const live = monthJson.games.filter((g) => g.rules === 'chess' && g.url.includes('/game/live/'));
  const plain = live.at(-1);
  const promo = live.find((g) => /=[QRBN]/.test(g.pgn) && /O-O-O/.test(g.pgn)) ?? live.find((g) => /=[QRBN]/.test(g.pgn));
  const picked = [plain, promo].filter(Boolean);
  for (const g of picked) {
    const id = g.url.split('/').pop();
    const cb = await request(`https://www.chess.com/callback/live/game/${id}`);
    const json = JSON.parse(cb.body);
    json.players = trimPlayers(json.players);
    write(`chesscom/callback-live-${id}.json`, `${JSON.stringify(json, null, 2)}\n`);
  }

  write(
    `chesscom/archives-${CHESSCOM_LIVE_PLAYER}.json`,
    `${JSON.stringify({ archives: list.slice(-3) }, null, 2)}\n`,
  );
  const ids = picked.map((g) => g.url.split('/').pop());
  write(
    `chesscom/archive-${CHESSCOM_LIVE_PLAYER}-${monthUrl.split('/').slice(-2).join('-')}.json`,
    `${JSON.stringify(
      {
        recorded: {
          url: monthUrl,
          etag: month.res.headers.get('etag'),
          lastModified: month.res.headers.get('last-modified'),
          totalGames: monthJson.games.length,
        },
        games: pickArchiveGames(monthJson.games, ids, 40),
      },
      null,
      2,
    )}\n`,
  );

  // A daily Chess960 game: Chess960 castling and the daily callback
  const dArchives = await request(`https://api.chess.com/pub/player/${CHESSCOM_DAILY_PLAYER}/games/archives`, {}, SCRIPT_UA);
  const dList = JSON.parse(dArchives.body).archives;
  for (const url of dList.slice(-3).reverse()) {
    const dm = await request(url, {}, SCRIPT_UA);
    const dJson = JSON.parse(dm.body);
    const c960 = dJson.games.find((g) => g.rules === 'chess960' && g.url.includes('/game/daily/'));
    const daily = dJson.games.find((g) => g.rules === 'chess' && g.url.includes('/game/daily/'));
    if (!c960) continue;
    const keep = [c960, daily].filter(Boolean);
    for (const g of keep) {
      const id = g.url.split('/').pop();
      const cb = await request(`https://www.chess.com/callback/daily/game/${id}`);
      const json = JSON.parse(cb.body);
      json.players = trimPlayers(json.players);
      write(`chesscom/callback-daily-${id}.json`, `${JSON.stringify(json, null, 2)}\n`);
    }
    write(
      `chesscom/archive-${CHESSCOM_DAILY_PLAYER}-${url.split('/').slice(-2).join('-')}.json`,
      `${JSON.stringify({ recorded: { url, etag: dm.res.headers.get('etag') }, games: keep }, null, 2)}\n`,
    );
    break;
  }
}

await recordLichess();
await recordChessCom();
console.log(`Fixtures written to ${OUT}`);
