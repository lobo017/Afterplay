import fs from 'node:fs';
import path from 'node:path';
import { devices, expect, test, type Page } from '@playwright/test';

// Phase 11 stage 2: iPhone support. Runs in every project; the parts that only make sense on a phone (one engine, the
// first-run install guide, real touch input) run in `webkit-iphone` (iPhone 13 in WebKit: 390 × 664, touch, iPhone
// user agent), and the desktop projects check that nothing changed for them.
const SCREENSHOT_DIR = path.join('test-results', 'phase11-screens');
const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const PAUSE_NOTE = 'Live analysis is paused while the review runs (this phone uses one engine).';

const isPhoneProject = () => test.info().project.name === 'webkit-iphone';

async function screenshot(page: Page, name: string): Promise<void> {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, `${test.info().project.name}-${name}.png`) });
}

async function openApp(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.getByTestId('play-layout').getByTestId('chess-board')).toBeVisible();
  await page.waitForFunction(() => Boolean(window.__wizardChessPlay && window.__wizardChessReview));
}

async function openSettingsAbout(page: Page): Promise<void> {
  await page.getByTestId('btn-settings').click();
  await expect(page.getByTestId('settings-sheet')).toBeVisible();
  await page.getByTestId('settings-about').scrollIntoViewIfNeeded();
}

test.describe('Phase 11 — iPhone support', () => {
  test('engine profile: one small engine on a phone, three on a desktop', async ({ page }) => {
    await openApp(page);
    const engines = await page.evaluate(() => {
      const play = window.__wizardChessPlay!;
      const review = window.__wizardChessReview!.getEngine();
      return {
        botShared: play.botEngine === play.engine,
        reviewShared: review === play.engine,
        threads: play.engine.getThreads(),
        hashMb: play.engine.getHashMb(),
        isolated: window.crossOriginIsolated,
      };
    });
    await openSettingsAbout(page);
    const profileText = page.getByTestId('stat-engine-profile');
    if (isPhoneProject()) {
      expect(engines).toMatchObject({ botShared: true, reviewShared: true, hashMb: 16, isolated: true });
      expect(engines.threads).toBeGreaterThanOrEqual(1);
      expect(engines.threads).toBeLessThanOrEqual(2);
      const threads = `${engines.threads} ${engines.threads === 1 ? 'thread' : 'threads'}`;
      await expect(profileText).toHaveText(`Phone: one engine, ${threads}, 16 MB hash`);
    } else {
      expect(engines.botShared).toBe(false);
      expect(engines.reviewShared).toBe(false);
      await expect(profileText).toHaveText(
        /^Desktop: analysis \d+ threads? and \d+ MB, bot 16 MB, review 1 thread and 32 MB$/,
      );
    }
  });

  test('a review started on the board pauses live analysis on a phone and resumes it afterwards', async ({ page }) => {
    await openApp(page);
    await page.getByTestId('mode-tab-review').click();
    await expect(page.getByTestId('analysis-layout')).toBeVisible();
    await page.getByTestId('select-review-preset').selectOption('quick');
    await page.getByTestId('btn-review-sample').click();
    await expect(page.getByTestId('review-panel')).toHaveAttribute('data-state', 'running');
    const note = () => page.evaluate(() => window.__wizardChessAnalysis!.controller.getLivePausedNote());

    if (!isPhoneProject()) {
      // A desktop keeps live analysis running on its own engine during a review
      expect(await note()).toBeNull();
      await expect(page.getByTestId('review-panel')).toHaveAttribute('data-state', 'done', { timeout: 120_000 });
      return;
    }

    expect(await note()).toBe(PAUSE_NOTE);
    await page.getByTestId('review-shell-tab-analysis').click();
    const paused = page.getByTestId('engine-lines-paused');
    await expect(paused).toBeVisible();
    await expect(paused).toHaveText(PAUSE_NOTE);
    // Nothing live is searched meanwhile: stepping through moves keeps the panel paused
    await page.keyboard.press('ArrowRight');
    expect(await page.evaluate(() => window.__wizardChessAnalysis!.controller.getLatestLines().length)).toBe(0);
    await screenshot(page, 'review-pauses-analysis');

    await expect(page.getByTestId('review-panel')).toHaveAttribute('data-state', 'done', { timeout: 120_000 });
    await expect(paused).toBeHidden();
    expect(await note()).toBeNull();
    await expect
      .poll(() => page.evaluate(() => window.__wizardChessAnalysis!.controller.getLatestLines().length), {
        timeout: 30_000,
      })
      .toBeGreaterThan(0);
  });

  test('persistent storage is asked for once after start-up, and Settings shows the answer', async ({ page }) => {
    await page.addInitScript(() => {
      const w = window as unknown as { __persistCalls: number };
      w.__persistCalls = 0;
      // On the prototype: in WebKit's iPhone mode a property set on `navigator.storage` itself does not stick
      const proto = StorageManager.prototype;
      Object.defineProperty(proto, 'persisted', { configurable: true, value: async () => false });
      Object.defineProperty(proto, 'persist', {
        configurable: true,
        value: async () => {
          w.__persistCalls++;
          return true;
        },
      });
    });
    await openApp(page);
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { __persistCalls: number }).__persistCalls), {
        timeout: 10_000,
      })
      .toBe(1);
    await openSettingsAbout(page);
    await expect(page.getByTestId('stat-persistence')).toHaveText('Kept: the browser will not clear it on its own');
    await page.waitForTimeout(1000);
    expect(await page.evaluate(() => (window as unknown as { __persistCalls: number }).__persistCalls)).toBe(1);
  });

  test('without the stub, the real browser answers and Settings says what it means', async ({ page }) => {
    await openApp(page);
    await openSettingsAbout(page);
    await expect(page.getByTestId('stat-persistence')).not.toHaveText('Checking…', { timeout: 10_000 });
    await expect(page.getByTestId('stat-persistence')).toHaveText(/^(Kept|Best effort|This browser cannot)/);
  });

  test('Add to Home Screen: opens by itself once on a first iPhone visit, with pictures; Settings reopens it', async ({
    browser,
    page,
  }) => {
    if (isPhoneProject()) {
      // A first visit: a fresh iPhone context without the project's "guide seen" storage state
      const context = await browser.newContext({
        ...devices['iPhone 13'],
        baseURL: test.info().project.use.baseURL,
        serviceWorkers: 'block',
        // (Playwright gives hand-made contexts the project's options too, including its "guide seen" storage state)
        storageState: { cookies: [], origins: [] },
      });
      const first = await context.newPage();
      await first.goto('/');
      const guide = first.getByTestId('install-guide');
      await expect(guide).toBeVisible({ timeout: 5000 });
      for (const pic of ['share', 'add', 'confirm', 'home']) {
        await expect(first.getByTestId(`install-picture-${pic}`)).toBeVisible();
      }
      await expect(first.getByTestId('install-step-2')).toContainText('Add to Home Screen');
      await screenshot(first, 'install-guide');
      await first.getByTestId('install-step-4').scrollIntoViewIfNeeded();
      await screenshot(first, 'install-guide-end');
      await first.getByTestId('install-guide-done').click();
      await expect(guide).toBeHidden();
      // Seen: it does not open by itself again
      await first.reload();
      await expect(first.getByTestId('play-layout').getByTestId('chess-board')).toBeVisible();
      await first.waitForTimeout(1500);
      await expect(guide).toBeHidden();
      await context.close();
    } else {
      // Not an iPhone or iPad: never by itself
      await openApp(page);
      await page.waitForTimeout(1500);
      await expect(page.getByTestId('install-guide')).toBeHidden();
    }

    await openApp(page);
    await openSettingsAbout(page);
    await page.getByTestId('btn-install-guide').click();
    await expect(page.getByTestId('settings-sheet')).toBeHidden();
    await expect(page.getByTestId('install-guide')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('install-guide')).toBeHidden();
  });

  test('touch on a phone: tap to move, a premove by taps while the bot thinks, the board fits the screen', async ({
    page,
  }) => {
    test.skip(!isPhoneProject(), 'real touch input: the iPhone project');
    await openApp(page);
    await page.evaluate((fen) => {
      const c = window.__wizardChessPlay!.controller;
      c.setBotDelayRangeMs(2500, 2500);
      c.loadPosition(fen, 'w');
    }, START_FEN);

    const center = async (sq: string) => {
      const box = await page.getByTestId('play-layout').getByTestId(`square-${sq}`).boundingBox();
      if (!box) throw new Error(`square-${sq} has no box`);
      return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    };
    const tap = async (sq: string) => {
      const c = await center(sq);
      await page.touchscreen.tap(c.x, c.y);
    };
    const mainLine = () =>
      page.evaluate(() =>
        window
          .__wizardChessPlay!.controller.getGameTree()
          .getMainLine()
          .map((n) => n.san),
      );

    // The board fits a 390 px screen with no sideways scrolling
    const fit = await page.evaluate(() => {
      const board = document.querySelector('[data-testid="play-layout"] [data-testid="chess-board"]')!;
      const r = board.getBoundingClientRect();
      return { left: r.left, right: r.right, width: innerWidth, scroll: document.documentElement.scrollWidth };
    });
    expect(fit.left).toBeGreaterThanOrEqual(0);
    expect(fit.right).toBeLessThanOrEqual(fit.width);
    expect(fit.scroll).toBeLessThanOrEqual(fit.width);

    await tap('e2');
    await expect(page.getByTestId('overlay-selected-square')).toHaveAttribute('data-square', 'e2');
    await tap('e4');
    await expect.poll(mainLine).toEqual(['e4']);
    // The bot thinks for 2.5 s: two taps queue a premove, played as soon as it has answered
    await tap('g1');
    await tap('f3');
    await expect.poll(mainLine, { timeout: 20_000 }).toHaveLength(3);
    expect((await mainLine())[2]).toBe('Nf3');
    await screenshot(page, 'touch-premove');

    // The bot is thinking again (2.5 s). A piece tapped now stays selected through its reply, so the next tap
    // finishes the move as a normal one
    await tap('b1');
    await expect(page.getByTestId('overlay-selected-square')).toHaveAttribute('data-square', 'b1');
    await expect.poll(mainLine, { timeout: 20_000 }).toHaveLength(4);
    await expect(page.getByTestId('overlay-selected-square')).toHaveAttribute('data-square', 'b1');
    const target = await page.evaluate(
      () => window.__wizardChessPlay!.controller.getAdapter().verboseMoves({ square: 'b1' })[0]!,
    );
    await tap(target.to);
    await expect.poll(async () => (await mainLine())[4], { timeout: 20_000 }).toBe(target.san);

    // Safari would zoom in on a focused small field: the viewport stops that on iOS (pinching still zooms)
    expect(await page.locator('meta[name="viewport"]').getAttribute('content')).toContain('maximum-scale=1');
  });
});
