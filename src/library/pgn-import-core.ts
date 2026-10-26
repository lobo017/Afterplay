import { checkPgnText, splitPgnGames } from '../capture/pgn-games';
import { buildGameRecord, type NewGameRecord } from './game-record';

/** A bulk import may be much bigger than one pasted game (a month of games from a site export). */
export const MAX_BULK_PGN_LENGTH = 96 * 1024 * 1024;
/** Games read per step: one batch is saved, and progress reported, after each. */
export const IMPORT_GROUP_SIZE = 25;

export interface ImportBatch {
  /** Games read in this step that are new. */
  records: NewGameRecord[];
  /** Keys of games read in this step that were already stored (or came twice). */
  duplicates: string[];
  /** One line per game that could not be read. */
  errors: string[];
  /** Games read so far, of `totalGames`. */
  gamesRead: number;
  totalGames: number;
}

/** "Game 2: no moves." with the game's number in the whole text rather than in its group. */
function renumber(error: string, offset: number, groupSize: number, wholeTextGames: number): string {
  if (wholeTextGames <= 1) return error;
  const m = /^Game (\d+): (.*)$/s.exec(error);
  if (m) return `Game ${offset + Number(m[1])}: ${m[2]}`;
  return groupSize === 1 ? `Game ${offset + 1}: ${error}` : error;
}

/**
 * Reads a PGN text (one game or thousands) a group of games at a time: each is checked move by
 * move and made into a library record, off whatever thread this runs on. Games whose key is in
 * `known`, or that appear twice, are reported as duplicates instead of records. Pure, so the
 * worker and the tests run the same code.
 */
export function* readPgnBatches(text: string, known: ReadonlySet<string>): Generator<ImportBatch> {
  const trimmed = text.trim();
  if (trimmed === '') {
    yield { records: [], duplicates: [], errors: ['The text is empty.'], gamesRead: 0, totalGames: 0 };
    return;
  }
  if (trimmed.length > MAX_BULK_PGN_LENGTH) {
    yield { records: [], duplicates: [], errors: ['The text is too large (over 96 MB).'], gamesRead: 0, totalGames: 0 };
    return;
  }
  const chunks = splitPgnGames(trimmed);
  const seen = new Set<string>();
  for (let at = 0; at < chunks.length; at += IMPORT_GROUP_SIZE) {
    const group = chunks.slice(at, at + IMPORT_GROUP_SIZE);
    const { games, errors } = checkPgnText(group.join('\n\n'));
    const records: NewGameRecord[] = [];
    const duplicates: string[] = [];
    for (const game of games) {
      if (known.has(game.key) || seen.has(game.key)) {
        duplicates.push(game.key);
        continue;
      }
      seen.add(game.key);
      records.push(buildGameRecord(game));
    }
    yield {
      records,
      duplicates,
      errors: errors.map((e) => renumber(e, at, group.length, chunks.length)),
      gamesRead: Math.min(chunks.length, at + group.length),
      totalGames: chunks.length,
    };
  }
  if (chunks.length === 0) {
    yield { records: [], duplicates: [], errors: ['No game found in the text.'], gamesRead: 0, totalGames: 0 };
  }
}
