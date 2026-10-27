import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';

// Phase 6b: screenshots of every screen at desktop and phone width, for the UX audit and
// for checking each redesign step. Each test also checks the page never scrolls sideways.
const SCREENSHOT_DIR = path.join('test-results', 'phase6b-screens');

const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'phone', width: 390, height: 844 },
] as const;

/** Two short games for the Games list: one mine (Lobo017 on Lichess), one not. */
const GAMES_PGN = `[Event "Rated blitz game"]
[Site "https://lichess.org/Ux6bTst1"]
[Date "2026.10.18"]
[White "Opponent1"]
[Black "Lobo017"]
[Result "0-1"]
[WhiteElo "1410"]
[BlackElo "1397"]
[TimeControl "180+0"]

1. e4 e5 2. Nf3 Nc6 3. Bc4 Nd4 4. Nxe5 Qg5 5. Nxf7 Qxg2 6. Rf1 Qxe4+ 7. Be2 Nf3# 0-1

[Event "Casual game"]
[Site "Chess.com"]
[Date "2026.10.17"]
[White "Someone"]
[Black "Another"]
[Result "1-0"]

1. e4 f5 2. exf5 g5 3. Qh5# 1-0`;

async function shot(page: Page, vp: string, name: string): Promise<void> {
  // Let colour transitions (e.g. the tab just clicked) finish first
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((a) => a instanceof CSSTransition)
        .map((a) => a.finished.catch(() => undefined)),
    ),
  );
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, `${vp}-${name}.png`), fullPage: true });
}

async function expectNoSideScroll(page: Page): Promise<void> {
  const { overflow, wide } = await page.evaluate(() => {
    const vw = window.innerWidth;
    const wide = [...document.querySelectorAll<HTMLElement>('body *')]
      .filter((el) => el.getBoundingClientRect().right > vw + 0.5 && el.offsetParent !== null)
      .slice(0, 8)
      .map(
        (el) =>
          `${el.tagName.toLowerCase()}.${[...el.classList].join('.')}[${el.dataset.testid ?? ''}] right=${Math.round(el.getBoundingClientRect().right)}`,
      );
    return { overflow: document.documentElement.scrollWidth - vw, wide };
  });
  expect
    .soft(overflow, `page scrolls sideways; elements past the right edge: ${wide.join(', ')}`)
    .toBeLessThanOrEqual(0);
}

async function squareCenter(page: Page, root: string, sq: string) {
  const box = await page.getByTestId(root).getByTestId(`square-${sq}`).boundingBox();
  if (!box) throw new Error(`square-${sq} has no box`);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

for (const vp of VIEWPORTS) {
  test.describe(`screens at ${vp.name} width`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } });

    test(`play, analysis and review (${vp.name})`, async ({ page }) => {
      test.setTimeout(180_000);
      await page.goto('/');
      await expect(page.getByTestId('play-layout')).toBeVisible();
      await shot(page, vp.name, 'play-start');
      await expectNoSideScroll(page);

      // A selected piece shows its legal-move hints
      const e2 = await squareCenter(page, 'play-layout', 'e2');
      await page.mouse.click(e2.x, e2.y);
      await expect(page.getByTestId('overlay-legal-dot')).toHaveCount(2);
      await shot(page, vp.name, 'play-selected');

      // Mid-drag: the held piece and the square under it
      await page.mouse.click(e2.x, e2.y);
      const g1 = await squareCenter(page, 'play-layout', 'g1');
      const f3 = await squareCenter(page, 'play-layout', 'f3');
      await page.mouse.move(g1.x, g1.y);
      await page.mouse.down();
      await page.mouse.move((g1.x + f3.x) / 2, (g1.y + f3.y) / 2, { steps: 4 });
      await page.mouse.move(f3.x + 6, f3.y - 4, { steps: 4 });
      await shot(page, vp.name, 'play-dragging');
      await page.mouse.up();

      await page.getByTestId('mode-tab-review').click();
      await expect(page.getByTestId('analysis-layout')).toBeVisible();
      await shot(page, vp.name, 'analysis-empty');
      await expectNoSideScroll(page);

      // Review the sample game on Quick
      await page.getByTestId('select-review-preset').selectOption('quick');
      await page.getByTestId('btn-review-sample').click();
      await expect(page.getByTestId('review-panel')).toHaveAttribute('data-state', 'done', { timeout: 150_000 });
      await shot(page, vp.name, 'review-done');
      await expectNoSideScroll(page);

      // Step to the first key moment
      await page.getByTestId('review-key-moments').locator('button').first().click();
      await shot(page, vp.name, 'review-key-moment');
    });

    test(`games, today and puzzles (${vp.name})`, async ({ page }) => {
      test.setTimeout(90_000);
      await page.goto('/');
      await page.getByTestId('mode-tab-games').click();
      await page.evaluate(() => window.__wizardChessLibraryReady);
      await expect(page.getByTestId('games-list')).toBeVisible();
      await shot(page, vp.name, 'games-empty');

      await page.getByTestId('btn-games-import').click();
      await page.getByTestId('btn-games-paste').click();
      await page.getByTestId('games-paste-text').fill(GAMES_PGN);
      await page.getByTestId('btn-games-paste-import').click();
      await expect(page.getByTestId('games-row')).toHaveCount(2);
      await shot(page, vp.name, 'games-list');
      await expectNoSideScroll(page);

      await page.getByTestId('mode-tab-train').click();
      await expect(page.getByTestId('today-screen')).toBeVisible();
      await shot(page, vp.name, 'today');
      await expectNoSideScroll(page);

      await page.getByTestId('btn-train-start').click();
      await expect(page.getByTestId('puzzle-trainer')).toBeVisible();
      await expect(page.getByTestId('puzzle-status')).not.toHaveAttribute('data-state', 'idle', { timeout: 30_000 });
      await shot(page, vp.name, 'puzzles');
      await expectNoSideScroll(page);
    });
  });
}
