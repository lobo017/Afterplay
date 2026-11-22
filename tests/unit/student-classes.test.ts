import { describe, expect, it } from 'vitest';
import { RulesAdapter } from '../../src/core/rules';
import { buildBook, lookupBook, serializeBook, type Book } from '../../src/engine/bot-profile';
import { TIME_CONTROL_PRESETS, botClassOfTimeControl, type TimeControlPresetId } from '../../src/ui/clock';
import { parseBots, parsePreset, parseBotsRevision, type CustomBot } from '../../src/preset/preset';
import {
  PROFILE_STORAGE_KEY,
  ProfileStore,
  awaitBotBooks,
  botsByRating,
  clearParsedBooks,
  namedBotForRating,
  resolveBotForClass,
  sanitizeProfile,
  warmBotBooks,
} from '../../src/preset/profile';
import { record } from './helpers/book-games';

// Invented bot names, ratings and books only: nothing here comes from a real player.

const bookOf = (games: string[][]): Book =>
  buildBook(
    games.map((g) => record(g)),
    { side: 'own' },
  ).book;

/** Three books that answer the first move differently. */
const POOLED = serializeBook(bookOf([['e4', 'e5', 'Nf3']]));
const BULLET = serializeBook(bookOf([['d4', 'd5', 'c4']]));
const BLITZ = serializeBook(bookOf([['c4', 'e5', 'Nc3']]));
const RAPID = serializeBook(bookOf([['Nf3', 'd5', 'g3']]));
const TABLE = { pooled: POOLED, 'pupil-bullet': BULLET, 'pupil-blitz': BLITZ, 'pupil-rapid': RAPID };

const START = new RulesAdapter().fen();
/** The move the bot's books give from the start position (null: none of them has it). */
const firstMove = (books: Book[]): string | null => lookupBook(books, START, () => 0.5);

const PUPIL = {
  name: 'Test Pupil',
  rating: 1500,
  style: 'solid',
  bookRefs: ['pupil-rapid', 'pooled'],
  classes: {
    bullet: { rating: 1350, bookRefs: ['pupil-bullet', 'pooled'] },
    blitz: { rating: 1425, bookRefs: ['pupil-blitz', 'pooled'] },
    rapid: { rating: 1500, bookRefs: ['pupil-rapid', 'pooled'] },
  },
};

const presetWith = (bots: unknown[], extra: Record<string, unknown> = {}) => ({
  version: 1,
  bots,
  books: TABLE,
  ...extra,
});

describe('a bot with classes: reading it', () => {
  it('keeps the three classes with their ratings and book references', () => {
    const problems: string[] = [];
    const [bot] = parseBots([PUPIL], problems, { bookNames: new Set(Object.keys(TABLE)) });
    expect(problems).toEqual([]);
    expect(bot).toEqual(PUPIL);
  });

  it('is an ordinary bot when it has no classes (nothing added)', () => {
    const [bot] = parseBots([{ name: 'Plain', rating: 1200, style: 'solid' }]);
    expect(bot).toEqual({ name: 'Plain', rating: 1200, style: 'solid' });
    expect('classes' in (bot as CustomBot)).toBe(false);
  });

  it('keeps a bot that has only some classes', () => {
    const [bot] = parseBots([{ name: 'Half', rating: 1500, classes: { blitz: { rating: 1425 } } }]);
    expect(bot?.classes).toEqual({ blitz: { rating: 1425 } });
  });

  it('reports an unknown class name and a class that is not an object, and keeps the bot', () => {
    const problems: string[] = [];
    const bots = parseBots(
      [{ name: 'Odd', rating: 1500, classes: { daily: { rating: 1400 }, bullet: 5, rapid: { rating: 1500 } } }],
      problems,
    );
    expect(bots).toHaveLength(1);
    expect(bots[0]?.classes).toEqual({ rapid: { rating: 1500 } });
    expect(problems).toContain('bots[0].classes.daily: not a known field (ignored)');
    expect(problems).toContain('bots[0].classes.bullet: must be an object (ignored)');
  });

  it('drops a class with a rating out of range or not whole, but keeps the bot and its other classes', () => {
    const problems: string[] = [];
    const [bot] = parseBots(
      [
        {
          name: 'Range',
          rating: 1500,
          classes: { bullet: { rating: 100 }, blitz: { rating: 1425.5 }, rapid: { rating: '1500' } },
        },
      ],
      problems,
    );
    expect(bot?.rating).toBe(1500);
    expect(bot && 'classes' in bot).toBe(false);
    expect(problems.filter((p) => p.includes('class ignored'))).toHaveLength(3);
  });

  it('is not an object: the bot plays as one bot', () => {
    const problems: string[] = [];
    const [bot] = parseBots([{ name: 'Flat', rating: 1500, classes: [1, 2] }], problems);
    expect(bot).toEqual({ name: 'Flat', rating: 1500, style: 'solid' });
    expect(problems).toContain('bots[0].classes: must be an object (ignored; the bot plays as one bot)');
  });

  it('checks a class rating against every rating of the other bots (one rating, one bot)', () => {
    const problems: string[] = [];
    const bots = parseBots(
      [
        { name: 'First', rating: 1000, style: 'solid' },
        { name: 'Second', rating: 1500, classes: { bullet: { rating: 1000 }, blitz: { rating: 1425 } } },
        { name: 'Third', rating: 1800, classes: { blitz: { rating: 1425 }, rapid: { rating: 1500 } } },
      ],
      problems,
    );
    expect(bots[1]?.classes).toEqual({ blitz: { rating: 1425 } });
    // Third's classes clash with Second's blitz and Second's own rating: both dropped, the bot stays
    expect(bots[2]).toEqual({ name: 'Third', rating: 1800, style: 'solid' });
    expect(problems.filter((p) => p.endsWith('the same rating as another bot (class ignored)'))).toHaveLength(3);
  });

  it("allows a class rating equal to the bot's own rating or to its other classes", () => {
    const problems: string[] = [];
    const [bot] = parseBots(
      [{ name: 'Same', rating: 1500, classes: { bullet: { rating: 1500 }, blitz: { rating: 1500 } } }],
      problems,
    );
    expect(problems).toEqual([]);
    expect(Object.keys(bot?.classes ?? {})).toEqual(['bullet', 'blitz']);
  });

  it('leaves out a later bot whose rating is a class rating of an earlier one, even in another style', () => {
    const problems: string[] = [];
    const bots = parseBots(
      [
        { name: 'Pupil', rating: 1500, style: 'solid', classes: { blitz: { rating: 1425 } } },
        { name: 'Other', rating: 1425, style: 'aggressive' },
      ],
      problems,
    );
    expect(bots.map((b) => b.name)).toEqual(['Pupil']);
    expect(problems).toContain('bots[1]: the same rating as a class of an earlier bot (ignored)');
  });

  it('does not change the rule for bots without classes (same rating in two styles stays allowed)', () => {
    const bots = parseBots([
      { name: 'A', rating: 1200, style: 'solid' },
      { name: 'B', rating: 1200, style: 'aggressive' },
    ]);
    expect(bots.map((b) => b.name)).toEqual(['A', 'B']);
  });

  it('limits the references of a class to three and checks their names against the table', () => {
    const problems: string[] = [];
    const [bot] = parseBots(
      [
        {
          name: 'Refs',
          rating: 1500,
          classes: {
            blitz: { rating: 1425, bookRefs: ['pooled', 'pupil-blitz', 'pupil-bullet', 'pupil-rapid', 'gone'] },
          },
        },
      ],
      problems,
      { bookNames: new Set(Object.keys(TABLE)) },
    );
    expect(bot?.classes?.blitz?.bookRefs).toEqual(['pooled', 'pupil-blitz', 'pupil-bullet']);
    expect(problems.some((p) => p.includes('classes.blitz.bookRefs[3]') && p.includes('more than 3'))).toBe(true);
    expect(problems.some((p) => p.includes('classes.blitz.bookRefs[4]') && p.includes('no book of that name'))).toBe(
      true,
    );
  });
});

describe('a preset with a bot with classes', () => {
  it('parses whole, and counts a class reference as a use of its table book', () => {
    const only = {
      ...PUPIL,
      bookRefs: undefined,
      classes: { blitz: { rating: 1425, bookRefs: ['pupil-blitz'] } },
    };
    const { preset, problems } = parsePreset(presetWith([only]));
    expect(preset?.bots[0]?.classes?.blitz?.bookRefs).toEqual(['pupil-blitz']);
    // Only the table book some bot refers to (here through a class) stays; the others are reported as unused
    expect(Object.keys(preset?.books ?? {})).toEqual(['pupil-blitz']);
    expect(problems.filter((p) => p.includes('no bot refers to it'))).toHaveLength(3);
  });

  it('keeps all four books when the classes use them', () => {
    const { preset, problems } = parsePreset(presetWith([PUPIL]));
    expect(problems).toEqual([]);
    expect(Object.keys(preset?.books ?? {}).sort()).toEqual(['pooled', 'pupil-blitz', 'pupil-bullet', 'pupil-rapid']);
  });

  it('knows no unknown-field problem for classes or botsRevision', () => {
    const { problems } = parsePreset(presetWith([PUPIL], { botsRevision: 3 }));
    expect(problems.filter((p) => p.includes('not a known field'))).toEqual([]);
  });

  it('reads botsRevision, and reports a wrong one', () => {
    expect(parsePreset(presetWith([PUPIL], { botsRevision: 3 })).preset?.botsRevision).toBe(3);
    expect(parsePreset(presetWith([PUPIL])).preset).not.toHaveProperty('botsRevision');
    const bad = parsePreset(presetWith([PUPIL], { botsRevision: -1 }));
    expect(bad.preset).not.toHaveProperty('botsRevision');
    expect(bad.problems).toContain('botsRevision: must be a whole number, 0 or more (ignored)');
    expect(parseBotsRevision(1.5)).toBe(0);
    expect(parseBotsRevision('2')).toBe(0);
    expect(parseBotsRevision(undefined)).toBe(0);
    expect(parseBotsRevision(0)).toBe(0);
  });

  it('is a version-1 preset that an older app reads as one bot at the Rapid rating', () => {
    const { preset } = parsePreset(presetWith([PUPIL]));
    // What an app without classes sees: the top-level rating and book references
    expect(preset?.bots[0]).toMatchObject({ rating: 1500, bookRefs: ['pupil-rapid', 'pooled'] });
  });
});

describe('the profile with classes', () => {
  it('keeps classes and botsRevision when it is cleaned', () => {
    const clean = sanitizeProfile({ displayName: 'Tester', bots: [PUPIL], botsRevision: 4 });
    expect(clean.bots[0]).toEqual(PUPIL);
    expect(clean.botsRevision).toBe(4);
  });

  it('has no botsRevision unless one was stored', () => {
    expect(sanitizeProfile({ bots: [PUPIL] })).not.toHaveProperty('botsRevision');
    expect(sanitizeProfile({ bots: [PUPIL], botsRevision: 'x' })).not.toHaveProperty('botsRevision');
  });

  it('is stored and read back whole', () => {
    const data = new Map<string, string>();
    const storage = {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
      removeItem: (k: string) => void data.delete(k),
    };
    new ProfileStore(storage).replace({ displayName: 'Tester', bots: [PUPIL], botsRevision: 2 });
    const again = new ProfileStore(storage).get();
    expect(again.bots[0]).toEqual(PUPIL);
    expect(again.botsRevision).toBe(2);
  });

  it('keeps the classes when only the profile without inline books fits in storage', () => {
    const data = new Map<string, string>();
    const storage = {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => {
        if (v.length > 5000) throw new Error('quota');
        data.set(k, v);
      },
      removeItem: (k: string) => void data.delete(k),
    };
    const store = new ProfileStore(storage);
    store.replace({ bots: [{ ...PUPIL, books: ['x'.repeat(6000)] }], botsRevision: 2 });
    const stored = JSON.parse(data.get(PROFILE_STORAGE_KEY) ?? 'null') as { bots: CustomBot[] };
    expect(stored.bots[0]?.classes).toEqual(PUPIL.classes);
    expect(stored.bots[0]).not.toHaveProperty('books');
  });
});

describe('finding the bot by the rating of a class', () => {
  const profile = sanitizeProfile({
    bots: [
      { name: 'Warm-up', rating: 800, style: 'solid' },
      { name: 'Test Pupil', rating: 1500, style: 'solid', classes: PUPIL.classes },
    ],
  });

  it('finds the bot at each of its class ratings and at its own', () => {
    for (const rating of [1350, 1425, 1500]) {
      expect(namedBotForRating(profile, rating, 'solid')?.name).toBe('Test Pupil');
    }
  });

  it('keeps the bot when the style changes', () => {
    expect(namedBotForRating(profile, 1425, 'aggressive')?.name).toBe('Test Pupil');
  });

  it("finds no bot at a rating that is nobody's, and still finds a classless bot as before", () => {
    expect(namedBotForRating(profile, 1426, 'solid')).toBeNull();
    expect(namedBotForRating(profile, 800, 'aggressive')?.name).toBe('Warm-up');
  });
});

describe('resolving the bot for a class', () => {
  const [pupil] = parseBots([PUPIL]);
  const bot = pupil as CustomBot;

  it("gives that class's rating and references and leaves the rest", () => {
    expect(resolveBotForClass(bot, 'bullet')).toMatchObject({
      name: 'Test Pupil',
      style: 'solid',
      rating: 1350,
      bookRefs: ['pupil-bullet', 'pooled'],
    });
    expect(resolveBotForClass(bot, 'blitz')).toMatchObject({ rating: 1425, bookRefs: ['pupil-blitz', 'pooled'] });
    expect(resolveBotForClass(bot, 'rapid')).toMatchObject({ rating: 1500, bookRefs: ['pupil-rapid', 'pooled'] });
  });

  it('returns a bot without classes as it is', () => {
    const plain: CustomBot = { name: 'Plain', rating: 1200, style: 'solid', bookRefs: ['pooled'] };
    expect(resolveBotForClass(plain, 'blitz')).toBe(plain);
  });

  it('returns the bot as it is for a class it has no entry for (the Rapid defaults)', () => {
    const half: CustomBot = {
      name: 'Half',
      rating: 1500,
      style: 'solid',
      bookRefs: ['pooled'],
      classes: { blitz: { rating: 1425 } },
    };
    expect(resolveBotForClass(half, 'rapid')).toBe(half);
    expect(resolveBotForClass(half, 'bullet')).toBe(half);
  });

  it("keeps the bot's own references for a class that names none", () => {
    const half: CustomBot = {
      name: 'Half',
      rating: 1500,
      style: 'solid',
      bookRefs: ['pooled'],
      classes: { blitz: { rating: 1425 } },
    };
    expect(resolveBotForClass(half, 'blitz')).toMatchObject({ rating: 1425, bookRefs: ['pooled'] });
  });

  it('does not change the bot it was given', () => {
    const before = JSON.stringify(bot);
    resolveBotForClass(bot, 'bullet');
    expect(JSON.stringify(bot)).toBe(before);
  });

  it('plays a different book move for each class (invented books)', async () => {
    clearParsedBooks();
    const load = async (name: string): Promise<string | null> => (TABLE as Record<string, string>)[name] ?? null;
    const moves: Record<string, string | null> = {};
    for (const cls of ['bullet', 'blitz', 'rapid'] as const) {
      moves[cls] = firstMove(await awaitBotBooks(resolveBotForClass(bot, cls), load));
    }
    expect(moves).toEqual({ bullet: 'd2d4', blitz: 'c2c4', rapid: 'g1f3' });
  });

  it('falls back to the pooled book when the class book is missing', async () => {
    clearParsedBooks();
    const load = async (name: string): Promise<string | null> =>
      name === 'pupil-blitz' ? null : ((TABLE as Record<string, string>)[name] ?? null);
    const books = await awaitBotBooks(resolveBotForClass(bot, 'blitz'), load);
    expect(books).toHaveLength(1);
    expect(firstMove(books)).toBe('e2e4');
  });

  it('warms the books of the resolved class only', async () => {
    clearParsedBooks();
    const asked: string[] = [];
    const load = async (name: string): Promise<string | null> => {
      asked.push(name);
      return (TABLE as Record<string, string>)[name] ?? null;
    };
    warmBotBooks(resolveBotForClass(bot, 'bullet'), (task) => task(), load);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(asked.sort()).toEqual(['pooled', 'pupil-bullet']);
  });
});

describe('the class a Time chip makes', () => {
  const EXPECTED: Record<TimeControlPresetId, 'bullet' | 'blitz' | 'rapid'> = {
    '1+0': 'bullet',
    '2+1': 'bullet',
    '3+0': 'blitz',
    '3+2': 'blitz',
    '5+0': 'blitz',
    '5+3': 'blitz',
    '10+0': 'rapid',
    '10+5': 'rapid',
    '15+10': 'rapid',
    unlimited: 'rapid',
  };

  it('gives every chip the class its label names, and Unlimited Rapid', () => {
    for (const [id, config] of Object.entries(TIME_CONTROL_PRESETS)) {
      expect(botClassOfTimeControl(id as TimeControlPresetId), id).toBe(EXPECTED[id as TimeControlPresetId]);
      const word = config.label.split(' · ')[1]?.toLowerCase();
      if (word) expect(botClassOfTimeControl(id as TimeControlPresetId), config.label).toBe(word);
    }
    expect(Object.keys(TIME_CONTROL_PRESETS).sort()).toEqual(Object.keys(EXPECTED).sort());
  });
});

describe('the order of the named bots follows the Time class', () => {
  // Shaped like the production list, with invented names; the profile's order is not the rating order
  const LIST = parseBots([
    { name: 'Level Bot', rating: 1669, style: 'solid' },
    { name: 'Peak Bot', rating: 1708, style: 'solid' },
    {
      name: 'Pupil',
      rating: 1489,
      style: 'solid',
      classes: { bullet: { rating: 1116 }, blitz: { rating: 1425 }, rapid: { rating: 1489 } },
    },
    { name: 'Top Bot', rating: 1800, style: 'solid' },
    { name: 'Warm Bot', rating: 800, style: 'solid' },
    { name: 'Even Bot', rating: 1200, style: 'solid' },
  ]);
  const names = (botClass?: Parameters<typeof botsByRating>[1]) =>
    botsByRating(LIST, botClass).map(({ bot }) => bot.name);

  it('orders by the class rating: Bullet puts the Pupil after the 800 bot and before 1200', () => {
    expect(LIST).toHaveLength(6);
    expect(names('bullet')).toEqual(['Warm Bot', 'Pupil', 'Even Bot', 'Level Bot', 'Peak Bot', 'Top Bot']);
  });

  it('Blitz and Rapid keep the Pupil between 1200 and 1669', () => {
    expect(names('blitz')).toEqual(['Warm Bot', 'Even Bot', 'Pupil', 'Level Bot', 'Peak Bot', 'Top Bot']);
    expect(names('rapid')).toEqual(['Warm Bot', 'Even Bot', 'Pupil', 'Level Bot', 'Peak Bot', 'Top Bot']);
  });

  it('a bot without classes, or with no entry for the class, sorts by its own rating', () => {
    const bots = parseBots([
      { name: 'Plain', rating: 1000, style: 'solid' },
      { name: 'Blitz only', rating: 1500, style: 'solid', classes: { blitz: { rating: 900 } } },
    ]);
    // Bullet has no entry for the second bot: it stays at its own 1500; Blitz moves it to 900
    expect(botsByRating(bots, 'bullet').map((b) => b.bot.name)).toEqual(['Plain', 'Blitz only']);
    expect(botsByRating(bots, 'blitz').map((b) => b.bot.name)).toEqual(['Blitz only', 'Plain']);
    expect(botsByRating(bots, 'rapid').map((b) => b.bot.name)).toEqual(['Plain', 'Blitz only']);
  });

  it("ties keep the profile's order, indexes are the profile's places, and the list is not changed", () => {
    const bots = parseBots([
      { name: 'Solid twin', rating: 1200, style: 'solid' },
      { name: 'Early', rating: 700, style: 'solid' },
      { name: 'Aggressive twin', rating: 1200, style: 'aggressive' },
    ]);
    const sorted = botsByRating(bots, 'bullet');
    expect(sorted.map((b) => b.bot.name)).toEqual(['Early', 'Solid twin', 'Aggressive twin']);
    expect(sorted.map((b) => b.index)).toEqual([1, 0, 2]);
    expect(bots.map((b) => b.name)).toEqual(['Solid twin', 'Early', 'Aggressive twin']);
    expect(LIST.map((b) => b.name)[0]).toBe('Level Bot');
  });

  it('without a class it gives the old order (every bot by its own, top-level, rating)', () => {
    expect(names()).toEqual(['Warm Bot', 'Even Bot', 'Pupil', 'Level Bot', 'Peak Bot', 'Top Bot']);
    expect(botsByRating(LIST).map((b) => b.bot.rating)).toEqual([800, 1200, 1489, 1669, 1708, 1800]);
  });
});
