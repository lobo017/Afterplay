import { expect, test, type Page } from '@playwright/test';

// Phase 9 — performance pass: regression tests for what the pass changed.

/** The Play move list as drawn, and as it should be drawn from the game tree (one slot per ply, both of a row). */
async function moveListState(page: Page) {
  return page.evaluate(() => {
    const controller = window.__wizardChessPlay!.controller;
    const sans = controller
      .getGameTree()
      .getMainLine()
      .map((n) => n.san ?? '');
    const list = document.querySelector('[data-testid="move-history-list"]')!;
    const spans = [...list.querySelectorAll<HTMLElement>('.wc-move-san')];
    const rows = [...list.querySelectorAll<HTMLElement>('.wc-move-row')];
    const drawn = spans.map((s) => ({
      id: s.getAttribute('data-testid'),
      text: s.textContent,
      active: s.classList.contains('wc-move-san-active'),
    }));
    const expected = Array.from({ length: Math.ceil(sans.length / 2) * 2 }, (_, i) => ({
      id: `move-ply-${i + 1}`,
      text: sans[i] ?? '',
      active: i === sans.length - 1,
    }));
    return {
      plies: sans.length,
      drawn,
      expected,
      rows: rows.map((r) => r.getAttribute('data-testid')),
      expectedRows: Array.from({ length: Math.ceil(sans.length / 2) }, (_, i) => `move-row-${i + 1}`),
      empty: Boolean(list.querySelector('.wc-move-empty')),
    };
  });
}

async function waitForPlies(page: Page, plies: number): Promise<void> {
  await expect
    .poll(() => page.evaluate(() => window.__wizardChessPlay!.controller.getGameTree().getMainLine().length), {
      timeout: 30_000,
    })
    .toBe(plies);
}

test.describe('Phase 9 — performance pass', () => {
  test('the move list is extended move by move and always equals a full rebuild (also after a takeback and a new game)', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/');
    await expect(page.getByTestId('play-layout')).toBeVisible();
    await page.evaluate(() => {
      const c = window.__wizardChessPlay!.controller;
      c.setBotMoveDelayMs(5);
      c.startNewGame({ playerColor: 'w' });
    });
    const play = page.getByTestId('play-layout');

    const empty = await moveListState(page);
    expect(empty.empty).toBe(true);

    // White's first moves, the bot answering each: the list after every ply matches the tree
    const moves: [string, string][] = [
      ['e2', 'e4'],
      ['d2', 'd4'],
      ['g1', 'f3'],
    ];
    let plies = 0;
    for (const [from, to] of moves) {
      await play.getByTestId(`square-${from}`).click();
      await play.getByTestId(`square-${to}`).click();
      plies += 2;
      await waitForPlies(page, plies);
      const s = await moveListState(page);
      expect(s.empty).toBe(false);
      expect(s.drawn).toEqual(s.expected);
      expect(s.rows).toEqual(s.expectedRows);
    }

    // An odd number of plies (the player moved, the bot has not answered yet): the half-filled last row is right too
    await page.evaluate(() => window.__wizardChessPlay!.controller.setBotMoveDelayMs(60_000));
    await play.getByTestId('square-b1').click();
    await play.getByTestId('square-c3').click();
    await waitForPlies(page, plies + 1);
    const odd = await moveListState(page);
    expect(odd.drawn).toEqual(odd.expected);
    expect(odd.drawn.filter((d) => d.active)).toHaveLength(1);
    expect(odd.drawn[odd.plies - 1]!.active).toBe(true);

    // Takeback rebuilds: the move that was taken back is gone, the new last move is the active one
    expect(await page.evaluate(() => window.__wizardChessPlay!.controller.takeback())).toBe(true);
    const back = await moveListState(page);
    expect(back.plies).toBeLessThan(odd.plies);
    expect(back.drawn).toEqual(back.expected);
    expect(back.rows).toEqual(back.expectedRows);

    // Then it keeps growing from there
    await page.evaluate(() => window.__wizardChessPlay!.controller.setBotMoveDelayMs(5));
    const fromPlies = back.plies;
    await play.getByTestId('square-b1').click();
    await play.getByTestId('square-c3').click();
    await waitForPlies(page, fromPlies + 2);
    const again = await moveListState(page);
    expect(again.drawn).toEqual(again.expected);

    // A new game starts from the empty message
    await page.evaluate(() => window.__wizardChessPlay!.controller.startNewGame({ playerColor: 'w' }));
    const fresh = await moveListState(page);
    expect(fresh.empty).toBe(true);
    expect(fresh.drawn).toEqual([]);
  });

  test('a hint asked for while playing is kept with the game: a comment on the move, in the PGN, and counted by the review', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/');
    await expect(page.getByTestId('play-layout')).toBeVisible();
    await page.evaluate(() => {
      const c = window.__wizardChessPlay!.controller;
      c.setBotMoveDelayMs(5);
      c.startNewGame({ playerColor: 'w' });
    });
    const hint = await page.evaluate(() => window.__wizardChessPlay!.controller.requestHint());
    expect(hint).not.toBeNull();
    const play = page.getByTestId('play-layout');
    // The move after the hint is mine to choose (not necessarily the suggestion); the bot answers, then a move without a hint
    await play.getByTestId('square-e2').click();
    await play.getByTestId('square-e4').click();
    await waitForPlies(page, 2);
    await play.getByTestId('square-d2').click();
    await play.getByTestId('square-d4').click();
    await waitForPlies(page, 4);
    const comments = await page.evaluate(() =>
      window
        .__wizardChessPlay!.controller.getGameTree()
        .getMainLine()
        .map((n) => n.comment),
    );
    expect(comments[0]).toBe(`Hint used: ${hint!.suggestedSan}`);
    expect(comments.slice(1)).toEqual(['', '', '']);
    expect(await page.evaluate(() => window.__wizardChessPlay!.controller.getPgn())).toContain(
      `Hint used: ${hint!.suggestedSan}`,
    );

    // The game goes to Review with its comment; the review keeps it and says how many moves followed a hint
    await page.evaluate(() => window.__wizardChessPlay!.controller.resign());
    await page.getByTestId('btn-review-game').click();
    await expect(page.getByTestId('review-progress-text')).toHaveText(/^Reviewed · /, { timeout: 60_000 });
    // (the move after the hint is 1. e4, whatever the hint suggested)
    await expect
      .poll(() => page.getByTestId('review-progress').getAttribute('data-details'))
      .toContain('1 move played after a hint (1. e4)');
    const afterReview = await page.evaluate(
      () => window.__wizardChessAnalysis!.controller.getGameTree().getMainLine()[0]!.comment,
    );
    expect(afterReview).toContain(`Hint used: ${hint!.suggestedSan}`);
  });

  test('the Review screen builds on first use or when idle, and the window hooks still reach it', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/');
    await expect(page.getByTestId('play-layout')).toBeVisible();
    // Used before the idle warm-up could run: the hook builds it on the spot and it works
    const plies = await page.evaluate(() => {
      const controller = window.__wizardChessAnalysis!.controller;
      controller.importPgn('1. e4 e5 2. Nf3 Nc6 3. Bb5 a6');
      return controller.getGameTree().getMainLine().length;
    });
    expect(plies).toBe(6);
    await page.getByTestId('mode-tab-review').click();
    await expect(page.getByTestId('analysis-layout')).toBeVisible();
    // Switching screens never builds anything for nothing: Games and back to Play work with the stack in place
    await page.getByTestId('mode-tab-games').click();
    await expect(page.getByTestId('games-list')).toBeVisible();
    await page.getByTestId('mode-tab-play').click();
    await expect(page.getByTestId('play-layout')).toBeVisible();
  });
});
