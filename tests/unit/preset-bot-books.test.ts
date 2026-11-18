import { describe, expect, it, vi } from 'vitest';
import { RulesAdapter } from '../../src/core/rules';
import { ChessBot, computeBotThinkTimeMs, type BotMoveDecision } from '../../src/engine/bot';
import {
  buildBook,
  decisionEvaluation,
  personalBookDecision,
  serializeBook,
  type Book,
} from '../../src/engine/bot-profile';
import type { EngineLine } from '../../src/engine/cache';
import { PRESET_LIMITS, parsePreset, type CustomBot } from '../../src/preset/preset';
import {
  PROFILE_STORAGE_KEY,
  ProfileStore,
  customBotBooks,
  customBotFor,
  personalBooksFor,
  sanitizeProfile,
} from '../../src/preset/profile';
import { record, seeded } from './helpers/book-games';

// Invented games and invented names only: nothing here comes from a real player.

const bookOf = (games: string[][], side: 'own' | 'opponent' = 'own'): Book =>
  buildBook(
    games.map((g) => record(g)),
    { side },
  ).book;

/** White's book: 1. e4, then 2. Nf3 after 1...e5 */
const WHITE_BOOK = serializeBook(bookOf([['e4', 'e5', 'Nf3']]));
/** Black's book: 1...h5 after 1. e4, then 2...a5 after 2. d4 (moves an engine would hardly choose) */
const BLACK_BOOK = serializeBook(bookOf([['e4', 'h5', 'd4', 'a5']], 'opponent'));

/** A book that reads as valid (made-up positions, never reached in a game) of about `chars` characters. */
function syntheticBook(chars: number): string {
  const entries: Book['entries'] = {};
  let length = 40;
  for (let i = 0; length < chars - 60; i++) {
    const key = `${i}/8/8/8/8/8/8/8 w - -`;
    entries[key] = [['e2e4', 1]];
    length += key.length + 16;
  }
  let text = serializeBook({ v: 1, pliesCap: 36, entries });
  while (text.length > chars) {
    delete entries[Object.keys(entries)[0]!];
    text = serializeBook({ v: 1, pliesCap: 36, entries });
  }
  return text;
}

const fenAfter = (...sans: string[]): string => {
  const adapter = new RulesAdapter();
  for (const san of sans) adapter.move(san);
  return adapter.fen();
};

function memoryStorage(limitChars = Infinity) {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      if (value.length > limitChars) throw new DOMException('quota', 'QuotaExceededError');
      data.set(key, value);
    },
    removeItem: (key: string) => void data.delete(key),
  };
}

describe('preset bots with opening books', () => {
  it('keeps valid books in order on the bot', () => {
    const { preset, problems } = parsePreset({
      version: 1,
      bots: [{ name: 'Book Bot', rating: 1200, style: 'solid', books: [BLACK_BOOK, WHITE_BOOK] }],
    });
    expect(problems).toEqual([]);
    expect(preset!.bots).toEqual([{ name: 'Book Bot', rating: 1200, style: 'solid', books: [BLACK_BOOK, WHITE_BOOK] }]);
  });

  it('drops a book that is not a book; the bot stays a usual custom bot, and the problems quote nothing', () => {
    const notJson = '{"v":1,"pliesCap":36,"entries":{not json';
    const notABook = JSON.stringify({ v: 1, pliesCap: 36, entries: { 'secret-looking text': [['e2e4', 1]] } });
    const { preset, problems } = parsePreset({
      version: 1,
      bots: [
        { name: 'Bad Books', rating: 1000, style: 'solid', books: [notJson, notABook, 42] },
        { name: 'Half Good', rating: 1100, style: 'solid', books: [notJson, WHITE_BOOK] },
        { name: 'Not A List', rating: 1300, style: 'solid', books: WHITE_BOOK },
      ],
    });
    expect(preset!.bots).toEqual([
      { name: 'Bad Books', rating: 1000, style: 'solid' },
      { name: 'Half Good', rating: 1100, style: 'solid', books: [WHITE_BOOK] },
      { name: 'Not A List', rating: 1300, style: 'solid' },
    ]);
    expect(problems).toEqual([
      'bots[0].books[0]: not a valid opening book (ignored)',
      'bots[0].books[1]: not a valid opening book (ignored)',
      'bots[0].books[2]: must be text (ignored)',
      'bots[1].books[0]: not a valid opening book (ignored)',
      'bots[2].books: must be a list (ignored; the bot plays without a book)',
    ]);
    for (const p of problems) {
      expect(p).not.toContain('secret');
      expect(p).not.toContain('pliesCap');
    }
  });

  it('keeps at most three books per bot', () => {
    const { preset, problems } = parsePreset({
      version: 1,
      bots: [{ name: 'Many', rating: 1200, style: 'solid', books: [WHITE_BOOK, BLACK_BOOK, WHITE_BOOK, BLACK_BOOK] }],
    });
    expect(preset!.bots[0]!.books).toEqual([WHITE_BOOK, BLACK_BOOK, WHITE_BOOK]);
    expect(problems).toEqual([`bots[0].books[3]: more than ${PRESET_LIMITS.booksPerBot} books for one bot (ignored)`]);
  });

  it('drops a book over the size limit, and books over the total for all bots', () => {
    const tooLong = 'x'.repeat(PRESET_LIMITS.bookChars + 1);
    const big = 'y'.repeat(PRESET_LIMITS.bookChars);
    // A stored profile (books checked only for size here; they are parsed when the bot plays)
    const profile = sanitizeProfile({
      bots: [
        { name: 'A', rating: 1000, style: 'solid', books: [tooLong, big] },
        { name: 'B', rating: 1100, style: 'solid', books: [big] },
        { name: 'C', rating: 1200, style: 'solid', books: [big, WHITE_BOOK] },
      ],
    });
    expect(profile.bots.map((b) => b.books?.length ?? 0)).toEqual([1, 1, 1]);
    expect(profile.bots[2]!.books).toEqual([big]);
    expect(profile.bots.every((b) => b.books!.every((t) => t.length <= PRESET_LIMITS.bookChars))).toBe(true);

    // A preset: valid books just under the limit, four of which are over the total
    const valid = syntheticBook(PRESET_LIMITS.bookChars - 100);
    expect(valid.length).toBeLessThanOrEqual(PRESET_LIMITS.bookChars);
    expect(valid.length * 3).toBeLessThanOrEqual(PRESET_LIMITS.booksTotalChars);
    const { preset, problems } = parsePreset({
      version: 1,
      bots: [
        { name: 'A', rating: 1000, style: 'solid', books: [tooLong] },
        { name: 'B', rating: 1100, style: 'solid', books: [valid, valid] },
        { name: 'C', rating: 1200, style: 'solid', books: [valid, valid, WHITE_BOOK] },
      ],
    });
    expect(preset!.bots.map((b) => b.books?.length ?? 0)).toEqual([0, 2, 2]);
    expect(preset!.bots[2]!.books![1]).toBe(WHITE_BOOK);
    expect(problems).toEqual([
      `bots[0].books[0]: longer than ${PRESET_LIMITS.bookChars} characters (ignored)`,
      `bots[2].books[1]: the books of all bots together are over ${PRESET_LIMITS.booksTotalChars} characters (ignored)`,
    ]);
  });

  it('leaves out a later bot with the same rating and style, even with other books', () => {
    const { preset, problems } = parsePreset({
      version: 1,
      bots: [
        { name: 'Peak', rating: 1500, style: 'solid', books: [WHITE_BOOK] },
        { name: 'Level', rating: 1500, style: 'solid', books: [BLACK_BOOK] },
        { name: 'Student', rating: 900, style: 'solid', books: [BLACK_BOOK] },
      ],
    });
    expect(preset!.bots.map((b) => b.name)).toEqual(['Peak', 'Student']);
    expect(problems).toEqual(['bots[1]: the same rating and style as an earlier bot (ignored)']);
    const profile = sanitizeProfile({ bots: preset!.bots });
    expect(customBotFor(profile, 1500, 'solid')!.name).toBe('Peak');
    expect(personalBooksFor(profile, 1500, 'solid')).toEqual([JSON.parse(WHITE_BOOK)]);
    expect(personalBooksFor(profile, 900, 'solid')).toEqual([JSON.parse(BLACK_BOOK)]);
    // A rating no custom bot has, or a bot without books: no books
    expect(personalBooksFor(profile, 1400, 'solid')).toEqual([]);
    expect(
      personalBooksFor(sanitizeProfile({ bots: [{ name: 'Plain', rating: 1500, style: 'solid' }] }), 1500, 'solid'),
    ).toEqual([]);
  });

  it('finds a bot and its books by rating, so a style change keeps them; the matching style wins a shared rating', () => {
    const profile = sanitizeProfile({
      bots: [
        { name: 'Peak', rating: 1500, style: 'solid', books: [WHITE_BOOK] },
        { name: 'Student', rating: 900, style: 'solid', books: [BLACK_BOOK] },
        { name: 'Twin sharp', rating: 1200, style: 'aggressive', books: [WHITE_BOOK] },
        { name: 'Twin solid', rating: 1200, style: 'solid', books: [BLACK_BOOK] },
      ],
    });
    // Was: personalBooksFor(profile, 1500, 'aggressive') gave [] (found by rating and style); now the same bot, same books
    expect(personalBooksFor(profile, 1500, 'aggressive')).toEqual([JSON.parse(WHITE_BOOK)]);
    expect(personalBooksFor(profile, 900, 'gambiteer')).toEqual([JSON.parse(BLACK_BOOK)]);
    expect(personalBooksFor(profile, 1200, 'aggressive')).toEqual([JSON.parse(WHITE_BOOK)]);
    expect(personalBooksFor(profile, 1200, 'solid')).toEqual([JSON.parse(BLACK_BOOK)]);
    // No style matches: the first bot of that rating in the list
    expect(personalBooksFor(profile, 1200, 'gambiteer')).toEqual([JSON.parse(WHITE_BOOK)]);
  });

  it('parses books at first use, keeps them for the session, and skips text that is not a book', () => {
    const bot: CustomBot = {
      name: 'Lazy',
      rating: 1200,
      style: 'solid',
      books: [BLACK_BOOK, 'not a book', WHITE_BOOK],
    };
    const first = customBotBooks(bot);
    expect(first).toEqual([JSON.parse(BLACK_BOOK), JSON.parse(WHITE_BOOK)]);
    const again = customBotBooks({ ...bot });
    expect(again[0]).toBe(first[0]);
    expect(again[1]).toBe(first[1]);
    expect(customBotBooks({ name: 'None', rating: 1200, style: 'solid' })).toEqual([]);
  });

  it('keeps the books in the stored profile across a reload', () => {
    const storage = memoryStorage();
    const store = new ProfileStore(storage);
    store.replace({
      displayName: 'Ada',
      bots: [{ name: 'Book Bot', rating: 1200, style: 'solid', books: [WHITE_BOOK] }],
    });
    expect(new ProfileStore(storage).get().bots).toEqual([
      { name: 'Book Bot', rating: 1200, style: 'solid', books: [WHITE_BOOK] },
    ]);
  });

  it('stores the profile without its books when the books do not fit, so the name and bots survive a reload', () => {
    const storage = memoryStorage(2_000);
    const big = 'z'.repeat(5_000);
    const store = new ProfileStore(storage);
    store.replace({ displayName: 'Ada', bots: [{ name: 'Book Bot', rating: 1200, style: 'solid', books: [big] }] });
    // This session keeps the books
    expect(store.get().bots[0]!.books).toEqual([big]);
    const reloaded = new ProfileStore(storage).get();
    expect(reloaded.displayName).toBe('Ada');
    expect(reloaded.bots).toEqual([{ name: 'Book Bot', rating: 1200, style: 'solid' }]);
    expect(storage.data.get(PROFILE_STORAGE_KEY)).not.toContain('zzz');
  });
});

function line(multipv: number, evalCp: number, pv: string[]): EngineLine {
  const score = { type: 'cp', value: evalCp } as const;
  return { multipv, depth: 12, seldepth: 16, score, scoreWhite: score, evalCp, nodes: 1e4, nps: 4e5, timeMs: 25, pv };
}

describe('a book move in the Play flow', () => {
  const books = [JSON.parse(BLACK_BOOK) as Book];
  const params = new ChessBot({} as never, { rating: 1200, style: 'solid' }).getParams();

  it('shows no evaluation for a book move; an engine move gives the same numbers as before', () => {
    const book = personalBookDecision(fenAfter('e4'), { books }, () => 0.5, params)!;
    expect(book.fromBook).toBe(true);
    expect(decisionEvaluation(book)).toBeNull();

    const engineMove = (color: 'w' | 'b', evalCp: number): BotMoveDecision =>
      ({
        ...book,
        fromBook: undefined,
        executedMove: { ...book.executedMove, color },
        selectedLine: line(1, evalCp, ['h7h5']),
      }) as BotMoveDecision;
    expect(decisionEvaluation(engineMove('b', 40))).toEqual({ scoreWhite: { type: 'cp', value: 40 }, whiteCp: -40 });
    expect(decisionEvaluation(engineMove('w', 40))).toEqual({ scoreWhite: { type: 'cp', value: 40 }, whiteCp: 40 });
  });

  it('a book move gets a normal think time: the same as an engine move of that move with one line', () => {
    const fen = fenAfter('e4');
    const book = personalBookDecision(fen, { books }, () => 0.5, params)!;
    const asEngine = { ...book, fromBook: undefined, selectedLine: line(1, 0, [book.uci]) } as BotMoveDecision;
    const options = { fen, ply: 1, minDelayMs: 500, maxDelayMs: 3000, unlimitedClock: true, lastOpponentMove: null };
    const forBook = computeBotThinkTimeMs({ ...options, decision: book, rng: seeded(1) });
    expect(forBook).toBe(computeBotThinkTimeMs({ ...options, decision: asEngine, rng: seeded(1) }));
    expect(forBook).toBeGreaterThanOrEqual(500);
    expect(forBook).toBeLessThanOrEqual(3000);
    // A fixed think time stays fixed
    expect(computeBotThinkTimeMs({ ...options, minDelayMs: 400, maxDelayMs: 400, decision: book })).toBe(400);
    // A timed game: within the clock's budget, never instant
    const timed = computeBotThinkTimeMs({ ...options, unlimitedClock: false, botRemainingMs: 600_000, decision: book });
    expect(timed).toBeGreaterThan(0);
  });

  it("a preset bot's books reach the bot: book moves first, then the engine as the usual bot", async () => {
    const { preset } = parsePreset({
      version: 1,
      bots: [{ name: 'Book Bot', rating: 1200, style: 'solid', books: [BLACK_BOOK] }],
    });
    const profile = sanitizeProfile({ bots: preset!.bots });
    const analyze = vi.fn(async (request: { fen: string }) => ({
      fen: request.fen,
      normalizedFen: request.fen,
      depth: 10,
      multipv: 1,
      bestMove: 'g8f6',
      ponder: null,
      lines: [line(1, 20, ['g8f6'])],
      nodes: 1000,
      nps: 1e5,
      timeMs: 10,
      cached: false,
    }));
    const bot = new ChessBot({ analyze } as never, { rating: 1200, style: 'solid', rng: seeded(7) });
    const personal = { books: personalBooksFor(profile, 1200, 'solid') };

    const first = await bot.chooseMove(fenAfter('e4'), { personal });
    expect([first.san, first.fromBook]).toEqual(['h5', true]);
    const second = await bot.chooseMove(fenAfter('e4', 'h5', 'd4'), { personal });
    expect([second.san, second.fromBook]).toEqual(['a5', true]);
    expect(analyze).not.toHaveBeenCalled();

    const third = await bot.chooseMove(fenAfter('e4', 'h5', 'd4', 'a5', 'Nf3'), { personal });
    expect(analyze).toHaveBeenCalledTimes(1);
    // (the usual bot's move: the engine's line or one of its human mistakes, which this test does not pin)
    expect(third.fromBook).toBeUndefined();
    expect(decisionEvaluation(third)).not.toBeNull();
    // Without books the same bot asks the engine at once, in a position its book knows
    const plain = await bot.chooseMove(fenAfter('e4'));
    expect(plain.fromBook).toBeUndefined();
    expect(analyze).toHaveBeenCalledTimes(2);
  });
});
