import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { SITE_URL } from './helpers/site';

// Popups and the Games tabs on small screens. Every popup, sheet, menu and overlay that covers the page has an X at its
// top right (44 × 44 px or more, named "Close", or "Close <title>" where the popup's name is part of it), fits the
// visible area (below the top bar, above the bottom tab bar), and scrolls inside itself with its head and X still on
// screen. The Games tabs stay visible and tappable after an import. Chess.com is answered here by route interception
// with invented players and games; nothing reaches a real network.

const SIZES = [
  { width: 375, height: 667 },
  { width: 390, height: 844 },
  { width: 844, height: 390 },
] as const;
const PHONES = [
  { width: 390, height: 844 },
  { width: 375, height: 667 },
] as const;
const touch = () => test.info().project.name === 'webkit-iphone';

const QUEEN_BLUNDER_PGN = `[Event "Review sign check"]
[White "White"]
[Black "Black"]
[Result "0-1"]

1. e4 e5 2. Qh5 Nc6 3. Qxe5+ Nxe5 0-1`;

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The part of the screen a popup may use: below the sticky top bar and above a fixed bottom tab bar. */
const band = (page: Page) =>
  page.evaluate(() => {
    const bar = document.querySelector<HTMLElement>('.wc-topbar');
    const nav = document.querySelector<HTMLElement>('.wc-nav');
    const navFixed = !!nav && getComputedStyle(nav).position === 'fixed';
    return {
      top: bar ? bar.getBoundingClientRect().bottom : 0,
      bottom: navFixed ? nav!.getBoundingClientRect().top : innerHeight,
      height: innerHeight,
      width: innerWidth,
    };
  });

/** Where a popup and its X are, whether the X covers any of the popup's text, and what is under the X's center. */
function geometry(page: Page, popupId: string, closeId: string) {
  return page.evaluate(
    ([popupId, closeId]) => {
      const popup = document.querySelector<HTMLElement>(`[data-testid="${popupId}"]`)!;
      const close = document.querySelector<HTMLElement>(`[data-testid="${closeId}"]`)!;
      const box = (r: DOMRect) => ({ x: r.x, y: r.y, w: r.width, h: r.height });
      const p = popup.getBoundingClientRect();
      const c = close.getBoundingClientRect();
      // Text of the popup (not the X's own) that the X sits on
      const walker = document.createTreeWalker(popup, NodeFilter.SHOW_TEXT);
      let overlaps = 0;
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (close.contains(node) || !(node.textContent ?? '').trim()) continue;
        const range = document.createRange();
        range.selectNodeContents(node);
        for (const r of range.getClientRects()) {
          if (r.width === 0 || r.height === 0) continue;
          const ix = Math.min(r.right, c.right) - Math.max(r.left, c.left);
          const iy = Math.min(r.bottom, c.bottom) - Math.max(r.top, c.top);
          if (ix > 0.5 && iy > 0.5) overlaps++;
        }
      }
      const hit = document.elementFromPoint(c.x + c.width / 2, c.y + c.height / 2);
      return { popup: box(p), close: box(c), overlaps, hitsClose: !!hit && close.contains(hit) };
    },
    [popupId, closeId] as const,
  );
}

/** The X: visible, named, at least 44 × 44, at the popup's top right, on no text, and the thing under a finger. */
async function expectCloseButton(
  page: Page,
  popupId: string,
  closeId: string,
  name: string,
  where: { within?: Box } = {},
): Promise<void> {
  const close = page.getByTestId(closeId);
  await expect(close).toBeVisible();
  await expect(close).toHaveAttribute('aria-label', name);
  await expect(close).toHaveAccessibleName(name);
  // Measured at rest (a sheet slides in for 180 ms)
  await expect
    .poll(() => page.getByTestId(popupId).evaluate((el) => el.getAnimations({ subtree: true }).length))
    .toBe(0);
  const g = await geometry(page, popupId, closeId);
  expect(g.close.w, `${closeId} width`).toBeGreaterThanOrEqual(44);
  expect(g.close.h, `${closeId} height`).toBeGreaterThanOrEqual(44);
  const area = where.within ?? g.popup;
  // Top right: its right edge near the area's right edge, its top near the area's top
  expect(area.x + area.w - (g.close.x + g.close.w), `${closeId} at the right`).toBeLessThanOrEqual(24);
  expect(area.x + area.w - (g.close.x + g.close.w), `${closeId} inside`).toBeGreaterThanOrEqual(-0.5);
  expect(g.close.y - area.y, `${closeId} at the top`).toBeLessThanOrEqual(24);
  expect(g.close.y - area.y, `${closeId} inside`).toBeGreaterThanOrEqual(-0.5);
  expect(g.overlaps, `${closeId} covers no text`).toBe(0);
  expect(g.hitsClose, `${closeId} is not covered`).toBe(true);
}

/** A popup that is part of the page: inside the band (top bar to bottom tab bar), no taller than it. */
async function expectFitsBand(page: Page, popupId: string): Promise<void> {
  const b = await band(page);
  const p = (await page.getByTestId(popupId).boundingBox())!;
  expect(p.height, `${popupId} no taller than the visible area`).toBeLessThanOrEqual(b.bottom - b.top + 0.5);
  expect(p.y, `${popupId} below the top bar`).toBeGreaterThanOrEqual(b.top - 0.5);
  expect(p.y + p.height, `${popupId} above the bottom tab bar`).toBeLessThanOrEqual(b.bottom + 0.5);
  expect(p.x).toBeGreaterThanOrEqual(-0.5);
  expect(p.x + p.width).toBeLessThanOrEqual(b.width + 0.5);
}

/** A modal sheet: inside the screen, no taller than it. */
async function expectFitsScreen(page: Page, popupId: string): Promise<void> {
  const b = await band(page);
  // A sheet slides in for 180 ms; measure where it comes to rest
  await expect.poll(() => page.getByTestId(popupId).evaluate((el) => el.getAnimations().length)).toBe(0);
  const p = (await page.getByTestId(popupId).boundingBox())!;
  expect(p.height).toBeLessThanOrEqual(b.height + 0.5);
  expect(p.y).toBeGreaterThanOrEqual(-0.5);
  expect(p.y + p.height).toBeLessThanOrEqual(b.height + 0.5);
  expect(p.x + p.width).toBeLessThanOrEqual(b.width + 0.5);
}

/**
 * The part that scrolls does so inside the popup; scrolled to its end, the X (and the head) stay where they were.
 * Returns whether the content was taller than the room it had.
 */
async function expectScrollsInside(page: Page, scrollSelector: string, closeId: string): Promise<boolean> {
  const scroller = page.locator(scrollSelector);
  expect(await scroller.evaluate((el) => getComputedStyle(el).overflowY)).toMatch(/auto|scroll/);
  const before = (await page.getByTestId(closeId).boundingBox())!;
  const overflows = await scroller.evaluate((el) => {
    const more = el.scrollHeight > el.clientHeight + 1;
    el.scrollTop = el.scrollHeight;
    return more;
  });
  if (overflows) expect(await scroller.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  const after = (await page.getByTestId(closeId).boundingBox())!;
  expect(Math.abs(after.y - before.y), `${closeId} stays while the content scrolls`).toBeLessThanOrEqual(0.5);
  await expect(page.getByTestId(closeId)).toBeVisible();
  return overflows;
}

async function press(page: Page, testId: string): Promise<void> {
  const el = page.getByTestId(testId);
  if (touch()) await el.tap();
  else await el.click();
}

test.describe('Popups: an X, the visible area, scrolling inside', () => {
  for (const size of SIZES) {
    test(`Settings sheet, a ⋯ menu, the performance overlay and the link notice at ${size.width}x${size.height}`, async ({
      page,
    }) => {
      await page.setViewportSize(size);
      await page.goto('/');
      await expect(page.getByTestId('play-layout')).toBeVisible();

      // Settings: its X is named after it; the head stays while the long body scrolls
      await press(page, 'btn-settings');
      await expect(page.getByTestId('settings-sheet')).toBeVisible();
      await expectCloseButton(page, 'settings-sheet', 'settings-sheet-close', 'Close Settings');
      await expectFitsScreen(page, 'settings-sheet');
      expect(await expectScrollsInside(page, '[data-testid="settings-sheet-body"]', 'settings-sheet-close')).toBe(true);
      await press(page, 'settings-sheet-close');
      await expect(page.getByTestId('settings-sheet')).toBeHidden();
      // Escape still closes it
      await press(page, 'btn-settings');
      await expect(page.getByTestId('settings-sheet')).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('settings-sheet')).toBeHidden();

      // A menu (Games › Import): a head with its name and the X; the items are still the only menu items
      await press(page, 'mode-tab-games');
      await press(page, 'btn-games-import');
      await expect(page.getByTestId('btn-games-import-popup')).toBeVisible();
      await expect(page.getByTestId('btn-games-import-list').getByRole('menuitem')).toHaveCount(2);
      await expectCloseButton(page, 'btn-games-import-popup', 'btn-games-import-close', 'Close');
      await expectFitsBand(page, 'btn-games-import-popup');
      await expectScrollsInside(page, '[data-testid="btn-games-import-list"]', 'btn-games-import-close');
      await press(page, 'btn-games-import-close');
      await expect(page.getByTestId('btn-games-import-popup')).toBeHidden();
      await expect(page.getByTestId('btn-games-import')).toHaveAttribute('aria-expanded', 'false');
      // Escape still closes it
      await press(page, 'btn-games-import');
      await expect(page.getByTestId('btn-games-import-popup')).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('btn-games-import-popup')).toBeHidden();

      // The performance overlay (Settings › About): its X turns it off, and the switch follows
      await press(page, 'btn-settings');
      const toggle = page.getByTestId('toggle-dev-overlay');
      await toggle.scrollIntoViewIfNeeded();
      await press(page, 'toggle-dev-overlay');
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('settings-sheet')).toBeHidden();
      await expect(page.getByTestId('dev-overlay')).toBeVisible();
      await expectCloseButton(page, 'dev-overlay', 'dev-overlay-close', 'Close');
      await expectFitsBand(page, 'dev-overlay');
      await expectScrollsInside(page, '[data-testid="dev-overlay"]', 'dev-overlay-close');
      await press(page, 'dev-overlay-close');
      await expect(page.getByTestId('dev-overlay')).toBeHidden();
      await expect(toggle).toHaveAttribute('aria-checked', 'false');

      // The notice of an unknown set-up link: OK and the X both close it
      await page.goto('/start/no-such-link/');
      await expect(page.getByTestId('app-notice')).toBeVisible({ timeout: 15_000 });
      await expectCloseButton(page, 'app-notice', 'app-notice-close', 'Close');
      await expectFitsBand(page, 'app-notice');
      await press(page, 'app-notice-close');
      await expect(page.getByTestId('app-notice')).toBeHidden();
    });

    test(`Review: the info popup, the status details, the ⋯ menu and the Load sheet at ${size.width}x${size.height}`, async ({
      page,
    }) => {
      test.setTimeout(120_000);
      await page.setViewportSize(size);
      await page.goto('/');
      await press(page, 'mode-tab-review');
      await expect(page.getByTestId('review-panel')).toBeVisible();
      await page.evaluate((pgn) => window.__wizardChessAnalysis!.controller.importPgn(pgn), QUEEN_BLUNDER_PGN);
      await press(page, 'btn-review-start');
      await expect(page.getByTestId('review-panel')).toHaveAttribute('data-state', 'done', { timeout: 60_000 });

      // The info popup, opened with its "i" low on the screen (as on the phone where it ran behind the tab bar)
      const info = page.getByTestId('btn-review-formulas');
      await info.scrollIntoViewIfNeeded();
      const b = await band(page);
      await info.evaluate((el, bottom) => {
        const r = el.getBoundingClientRect();
        window.scrollBy(0, r.bottom - (bottom - 6));
      }, b.bottom);
      await press(page, 'btn-review-formulas');
      const formulas = page.getByTestId('review-formulas-tooltip');
      await expect(formulas).toBeVisible();
      await expect(info).toHaveAttribute('aria-expanded', 'true');
      await expect(page.getByTestId('review-formulas-title')).toHaveText('How these numbers are computed');
      await expectFitsBand(page, 'review-formulas-tooltip');
      await expectCloseButton(page, 'review-formulas-tooltip', 'review-formulas-close', 'Close');
      const title = (await page.getByTestId('review-formulas-title').boundingBox())!;
      await expectScrollsInside(
        page,
        '[data-testid="review-formulas-tooltip"] .wc-popup-body',
        'review-formulas-close',
      );
      // The head stays too, and the last line can be reached
      expect(
        Math.abs((await page.getByTestId('review-formulas-title').boundingBox())!.y - title.y),
      ).toBeLessThanOrEqual(0.5);
      await expect(formulas.getByText('far below a human player')).toBeInViewport();
      await press(page, 'review-formulas-close');
      await expect(formulas).toBeHidden();
      await expect(info).toHaveAttribute('aria-expanded', 'false');
      // Escape still closes it
      await press(page, 'btn-review-formulas');
      await expect(formulas).toBeVisible();
      await page.keyboard.press('Escape');
      // (a mouse still over the "i" shows it on hover, as before: move it away)
      if (!touch()) await page.mouse.move(2, 2);
      await expect(formulas).toBeHidden();

      // The status details
      await press(page, 'review-progress');
      const statusTip = page.getByTestId('review-status-tooltip');
      await expect(statusTip).toBeVisible();
      await expect(statusTip).toHaveText(/^7 positions in \d+\.\d s · mean depth/);
      await expectFitsBand(page, 'review-status-tooltip');
      await expectCloseButton(page, 'review-status-tooltip', 'review-status-close', 'Close');
      await press(page, 'review-status-close');
      await expect(statusTip).toBeHidden();

      // The Review ⋯ menu
      await press(page, 'review-menu');
      await expect(page.getByTestId('review-menu-popup')).toBeVisible();
      await expectCloseButton(page, 'review-menu-popup', 'review-menu-close', 'Close');
      await expectFitsBand(page, 'review-menu-popup');
      await expectScrollsInside(page, '[data-testid="review-menu-list"]', 'review-menu-close');
      await press(page, 'review-menu-close');
      await expect(page.getByTestId('review-menu-popup')).toBeHidden();

      // The Load FEN or PGN sheet
      await page.evaluate(() => window.scrollTo(0, 0));
      await press(page, 'btn-load-pgn');
      await expect(page.getByTestId('pgn-sheet')).toBeVisible();
      await expectCloseButton(page, 'pgn-sheet', 'pgn-sheet-close', 'Close Load FEN or PGN');
      await expectFitsScreen(page, 'pgn-sheet');
      await expectScrollsInside(page, '[data-testid="pgn-sheet-body"]', 'pgn-sheet-close');
      await press(page, 'pgn-sheet-close');
      await expect(page.getByTestId('pgn-sheet')).toBeHidden();
    });

    test(`the promotion picker's X at ${size.width}x${size.height}`, async ({ page }) => {
      await page.setViewportSize(size);
      await page.goto('/');
      await expect(page.getByTestId('play-layout')).toBeVisible();
      const board = page.getByTestId('play-layout').getByTestId('chess-board');
      const boardBox = async (): Promise<Box> => {
        const r = (await board.boundingBox())!;
        return { x: r.x, y: r.y, w: r.width, h: r.height };
      };

      // On the a-file: the X in the board's top right corner
      await page.evaluate(() => window.__wizardChessPlay!.controller.loadPosition('8/P6k/8/8/8/8/8/K7 w - - 0 1', 'w'));
      await page.getByTestId('square-a7').click();
      await page.getByTestId('square-a8').click();
      await expect(page.getByTestId('promotion-picker')).toBeVisible();
      await expectCloseButton(page, 'promotion-backdrop', 'promotion-close', 'Close', { within: await boardBox() });
      await page.getByTestId('promotion-close').click();
      await expect(page.getByTestId('promotion-picker')).toBeHidden();
      await expect(page.getByTestId('piece-a7')).toBeVisible();

      // On the h-file the picker takes that corner: the X goes on the square beside it, covering no choice
      await page.evaluate(() => window.__wizardChessPlay!.controller.loadPosition('8/k6P/8/8/8/8/8/K7 w - - 0 1', 'w'));
      await page.getByTestId('square-h7').click();
      await page.getByTestId('square-h8').click();
      await expect(page.getByTestId('promotion-picker')).toBeVisible();
      const picker = (await page.getByTestId('promotion-picker').boundingBox())!;
      const close = (await page.getByTestId('promotion-close').boundingBox())!;
      const bb = await boardBox();
      expect(close.width).toBeGreaterThanOrEqual(44);
      expect(close.height).toBeGreaterThanOrEqual(44);
      expect(close.x + close.width, 'left of the picker').toBeLessThanOrEqual(picker.x + 0.5);
      expect(bb.x + bb.w - (close.x + close.width), 'one square from the right').toBeLessThanOrEqual(bb.w / 8 + 6);
      expect(close.y - bb.y, 'in the top row').toBeLessThanOrEqual(8);
      expect((await geometry(page, 'promotion-backdrop', 'promotion-close')).hitsClose).toBe(true);
      // Escape still cancels it
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('promotion-picker')).toBeHidden();
      await expect(page.getByTestId('piece-h7')).toBeVisible();
    });
  }
});

// ---------------------------------------------------------------------------------------------------------------------
// The Games tabs after an import (on a phone they ended up under the top bar)
// ---------------------------------------------------------------------------------------------------------------------
const API = 'https://api.chess.com';
const PLAYER = 'Mock_Tabs_A';
const base = `${API}/pub/player/${PLAYER.toLowerCase()}/games`;
const MONTHS = ['2024-05', '2024-06'] as const;
const monthUrl = (m: string) => `${base}/${m.slice(0, 4)}/${m.slice(5, 7)}`;

function archiveGame(id: number, date: string): { url: string; pgn: string } {
  const url = `https://www.chess.com/game/live/${id}`;
  const tags = [
    ['Event', 'Live Chess'],
    ['Site', 'Chess.com'],
    ['Date', date],
    ['White', PLAYER],
    ['Black', 'mock_rival_x'],
    ['Result', '1-0'],
    ['UTCDate', date],
    ['UTCTime', '18:02:11'],
    ['WhiteElo', '905'],
    ['BlackElo', '890'],
    ['TimeControl', '600'],
    ['Link', url],
  ];
  return {
    url,
    pgn: `${tags.map(([k, v]) => `[${k} "${v}"]`).join('\n')}\n\n1. e4 e5 2. Qh5 Nc6 3. Bc4 Nf6 4. Qxf7# 1-0\n`,
  };
}

/** 30 invented games in two months; the newer month waits for `release`. */
async function mockChessCom(context: BrowserContext, release: Promise<void>): Promise<void> {
  const cors = { 'access-control-allow-origin': '*' };
  await context.route(`${API}/**`, async (route) => {
    const url = route.request().url();
    if (url === `${base}/archives`) {
      return route.fulfill({ status: 200, headers: cors, json: { archives: MONTHS.map(monthUrl) } });
    }
    const month = MONTHS.find((m) => monthUrl(m) === url);
    if (month) {
      if (month === '2024-06') await release;
      const games = Array.from({ length: 15 }, (_, i) =>
        archiveGame(
          9000 + Number(month.slice(5)) * 100 + i,
          `${month.replace('-', '.')}.${String(i + 1).padStart(2, '0')}`,
        ),
      );
      return route.fulfill({ status: 200, headers: cors, json: { games } });
    }
    return route.fulfill({ status: 404, headers: cors, json: { message: 'not found' } });
  });
}

/** The tab bar against the top bar and the bottom tab bar, and whether a finger on each tab reaches that tab. */
const tabsReport = (page: Page) =>
  page.evaluate(() => {
    const bar = document.querySelector('.wc-topbar')!.getBoundingClientRect();
    const nav = document.querySelector<HTMLElement>('.wc-nav')!;
    const navTop = getComputedStyle(nav).position === 'fixed' ? nav.getBoundingClientRect().top : innerHeight;
    const list = document.querySelector('.wc-games-tabs [role="tablist"]')!.getBoundingClientRect();
    const tabs = [...document.querySelectorAll<HTMLElement>('.wc-games-tabs [role="tab"]')].map((t) => {
      const r = t.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return {
        id: t.dataset.tab!,
        x: r.left + r.width / 2,
        y: r.top + r.height / 2,
        reached: !!hit && t.contains(hit),
      };
    });
    return {
      overlapTop: Math.max(0, bar.bottom - list.top),
      overlapBottom: Math.max(0, list.bottom - navTop),
      tabs,
    };
  });

async function expectTabsClear(page: Page, when: string): Promise<void> {
  const r = await tabsReport(page);
  expect(r.overlapTop, `${when}: tabs under the top bar (px)`).toBe(0);
  expect(r.overlapBottom, `${when}: tabs under the bottom tab bar (px)`).toBe(0);
  for (const t of r.tabs) expect(t.reached, `${when}: the ${t.id} tab can be pressed`).toBe(true);
}

/** Scrolls the page to its end as a swipe would, then checks the tabs; the same at the top. */
async function expectTabsClearScrolled(page: Page, when: string): Promise<void> {
  await page.evaluate(() => window.scrollTo(0, document.scrollingElement!.scrollHeight));
  await expectTabsClear(page, `${when}, page scrolled to its end`);
  await page.evaluate(() => window.scrollTo(0, 0));
  await expectTabsClear(page, `${when}, page at the top`);
}

/** Presses a tab where it is on screen (no scrolling first, as a finger would), from the end of the page. */
async function pressTabInPlace(page: Page, id: string): Promise<void> {
  await page.evaluate(() => window.scrollTo(0, document.scrollingElement!.scrollHeight));
  const t = (await tabsReport(page)).tabs.find((x) => x.id === id)!;
  if (touch()) await page.touchscreen.tap(t.x, t.y);
  else await page.mouse.click(t.x, t.y);
  await expect(page.getByTestId(`games-tab-${id}`)).toHaveAttribute('aria-selected', 'true');
}

test.describe('Games tabs stay visible and tappable after an import', () => {
  test.use({
    storageState: {
      cookies: [],
      origins: [{ origin: SITE_URL, localStorage: [{ name: 'wc-install-guide-seen', value: '1' }] }],
    },
  });

  for (const size of PHONES) {
    test(`a Chess.com import at ${size.width}x${size.height}: while the banner is up, after it, other tabs, turned`, async ({
      page,
      context,
    }) => {
      test.setTimeout(120_000);
      let release: () => void = () => undefined;
      const released = new Promise<void>((resolve) => (release = resolve));
      await mockChessCom(context, released);
      await page.setViewportSize(size);
      await page.goto('/');
      await expect(page.getByTestId('story-form')).toBeVisible();
      await page.evaluate(() => window.__wizardChessLibraryReady);

      await page.getByTestId('story-account-chesscom').fill(PLAYER);
      await page.getByTestId('story-start-import').click();
      await expect(page.getByTestId('story-sync-status')).toHaveAttribute('data-state', 'running', { timeout: 10_000 });
      // The banner shares the Story's height: the page is no taller than the screen
      expect(await page.evaluate(() => document.scrollingElement!.scrollHeight - innerHeight)).toBeLessThanOrEqual(0);
      await expectTabsClearScrolled(page, 'while the import runs');

      release();
      await expect(page.getByTestId('story-sync-status')).toContainText('Import finished', { timeout: 20_000 });
      expect(await page.evaluate(() => document.scrollingElement!.scrollHeight - innerHeight)).toBeLessThanOrEqual(0);
      await expectTabsClearScrolled(page, 'after the import');

      // Each tab, pressed in place from the end of the page (the Library is long)
      for (const id of ['library', 'insights', 'story', 'library'] as const) {
        await pressTabInPlace(page, id);
        await expectTabsClearScrolled(page, `on ${id}`);
      }
      await expect(page.getByTestId('games-row')).toHaveCount(30);

      // Turned to landscape and back
      await page.setViewportSize({ width: size.height, height: size.width });
      await expectTabsClearScrolled(page, 'turned');
      await pressTabInPlace(page, 'story');
      await page.setViewportSize(size);
      await expectTabsClearScrolled(page, 'turned back');
      await pressTabInPlace(page, 'insights');
    });

    test(`the first-run link's history at ${size.width}x${size.height}: welcome closed, then other tabs, turned`, async ({
      page,
    }) => {
      test.setTimeout(120_000);
      await page.setViewportSize(size);
      await page.goto('/start/sample/');
      await expect(page.getByTestId('app-shell')).toHaveAttribute('data-first-run', 'applied', { timeout: 15_000 });
      const welcome = page.getByTestId('welcome-sheet');
      await expect(welcome).toBeVisible({ timeout: 8000 });
      // The welcome sheet has its X too (its own "Start playing" is what closes it here)
      await expectCloseButton(page, 'welcome-sheet', 'welcome-sheet-close', 'Close Welcome');
      await expectFitsScreen(page, 'welcome-sheet');
      await page.getByTestId('welcome-done').click();
      await expect(welcome).toBeHidden();
      await expect
        .poll(
          () => page.evaluate(() => window.__wizardChessLibrary?.library.listIds().then((ids) => ids.length) ?? -1),
          {
            timeout: 15_000,
          },
        )
        .toBe(30);
      await expect(page.getByTestId('story-load-status')).toHaveCount(0, { timeout: 15_000 });
      await expectTabsClearScrolled(page, 'after the link import');
      for (const id of ['library', 'insights', 'story'] as const) {
        await pressTabInPlace(page, id);
        await expectTabsClearScrolled(page, `on ${id}`);
      }
      await page.setViewportSize({ width: size.height, height: size.width });
      await expectTabsClearScrolled(page, 'turned');
      await pressTabInPlace(page, 'library');
      await page.setViewportSize(size);
      await expectTabsClearScrolled(page, 'turned back');
      await pressTabInPlace(page, 'story');
    });
  }
});
