import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type Locator, type Page, type Route } from '@playwright/test';
import { SITE_URL } from './helpers/site';

// The Story's Brilliant and Great highlight card, and "Open this game" on every card that features one game. The sample
// link's history (30 invented games for "ada-sample") gets invented summaries in which six different games are the most
// brilliant, the most accurate, the best win, the most unlikely win, the longest game and the longest win, so a button
// wired to the wrong game is caught. Every expected text is worked out here from those numbers, not by the app.
// Nothing reaches a real network.
test.use({
  storageState: {
    cookies: [],
    origins: [{ origin: SITE_URL, localStorage: [{ name: 'wc-install-guide-seen', value: '1' }] }],
  },
});

const SAMPLE = '/start/sample/';
const SAMPLE_HISTORY = path.join('public', 'start', 'sample', 'history.json');
/** A folder OUTSIDE the repository for screenshots; with it unset nothing is saved. */
const LOOK_DIR = process.env.PHASE_LOOK_DIR ?? '';

async function look(page: Page, name: string, testId?: string): Promise<void> {
  if (LOOK_DIR === '') return;
  const dir = path.resolve(LOOK_DIR);
  if (!path.relative(process.cwd(), dir).startsWith('..'))
    throw new Error('PHASE_LOOK_DIR must be outside the repository');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${test.info().project.name}-${name}.png`);
  if (testId) await page.getByTestId(testId).screenshot({ path: file });
  else await page.screenshot({ path: file });
}

interface SampleGame {
  id: string;
  playerColor: 'w' | 'b';
  result: string;
  timeControl: string;
  playedAt: number;
  date: string;
  whiteElo: number;
  blackElo: number;
  [field: string]: unknown;
}

// The six featured games, by their place in the sample file
const MOST_BRILLIANT = 14; // White, a win, 900+10, September 11, 2026: 2 Brilliant and 3 Great moves
const ALSO_BRILLIANT = 4; // 2 Brilliant moves too, but 1 Great move, and a year earlier
const LATEST_BRILLIANT = 20; // 1 Brilliant move, October 3, 2026
const MOST_ACCURATE = 22; // accuracy 92, the highest of the formula below
const BEST_WIN = 11; // a win as Black against the one opponent rated 1,480
const COMEBACK = 24; // a win from 2%
const LONGEST = 2; // a loss of 90 moves
const LONGEST_WIN = 10; // a win of 75 moves
const YEAR_MS = 365 * 86_400_000;

/** The invented review numbers of the game at place `i`. */
function inventedFor(i: number) {
  const moves = 25 + (i % 6);
  return {
    accuracy: 62 + ((i * 7) % 31),
    moves,
    plies: i === LONGEST ? 180 : i === LONGEST_WIN ? 150 : moves * 2,
    brilliant: i === MOST_BRILLIANT || i === ALSO_BRILLIANT ? 2 : i === LATEST_BRILLIANT ? 1 : 0,
    great: i === MOST_BRILLIANT ? 3 : i === ALSO_BRILLIANT || i % 7 === 0 ? 1 : 0,
    low: i === COMEBACK ? 2 : 10 + i,
  };
}

/** The sample's games with a summary each; the first ten are moved a year back, so the games span two years. */
function history(): SampleGame[] {
  const games = (JSON.parse(fs.readFileSync(SAMPLE_HISTORY, 'utf8')) as { games: SampleGame[] }).games;
  return games.map((g, i) => {
    const n = inventedFor(i);
    const playedAt = i < 10 ? g.playedAt - YEAR_MS : g.playedAt;
    return {
      ...g,
      playedAt,
      date: new Date(playedAt).toISOString().slice(0, 10).replace(/-/g, '.'),
      ...(i === BEST_WIN ? { whiteElo: 1480 } : {}),
      accuracy: n.accuracy,
      analysis: {
        preset: null,
        savedAt: 1,
        depth: 18,
        summaryOnly: true,
        plies: n.plies,
        whiteAccuracy: g.playerColor === 'w' ? n.accuracy : null,
        blackAccuracy: g.playerColor === 'b' ? n.accuracy : null,
        sides: {
          [g.playerColor]: {
            moves: n.moves,
            acpl: 40,
            inaccuracy: 2,
            mistake: 1,
            blunder: i % 3,
            miss: 0,
            brilliant: n.brilliant,
            great: n.great,
            low: n.low,
            drop: 20,
            dropPly: 11,
            // Phase numbers, so the wide layout has its four "How well you play" cards, as a full history does
            phases: [
              [10, 90, 0, 0, 0],
              [n.moves - 14, 80, i % 3, 1, 0],
              [4, 85, 0, 0, 0],
            ],
          },
        },
      },
    };
  });
}

/** Fails loudly if the sample file stops giving what the picks above assume. */
function checkFixture(games: SampleGame[]): void {
  const won = (i: number) => (games[i]!.result === '1-0') === (games[i]!.playerColor === 'w');
  expect(games).toHaveLength(30);
  for (const i of [MOST_BRILLIANT, BEST_WIN, COMEBACK, LONGEST_WIN]) expect(won(i)).toBe(true);
  expect(games[MOST_BRILLIANT]).toMatchObject({ playerColor: 'w', timeControl: '900+10' });
  expect(new Date(games[MOST_BRILLIANT]!.playedAt).toISOString().slice(0, 10)).toBe('2026-09-11');
  expect(new Date(games[LATEST_BRILLIANT]!.playedAt).toISOString().slice(0, 10)).toBe('2026-10-03');
  expect(new Date(games[ALSO_BRILLIANT]!.playedAt).getUTCFullYear()).toBe(2025);
  expect(games[BEST_WIN]!.playerColor).toBe('b');
  const accuracies = games.map((_, i) => inventedFor(i).accuracy);
  expect(Math.max(...accuracies)).toBe(accuracies[MOST_ACCURATE]);
  expect(new Set(accuracies).size).toBe(30);
  expect(new Set([MOST_BRILLIANT, MOST_ACCURATE, BEST_WIN, COMEBACK, LONGEST, LONGEST_WIN]).size).toBe(6);
}

/** The Brilliant and Great card's text, from the numbers above. */
function wantMarks(games: SampleGame[]) {
  const all = games.map((_, i) => inventedFor(i));
  const brilliant = all.reduce((s, n) => s + n.brilliant, 0);
  const great = all.reduce((s, n) => s + n.great, 0);
  const brilliantGames = all.filter((n) => n.brilliant > 0).length;
  const greatGames = all.filter((n) => n.great > 0).length;
  const in2026 = all.reduce(
    (s, n, i) => s + (new Date(games[i]!.playedAt).getUTCFullYear() === 2026 ? n.brilliant : 0),
    0,
  );
  return {
    brilliant: String(brilliant),
    great: String(great),
    sentence: `You played a Brilliant move in ${brilliantGames} of your 30 reviewed games, about one every ${Math.round(30 / brilliantGames)} games.`,
    rows: [
      ['Most in one game', '2 Brilliant · 3 Great'],
      ['Best year', `2026 · ${in2026} Brilliant`],
      ['Latest Brilliant move', 'October 3, 2026'],
      ['Games with a Great move', `${greatGames} of 30`],
    ] as const,
    note: 'Your most brilliant game: a rapid win as White on September 11, 2026 (15+10).',
  };
}

/** Every "Open this game" button: its test id, card, accessible name, visible words and game. */
const OPENERS = [
  { key: 'marks', card: 'marks', name: 'Open your most brilliant game', text: 'Open this game', game: MOST_BRILLIANT },
  {
    key: 'bestGame',
    card: 'bestGame',
    name: 'Open your most accurate game',
    text: 'Open this game',
    game: MOST_ACCURATE,
  },
  { key: 'bestWin', card: 'bestWin', name: 'Open your best win', text: 'Open this game', game: BEST_WIN },
  { key: 'comebacks', card: 'comebacks', name: 'Open your most unlikely win', text: 'Open this game', game: COMEBACK },
  { key: 'longest', card: 'records', name: 'Open your longest game', text: 'Open longest game', game: LONGEST },
  { key: 'longestWin', card: 'records', name: 'Open your longest win', text: 'Open longest win', game: LONGEST_WIN },
] as const;

const fulfilJson = (route: Route, body: unknown) =>
  route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

async function closeWelcomeIfShown(page: Page): Promise<void> {
  const welcome = page.getByTestId('welcome-sheet');
  await welcome.waitFor({ state: 'visible', timeout: 8000 }).catch(() => undefined);
  if (await welcome.isVisible()) {
    await page.getByTestId('welcome-done').click();
    await expect(welcome).toBeHidden();
  }
}

/** Opens the sample link with the fixture history and waits for the Story to have counted it. */
async function openStory(page: Page): Promise<SampleGame[]> {
  const games = history();
  checkFixture(games);
  const base = JSON.parse(fs.readFileSync(SAMPLE_HISTORY, 'utf8')) as object;
  await page.route('**/start/sample/history.json', (route) => fulfilJson(route, { ...base, games }));
  await page.goto(SAMPLE);
  await expect(page.getByTestId('app-shell')).toHaveAttribute('data-first-run', 'applied', { timeout: 15_000 });
  await closeWelcomeIfShown(page);
  await expect
    .poll(
      () =>
        page
          .evaluate(() => window.__wizardChessLibrary?.library.listIds().then((ids) => ids.length) ?? -1)
          .catch(() => -1),
      { timeout: 15_000 },
    )
    .toBe(games.length);
  await expect(page.getByTestId('story-value-totals')).toHaveText(String(games.length), { timeout: 20_000 });
  await expect(page.getByTestId('story-load-status')).toHaveCount(0, { timeout: 20_000 });
  await expect(page.getByTestId('story-card-marks')).toBeVisible();
  return games;
}

const card = (page: Page, id: string) => page.getByTestId(`story-card-${id}`);
const opener = (page: Page, key: string) => page.getByTestId(`story-open-${key}`);
const openGameId = (page: Page) => page.evaluate(() => window.__wizardChessLibrary!.getOpenGameId());

/** Where the reader is: the Story's own scroll box (the phone) and the page (the wide layout). */
const position = (page: Page) =>
  page.evaluate(() => ({
    box: Math.round(document.querySelector('.wc-story-scroll')?.scrollTop ?? -1),
    page: Math.round(window.scrollY),
  }));

/**
 * Presses a tab with the page's own click. Playwright's click first scrolls its target into view, and on WebKit that
 * moves the page a few pixels even for the sticky tab bar: the Story would then, rightly, come back at that moved place.
 */
const press = (target: Locator) => target.evaluate((el) => (el as HTMLElement).click());

/** Scrolls a card to the top of the view and waits until the scroll (and the phone's snap) has settled. */
async function scrollTo(page: Page, target: Locator): Promise<{ box: number; page: number }> {
  await target.evaluate((el) => el.scrollIntoView({ block: 'start' }));
  let last = await position(page);
  await expect
    .poll(
      async () => {
        const now = await position(page);
        const still = now.box === last.box && now.page === last.page;
        last = now;
        return still;
      },
      { intervals: [150], timeout: 5000 },
    )
    .toBe(true);
  return last;
}

/** The card as laid out: sideways overflow, cut-off text, and the room between its last line and the button. */
function measure(target: Locator) {
  return target.evaluate((el) => {
    const box = el.getBoundingClientRect();
    const scroller = el.closest('.wc-story-scroll')!;
    const view = scroller.getBoundingClientRect();
    const texts = [...el.querySelectorAll('p, th, td, button, span')];
    const open = el.querySelector('.wc-story-open');
    const before = open?.previousElementSibling ?? null;
    return {
      width: Math.round(box.width),
      height: Math.round(box.height),
      boxHeight: Math.round(view.height),
      scrolls: getComputedStyle(scroller).overflowY === 'auto',
      overflowX: el.scrollWidth - el.clientWidth,
      overflowY: el.scrollHeight - el.clientHeight,
      pageOverflowX: document.documentElement.scrollWidth - window.innerWidth,
      // Cut off: wider than its box, or taller than a box that hides what does not fit (a large number's line box is
      // shorter than its glyphs by design, and hides nothing)
      clipped: texts.filter(
        (t) =>
          t.scrollWidth > t.clientWidth + 1 ||
          (getComputedStyle(t).overflowY !== 'visible' && t.scrollHeight > t.clientHeight + 1),
      ).length,
      outside: texts.filter((t) => {
        const r = t.getBoundingClientRect();
        return r.width > 0 && (r.left < box.left - 1 || r.right > box.right + 1 || r.bottom > box.bottom + 1);
      }).length,
      gapAboveButton:
        open && before ? Math.round(open.getBoundingClientRect().top - before.getBoundingClientRect().bottom) : -1,
      leadPx: parseFloat(
        getComputedStyle(el.querySelector('.wc-story-figure-lead .wc-story-figure-value') ?? el).fontSize,
      ),
      secondPx: parseFloat(
        getComputedStyle(el.querySelector('.wc-story-figure:not(.wc-story-figure-lead) .wc-story-figure-value') ?? el)
          .fontSize,
      ),
    };
  });
}

const SIZES = [
  { label: '375x667', width: 375, height: 667 },
  { label: '390x844', width: 390, height: 844 },
  { label: '900x900', width: 900, height: 900 },
  { label: '1280x900', width: 1280, height: 900 },
] as const;

test.describe('Story: the Brilliant and Great highlight card', () => {
  for (const size of SIZES) {
    test(`shows the totals, how often, the best game, year and latest date, and fits at ${size.label}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: size.width, height: size.height });
      const want = wantMarks(await openStory(page));
      const marks = card(page, 'marks');

      // The two totals, Brilliant first and larger, each with its words and the review's badge
      const figures = marks.locator('.wc-story-figure');
      await expect(figures).toHaveCount(2);
      await expect(figures.nth(0)).toHaveAttribute('data-testid', 'story-figure-brilliant');
      await expect(marks.getByTestId('story-figure-brilliant').locator('.wc-story-figure-value')).toHaveText(
        want.brilliant,
      );
      await expect(marks.getByTestId('story-figure-brilliant').locator('.wc-story-figure-label')).toHaveText(
        '!!Brilliant moves',
      );
      await expect(marks.getByTestId('story-figure-great').locator('.wc-story-figure-value')).toHaveText(want.great);
      await expect(marks.getByTestId('story-figure-great').locator('.wc-story-figure-label')).toHaveText(
        '!Great moves',
      );
      await expect(marks.locator('.wc-story-figure .wc-class-badge.wc-class-brilliant')).toHaveCount(1);
      await expect(marks.locator('.wc-story-figure .wc-class-badge.wc-class-great')).toHaveCount(1);

      await expect(marks.locator('.wc-story-sentence')).toHaveText(want.sentence);
      const rows = marks.locator('tbody tr');
      await expect(rows).toHaveCount(want.rows.length);
      for (const [i, [label, detail]] of want.rows.entries()) {
        await expect(rows.nth(i).locator('th')).toHaveText(label);
        await expect(rows.nth(i).locator('td')).toHaveText(detail);
      }
      await expect(marks.locator('.wc-story-note')).toHaveText([want.note]);
      // No move is named and no opponent: the summaries hold neither
      await expect(marks).not.toContainText(/sample_rival|ada-sample|chesscom:/);

      await scrollTo(page, marks);
      const m = await measure(marks);
      expect(m.pageOverflowX).toBeLessThanOrEqual(0);
      expect(m.overflowX).toBeLessThanOrEqual(1);
      expect(m.overflowY).toBeLessThanOrEqual(1);
      expect(m.clipped).toBe(0);
      expect(m.outside).toBe(0);
      expect(m.leadPx).toBeGreaterThan(m.secondPx);
      if (m.scrolls) {
        // The phone: the whole card is inside the Story's scroll box, and it is filled (no empty half under two totals)
        expect(m.height).toBeLessThanOrEqual(m.boxHeight);
        expect(m.height).toBeGreaterThanOrEqual(360);
        expect(m.gapAboveButton).toBeLessThanOrEqual(24);
      } else {
        // The wide grid: the card fills its cell beside Game phases (same top, height and width), under Mistakes
        const [phases, own, above] = [
          (await card(page, 'phases').boundingBox())!,
          (await card(page, 'marks').boundingBox())!,
          (await card(page, 'mistakes').boundingBox())!,
        ];
        expect(Math.abs(phases.y - own.y)).toBeLessThanOrEqual(1);
        expect(Math.abs(phases.height - own.height)).toBeLessThanOrEqual(1);
        expect(Math.abs(phases.width - own.width)).toBeLessThanOrEqual(1);
        expect(own.x).toBeGreaterThanOrEqual(phases.x + phases.width);
        expect(Math.abs(above.x - own.x)).toBeLessThanOrEqual(1);
        expect(own.x + own.width).toBeLessThanOrEqual(size.width);
        // Nothing but the button's own margin is left empty in the cell
        expect(m.gapAboveButton).toBeLessThanOrEqual(80);
      }
      await look(page, `marks-${size.label}`);
      await look(page, `marks-${size.label}-card`, 'story-card-marks');
    });
  }
});

test.describe('Story: Open this game', () => {
  for (const size of SIZES) {
    test(`every card that features one game has a real button of 44 px with its game's name, readable at ${size.label}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: size.width, height: size.height });
      await openStory(page);
      // Six buttons in all: none on a card about many games
      await expect(page.locator('[data-story-open]')).toHaveCount(OPENERS.length);
      for (const o of OPENERS) {
        const button = card(page, o.card).getByRole('button', { name: o.name, exact: true });
        await expect(button).toHaveCount(1);
        await expect(button).toHaveAttribute('data-testid', `story-open-${o.key}`);
        await expect(button).toHaveText(o.text);
        expect(await button.evaluate((el) => el.tagName)).toBe('BUTTON');
        await scrollTo(page, card(page, o.card));
        const box = (await button.boundingBox())!;
        expect(box.height).toBeGreaterThanOrEqual(44);
        // Its words are on one line
        expect(box.height).toBeLessThanOrEqual(48);
        const m = await measure(card(page, o.card));
        expect(m.pageOverflowX).toBeLessThanOrEqual(0);
        expect(m.overflowX).toBeLessThanOrEqual(1);
        expect(m.clipped).toBe(0);
        expect(m.outside).toBe(0);
        if (m.scrolls) expect(m.height).toBeLessThanOrEqual(m.boxHeight);
      }
      // Records: the two buttons sit side by side, each wide enough to read
      const [a, b] = [
        (await opener(page, 'longest').boundingBox())!,
        (await opener(page, 'longestWin').boundingBox())!,
      ];
      expect(Math.abs(a.y - b.y)).toBeLessThanOrEqual(1);
      expect(b.x).toBeGreaterThanOrEqual(a.x + a.width);
      await scrollTo(page, card(page, 'records'));
      await look(page, `records-${size.label}`, 'story-card-records');
      for (const id of ['bestGame', 'bestWin', 'comebacks'])
        await look(page, `${id}-${size.label}`, `story-card-${id}`);
    });
  }

  for (const size of [SIZES[1], SIZES[3]]) {
    test(`each button opens its own game as the Games list does, and coming back shows the same place, at ${size.label}`, async ({
      page,
    }) => {
      test.setTimeout(180_000);
      await page.setViewportSize({ width: size.width, height: size.height });
      const games = await openStory(page);
      for (const o of OPENERS) {
        const before = await scrollTo(page, card(page, o.card));
        expect(before.box + before.page).toBeGreaterThan(0);
        await opener(page, o.key).click();

        // The game, on the analysis board, with its stored numbers at once and "Review this game"
        await expect(page.getByTestId('analysis-layout')).toBeVisible();
        expect(await openGameId(page)).toBe(games[o.game]!.id);
        const panel = page.getByTestId('review-panel');
        await expect(panel).toBeVisible();
        await expect(panel).toContainText('Your numbers from this game');
        await expect(panel).toContainText(`${inventedFor(o.game).accuracy.toFixed(1)}%`);
        await expect(page.getByTestId('btn-review-start')).toHaveText('Review this game');
        await expect(page.getByTestId('btn-review-start')).toBeEnabled();

        // Back with the app's own navigation: Games is still on the Story, at the same card
        await page.getByTestId('mode-tab-games').click();
        await expect(page.getByTestId('games-tab-story')).toHaveAttribute('aria-selected', 'true');
        await expect(card(page, o.card)).toBeInViewport();
        await expect.poll(() => position(page)).toEqual(before);
      }
      await look(page, `back-on-story-${size.label}`);
    });
  }

  for (const size of [SIZES[0], SIZES[2]]) {
    test(`the place is kept through the other screens and the Games tabs too, at ${size.label}`, async ({ page }) => {
      await page.setViewportSize({ width: size.width, height: size.height });
      await openStory(page);
      const before = await scrollTo(page, card(page, 'bestWin'));
      expect(before.box + before.page).toBeGreaterThan(0);

      // Another Games tab and back
      await press(page.getByTestId('games-tab-library'));
      await expect(page.getByTestId('games-row').first()).toBeVisible();
      await page.getByTestId('games-tab-story').click();
      await expect(card(page, 'bestWin')).toBeInViewport();
      await expect.poll(() => position(page)).toEqual(before);

      // Another screen and back
      await press(page.getByTestId('mode-tab-play'));
      await expect(page.getByTestId('games-tab-story')).toHaveCount(0);
      await page.getByTestId('mode-tab-games').click();
      await expect(card(page, 'bestWin')).toBeInViewport();
      await expect.poll(() => position(page)).toEqual(before);

      // A game opened from a card, then back
      await opener(page, 'bestWin').click();
      await expect(page.getByTestId('analysis-layout')).toBeVisible();
      await page.getByTestId('mode-tab-games').click();
      await expect(card(page, 'bestWin')).toBeInViewport();
      await expect.poll(() => position(page)).toEqual(before);
    });
  }

  test('a game that is no longer stored has no button; the next count features another game', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const games = await openStory(page);
    await scrollTo(page, card(page, 'bestGame'));
    await expect(opener(page, 'bestGame')).toBeVisible();
    await expect(page.getByTestId('story-value-bestGame')).toHaveText('92.0%');

    // The game is deleted while the Story is on screen: its button goes, the other five stay
    await page.evaluate((id) => window.__wizardChessLibrary!.library.deleteGames([id]), games[MOST_ACCURATE]!.id);
    await expect(opener(page, 'bestGame')).toHaveCount(0);
    await expect(page.locator('[data-story-open]')).toHaveCount(OPENERS.length - 1);
    for (const o of OPENERS.filter((x) => x.key !== 'bestGame')) await expect(opener(page, o.key)).toHaveCount(1);

    // The Story counts again when it is next shown: the most accurate game is now another one, with its button
    await page.getByTestId('games-tab-library').click();
    await page.getByTestId('games-tab-story').click();
    const accuracies = games.map((_, i) => inventedFor(i).accuracy);
    const next = accuracies.indexOf(Math.max(...accuracies.filter((_, i) => i !== MOST_ACCURATE)));
    await expect(page.getByTestId('story-value-bestGame')).toHaveText(`${accuracies[next]!.toFixed(1)}%`);
    await expect(page.getByTestId('story-value-totals')).toHaveText('29');
    await opener(page, 'bestGame').click();
    await expect(page.getByTestId('analysis-layout')).toBeVisible();
    expect(await openGameId(page)).toBe(games[next]!.id);
  });

  test('a history with no review numbers has the Best win button only, and no Brilliant and Great card', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(SAMPLE);
    await expect(page.getByTestId('app-shell')).toHaveAttribute('data-first-run', 'applied', { timeout: 15_000 });
    await closeWelcomeIfShown(page);
    await expect(page.getByTestId('story-value-totals')).toHaveText('30', { timeout: 20_000 });
    await expect(card(page, 'marks')).toHaveCount(0);
    await expect(page.locator('[data-story-open]')).toHaveCount(1);
    await expect(card(page, 'bestWin').getByRole('button', { name: 'Open your best win', exact: true })).toBeVisible();
    await expect(card(page, 'records').locator('[data-story-open]')).toHaveCount(0);
  });
});
