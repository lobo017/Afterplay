import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';

// One themed scrollbar for the whole app: thin, a dark track and the gold thumb, on the page, popups, sheets, menus,
// lists, textareas, dialogs and every screen (it was only on the Review panel). The check reads the computed style of
// named scroll containers on different screens, and sweeps every element on those screens that can scroll. The app is
// dark only, so there is one set of colors.
const THUMB = 'rgba(212, 175, 55, 0.5)';
const TRACK = 'rgb(16, 19, 27)';
/** A folder OUTSIDE the repository for screenshots; with it unset nothing is saved. */
const LOOK_DIR = process.env.PHASE_LOOK_DIR ?? '';

async function look(page: Page, name: string): Promise<void> {
  if (LOOK_DIR === '') return;
  const dir = path.resolve(LOOK_DIR);
  if (!path.relative(process.cwd(), dir).startsWith('..'))
    throw new Error('PHASE_LOOK_DIR must be outside the repository');
  fs.mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: path.join(dir, `${test.info().project.name}-${name}.png`) });
}

const normalize = (s: string) => s.replace(/\s+/g, ' ').trim();

interface Themed {
  /** Whether this browser reads the standard properties at all. */
  standard: boolean;
  width: string;
  color: string;
}

/** The scrollbar properties an element computes to. */
function themeOf(target: Locator): Promise<Themed> {
  return target.evaluate((el) => {
    const s = getComputedStyle(el);
    return {
      standard: CSS.supports('scrollbar-width', 'thin') && CSS.supports('scrollbar-color', 'red blue'),
      width: s.getPropertyValue('scrollbar-width'),
      color: s.getPropertyValue('scrollbar-color'),
    };
  });
}

/** The themed scrollbar, in whichever form this browser reads. */
async function expectThemed(target: Locator, label: string): Promise<void> {
  const t = await themeOf(target);
  if (t.standard) {
    expect(t.width, `${label}: width`).toBe('thin');
    expect(normalize(t.color), `${label}: colors`).toBe(`${THUMB} ${TRACK}`);
  } else {
    // An older Safari reads only the prefixed pieces: they are in the style sheet, once, for everything
    const rules = await target.evaluate(() => {
      const found: Record<string, string> = {};
      for (const sheet of Array.from(document.styleSheets)) {
        for (const rule of Array.from(sheet.cssRules)) {
          if (rule instanceof CSSStyleRule && rule.selectorText.startsWith('::-webkit-scrollbar'))
            found[rule.selectorText] = rule.style.cssText;
        }
      }
      return found;
    });
    expect(rules['::-webkit-scrollbar'], label).toContain('8px');
    expect(rules['::-webkit-scrollbar-thumb'], label).toContain('212, 175, 55');
  }
}

/** Every element on the screen that scrolls (overflow auto or scroll), plus the page, its body, textareas and menus. */
async function sweep(page: Page, label: string): Promise<number> {
  const found = await page.evaluate(() => {
    const standard = CSS.supports('scrollbar-width', 'thin') && CSS.supports('scrollbar-color', 'red blue');
    const out: Array<{ what: string; width: string; color: string }> = [];
    const consider = (el: Element, what: string) => {
      const s = getComputedStyle(el);
      out.push({ what, width: s.getPropertyValue('scrollbar-width'), color: s.getPropertyValue('scrollbar-color') });
    };
    consider(document.documentElement, 'page');
    consider(document.body, 'body');
    for (const el of Array.from(document.querySelectorAll('*'))) {
      const s = getComputedStyle(el);
      const scrolls = ['auto', 'scroll'].includes(s.overflowX) || ['auto', 'scroll'].includes(s.overflowY);
      const id = el.getAttribute('data-testid') ?? '';
      if (
        scrolls ||
        el.tagName === 'TEXTAREA' ||
        el.getAttribute('role') === 'menu' ||
        el.getAttribute('role') === 'dialog'
      )
        consider(el, `${el.tagName.toLowerCase()}${id ? `[${id}]` : `.${String(el.className).split(' ')[0]}`}`);
    }
    return { standard, out };
  });
  if (found.standard) {
    for (const e of found.out) {
      expect(e.width, `${label}: ${e.what} width`).toBe('thin');
      expect(normalize(e.color), `${label}: ${e.what} colors`).toBe(`${THUMB} ${TRACK}`);
    }
  }
  return found.out.length;
}

/** The prefixed bar of an element, where this browser can say it (Chromium computes it for any element). */
async function expectWebkitBar(target: Locator, label: string): Promise<void> {
  if (test.info().project.name !== 'chromium') return;
  const bar = await target.evaluate((el) => ({
    width: getComputedStyle(el, '::-webkit-scrollbar').width,
    thumb: getComputedStyle(el, '::-webkit-scrollbar-thumb').backgroundColor,
    track: getComputedStyle(el, '::-webkit-scrollbar-track').backgroundColor,
  }));
  expect(bar.width, `${label}: bar width`).toBe('8px');
  // The thumb under the mouse reads as its hover color
  expect(bar.thumb, `${label}: thumb`).toMatch(/^rgba\(212, 175, 55, 0\.(5|75)\)$/);
  expect(bar.track, `${label}: track`).toBe(TRACK);
}

test.describe('The themed scrollbar is app-wide', () => {
  test('the page, a sheet, its textarea, the menus and the Settings dialog', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto('/#review');
    await expect(page.getByTestId('analysis-layout')).toBeVisible();

    await expectThemed(page.locator('html'), 'the page');
    await expectThemed(page.locator('body'), 'body');
    await expectWebkitBar(page.locator('html'), 'the page');
    expect(await sweep(page, 'Review')).toBeGreaterThan(2);

    // A sheet and the PGN box inside it
    await page.getByTestId('btn-load-pgn').click();
    const sheet = page.getByTestId('pgn-sheet');
    await expect(sheet).toBeVisible();
    await expectThemed(sheet, 'the Load sheet');
    await expectThemed(sheet.locator('.wc-sheet-body'), 'the Load sheet body');
    await expectThemed(page.getByTestId('textarea-pgn'), 'the PGN textarea');
    await expectWebkitBar(page.getByTestId('textarea-pgn'), 'the PGN textarea');
    await expectWebkitBar(sheet.locator('.wc-sheet-body'), 'the Load sheet body');
    expect(await sweep(page, 'the Load sheet')).toBeGreaterThan(3);
    await look(page, 'scrollbar-load-sheet');
    await page.keyboard.press('Escape');
    await expect(sheet).toBeHidden();

    // A menu
    await page.getByTestId('board-tools').click();
    const menu = page.getByTestId('board-tools-popup');
    await expect(menu).toBeVisible();
    await expectThemed(menu, 'the Board tools menu');
    await expectThemed(menu.getByRole('menu'), 'the Board tools list');
    expect(await sweep(page, 'a menu')).toBeGreaterThan(2);
    await page.keyboard.press('Escape');

    // The Settings dialog
    await page.getByTestId('btn-settings').click();
    const settings = page.getByTestId('settings-sheet');
    await expect(settings).toBeVisible();
    await expectThemed(settings, 'the Settings dialog');
    await expectThemed(settings.locator('.wc-sheet-body'), 'the Settings body');
    await expectWebkitBar(settings.locator('.wc-sheet-body'), 'the Settings body');
    expect(await sweep(page, 'Settings')).toBeGreaterThan(3);
    await look(page, 'scrollbar-settings');
  });

  test('Train, Games (list, paste box, menu), Insights and the Story', async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto('/#train');
    await page.evaluate(() => window.__wizardChessPuzzlesReady);
    await expect(page.getByTestId('today-screen')).toHaveAttribute('data-state', 'ready');
    await expectThemed(page.getByTestId('today-screen'), 'the Train hub');
    expect(await sweep(page, 'Train hub')).toBeGreaterThan(1);
    await page.evaluate(async () => {
      const api = await window.__wizardChessPuzzlesReady!;
      await api.open('rated');
    });
    await expect(page.getByTestId('puzzle-trainer')).toBeVisible();
    await expectThemed(page.locator('.wc-puzzle-panel .wc-panel-body'), 'the puzzle panel');
    await expectWebkitBar(page.locator('.wc-puzzle-panel .wc-panel-body'), 'the puzzle panel');
    expect(await sweep(page, 'Train puzzles')).toBeGreaterThan(1);

    // Games: the list, the paste box and its menu
    await page.getByTestId('mode-tab-games').click();
    await page.getByTestId('games-tab-library').click();
    await expect(page.getByTestId('games-list')).toBeVisible();
    await expectThemed(page.getByTestId('games-list'), 'the Games list');
    expect(await sweep(page, 'Games list')).toBeGreaterThan(1);
    await page.getByTestId('btn-games-import').click();
    const gamesMenu = page.getByTestId('btn-games-import-popup');
    await expect(gamesMenu).toBeVisible();
    await expectThemed(gamesMenu, 'the Games menu');
    expect(await sweep(page, 'the Games menu')).toBeGreaterThan(1);
    await page.getByTestId('btn-games-paste').click();
    const paste = page.getByTestId('games-paste-text');
    await expect(paste).toBeVisible();
    await expectThemed(paste, 'the Games paste box');
    await expectWebkitBar(paste, 'the Games paste box');
    await look(page, 'scrollbar-games');

    await page.getByTestId('games-tab-insights').click();
    await expect(page.getByTestId('insights')).toBeVisible();
    await expectThemed(page.getByTestId('insights'), 'Insights');
    expect(await sweep(page, 'Insights')).toBeGreaterThan(1);

    await page.getByTestId('games-tab-story').click();
    const story = page.getByTestId('story-scroll');
    await expect(story).toBeAttached();
    await expectThemed(story, 'the Story');
    await expectWebkitBar(story, 'the Story');
    expect(await sweep(page, 'Story')).toBeGreaterThan(1);
  });

  test('on a phone, the same: page, sheet and menu', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/#review');
    await expect(page.getByTestId('analysis-layout')).toBeVisible();
    await expectThemed(page.locator('html'), 'the page');
    expect(await sweep(page, 'Review (phone)')).toBeGreaterThan(2);
    await page.getByTestId('btn-settings').click();
    await expect(page.getByTestId('settings-sheet')).toBeVisible();
    await expectThemed(page.getByTestId('settings-sheet').locator('.wc-sheet-body'), 'the Settings body');
    expect(await sweep(page, 'Settings (phone)')).toBeGreaterThan(3);
    await look(page, 'scrollbar-settings-phone');
  });
});
