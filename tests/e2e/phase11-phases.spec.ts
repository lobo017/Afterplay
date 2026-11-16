import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type Page, type Route } from '@playwright/test';
import { saveMyAccounts } from './helpers/accounts';
import { SITE_URL } from './helpers/site';

// Accuracy by game phase: the Story's "Game phases" card, its place in the wide "How well you play" grid, and the Insights
// card. The sample link's history (30 invented games for "ada-sample") gets invented summaries with phase numbers; every
// expected number is worked out here from those numbers, not by the app. Nothing reaches a real network.
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
const touch = () => test.info().project.name === 'webkit-iphone';

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
  [field: string]: unknown;
}
type Tuple = [number, number, number, number, number];

/** The invented phase numbers of game `i`: every third game never reaches an endgame. */
function phasesFor(i: number): [Tuple, Tuple, Tuple] {
  return [
    [10, 90 + (i % 7), i % 2, 0, 0],
    [14 + (i % 5), 78 + (i % 9), 1 + (i % 3), 1, i % 2],
    i % 3 === 0 ? [0, 0, 0, 0, 0] : [4 + (i % 4), 85 + (i % 6), i % 2, 0, 0],
  ];
}

function history(withPhases: boolean): SampleGame[] {
  const games = (JSON.parse(fs.readFileSync(SAMPLE_HISTORY, 'utf8')) as { games: SampleGame[] }).games;
  return games.map((g, i) => {
    const phases = phasesFor(i);
    const sum = (k: number) => phases.reduce((n, t) => n + t[k]!, 0);
    const accuracy = 62 + ((i * 7) % 31);
    return {
      ...g,
      accuracy,
      analysis: {
        preset: null,
        savedAt: 1,
        depth: 18,
        summaryOnly: true,
        plies: 2 * sum(0),
        whiteAccuracy: g.playerColor === 'w' ? accuracy : null,
        blackAccuracy: g.playerColor === 'b' ? accuracy : null,
        sides: {
          [g.playerColor]: {
            moves: sum(0),
            acpl: 40,
            inaccuracy: 2,
            mistake: sum(3),
            blunder: sum(2),
            miss: sum(4),
            brilliant: i % 11 === 0 ? 1 : 0,
            great: i % 7 === 0 ? 1 : 0,
            low: 10 + i,
            drop: 20,
            dropPly: 11,
            ...(withPhases ? { phases } : {}),
          },
        },
      },
    };
  });
}

/** What the cards must show, from the numbers above. */
function expected(games: SampleGame[]) {
  const per = games.map((_, i) => phasesFor(i));
  return [0, 1, 2].map((k) => {
    const moves = per.reduce((n, p) => n + p[k]![0], 0);
    const weighted = per.reduce((n, p) => n + p[k]![0] * p[k]![1], 0);
    const blunders = per.reduce((n, p) => n + p[k]![2], 0);
    return {
      moves,
      accuracy: `${(weighted / moves).toFixed(1)}%`,
      blunders: ((blunders / moves) * 10).toFixed(2),
      games: per.filter((p) => p[k]![0] > 0).length,
    };
  });
}

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

async function openWith(page: Page, games: SampleGame[]): Promise<void> {
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
}

const cardOrder = (page: Page) =>
  page
    .locator('[data-testid="story-scroll"] > section')
    .evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.card));

test.describe('Game phases: the Story card', () => {
  test('is made after Mistakes with the three phases, where you slip, and the endgames reached; it fits a 375x667 phone', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    const games = history(true);
    await openWith(page, games);
    const ids = await cardOrder(page);
    expect(ids.indexOf('phases')).toBe(ids.indexOf('mistakes') + 1);
    expect(ids[ids.indexOf('phases') + 1]).toBe('marks');

    const want = expected(games);
    const card = page.getByTestId('story-card-phases');
    for (const [k, label] of ['Opening', 'Middlegame', 'Endgame'].entries()) {
      const row = card.locator('tr', { hasText: label });
      await expect(row).toContainText(`${want[k]!.accuracy} accuracy`);
      await expect(row).toContainText(`${want[k]!.blunders} blunders per 10 moves`);
    }
    await expect(card).toContainText(`${want[2]!.games} of ${games.length} games reached an endgame.`);
    const names = ['opening', 'middlegame', 'endgame'];
    const acc = want.map((w) => parseFloat(w.accuracy));
    const best = acc.indexOf(Math.max(...acc));
    const worst = acc.indexOf(Math.min(...acc));
    await expect(card).toContainText(
      `You play best in the ${names[best]} (${want[best]!.accuracy}) and worst in the ${names[worst]} (${want[worst]!.accuracy}).`,
    );
    const rate = want.map((w) => parseFloat(w.blunders));
    const most = rate.indexOf(Math.max(...rate));
    await expect(card).toContainText(`You blunder most in the ${names[most]}: ${want[most]!.blunders} per 10 moves`);

    // The card is fully inside the scroll box once scrolled to
    const fit = await card.evaluate((el) => {
      el.scrollIntoView({ block: 'start' });
      const scroller = el.closest('.wc-story-scroll')!.getBoundingClientRect();
      const r = el.getBoundingClientRect();
      return { top: r.top - scroller.top, bottom: scroller.bottom - r.bottom };
    });
    expect(fit.top).toBeGreaterThanOrEqual(-1);
    expect(fit.bottom).toBeGreaterThanOrEqual(-1);
    await look(page, 'story-phases-375x667', 'story-card-phases');
  });

  test('looks right on a 390 px phone', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openWith(page, history(true));
    await page.getByTestId('story-card-phases').scrollIntoViewIfNeeded();
    await expect(page.getByTestId('story-card-phases')).toBeVisible();
    await look(page, 'story-phases-390', 'story-card-phases');
  });

  test('is left out when no game has phase numbers (an older history)', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openWith(page, history(false));
    const ids = await cardOrder(page);
    expect(ids).toContain('mistakes');
    expect(ids).not.toContain('phases');
  });

  test('the wide layout shows "How well you play" as two rows of two, equal in size', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await openWith(page, history(true));
    const box = async (id: string) => (await page.getByTestId(`story-card-${id}`).boundingBox())!;
    const [a, m, p, b] = [await box('accuracy'), await box('mistakes'), await box('phases'), await box('marks')];
    const near = (x: number, y: number) => expect(Math.abs(x - y)).toBeLessThanOrEqual(1);
    // Accuracy and Mistakes side by side, Phases and Brilliant and Great under them
    near(a.y, m.y);
    near(p.y, b.y);
    near(a.x, p.x);
    near(m.x, b.x);
    expect(m.x).toBeGreaterThan(a.x + a.width - 1);
    expect(p.y).toBeGreaterThan(a.y + Math.min(a.height, m.height) - 1);
    near(a.width, m.width);
    near(p.width, b.width);
    near(a.width, p.width);
    await page.getByTestId('story-card-accuracy').scrollIntoViewIfNeeded();
    await look(page, 'story-wide-1280');
  });
});

test.describe('Game phases: the Insights card', () => {
  async function openInsights(page: Page, games: SampleGame[]): Promise<void> {
    await openWith(page, games);
    await page.getByTestId('games-tab-insights').click();
    await expect(page.getByTestId('insights-summary')).toBeVisible();
  }

  test('from the summaries: bars with accuracy and blunders as text, and no click promised without a review made here', async ({
    page,
  }) => {
    await page.setViewportSize(touch() ? { width: 390, height: 844 } : { width: 1280, height: 900 });
    const games = history(true);
    await openInsights(page, games);
    const want = expected(games);
    for (const [k, phase] of ['opening', 'middlegame', 'endgame'].entries()) {
      const bar = page.getByTestId(`phase-${phase}`);
      await expect(bar).toContainText(want[k]!.accuracy);
      await expect(bar).toContainText(`${want[k]!.blunders} blunders per 10 moves`);
      // Not a button: nothing to open without a review made on this device
      await expect(bar).not.toHaveAttribute('role', 'button');
      expect(await bar.evaluate((el) => el.tagName)).toBe('DIV');
    }
    await expect(page.getByTestId('chart-phase').locator('button')).toHaveCount(0);
    const hint = page.locator('section[aria-labelledby="ins-phase"] .wc-insight-hint');
    await expect(hint).toHaveText(`How well you play each part of the game, over ${games.length} reviewed games.`);
    await expect(hint).not.toContainText(/Tap|Click/);
    await page.getByTestId('chart-phase').scrollIntoViewIfNeeded();
    await look(page, 'insights-phases', 'chart-phase');
  });

  test('a review made on this device makes the bars buttons again, worst moves first', async ({ page }) => {
    test.setTimeout(240_000);
    await page.setViewportSize(touch() ? { width: 390, height: 844 } : { width: 1280, height: 900 });
    const games = history(true);
    await openWith(page, games);
    // A short game of mine (the sample link saves the Chess.com name "ada-sample"), reviewed on Quick through the queue
    await page.getByTestId('games-tab-library').click();
    await saveMyAccounts(page, { lichess: 'ada-sample', chesscom: 'ada-sample' });
    await page.getByTestId('btn-games-import').click();
    await page.getByTestId('btn-games-paste').click();
    await page.getByTestId('games-paste-text').evaluate((el) => {
      (el as HTMLTextAreaElement).value =
        '[Event "Casual"]\n[White "ada-sample"]\n[Black "Opp"]\n[Result "0-1"]\n[Date "2026.10.01"]\n\n1. e4 e5 2. Qh5 Nc6 3. Qxe5+ Nxe5 0-1';
    });
    await page.getByTestId('btn-games-paste-import').click();
    await expect(page.getByTestId('games-row')).toHaveCount(games.length + 1);
    await page.evaluate(async () => {
      const api = await window.__wizardChessLibraryReady!;
      const all = await api.library.list();
      api.queue.enqueue(
        all.filter((g) => g.source !== 'chesscom').map((g) => g.id),
        'quick',
      );
    });
    await expect(page.locator('[data-analysis="analyzed"]')).toHaveCount(1, { timeout: 120_000 });

    await page.getByTestId('games-tab-insights').click();
    const bar = page.getByTestId('phase-opening');
    await expect(bar).toHaveAttribute('role', 'button');
    const hint = page.locator('section[aria-labelledby="ins-phase"] .wc-insight-hint');
    await expect(hint).toHaveText(
      `How well you play each part of the game. ${touch() ? 'Tap' : 'Click'} a bar to see your moves from games you reviewed here, worst first.`,
    );
    await bar.click();
    await expect(page.getByTestId('insights-detail')).toBeVisible();
    await expect(page.getByTestId('insights-detail-count')).toContainText('positions');
    // The numbers on the bars are still the summaries' (the file's games plus nothing the Story leaves out)
    await expect(bar).toContainText('blunders per 10 moves');
  });
});
