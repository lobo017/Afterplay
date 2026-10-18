// Saves a Lichess game with Lichess's own analysis as a review test fixture.
//
//   LICHESS_TOKEN=lip_xxx node scripts/fetch-lichess-game.mjs [gameId]   (default Bjl39T9x)
//
// Lichess's export endpoint needs a logged-in client (anonymous requests are redirected to
// /signup). Create a personal API token at https://lichess.org/account/oauth/token (no
// scopes needed) and pass it in LICHESS_TOKEN; it is only sent to lichess.org.
//
// Dev-time only (the app makes no network requests). Uses the official game export
// endpoint twice: as PGN with evals, clocks and Lichess's annotation comments
// (`evals=true&literate=true`), and as JSON with the per-move analysis and each side's
// accuracy / ACPL / error counts. Writes tests/fixtures/review/lichess-<id>.json.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const gameId = process.argv[2] ?? 'Bjl39T9x';
if (!/^[A-Za-z0-9]{8}$/.test(gameId)) {
  console.error(`Not a Lichess game id: ${gameId}`);
  process.exit(2);
}
const token = process.env.LICHESS_TOKEN?.trim();
if (!token) {
  console.error(
    'LICHESS_TOKEN is not set. Lichess requires a logged-in client for game exports: create a ' +
      'token at https://lichess.org/account/oauth/token (no scopes needed) and run\n' +
      '  PowerShell: $env:LICHESS_TOKEN = "lip_..."; node scripts/fetch-lichess-game.mjs',
  );
  process.exit(2);
}
const base = `https://lichess.org/game/export/${gameId}`;
const params = 'evals=true&clocks=true&opening=true&literate=true&accuracy=true';

async function get(accept) {
  const res = await fetch(`${base}?${params}`, {
    headers: {
      Accept: accept,
      Authorization: `Bearer ${token}`,
      'User-Agent': 'wizards-chess fixture script (dev-time)',
    },
    redirect: 'manual',
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    throw new Error(
      `${accept}: HTTP ${res.status} ${res.statusText}${res.status === 401 || res.status === 303 ? ' (is LICHESS_TOKEN valid?)' : ''}`,
    );
  }
  return res.text();
}

async function main() {
  const pgn = await get('application/x-chess-pgn');
  const json = JSON.parse(await get('application/json'));
  if (!json.analysis) {
    throw new Error('The game has no server analysis on Lichess (request one on the game page first).');
  }
  const out = {
    description:
      'Fetched by scripts/fetch-lichess-game.mjs from the Lichess game export endpoint. ' +
      "Do not edit by hand. `analysis` is Lichess's per-ply analysis (eval after each move, " +
      'White point of view), `players.*.analysis` its accuracy / ACPL summary.',
    id: gameId,
    url: `https://lichess.org/${gameId}`,
    fetchedAt: new Date().toISOString(),
    pgn,
    game: json,
  };
  const outPath = path.join(rootDir, 'tests/fixtures/review', `lichess-${gameId}.json`);
  fs.writeFileSync(outPath, `${JSON.stringify(out, null, 1)}\n`);
  const w = json.players?.white;
  const b = json.players?.black;
  console.log(
    `Wrote ${path.relative(rootDir, outPath)}: ${json.analysis.length} analysed plies; ` +
      `White ${w?.user?.name ?? '?'} (${w?.rating}) accuracy ${w?.analysis?.accuracy} ACPL ${w?.analysis?.acpl}; ` +
      `Black ${b?.user?.name ?? '?'} (${b?.rating}) accuracy ${b?.analysis?.accuracy} ACPL ${b?.analysis?.acpl}`,
  );
}

main().catch((err) => {
  console.error('Fetching the Lichess game failed:', err.message);
  process.exit(1);
});
