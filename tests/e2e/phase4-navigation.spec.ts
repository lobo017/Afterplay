import { expect, test, type Page } from '@playwright/test';
import {
  FORTY_MOVE_PGN,
  startLayoutShiftRecorder,
  stopLayoutShiftRecorder,
  summarizeShiftSources,
} from './helpers/layout-shift';

async function openAnalysisWithGame(page: Page): Promise<number> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await page.getByTestId('mode-tab-analysis').click();
  await expect(page.getByTestId('analysis-layout')).toBeVisible();
  await page.getByTestId('select-multipv').selectOption('5');

  const plyCount = await page.evaluate((pgn) => {
    const analysis = window.__wizardChessAnalysis!;
    if (!analysis.controller.importPgn(pgn)) {
      throw new Error('PGN import failed');
    }
    analysis.controller.goToStart();
    return analysis.controller.getGameTree().getMainLine().length;
  }, FORTY_MOVE_PGN);

  // Let the first engine lines arrive so the panels are in their steady state.
  await expect(page.getByTestId('engine-pv-move-1-0')).toBeVisible({
    timeout: 20_000,
  });
  // Keyboard focus on the page body, the way a user would after clicking empty space.
  await page.mouse.click(5, 450);
  return plyCount;
}

async function readBoardState(page: Page) {
  return page.evaluate(() => {
    const controller = window.__wizardChessAnalysis!.controller;
    const placement = controller.getAdapter().fen().split(' ')[0] ?? '';
    const pieces = Array.from(
      document.querySelectorAll<HTMLElement>(
        '[data-testid="board-pieces-layer"] .wc-piece',
      ),
    ).map(
      (el) =>
        `${el.getAttribute('data-square')}:${el.getAttribute('data-color')}${el.getAttribute('data-piece')}`,
    );
    const runningPieceAnimations = document
      .getAnimations()
      .filter(
        (a) =>
          a.playState === 'running' &&
          (a.effect as KeyframeEffect | null)?.target instanceof HTMLElement &&
          ((a.effect as KeyframeEffect).target as HTMLElement).classList.contains(
            'wc-piece',
          ),
      ).length;
    return {
      fen: controller.getAdapter().fen(),
      placement,
      currentPly: controller.getGameTree().currentNode.ply,
      pieces: pieces.sort(),
      runningPieceAnimations,
      scrollY: window.scrollY,
    };
  });
}

function expectedPiecesFromPlacement(placement: string): string[] {
  const files = 'abcdefgh';
  const out: string[] = [];
  placement.split('/').forEach((row, r) => {
    let f = 0;
    for (const ch of row) {
      if (/\d/.test(ch)) {
        f += Number(ch);
      } else {
        const color = ch === ch.toUpperCase() ? 'w' : 'b';
        out.push(`${files[f]}${8 - r}:${color}${ch.toLowerCase()}`);
        f++;
      }
    }
  });
  return out.sort();
}

test.describe('Phase 4 — Analysis navigation: zero layout shift & move animation', () => {
  test('stepping through a 40-move game with arrow keys causes zero layout shift', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const plyCount = await openAnalysisWithGame(page);
    expect(plyCount).toBe(81);

    const scrollBefore = await page.evaluate(() => window.scrollY);
    await startLayoutShiftRecorder(page);

    // Step forward through every ply at a human pace (engine lines stream in between steps),
    // then step back through the whole game.
    for (let i = 0; i < plyCount; i++) {
      await page.keyboard.press('ArrowRight');
      await page.waitForTimeout(110);
    }
    const atEnd = await readBoardState(page);
    for (let i = 0; i < plyCount; i++) {
      await page.keyboard.press('ArrowLeft');
      await page.waitForTimeout(70);
    }

    const shifts = await stopLayoutShiftRecorder(page);
    const summary = summarizeShiftSources(shifts);
    const totalShift = shifts.reduce((acc, s) => acc + s.value, 0);
    console.log(
      `[layout-shift] entries=${shifts.length} total=${totalShift.toFixed(5)}`,
    );
    for (const s of summary) {
      console.log(
        `[layout-shift] ${s.count}× ${s.node} prev=${JSON.stringify(s.example.previousRect)} curr=${JSON.stringify(s.example.currentRect)}`,
      );
    }
    await test.info().attach('layout-shifts.json', {
      body: JSON.stringify({ totalShift, summary, shifts }, null, 2),
      contentType: 'application/json',
    });

    expect(atEnd.currentPly).toBe(plyCount);
    const atStart = await readBoardState(page);
    expect(atStart.currentPly).toBe(0);
    expect(atStart.scrollY).toBe(scrollBefore);
    expect(summary).toEqual([]);
    expect(shifts.length).toBe(0);
  });

  test('holding the arrow key through a game ends on the correct position with no layout shift', async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const plyCount = await openAnalysisWithGame(page);
    const scrollBefore = await page.evaluate(() => window.scrollY);
    await startLayoutShiftRecorder(page);

    // Holding a key: the first keydown, then auto-repeat (repeat: true) every ~33 ms,
    // faster than the 100 ms step animation. Overshoot the last move on purpose.
    await page.keyboard.down('ArrowRight');
    for (let i = 0; i < plyCount + 5; i++) {
      await page.waitForTimeout(33);
      await page.keyboard.down('ArrowRight');
    }
    await page.keyboard.up('ArrowRight');
    const afterForward = await readBoardState(page);

    // Hold ← all the way back to the start.
    await page.keyboard.down('ArrowLeft');
    for (let i = 0; i < plyCount + 5; i++) {
      await page.waitForTimeout(33);
      await page.keyboard.down('ArrowLeft');
    }
    await page.keyboard.up('ArrowLeft');
    const afterBack = await readBoardState(page);

    // Tap a single step with animation, then interrupt it right away with another step:
    // the board must still settle on the exact position.
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(250);
    const afterTaps = await readBoardState(page);

    const shifts = await stopLayoutShiftRecorder(page);
    const summary = summarizeShiftSources(shifts);
    for (const s of summary) {
      console.log(`[layout-shift] ${s.count}× ${s.node}`);
    }

    // Held forward: on the final move, every piece element on its square, nothing animating.
    expect(afterForward.currentPly).toBe(plyCount);
    expect(afterForward.pieces).toEqual(
      expectedPiecesFromPlacement(afterForward.placement),
    );
    expect(afterForward.runningPieceAnimations).toBe(0);

    expect(afterBack.currentPly).toBe(0);
    expect(afterBack.pieces).toEqual(expectedPiecesFromPlacement(afterBack.placement));
    expect(afterBack.placement).toBe('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR');

    expect(afterTaps.currentPly).toBe(3);
    expect(afterTaps.pieces).toEqual(expectedPiecesFromPlacement(afterTaps.placement));
    expect(afterTaps.runningPieceAnimations).toBe(0);

    expect(afterBack.scrollY).toBe(scrollBefore);
    expect(summary).toEqual([]);
    expect(shifts.length).toBe(0);
  });

  test('a single step animates the move (reversed when stepping back) and highlights it', async ({
    page,
  }) => {
    test.setTimeout(60_000);
    await openAnalysisWithGame(page);

    // Step forward to 1. c4 and catch the pawn mid-flight.
    const forward = await page.evaluate(async () => {
      const controller = window.__wizardChessAnalysis!.controller;
      controller.setNavAnimation('normal');
      await new Promise((r) => setTimeout(r, 250));
      controller.goForward();
      const el = document.querySelector<HTMLElement>('[data-testid="piece-c4"]')!;
      // Chrome may report the z component as "0" or "0px"
      const norm = (t: unknown) => String(t).replace(/, 0\)$/, ', 0px)');
      const anims = el.getAnimations().map((a) => {
        const kf = (a.effect as KeyframeEffect).getKeyframes();
        return {
          from: norm(kf[0]?.transform),
          to: norm(kf[kf.length - 1]?.transform),
          duration: Number((a.effect as KeyframeEffect).getTiming().duration),
        };
      });
      return {
        anims,
        lastFrom: document
          .querySelector('[data-testid="overlay-last-move-from"]')
          ?.getAttribute('data-square'),
        lastTo: document
          .querySelector('[data-testid="overlay-last-move-to"]')
          ?.getAttribute('data-square'),
      };
    });
    expect(forward.anims).toHaveLength(1);
    expect(forward.anims[0]!.from).toBe('translate3d(200%, 600%, 0px)');
    expect(forward.anims[0]!.to).toBe('translate3d(200%, 400%, 0px)');
    expect(forward.anims[0]!.duration).toBe(100);
    expect(forward.lastFrom).toBe('c2');
    expect(forward.lastTo).toBe('c4');

    // Step back: the same pawn slides c4 → c2.
    const backward = await page.evaluate(async () => {
      const controller = window.__wizardChessAnalysis!.controller;
      await new Promise((r) => setTimeout(r, 250));
      controller.goBack();
      const el = document.querySelector<HTMLElement>('[data-testid="piece-c2"]')!;
      const norm = (t: unknown) => String(t).replace(/, 0\)$/, ', 0px)');
      return el.getAnimations().map((a) => {
        const kf = (a.effect as KeyframeEffect).getKeyframes();
        return { from: norm(kf[0]?.transform), to: norm(kf[kf.length - 1]?.transform) };
      });
    });
    expect(backward).toEqual([
      { from: 'translate3d(200%, 400%, 0px)', to: 'translate3d(200%, 600%, 0px)' },
    ]);

    // Home / End are jumps: they snap without animating.
    const jump = await page.evaluate(async () => {
      const controller = window.__wizardChessAnalysis!.controller;
      await new Promise((r) => setTimeout(r, 250));
      controller.goToEnd();
      return document
        .getAnimations()
        .filter((a) =>
          ((a.effect as KeyframeEffect).target as HTMLElement | null)?.classList.contains(
            'wc-piece',
          ),
        ).length;
    });
    expect(jump).toBe(0);

    // With the setting off, a single step snaps too.
    await page.getByTestId('select-nav-animation').selectOption('off');
    const off = await page.evaluate(async () => {
      const controller = window.__wizardChessAnalysis!.controller;
      await new Promise((r) => setTimeout(r, 250));
      controller.goBack();
      return document
        .getAnimations()
        .filter((a) =>
          ((a.effect as KeyframeEffect).target as HTMLElement | null)?.classList.contains(
            'wc-piece',
          ),
        ).length;
    });
    expect(off).toBe(0);
  });
});
