import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';

// One named bot whose rating and opening book follow the time class the Time chip makes (Bullet, Blitz, Rapid).
// Everything here is invented: a made-up bot, made-up ratings and four one-move books of moves an engine would hardly
// choose, served in place of the committed sample link's preset. Runs in every project.
//
// Set STUDENT_SCREENSHOT_DIR to a folder (outside the repo) to also save a screenshot of every chip at three sizes.

const SAMPLE = '/start/sample/';

/** Black's book for the position after 1. e4: the one reply `uci`, as the text `serializeBook` writes. */
function replyBook(uci: string): string {
  const entries: Record<string, [string, number][]> = {};
  const placement = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR';
  for (const key of [`${placement} b KQkq -`, `${placement} b KQkq e3`]) entries[key] = [[uci, 3]];
  const sorted: typeof entries = {};
  for (const key of Object.keys(entries).sort()) sorted[key] = entries[key]!;
  return JSON.stringify({ v: 1, pliesCap: 36, entries: sorted });
}

/** The bullet, blitz and rapid books answer 1. e4 with ...h5, ...a5 and ...g5; the pooled book with ...b5. */
const REPLY = { bullet: 'h5', blitz: 'a5', rapid: 'g5', pooled: 'b5' } as const;

const RATING = { bullet: 1300, blitz: 1425, rapid: 1489 } as const;

/** Each Time chip and the class it makes (the chip labels say so: 3+0 is the first Blitz). */
const CHIPS: Array<[id: string, cls: keyof typeof RATING]> = [
  ['1+0', 'bullet'],
  ['2+1', 'bullet'],
  ['3+0', 'blitz'],
  ['3+2', 'blitz'],
  ['5+0', 'blitz'],
  ['5+3', 'blitz'],
  ['10+0', 'rapid'],
  ['10+5', 'rapid'],
  ['15+10', 'rapid'],
  ['unlimited', 'rapid'],
];

const PRESET = {
  version: 1,
  profile: { displayName: 'Test Player' },
  settings: { newGame: { botRating: RATING.rapid, botStyle: 'solid', color: 'w', timeControlId: '10+0' } },
  bots: [
    { name: 'Plain Bot', rating: 1000, style: 'solid' },
    {
      name: 'Test Student',
      rating: RATING.rapid,
      style: 'solid',
      bookRefs: ['student-rapid', 'student'],
      classes: {
        bullet: { rating: RATING.bullet, bookRefs: ['student-bullet', 'student'] },
        blitz: { rating: RATING.blitz, bookRefs: ['student-blitz', 'student'] },
        rapid: { rating: RATING.rapid, bookRefs: ['student-rapid', 'student'] },
      },
    },
  ],
  books: {
    student: replyBook('b7b5'),
    'student-bullet': replyBook('h7h5'),
    'student-blitz': replyBook('a7a5'),
    'student-rapid': replyBook('g7g5'),
  },
};

const touch = () => test.info().project.name === 'webkit-iphone';

async function press(page: Page, testId: string): Promise<void> {
  const el = page.getByTestId(testId);
  if (touch()) await el.tap();
  else await el.click();
}

const board = (page: Page) => page.getByTestId('play-layout');
const mainLine = (page: Page) =>
  page.evaluate(() =>
    window
      .__wizardChessPlay!.controller.getGameTree()
      .getMainLine()
      .map((n) => n.san),
  );

/** The names of the named-bot buttons, in the order they are shown. */
const botOrder = (page: Page) => page.getByTestId('custom-bots').locator('.wc-custom-bot-name').allTextContents();

const STUDENT = 'custom-bot-1';

test.describe('Phase 11 — one Student bot whose rating and book follow the time class', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/start/sample/preset.json', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(PRESET) }),
    );
    await page.route('**/start/sample/history.json', (route) => route.fulfill({ status: 404, body: 'none' }));
    await page.goto(SAMPLE);
    await expect(board(page).getByTestId('chess-board')).toBeVisible();
    await expect(page.getByTestId('app-shell')).toHaveAttribute('data-first-run', 'applied', { timeout: 15_000 });
    await expect(page.getByTestId('custom-bots').locator('button')).toHaveCount(2);
  });

  test('every Time chip gives the Student its class rating: chip, card line and player bar', async ({ page }) => {
    // The preset opens on 10 + 0, so the first class is Rapid at the bot's own rating
    await expect(page.getByTestId(STUDENT)).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('bot-rating-label')).toHaveText(`Test Student · Rapid · Solid · ${RATING.rapid} Elo`);
    const order = await botOrder(page);
    expect(order).toEqual(['Plain Bot', 'Test Student']);

    for (const [id, cls] of CHIPS) {
      await press(page, `time-control-${id}`);
      const label = cls[0]!.toUpperCase() + cls.slice(1);
      await expect(page.getByTestId('bot-rating-label')).toHaveText(
        `Test Student · ${label} · Solid · ${RATING[cls]} Elo`,
      );
      await expect(page.getByTestId(STUDENT).locator('.wc-custom-bot-rating')).toHaveText(String(RATING[cls]));
      await expect(page.getByTestId('top-player-name')).toHaveText(`Test Student · Solid (${RATING[cls]})`);
      await expect(page.getByTestId(STUDENT)).toHaveAttribute('aria-pressed', 'true');
      // The list keeps its order whatever the chip
      expect(await botOrder(page)).toEqual(order);
    }
    // The other bot never changes
    await expect(page.getByTestId('custom-bot-0').locator('.wc-custom-bot-rating')).toHaveText('1000');
  });

  test("the Student chip tapped on a chip uses that chip's class; a plain bot keeps its text and rating", async ({
    page,
  }) => {
    await press(page, 'custom-bot-0');
    await expect(page.getByTestId('bot-rating-label')).toHaveText('Plain Bot · Solid · 1000 Elo');
    await press(page, 'time-control-1+0');
    await expect(page.getByTestId('bot-rating-label')).toHaveText('Plain Bot · Solid · 1000 Elo');
    await expect(page.getByTestId('top-player-name')).toHaveText('Plain Bot · Solid (1000)');

    await press(page, STUDENT);
    await expect(page.getByTestId('bot-rating-label')).toHaveText(
      `Test Student · Bullet · Solid · ${RATING.bullet} Elo`,
    );
    await expect(page.getByTestId('top-player-name')).toHaveText(`Test Student · Solid (${RATING.bullet})`);
    await press(page, 'time-control-5+0');
    await expect(page.getByTestId('top-player-name')).toHaveText(`Test Student · Solid (${RATING.blitz})`);

    // Leaving the Student for the plain bot: the chips no longer move its rating
    await press(page, 'custom-bot-0');
    await press(page, 'time-control-15+10');
    await expect(page.getByTestId('top-player-name')).toHaveText('Plain Bot · Solid (1000)');
  });

  test('the card line of a bot with classes joins the number and Elo with a no-break space; other lines are unchanged', async ({
    page,
  }) => {
    const label = page.getByTestId('bot-rating-label');
    await expect(label).toHaveText(`Test Student · Rapid · Solid · ${RATING.rapid} Elo`);
    expect(await label.evaluate((el) => el.textContent)).toBe(
      `Test Student · Rapid · Solid · ${RATING.rapid}\u00a0Elo`,
    );
    await press(page, 'time-control-1+0');
    expect(await label.evaluate((el) => el.textContent)).toBe(
      `Test Student · Bullet · Solid · ${RATING.bullet}\u00a0Elo`,
    );
    // A bot without classes keeps its plain space, byte for byte
    await press(page, 'custom-bot-0');
    expect(await label.evaluate((el) => el.textContent)).toBe('Plain Bot · Solid · 1000 Elo');
  });

  test('Unlimited uses the Rapid rating and book', async ({ page }) => {
    await press(page, 'time-control-1+0');
    await expect(page.getByTestId('top-player-name')).toHaveText(`Test Student · Solid (${RATING.bullet})`);
    await press(page, 'time-control-unlimited');
    await expect(page.getByTestId('top-player-name')).toHaveText(`Test Student · Solid (${RATING.rapid})`);
    await expect(page.getByTestId('bot-rating-label')).toHaveText(`Test Student · Rapid · Solid · ${RATING.rapid} Elo`);
  });

  test('a style change keeps the bot and its class rating', async ({ page }) => {
    await press(page, 'time-control-3+2');
    await press(page, 'bot-style-aggressive');
    await expect(page.getByTestId('top-player-name')).toHaveText(`Test Student · Aggressive (${RATING.blitz})`);
    await expect(page.getByTestId('bot-rating-label')).toHaveText(
      `Test Student · Blitz · Aggressive · ${RATING.blitz} Elo`,
    );
    await expect(page.getByTestId(STUDENT)).toHaveAttribute('aria-pressed', 'true');
    await press(page, 'time-control-1+0');
    await expect(page.getByTestId('top-player-name')).toHaveText(`Test Student · Aggressive (${RATING.bullet})`);
  });

  test('a time chip changes the settings once: no change loop', async ({ page }) => {
    await page.evaluate(() => {
      const w = window as unknown as { __settingWrites: number };
      w.__settingWrites = 0;
      const original = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key: string, value: string) {
        if (key === 'wc.settings.v1') w.__settingWrites++;
        return original.call(this, key, value);
      };
    });
    await press(page, 'time-control-3+0');
    await expect(page.getByTestId('top-player-name')).toHaveText(`Test Student · Solid (${RATING.blitz})`);
    // Let anything that would follow happen
    await page.waitForTimeout(500);
    expect(await page.evaluate(() => (window as unknown as { __settingWrites: number }).__settingWrites)).toBe(1);
    await press(page, 'time-control-10+5');
    await expect(page.getByTestId('top-player-name')).toHaveText(`Test Student · Solid (${RATING.rapid})`);
    await page.waitForTimeout(500);
    expect(await page.evaluate(() => (window as unknown as { __settingWrites: number }).__settingWrites)).toBe(2);
  });

  test('a saved rating of another class follows the chip after a reload', async ({ page }) => {
    // The stored choice says Blitz rating on a Rapid chip (a backup, or a rating set before the bot had classes)
    await page.evaluate((rating) => {
      const stored = JSON.parse(localStorage.getItem('wc.settings.v1') ?? '{}') as {
        newGame: { botRating: number; timeControlId: string };
      };
      stored.newGame.botRating = rating;
      stored.newGame.timeControlId = '10+0';
      localStorage.setItem('wc.settings.v1', JSON.stringify(stored));
    }, RATING.blitz);
    await page.reload();
    await expect(board(page).getByTestId('chess-board')).toBeVisible();
    await expect(page.getByTestId('top-player-name')).toHaveText(`Test Student · Solid (${RATING.rapid})`);
    await expect(page.getByTestId('bot-rating-label')).toHaveText(`Test Student · Rapid · Solid · ${RATING.rapid} Elo`);
    expect(
      await page.evaluate(
        () =>
          (JSON.parse(localStorage.getItem('wc.settings.v1') ?? '{}') as { newGame: { botRating: number } }).newGame
            .botRating,
      ),
    ).toBe(1489);
  });

  for (const [id, cls] of [
    ['1+0', 'bullet'],
    ['5+0', 'blitz'],
    ['10+0', 'rapid'],
    ['unlimited', 'rapid'],
  ] as const) {
    test(`the ${id} game: rating ${RATING[cls]}, a ${cls} book move, and the stored game says so`, async ({ page }) => {
      await press(page, `time-control-${id}`);
      await page.getByTestId('btn-new-game').click();
      await expect(page.getByTestId('top-player-name')).toHaveText(`Test Student · Solid (${RATING[cls]})`);
      await page.evaluate(() => window.__wizardChessPlay!.controller.setBotMoveDelayMs(5));

      await board(page).getByTestId('square-e2').click();
      await board(page).getByTestId('square-e4').click();
      await expect.poll(async () => (await mainLine(page)).length, { timeout: 30_000 }).toBe(2);
      // The reply comes from that class's book, not the pooled one and not another class's
      expect(await mainLine(page)).toEqual(['e4', REPLY[cls]]);
      expect(await page.evaluate(() => window.__wizardChessPlay!.controller.wasLastBotMoveFromBook())).toBe(true);

      await page.evaluate(() => window.__wizardChessPlay!.controller.resign());
      await expect
        .poll(() => page.evaluate(async () => (await (await window.__wizardChessLibraryReady!).library.list()).length))
        .toBe(1);
      const pgn = await page.evaluate(
        async () => (await (await window.__wizardChessLibraryReady!).library.list())[0]!.pgn,
      );
      expect(pgn).toContain(`[Event "Casual game vs Test Student (${RATING[cls]})"]`);
      expect(pgn).toContain(`[BlackElo "${RATING[cls]}"]`);
    });
  }

  test('a chip changed while a game is on changes the card, not the game', async ({ page }) => {
    await press(page, 'time-control-1+0');
    await page.getByTestId('btn-new-game').click();
    await page.evaluate(() => window.__wizardChessPlay!.controller.setBotMoveDelayMs(5));
    await board(page).getByTestId('square-e2').click();
    await board(page).getByTestId('square-e4').click();
    await expect.poll(async () => (await mainLine(page)).length, { timeout: 30_000 }).toBe(2);
    await press(page, 'play-menu');
    await press(page, 'menu-new-game');
    await press(page, 'time-control-10+0');
    await expect(page.getByTestId('bot-rating-label')).toHaveText(`Test Student · Rapid · Solid · ${RATING.rapid} Elo`);
    // The game on the board is still the Bullet one
    await expect(page.getByTestId('top-player-name')).toHaveText(`Test Student · Solid (${RATING.bullet})`);
    expect(await mainLine(page)).toEqual(['e4', REPLY.bullet]);
  });

  test('the chip text fits at phone and desktop sizes, and every chip can be looked at', async ({ page }) => {
    const dir = process.env.STUDENT_SCREENSHOT_DIR;
    const sizes = [
      { width: 375, height: 667 },
      { width: 390, height: 844 },
      { width: 1280, height: 900 },
    ];
    for (const size of sizes) {
      await page.setViewportSize(size);
      for (const [id, cls] of CHIPS) {
        await press(page, `time-control-${id}`);
        await expect(page.getByTestId('bot-rating-label')).toContainText(`${RATING[cls]} Elo`);
        const fit = await page.getByTestId(STUDENT).evaluate((button) => {
          const name = button.querySelector<HTMLElement>('.wc-custom-bot-name')!;
          const rating = button.querySelector<HTMLElement>('.wc-custom-bot-rating')!;
          const box = button.getBoundingClientRect();
          const parent = button.parentElement!.getBoundingClientRect();
          return {
            nameCut: name.scrollWidth > name.clientWidth,
            ratingInside: rating.getBoundingClientRect().right <= box.right + 0.5,
            insideParent: box.left >= parent.left - 0.5 && box.right <= parent.right + 0.5,
            pageOverflow: document.documentElement.scrollWidth > window.innerWidth,
          };
        });
        expect(fit, `${size.width}x${size.height} ${id}`).toEqual({
          nameCut: false,
          ratingInside: true,
          insideParent: true,
          pageOverflow: false,
        });
        if (dir) {
          await page.getByTestId('new-game-card').screenshot({
            path: path.join(
              dir,
              `student-${size.width}x${size.height}-${test.info().project.name}-${id.replace('+', '_')}.png`,
            ),
          });
        }
      }
    }
  });
});
