// Invented, deterministic backups for the restore checks (scripts/perf-tasks.mjs, and by hand on a device). Every name,
// id and number here is made up; the game text is Morphy's well-known public game with clock comments. Nothing is read
// from a real backup, and the same call always gives the same bytes.
//
// buildInventedBackups() returns three payloads that relate like two devices of one person:
//   file   the backup that gets restored (about 15 MB as the app writes it, indented by 2)
//   local  what the device already holds before the restore: the same library, plus records only it has, and progress
//          that is newer here than in the file (so the restore must keep it)
//   expect what a correct restore must report for that pair (counts per rule)

const T0 = Date.UTC(2026, 0, 1);
const DAY = 24 * 60 * 60 * 1000;

/** A small seeded random number generator (mulberry32): the same seed, the same sequence. */
function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const MORPHY = [
  'e4 e5',
  'Nf3 d6',
  'd4 Bg4',
  'dxe5 Bxf3',
  'Qxf3 dxe5',
  'Bc4 Nf6',
  'Qb3 Qe7',
  'Nc3 c6',
  'Bg5 b5',
  'Nxb5 cxb5',
  'Bxb5+ Nbd7',
  'O-O-O Rd8',
  'Rxd7 Rxd7',
  'Rd1 Qe6',
  'Bxd7+ Nxd7',
  'Qb8+ Nxb8',
  'Rd8#',
];

const pad2 = (n) => String(n).padStart(2, '0');
const clock = (s) => `${Math.floor(s / 60)}:${pad2(s % 60)}`;

function pgnOf(i, rand) {
  const white = `Invented${i % 97}`;
  const black = `Rival${i % 211}`;
  const date = `2025.${pad2(1 + (i % 12))}.${pad2(1 + (i % 28))}`;
  let seconds = 180;
  const moves = MORPHY.map((pair, n) => {
    const [w, b] = pair.split(' ');
    seconds = Math.max(1, seconds - 1 - Math.floor(rand() * 9));
    const cw = `{ [%clk 0:${clock(seconds)}] }`;
    seconds = Math.max(1, seconds - 1 - Math.floor(rand() * 9));
    return b === undefined
      ? `${n + 1}. ${w} ${cw}`
      : `${n + 1}. ${w} ${cw} ${n + 1}... ${b} { [%clk 0:${clock(seconds)}] }`;
  }).join(' ');
  return `[Event "Invented ${i}"]\n[Site "https://example.invalid/g/${i}"]\n[Date "${date}"]\n[White "${white}"]\n[Black "${black}"]\n[Result "1-0"]\n[WhiteElo "${1400 + (i % 700)}"]\n[BlackElo "${1400 + ((i * 7) % 700)}"]\n[TimeControl "180+0"]\n[Termination "Normal"]\n\n${moves} 1-0\n`;
}

const side = (rand, moves) => {
  const tuple = (n) => [
    n,
    Math.round(rand() * 10000) / 100,
    Math.floor(rand() * 3),
    Math.floor(rand() * 3),
    Math.floor(rand() * 2),
  ];
  return {
    moves,
    acpl: Math.round(rand() * 800) / 10,
    inaccuracy: Math.floor(rand() * 4),
    mistake: Math.floor(rand() * 3),
    blunder: Math.floor(rand() * 2),
    miss: Math.floor(rand() * 2),
    brilliant: Math.floor(rand() * 2),
    great: Math.floor(rand() * 3),
    low: Math.round(rand() * 6000) / 100,
    drop: Math.round(rand() * 5000) / 100,
    dropPly: 1 + Math.floor(rand() * 30),
    phases: [tuple(8), tuple(16), tuple(10)],
  };
};

function gameOf(i, rand) {
  const id = `lichess:inv${String(i).padStart(6, '0')}`;
  const createdAt = T0 + i * 60_000;
  const played = T0 - (i + 1) * DAY;
  return {
    id,
    white: `Invented${i % 97}`,
    black: `Rival${i % 211}`,
    playerColor: i % 2 ? 'b' : 'w',
    result: '1-0',
    date: `2025.${pad2(1 + (i % 12))}.${pad2(1 + (i % 28))}`,
    openingEco: 'C41',
    openingName: 'Philidor Defense: Philidor Gambit',
    accuracy: Math.round(rand() * 10000) / 100,
    pgn: pgnOf(i, rand),
    tags: [],
    schemaVersion: 4,
    createdAt,
    updatedAt: createdAt,
    source: 'lichess',
    url: `https://example.invalid/g/${i}`,
    whiteElo: 1400 + (i % 700),
    blackElo: 1400 + ((i * 7) % 700),
    timeControl: '180+0',
    playedAt: played,
    analysis: {
      preset: null,
      savedAt: T0 + 5 * DAY,
      whiteAccuracy: Math.round(rand() * 10000) / 100,
      blackAccuracy: Math.round(rand() * 10000) / 100,
      depth: 12,
      summaryOnly: true,
      plies: 33,
      sides: { w: side(rand, 17), b: side(rand, 16) },
    },
  };
}

const puzzleOf = (i, attempts, lastAttemptAt) => ({
  id: `personal:inv${String(i).padStart(5, '0')}:${10 + (i % 20)}`,
  source: 'personal',
  fen: 'r1bq1b1r/ppp1k1pp/2n2n2/3pp3/2B5/2N2Q2/PPPP1PPP/R1B1K2R w KQ - 0 8',
  moves: ['f3f6', 'g7f6'],
  rating: 0,
  themes: [],
  origin: 'history',
  dueDate: T0 + 10 * DAY,
  attempts,
  solvedCount: Math.min(attempts, 1),
  updatedAt: T0 + 6 * DAY,
  ply: 10 + (i % 20),
  playedSan: 'Qf3',
  classification: 'Mistake',
  explanation: null,
  bestLineSan: ['Qxf6', 'gxf6', 'Bxf7'],
  gameLabel: `Invented${i % 97} vs Rival${i % 211}`,
  ...(attempts > 0 ? { lastAttemptAt } : {}),
});

const cardOf = (puzzle, reps, lastReviewDate) => ({
  id: `puzzle:${puzzle.id}`,
  deck: 'puzzle',
  targetId: puzzle.id,
  state: 'review',
  stability: 2.5,
  difficulty: 5,
  reps,
  lapses: 0,
  dueDate: T0 + 10 * DAY,
  updatedAt: lastReviewDate ?? T0 + 6 * DAY,
  ...(reps > 0 ? { lastReviewDate } : {}),
});

const reviewOf = (gameId, updatedAt) => ({
  id: gameId,
  updatedAt,
  review: {
    version: 1,
    preset: 'quick',
    savedAt: updatedAt,
    ucis: ['e2e4', 'e7e5'],
    review: { complete: true, preset: 'quick', moves: [], keyMoments: [] },
    positions: [null, null, null],
    stats: { positions: 3, millis: 1000 },
  },
});

/**
 * @param {{ games?: number, puzzles?: number, reviews?: number, olderHere?: number, newerHere?: number, onlyHere?: number, onlyInFile?: number }} [options]
 */
export function buildInventedBackups(options = {}) {
  const {
    games = 4600,
    puzzles: puzzleCount = 600,
    reviews: reviewCount = 24,
    olderHere = 120, // puzzles the file has newer progress on (they get updated)
    newerHere = 60, // puzzles this device has newer progress on (they are kept)
    onlyHere = 40, // games only this device has
    onlyInFile = 40, // games only the file has
  } = options;
  const rand = seeded(20261122);

  const library = Array.from({ length: games }, (_, i) => gameOf(i, rand));
  const filePuzzles = [];
  const localPuzzles = [];
  const fileCards = [];
  const localCards = [];
  for (let i = 0; i < puzzleCount; i++) {
    const base = puzzleOf(i, 1, T0 + 7 * DAY);
    let fileRow = base;
    let localRow = base;
    if (i < newerHere) {
      // this device solved it again after the backup was made
      localRow = { ...base, attempts: 3, solvedCount: 2, lastAttemptAt: T0 + 9 * DAY };
    } else if (i < newerHere + olderHere) {
      // the file holds the later attempt
      fileRow = { ...base, attempts: 4, solvedCount: 3, lastAttemptAt: T0 + 9 * DAY };
    }
    filePuzzles.push(fileRow);
    localPuzzles.push(localRow);
    fileCards.push(cardOf(fileRow, fileRow.attempts, fileRow.lastAttemptAt));
    localCards.push(cardOf(localRow, localRow.attempts, localRow.lastAttemptAt));
  }

  const fileReviews = [];
  const localReviews = [];
  for (let i = 0; i < reviewCount; i++) {
    const gameId = library[i].id;
    fileReviews.push(reviewOf(gameId, T0 + 5 * DAY));
    // half of them were reviewed again here, later
    localReviews.push(reviewOf(gameId, i % 2 === 0 ? T0 + 8 * DAY : T0 + 5 * DAY));
  }

  const extra = (prefix, n, from) =>
    Array.from({ length: n }, (_, k) => gameOf(from + k, rand)).map((g) => ({
      ...g,
      id: `${prefix}${g.id.slice('lichess:inv'.length)}`,
    }));
  const filePlusGames = [...library, ...extra('lichess:fil', onlyInFile, games)];
  const localPlusGames = [...library, ...extra('lichess:loc', onlyHere, games + onlyInFile)];

  const settings = (updatedAt) => [
    {
      key: 'puzzles.rating',
      updatedAt,
      value: {
        rating: 1500,
        rd: 100,
        volatility: 0.06,
        games: 3,
        history: [1, 2, 3].map((n) => ({ at: updatedAt - n, rating: 1500, puzzleId: 'inv', solved: true })),
      },
    },
  ];

  const payload = (parts) => ({
    format: 'wizards-chess-backup',
    schemaVersion: 4,
    exportedAt: T0 + 7 * DAY,
    repertoires: [],
    endgameProgress: [],
    ...parts,
  });

  return {
    file: payload({
      games: filePlusGames,
      puzzles: filePuzzles,
      srsCards: fileCards,
      reviews: fileReviews,
      settings: settings(T0 + 7 * DAY),
    }),
    local: payload({
      games: localPlusGames,
      puzzles: localPuzzles,
      srsCards: localCards,
      reviews: localReviews,
      settings: settings(T0 + 7 * DAY),
    }),
    expect: {
      gamesAdded: onlyInFile,
      puzzlesKeptNewer: newerHere,
      puzzlesUpdated: olderHere,
      reviewsKeptNewer: Math.ceil(reviewCount / 2),
      // the puzzle row the check reads back: this device's newer attempt
      keptPuzzleId: filePuzzles[0].id,
      keptPuzzleAttempts: 3,
    },
  };
}

/** The file as the app writes it. */
export const asBackupText = (payload) => JSON.stringify(payload, null, 2);
