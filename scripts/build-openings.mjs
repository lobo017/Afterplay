import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Chess } from 'chess.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.resolve(__dirname, '..', 'data');
const outPath = path.join(dataDir, 'openings.json');

const FILES = ['a.tsv', 'b.tsv', 'c.tsv', 'd.tsv', 'e.tsv'];
const BASE_URL = 'https://raw.githubusercontent.com/lichess-org/chess-openings/master';

/**
 * Normalize a full 6-field FEN into a 4-field EPD key (board, turn, castling, ep).
 * @param {string} fen
 */
function fenToEpd(fen) {
  return fen.split(' ').slice(0, 4).join(' ');
}

async function main() {
  await fs.mkdir(dataDir, { recursive: true });
  /** @type {Record<string, { eco: string; name: string; pgn: string; moves: string[] }>} */
  const openingsByEpd = {};
  let totalRows = 0;

  for (const file of FILES) {
    const url = `${BASE_URL}/${file}`;
    console.log(`Fetching ${url} ...`);
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to fetch ${url}: HTTP ${response.status}`);
    }
    const text = await response.text();
    const lines = text.split(/\r?\n/);

    // Skip header line: eco\tname\tpgn
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i]?.trim();
      if (!line) continue;
      const parts = line.split('\t');
      if (parts.length < 3) continue;
      const [eco, name, pgn] = parts;
      if (!eco || !name || !pgn) continue;

      const chess = new Chess();
      chess.loadPgn(pgn);
      const moves = chess.history();
      if (moves.length === 0) continue;

      const epd = fenToEpd(chess.fen());
      openingsByEpd[epd] = {
        eco,
        name,
        pgn,
        moves,
      };
      totalRows++;
    }
  }

  const uniqueCount = Object.keys(openingsByEpd).length;
  await fs.writeFile(outPath, JSON.stringify(openingsByEpd), 'utf8');
  console.log(`Wrote ${uniqueCount} unique opening positions (from ${totalRows} rows) to ${outPath}`);
}

main().catch((err) => {
  console.error('Error building openings dataset:', err);
  process.exit(1);
});
