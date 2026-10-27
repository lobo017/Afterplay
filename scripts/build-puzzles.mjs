import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { Readable, Transform } from 'node:stream';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.resolve(__dirname, '..', 'data');
const outPath = path.join(dataDir, 'puzzles.json');

const PUZZLE_URL = 'https://database.lichess.org/lichess_db_puzzle.csv.zst';
const TARGET_TOTAL = 20000;
const MIN_ROWS_TO_SCAN = 350000;
const fullScan = process.argv.includes('--full');

const RATING_BUCKETS = [
  { name: 'u1000', min: 0, max: 999 },
  { name: '1000-1399', min: 1000, max: 1399 },
  { name: '1400-1799', min: 1400, max: 1799 },
  { name: '1800-2199', min: 1800, max: 2199 },
  { name: '2200+', min: 2200, max: 9999 },
];

const PRIORITY_THEMES = [
  'fork',
  'pin',
  'skewer',
  'discoveredAttack',
  'hangingPiece',
  'backRankMate',
  'mateIn1',
  'mateIn2',
  'mateIn3',
  'trappedPiece',
  'promotion',
  'sacrifice',
  'deflection',
  'attraction',
  'intermezzo',
  'zugzwang',
  'quietMove',
  'defensiveMove',
  'endgame',
  'middlegame',
];

/**
 * Deterministic PRNG (Mulberry32) so sampling is reproducible.
 * @param {number} seed
 */
function createRng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Determine rating bucket name for a puzzle rating.
 * @param {number} rating
 */
function getRatingBucket(rating) {
  for (const b of RATING_BUCKETS) {
    if (rating >= b.min && rating <= b.max) return b.name;
  }
  return '1400-1799';
}

/**
 * Determine primary stratum theme from a puzzle's theme list.
 * @param {string[]} themes
 */
function getPrimaryTheme(themes) {
  for (const pt of PRIORITY_THEMES) {
    if (themes.includes(pt)) return pt;
  }
  return themes[0] ?? 'general';
}

async function main() {
  await fs.mkdir(dataDir, { recursive: true });
  const rng = createRng(0x57495a43); // "WIZC"

  // 5 rating buckets x 20 priority themes = 100 strata -> ~200 puzzles per stratum = 20,000
  const stratumCapacity = Math.ceil(TARGET_TOTAL / (RATING_BUCKETS.length * PRIORITY_THEMES.length));
  /** @type {Map<string, { items: Array<{ id: string; fen: string; moves: string[]; rating: number; themes: string[] }>; seen: number }>} */
  const strata = new Map();
  /** @type {Array<{ id: string; fen: string; moves: string[]; rating: number; themes: string[] }>} */
  const overflowPool = [];
  let overflowSeen = 0;

  for (const rb of RATING_BUCKETS) {
    for (const th of PRIORITY_THEMES) {
      strata.set(`${rb.name}:${th}`, { items: [], seen: 0 });
    }
  }

  const controller = new AbortController();
  console.log(`Streaming ${PUZZLE_URL} ...`);
  const response = await fetch(PUZZLE_URL, { signal: controller.signal });
  if (!response.ok || !response.body) {
    throw new Error(`Failed to fetch ${PUZZLE_URL}: HTTP ${response.status}`);
  }

  let remainingInFrame = 0;
  let headerBuf = Buffer.alloc(0);

  // Lichess compresses puzzles with pzstd, which prefixes each Zstd frame with a 12-byte
  // skippable frame: [0x184d2a50, 4, compressedFrameByteLength].
  const stripPzstdHeaders = new Transform({
    transform(chunk, _encoding, callback) {
      let buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const outChunks = [];

      while (buf.length > 0) {
        if (remainingInFrame > 0) {
          const take = Math.min(buf.length, remainingInFrame);
          outChunks.push(buf.subarray(0, take));
          buf = buf.subarray(take);
          remainingInFrame -= take;
        } else {
          const needed = 12 - headerBuf.length;
          const take = Math.min(buf.length, needed);
          headerBuf = Buffer.concat([headerBuf, buf.subarray(0, take)]);
          buf = buf.subarray(take);

          if (headerBuf.length === 12) {
            const magic = headerBuf.readUInt32LE(0);
            const payloadLen = headerBuf.readUInt32LE(4);
            if ((magic & 0xfffffff0) === 0x184d2a50 && payloadLen === 4) {
              remainingInFrame = headerBuf.readUInt32LE(8);
              headerBuf = Buffer.alloc(0);
            } else {
              // Standard single-frame zstd without pzstd header
              outChunks.push(headerBuf);
              headerBuf = Buffer.alloc(0);
              remainingInFrame = Number.MAX_SAFE_INTEGER;
            }
          }
        }
      }

      if (outChunks.length > 0) {
        callback(null, Buffer.concat(outChunks));
      } else {
        callback();
      }
    },
  });

  const nodeStream = Readable.fromWeb(response.body);
  const zstd = zlib.createZstdDecompress();

  nodeStream.on('error', (err) => {
    if (!controller.signal.aborted) {
      zstd.destroy(err);
    }
  });
  stripPzstdHeaders.on('error', () => {});
  zstd.on('error', (err) => {
    if (!controller.signal.aborted) {
      throw err;
    }
  });

  const rl = readline.createInterface({
    input: nodeStream.pipe(stripPzstdHeaders).pipe(zstd),
    crlfDelay: Infinity,
  });

  let scannedRows = 0;
  let collectedCount = 0;

  try {
    for await (const line of rl) {
      if (!line || line.startsWith('PuzzleId,')) continue;

      // CSV format: PuzzleId,FEN,Moves,Rating,RatingDeviation,Popularity,NbPlays,Themes,GameUrl,OpeningTags
      const parts = line.split(',');
      if (parts.length < 8) continue;

      const [id, fen, movesStr, ratingStr, rdStr, popStr, , themesStr] = parts;
      if (!id || !fen || !movesStr || !ratingStr || !themesStr) continue;

      const rating = Number(ratingStr);
      const rd = Number(rdStr);
      const popularity = Number(popStr);
      if (!Number.isFinite(rating) || rd > 110 || popularity < 60) continue;

      const moves = movesStr.trim().split(' ');
      // Gotcha: moves[0] is opponent's move; solution starts at moves[1]
      if (moves.length < 2) continue;

      const themes = themesStr.trim().split(' ').filter(Boolean);
      if (themes.length === 0) continue;

      scannedRows++;
      const bucket = getRatingBucket(rating);
      const pTheme = getPrimaryTheme(themes);
      const key = `${bucket}:${pTheme}`;
      const puzzle = { id, fen, moves, rating, themes };

      const stratum = strata.get(key);
      if (stratum) {
        stratum.seen++;
        if (stratum.items.length < stratumCapacity) {
          stratum.items.push(puzzle);
          collectedCount++;
        } else {
          const j = Math.floor(rng() * stratum.seen);
          if (j < stratumCapacity) {
            const evicted = stratum.items[j];
            stratum.items[j] = puzzle;
            if (evicted && overflowPool.length < 2500) {
              overflowPool.push(evicted);
            }
          } else if (overflowPool.length < 2500) {
            overflowPool.push(puzzle);
          }
        }
      } else {
        overflowSeen++;
        if (overflowPool.length < 2500) {
          overflowPool.push(puzzle);
        } else {
          const j = Math.floor(rng() * overflowSeen);
          if (j < overflowPool.length) {
            overflowPool[j] = puzzle;
          }
        }
      }

      if (scannedRows % 50000 === 0) {
        console.log(
          `Scanned ${scannedRows.toLocaleString()} valid puzzles (stratum pool: ${collectedCount.toLocaleString()})...`,
        );
      }

      if (!fullScan && scannedRows >= MIN_ROWS_TO_SCAN && collectedCount >= TARGET_TOTAL * 0.92) {
        controller.abort();
        break;
      }
    }
  } catch (err) {
    if (err?.name !== 'AbortError' && !controller.signal.aborted) {
      throw err;
    }
  }

  /** @type {Array<{ id: string; fen: string; moves: string[]; rating: number; themes: string[] }>} */
  const selected = [];
  const usedIds = new Set();

  for (const stratum of strata.values()) {
    for (const item of stratum.items) {
      if (selected.length < TARGET_TOTAL && !usedIds.has(item.id)) {
        selected.push(item);
        usedIds.add(item.id);
      }
    }
  }

  for (const item of overflowPool) {
    if (selected.length >= TARGET_TOTAL) break;
    if (!usedIds.has(item.id)) {
      selected.push(item);
      usedIds.add(item.id);
    }
  }

  // Sort deterministically by rating then ID for clean indexing
  selected.sort((a, b) => a.rating - b.rating || a.id.localeCompare(b.id));

  await fs.writeFile(outPath, JSON.stringify(selected), 'utf8');
  console.log(
    `Wrote ${selected.length.toLocaleString()} stratified puzzles (scanned ${scannedRows.toLocaleString()} rows) to ${outPath}`,
  );
}

main().catch((err) => {
  console.error('Error building puzzles dataset:', err);
  process.exit(1);
});
