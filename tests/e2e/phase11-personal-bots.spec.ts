import { expect, test, type Page } from '@playwright/test';

// Personal bots: a preset bot with its own opening book (src/preset/preset.ts `books`, src/engine/bot-profile.ts).
// Everything here is invented: a made-up bot and a two-move book of moves an engine would hardly choose (1...h5 and
// 2...a5), served in place of the committed sample link's preset. Runs in every project.

const SAMPLE = '/start/sample/';

/** A position key as the book writes it (the first four FEN fields), listed with and without an en passant square. */
const keys = (placement: string, ep: string): string[] => [`${placement} b KQkq -`, `${placement} b KQkq ${ep}`];

/** Black's book: 1. e4 h5 2. d4 a5 (the text `serializeBook` writes: keys sorted). */
function blackBook(): string {
  const entries: Record<string, [string, number][]> = {};
  for (const key of keys('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR', 'e3')) entries[key] = [['h7h5', 3]];
  for (const key of keys('rnbqkbnr/ppppppp1/8/7p/3PP3/8/PPP2PPP/RNBQKBNR', 'd3')) entries[key] = [['a7a5', 2]];
  const sorted: typeof entries = {};
  for (const key of Object.keys(entries).sort()) sorted[key] = entries[key]!;
  return JSON.stringify({ v: 1, pliesCap: 36, entries: sorted });
}

const PRESET = {
  version: 1,
  profile: { displayName: 'Test Player' },
  settings: { newGame: { botRating: 1200, botStyle: 'solid', color: 'w' } },
  bots: [
    { name: 'Book Bot', rating: 1200, style: 'solid', books: [blackBook()] },
    { name: 'Plain Bot', rating: 1600, style: 'solid' },
  ],
};

/** Long enough to tell from an instant reply even with WebKit's slow clicks (300-500 ms each). */
const THINK_MS = 1500;

const board = (page: Page) => page.getByTestId('play-layout');
const mainLine = (page: Page) =>
  page.evaluate(() =>
    window
      .__wizardChessPlay!.controller.getGameTree()
      .getMainLine()
      .map((n) => n.san),
  );

async function play(page: Page, from: string, to: string, pliesAfterReply: number): Promise<number> {
  await board(page).getByTestId(`square-${from}`).click();
  await board(page).getByTestId(`square-${to}`).click();
  const movedAt = Date.now();
  await expect.poll(async () => (await mainLine(page)).length, { timeout: 30_000 }).toBe(pliesAfterReply);
  return Date.now() - movedAt;
}

test.describe('Phase 11 — personal bots: a preset bot with an opening book', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/start/sample/preset.json', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(PRESET) }),
    );
    await page.route('**/start/sample/history.json', (route) => route.fulfill({ status: 404, body: 'none' }));
    await page.goto(SAMPLE);
    await expect(board(page).getByTestId('chess-board')).toBeVisible();
    await expect(page.getByTestId('app-shell')).toHaveAttribute('data-first-run', 'applied', { timeout: 15_000 });
  });

  test('plays its book moves with the usual think time and no evaluation, then plays on as the usual bot', async ({
    page,
  }) => {
    // The New game card shows the two bots as the custom-bots group always does; the book bot is the chosen one
    await expect(page.getByTestId('custom-bots').locator('button')).toHaveCount(2);
    await expect(page.getByTestId('custom-bot-0')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('bot-rating-label')).toHaveText('Book Bot · Solid · 1200 Elo');
    await page.getByTestId('btn-new-game').click();
    await expect(page.getByTestId('top-player-name')).toHaveText('Book Bot · Solid (1200)');
    await page.evaluate((ms) => window.__wizardChessPlay!.controller.setBotDelayRangeMs(ms, ms), THINK_MS);
    const evalBadge = page.getByTestId('live-eval-score');
    const evalBefore = await evalBadge.textContent();

    // 1. e4 h5: from the book, after the full think time, and the evaluation is left as it was
    const first = await play(page, 'e2', 'e4', 2);
    expect(await mainLine(page)).toEqual(['e4', 'h5']);
    expect(await page.evaluate(() => window.__wizardChessPlay!.controller.wasLastBotMoveFromBook())).toBe(true);
    expect(await page.evaluate(() => window.__wizardChessPlay!.controller.getLastBotThinkTimeMs())).toBe(THINK_MS);
    expect(first).toBeGreaterThanOrEqual(THINK_MS - 600);
    await expect(evalBadge).toHaveText(evalBefore ?? '');

    // 2. d4 a5: still the book
    const second = await play(page, 'd2', 'd4', 4);
    expect(await mainLine(page)).toEqual(['e4', 'h5', 'd4', 'a5']);
    expect(await page.evaluate(() => window.__wizardChessPlay!.controller.wasLastBotMoveFromBook())).toBe(true);
    expect(second).toBeGreaterThanOrEqual(THINK_MS - 600);
    await expect(evalBadge).toHaveText(evalBefore ?? '');

    // 3. Nf3: out of book, so the engine plays as the usual 1200 bot
    await play(page, 'g1', 'f3', 6);
    expect(await page.evaluate(() => window.__wizardChessPlay!.controller.wasLastBotMoveFromBook())).toBe(false);
    expect((await mainLine(page)).slice(0, 5)).toEqual(['e4', 'h5', 'd4', 'a5', 'Nf3']);

    // The stored game names the bot as before, and carries nothing of its book
    await page.evaluate(() => window.__wizardChessPlay!.controller.resign());
    await expect
      .poll(() => page.evaluate(async () => (await (await window.__wizardChessLibraryReady!).library.list()).length))
      .toBe(1);
    const pgn = await page.evaluate(
      async () => (await (await window.__wizardChessLibraryReady!).library.list())[0]!.pgn,
    );
    expect(pgn).toContain('[Event "Casual game vs Book Bot (1200)"]');
    expect(pgn).toContain('[BlackElo "1200"]');
    expect(pgn).not.toContain('pliesCap');
    expect(pgn).not.toContain('h7h5');
  });

  test('a bot without books asks the engine from the first move', async ({ page }) => {
    await page.getByTestId('custom-bot-1').click();
    await expect(page.getByTestId('bot-rating-label')).toHaveText('Plain Bot · Solid · 1600 Elo');
    await page.getByTestId('btn-new-game').click();
    await expect(page.getByTestId('top-player-name')).toHaveText('Plain Bot · Solid (1600)');
    await page.evaluate(() => window.__wizardChessPlay!.controller.setBotMoveDelayMs(5));
    await play(page, 'e2', 'e4', 2);
    expect(await page.evaluate(() => window.__wizardChessPlay!.controller.wasLastBotMoveFromBook())).toBe(false);
  });

  test('the book bot as White has no book move for the start position and asks the engine', async ({ page }) => {
    // Its book holds only Black's moves
    await page.getByTestId('play-as-b').click();
    await page.evaluate(() => window.__wizardChessPlay!.controller.setBotDelayRangeMs(5, 5));
    await page.getByTestId('btn-new-game').click();
    await expect(page.getByTestId('top-player-name')).toHaveText('Book Bot · Solid (1200)');
    await expect.poll(async () => (await mainLine(page)).length, { timeout: 30_000 }).toBe(1);
    expect(await page.evaluate(() => window.__wizardChessPlay!.controller.wasLastBotMoveFromBook())).toBe(false);
  });

  test('the books survive a reload with the profile', async ({ page }) => {
    await page.reload();
    await expect(board(page).getByTestId('chess-board')).toBeVisible();
    await expect(page.getByTestId('bot-rating-label')).toHaveText('Book Bot · Solid · 1200 Elo');
    const stored = await page.evaluate(() => {
      const profile = JSON.parse(localStorage.getItem('wc.profile.v1') ?? '{}') as { bots?: { books?: string[] }[] };
      return profile.bots?.map((b) => b.books?.length ?? 0);
    });
    expect(stored).toEqual([1, 0]);
    await page.getByTestId('btn-new-game').click();
    await page.evaluate(() => window.__wizardChessPlay!.controller.setBotMoveDelayMs(5));
    await play(page, 'e2', 'e4', 2);
    expect(await mainLine(page)).toEqual(['e4', 'h5']);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The same bot with its book by reference: the preset's `books` table and the bot's `bookRefs`. The book is written
// to the database (bots.preset.<name>), the profile in localStorage keeps only the name, and the bot reads the book in
// an idle moment once a game begins. Invented data again (the same two-move book).

const PRESET_BY_REFERENCE = {
  version: 1,
  profile: { displayName: 'Test Player' },
  settings: { newGame: { botRating: 1200, botStyle: 'solid', color: 'w' } },
  books: { 'test-black': blackBook() },
  bots: [
    { name: 'Book Bot', rating: 1200, style: 'solid', bookRefs: ['test-black'] },
    { name: 'Plain Bot', rating: 1600, style: 'solid' },
  ],
};

const bookRow = (page: Page) =>
  page.evaluate(async () => {
    const api = await window.__wizardChessLibraryReady!;
    const text = await api.library.readSetting<string>('bots.preset.test-black');
    return typeof text === 'string' ? text.length : null;
  });

test.describe('Phase 11 — personal bots: a preset bot with its book by reference', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/start/sample/preset.json', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(PRESET_BY_REFERENCE) }),
    );
    await page.route('**/start/sample/history.json', (route) => route.fulfill({ status: 404, body: 'none' }));
    await page.goto(SAMPLE);
    await expect(board(page).getByTestId('chess-board')).toBeVisible();
    await expect(page.getByTestId('app-shell')).toHaveAttribute('data-first-run', 'applied', { timeout: 15_000 });
  });

  test('stores the book once in the database and only its name in the profile', async ({ page }) => {
    await expect.poll(() => bookRow(page), { timeout: 15_000 }).toBe(blackBook().length);
    const profile = await page.evaluate(() => {
      const raw = localStorage.getItem('wc.profile.v1') ?? '';
      const bots = (JSON.parse(raw) as { bots?: { books?: string[]; bookRefs?: string[] }[] }).bots ?? [];
      return {
        size: raw.length,
        books: bots.map((b) => b.books?.length ?? 0),
        refs: bots.map((b) => b.bookRefs ?? []),
      };
    });
    expect(profile.books).toEqual([0, 0]);
    expect(profile.refs).toEqual([['test-black'], []]);
    expect(profile.size).toBeLessThan(2_000);
  });

  test('plays its book moves, then plays on as the usual bot; the book survives a reload', async ({ page }) => {
    await expect.poll(() => bookRow(page), { timeout: 15_000 }).not.toBeNull();
    await page.getByTestId('btn-new-game').click();
    await expect(page.getByTestId('top-player-name')).toHaveText('Book Bot · Solid (1200)');
    await page.evaluate(() => window.__wizardChessPlay!.controller.setBotMoveDelayMs(5));
    await play(page, 'e2', 'e4', 2);
    expect(await mainLine(page)).toEqual(['e4', 'h5']);
    expect(await page.evaluate(() => window.__wizardChessPlay!.controller.wasLastBotMoveFromBook())).toBe(true);
    await play(page, 'd2', 'd4', 4);
    expect(await mainLine(page)).toEqual(['e4', 'h5', 'd4', 'a5']);
    await play(page, 'g1', 'f3', 6);
    expect(await page.evaluate(() => window.__wizardChessPlay!.controller.wasLastBotMoveFromBook())).toBe(false);

    await page.reload();
    await expect(board(page).getByTestId('chess-board')).toBeVisible();
    await page.getByTestId('btn-new-game').click();
    await page.evaluate(() => window.__wizardChessPlay!.controller.setBotMoveDelayMs(5));
    await play(page, 'e2', 'e4', 2);
    expect(await mainLine(page)).toEqual(['e4', 'h5']);
  });

  test('"reset" of the bot data leaves the preset book; a book that is gone means no book, and the game goes on', async ({
    page,
  }) => {
    await expect.poll(() => bookRow(page), { timeout: 15_000 }).not.toBeNull();
    await page.evaluate(async () => {
      const api = await window.__wizardChessLibraryReady!;
      // Same effect as resetBotData: the keys built on the device are deleted, the preset's are not in that list
      for (const key of ['bots.book.me', 'bots.book.peak', 'bots.book.student']) await api.library.deleteSetting(key);
    });
    expect(await bookRow(page)).not.toBeNull();

    // Now the book is lost (a cleared row): the bot has nothing to read and asks the engine from its first move
    await page.evaluate(async () => {
      const api = await window.__wizardChessLibraryReady!;
      await api.library.deleteSetting('bots.preset.test-black');
    });
    await page.reload();
    await expect(board(page).getByTestId('chess-board')).toBeVisible();
    await page.getByTestId('btn-new-game').click();
    await expect(page.getByTestId('top-player-name')).toHaveText('Book Bot · Solid (1200)');
    await page.evaluate(() => window.__wizardChessPlay!.controller.setBotMoveDelayMs(5));
    await play(page, 'e2', 'e4', 2);
    expect(await page.evaluate(() => window.__wizardChessPlay!.controller.wasLastBotMoveFromBook())).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Six named bots (the personal set has this many). The New game card lists them lowest rating first and finds a bot by
// its rating alone, so a style change keeps the bot, its highlight and its books. Invented ratings and books.

const SIX_PRESET = {
  version: 1,
  profile: { displayName: 'Test Player' },
  settings: { newGame: { botRating: 1450, botStyle: 'solid', color: 'w' } },
  books: { 'test-black': blackBook() },
  bots: [
    { name: 'Your level', rating: 1450, style: 'solid', bookRefs: ['test-black'] },
    { name: 'Peak you', rating: 1550, style: 'solid', bookRefs: ['test-black'] },
    { name: 'Your Student', rating: 1250, style: 'solid', bookRefs: ['test-black'] },
    { name: 'The Boss', rating: 1800, style: 'solid' },
    { name: 'Warm-up', rating: 800, style: 'solid' },
    { name: 'Even Match', rating: 1200, style: 'solid' },
  ],
};
const SIX_BY_RATING = ['Warm-up', 'Even Match', 'Your Student', 'Your level', 'Peak you', 'The Boss'];
const STYLE_LABELS = { aggressive: 'Aggressive', gambiteer: 'Gambiteer', solid: 'Solid' } as const;

const isTouch = () => test.info().project.name === 'webkit-iphone';

async function press(page: Page, testId: string): Promise<void> {
  const el = page.getByTestId(testId);
  if (isTouch()) await el.tap();
  else await el.click();
}

async function openSix(page: Page, width?: number): Promise<void> {
  if (width) await page.setViewportSize({ width, height: 800 });
  await page.route('**/start/sample/preset.json', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(SIX_PRESET) }),
  );
  await page.route('**/start/sample/history.json', (route) => route.fulfill({ status: 404, body: 'none' }));
  await page.goto(SAMPLE);
  await expect(board(page).getByTestId('chess-board')).toBeVisible();
  await expect(page.getByTestId('app-shell')).toHaveAttribute('data-first-run', 'applied', { timeout: 15_000 });
}

const pressedCount = (page: Page) =>
  page.locator('[data-testid=custom-bots] .wc-custom-bot[aria-pressed=true]').count();

test.describe('Phase 11 — personal bots: six named bots on the New game card', () => {
  test('lists them lowest rating first, opens on the default bot, and keeps the highlight when the style changes', async ({
    page,
  }) => {
    await openSix(page);
    await expect(page.getByTestId('custom-bots').locator('.wc-custom-bot-name')).toHaveText(SIX_BY_RATING);
    await expect(page.getByTestId('custom-bots').locator('.wc-custom-bot-rating')).toHaveText([
      '800',
      '1200',
      '1250',
      '1450',
      '1550',
      '1800',
    ]);
    // The test id keeps the bot's place in the preset's list: "Your level" is the first of the six there
    const yourLevel = page.getByTestId('custom-bot-0');
    await expect(yourLevel).toHaveAttribute('aria-pressed', 'true');
    expect(await pressedCount(page)).toBe(1);
    await expect(page.getByTestId('top-player-name')).toHaveText('Your level · Solid (1450)');
    await expect(page.getByTestId('bot-rating-label')).toHaveText('Your level · Solid · 1450 Elo');

    for (const style of ['aggressive', 'gambiteer', 'solid'] as const) {
      await press(page, `bot-style-${style}`);
      await expect(page.getByTestId('top-player-name')).toHaveText(`Your level · ${STYLE_LABELS[style]} (1450)`);
      await expect(page.getByTestId('bot-rating-label')).toHaveText(`Your level · ${STYLE_LABELS[style]} · 1450 Elo`);
      await expect(yourLevel).toHaveAttribute('aria-pressed', 'true');
      expect(await pressedCount(page)).toBe(1);
    }

    // Another bot: the highlight moves with the choice, never two at once
    await press(page, 'custom-bot-1');
    await expect(page.getByTestId('top-player-name')).toHaveText('Peak you · Solid (1550)');
    await expect(page.getByTestId('custom-bot-1')).toHaveAttribute('aria-pressed', 'true');
    expect(await pressedCount(page)).toBe(1);
  });

  for (const width of [375, 390]) {
    test(`the row of six fits a ${width} px screen: every bot whole, inside the row and the screen`, async ({
      page,
    }) => {
      await openSix(page, width);
      await expect(page.getByTestId('custom-bots').locator('.wc-custom-bot')).toHaveCount(6);
      for (const style of [null, 'aggressive'] as const) {
        if (style) await press(page, `bot-style-${style}`);
        const fit = await page.evaluate(() => {
          const row = document.querySelector<HTMLElement>('[data-testid=custom-bots]')!;
          const box = row.getBoundingClientRect();
          const buttons = [...row.querySelectorAll<HTMLElement>('.wc-custom-bot')];
          const rects = buttons.map((b) => b.getBoundingClientRect());
          const touching = (a: DOMRect, b: DOMRect) =>
            a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5;
          return {
            rowOverflow: row.scrollWidth - row.clientWidth,
            insideRow: rects.every(
              (r) => r.width > 0 && r.height > 0 && r.left >= box.left - 0.5 && r.right <= box.right + 0.5,
            ),
            insideScreen: rects.every((r) => r.left >= 0 && r.right <= window.innerWidth + 0.5),
            nameCut: buttons.some((b) => {
              const name = b.querySelector<HTMLElement>('.wc-custom-bot-name')!;
              return name.scrollWidth > name.clientWidth + 1;
            }),
            overlap: rects.some((a, i) => rects.some((b, j) => j > i && touching(a, b))),
          };
        });
        expect(fit, `${width} px, style ${style ?? 'solid'}`).toEqual({
          rowOverflow: 0,
          insideRow: true,
          insideScreen: true,
          nameCut: false,
          overlap: false,
        });
        await expect(page.getByTestId('custom-bot-0')).toHaveAttribute('aria-pressed', 'true');
      }
    });
  }

  test('a style change keeps the bot and its book: the game opens as that bot, from its book', async ({ page }) => {
    await openSix(page);
    await expect.poll(() => bookRow(page), { timeout: 15_000 }).not.toBeNull();
    await press(page, 'bot-style-aggressive');
    await page.evaluate(() => window.__wizardChessPlay!.controller.setBotMoveDelayMs(5));
    await press(page, 'btn-new-game');
    await expect(page.getByTestId('top-player-name')).toHaveText('Your level · Aggressive (1450)');
    await play(page, 'e2', 'e4', 2);
    expect(await mainLine(page)).toEqual(['e4', 'h5']);
    expect(await page.evaluate(() => window.__wizardChessPlay!.controller.wasLastBotMoveFromBook())).toBe(true);

    // The stored game names the bot as before: no style in the PGN name
    await page.evaluate(() => window.__wizardChessPlay!.controller.resign());
    await expect
      .poll(() => page.evaluate(async () => (await (await window.__wizardChessLibraryReady!).library.list()).length))
      .toBe(1);
    const pgn = await page.evaluate(
      async () => (await (await window.__wizardChessLibraryReady!).library.list())[0]!.pgn,
    );
    expect(pgn).toContain('[Event "Casual game vs Your level (1450)"]');
    expect(pgn).not.toContain('Aggressive');
  });

  test('a bot of the six without a book asks the engine', async ({ page }) => {
    await openSix(page);
    // Warm-up is the fifth in the preset's list
    await press(page, 'custom-bot-4');
    await expect(page.getByTestId('top-player-name')).toHaveText('Warm-up · Solid (800)');
    await page.evaluate(() => window.__wizardChessPlay!.controller.setBotMoveDelayMs(5));
    await press(page, 'btn-new-game');
    await play(page, 'e2', 'e4', 2);
    expect(await page.evaluate(() => window.__wizardChessPlay!.controller.wasLastBotMoveFromBook())).toBe(false);
  });
});
