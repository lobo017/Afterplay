import { expect, test, type Page } from '@playwright/test';

// Review's two pages, in one tab with one controller and one address (#review).
// - The board page: free analysis. The toolbar (New board, Edit position, Load FEN or PGN) and Sample game show. It is
//   where Review starts, and where New board, a position applied in the editor, a FEN and a PGN with no moves lead.
// - The game page: a game with at least one move is open, or a review was started. Review only: no toolbar, no Sample
//   game. Moves played on the free board do not change the page.
// The "Board tools" menu at the end of the transport row holds the three tools on both pages, so with a game open free
// analysis is two presses away. Every game here is invented; nothing reaches a network.

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const ENDGAME_FEN = '8/8/4k3/8/8/4K3/4P3/8 w - - 0 1';
const KINGS_FEN = '4k3/8/8/8/8/8/8/4K3 w - - 0 1';
const SHORT_PGN = `[Event "Study"]
[White "A"]
[Black "B"]

1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 *`;
const NO_MOVES_PGN = `[Event "Nothing played"]
[White "A"]
[Black "B"]
[Result "*"]

*`;

const SIZES = [
  { width: 375, height: 667 },
  { width: 390, height: 844 },
  { width: 900, height: 800 },
  { width: 1280, height: 900 },
] as const;
const TOOLBAR = ['btn-reset-analysis', 'btn-toggle-editor', 'btn-load-pgn'] as const;
const TRANSPORT = [
  'btn-nav-start',
  'btn-nav-prev',
  'btn-nav-next',
  'btn-nav-end',
  'btn-flip-board',
  'board-tools',
] as const;
const MENU_ITEMS = ['menu-new-board', 'menu-edit-position', 'menu-load-pgn'] as const;

const touch = () => test.info().project.name === 'webkit-iphone';

async function press(page: Page, testId: string): Promise<void> {
  const el = page.getByTestId(testId);
  if (touch()) await el.tap();
  else await el.click();
}

async function openReview(page: Page, size: { width: number; height: number }): Promise<void> {
  await page.setViewportSize(size);
  await page.goto('/');
  await press(page, 'mode-tab-review');
  await expect(page.getByTestId('analysis-layout')).toBeVisible();
  await expect(page.getByTestId('review-panel')).toBeVisible();
}

const defaultSize = () => (touch() ? { width: 390, height: 844 } : { width: 1280, height: 900 });
const layout = (page: Page) => page.getByTestId('analysis-layout');
const panel = (page: Page) => page.getByTestId('review-panel');
const controllerPage = (page: Page) => page.evaluate(() => window.__wizardChessAnalysis!.controller.getPage());
const fen = (page: Page) => page.evaluate(() => window.__wizardChessAnalysis!.controller.getAdapter().fen());
const tab = (page: Page) => page.evaluate(() => window.__wizardChessAnalysis!.controller.getTab());
const mainLine = (page: Page) =>
  page.evaluate(() => window.__wizardChessAnalysis!.controller.getGameTree().getMainLine().length);
const importPgn = (page: Page, pgn: string) =>
  page.evaluate((text) => window.__wizardChessAnalysis!.controller.importPgn(text), pgn);

/** The test ids of the review panel's action row, in page order. */
const actionOrder = (page: Page) =>
  page
    .locator('[data-testid="review-panel"] .wc-review-actions > *')
    .evaluateAll((els) => els.map((e) => e.getAttribute('data-testid') ?? ''));

/** The board page: the toolbar with its three tools, Sample game in the page, Board tools under the board. */
async function expectBoardPage(page: Page): Promise<void> {
  await expect(layout(page)).toHaveAttribute('data-page', 'board');
  expect(await controllerPage(page)).toBe('board');
  await expect(page.getByTestId('review-toolbar')).toBeVisible();
  for (const id of TOOLBAR) await expect(page.getByTestId(id)).toBeVisible();
  await expect(page.getByTestId('btn-review-sample')).toHaveCount(1);
  await expect(page.getByTestId('board-tools')).toBeVisible();
  await expect(page.getByTestId('pgn-sheet')).toHaveCount(1);
}

/** The game page: no toolbar and no Sample game; Board tools and the (closed) Load sheet are still there. */
async function expectGamePage(page: Page): Promise<void> {
  await expect(layout(page)).toHaveAttribute('data-page', 'game');
  expect(await controllerPage(page)).toBe('game');
  await expect(page.getByTestId('review-toolbar')).toBeHidden();
  for (const id of TOOLBAR) await expect(page.getByTestId(id)).toBeHidden();
  await expect(page.getByTestId('btn-review-sample')).toHaveCount(0);
  await expect(page.getByTestId('board-tools')).toBeVisible();
  await expect(page.getByTestId('pgn-sheet')).toHaveCount(1);
  // The three tabs and the transport row are as on the board page
  for (const id of ['review-shell-tab-review', 'review-shell-tab-analysis', 'review-shell-tab-moves']) {
    await expect(page.getByTestId(id)).toBeVisible();
  }
}

/** Opens Board tools and presses one of its items. */
async function boardTool(page: Page, item: (typeof MENU_ITEMS)[number]): Promise<void> {
  await press(page, 'board-tools');
  await expect(page.getByTestId('board-tools-popup')).toBeVisible();
  await press(page, item);
  await expect(page.getByTestId('board-tools-popup')).toBeHidden();
}

test.describe('Review: the board page and the game page', () => {
  test('starts on the board page; 1. e4 on the free board stays there; a review of those moves is the game page', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await openReview(page, defaultSize());
    await expectBoardPage(page);
    await expect(page.getByTestId('btn-review-sample')).toBeVisible();
    expect(new URL(page.url()).hash).toBe('#review');

    // Start review with nothing on the board: a message, and still the board page
    await press(page, 'btn-review-start');
    await expect(panel(page)).toHaveAttribute('data-state', 'error');
    await expectBoardPage(page);

    // Moves played on the free board do not make it a game
    const board = layout(page);
    await board.getByTestId('square-e2').click();
    await board.getByTestId('square-e4').click();
    await expect.poll(() => mainLine(page)).toBe(1);
    await expectBoardPage(page);
    await board.getByTestId('square-e7').click();
    await board.getByTestId('square-e5').click();
    await expect.poll(() => mainLine(page)).toBe(2);
    await expectBoardPage(page);
    await expect(page.getByTestId('btn-review-sample')).toBeVisible();

    // A review of them does
    await page.getByTestId('select-review-preset').selectOption('quick');
    await press(page, 'btn-review-start');
    await expect(panel(page)).toHaveAttribute('data-state', /^(running|done)$/);
    await expectGamePage(page);
    await expect(panel(page)).toHaveAttribute('data-state', 'done', { timeout: 60_000 });
    await expectGamePage(page);
    expect(await mainLine(page)).toBe(2);
    // One tab, one address
    expect(new URL(page.url()).hash).toBe('#review');
    await expect(page.getByTestId('mode-tab-review')).toHaveAttribute('aria-current', 'page');
  });

  test('a game with moves gives the game page, however it is loaded; a FEN or a PGN with no moves gives the board page', async ({
    page,
  }) => {
    await openReview(page, defaultSize());
    await expectBoardPage(page);

    // The way the Games list, the Story cards and the puzzles load a game
    expect(await importPgn(page, SHORT_PGN)).toBe(true);
    expect(await mainLine(page)).toBe(6);
    await expectGamePage(page);

    // A position: the board page
    await page.evaluate((f) => window.__wizardChessAnalysis!.controller.loadFen(f), ENDGAME_FEN);
    await expectBoardPage(page);

    // The way the sample game is loaded (shown from its first position)
    expect(
      await page.evaluate((pgn) => window.__wizardChessAnalysis!.controller.importPgnFromStart(pgn), SHORT_PGN),
    ).toBe(true);
    await expectGamePage(page);

    // A PGN with no moves is not a game
    expect(await importPgn(page, NO_MOVES_PGN)).toBe(true);
    expect(await mainLine(page)).toBe(0);
    await expectBoardPage(page);

    // The Load sheet, from the toolbar: a PGN with moves
    const sheet = page.getByTestId('pgn-sheet');
    await press(page, 'btn-load-pgn');
    await expect(sheet).toBeVisible();
    await page.getByTestId('textarea-pgn').fill(SHORT_PGN);
    await press(page, 'btn-import-pgn');
    await expect(sheet).toBeHidden();
    expect(await tab(page)).toBe('review');
    await expectGamePage(page);

    // The Load sheet again (from Board tools now): a PGN with no moves, then a FEN
    await boardTool(page, 'menu-load-pgn');
    await expect(sheet).toBeVisible();
    await page.getByTestId('textarea-pgn').fill(NO_MOVES_PGN);
    await press(page, 'btn-import-pgn');
    await expect(sheet).toBeHidden();
    expect(await mainLine(page)).toBe(0);
    await expectBoardPage(page);
    await press(page, 'btn-load-pgn');
    await page.getByTestId('textarea-pgn').fill(ENDGAME_FEN);
    await press(page, 'btn-import-pgn');
    await expect(sheet).toBeHidden();
    expect(await fen(page)).toBe(ENDGAME_FEN);
    expect(await tab(page)).toBe('analysis');
    await expectBoardPage(page);

    // A game from Play ("Analyze this position" copies it to Review)
    await press(page, 'mode-tab-play');
    await expect(page.getByTestId('play-layout')).toBeVisible();
    await page.evaluate(() => window.__wizardChessPlay!.controller.setBotMoveDelayMs(5));
    await page.getByTestId('play-layout').getByTestId('square-e2').click();
    await page.getByTestId('play-layout').getByTestId('square-e4').click();
    await press(page, 'play-menu');
    await press(page, 'btn-analyze-game');
    await expect(layout(page)).toBeVisible();
    expect(await mainLine(page)).toBeGreaterThanOrEqual(1);
    expect(await tab(page)).toBe('analysis');
    await expectGamePage(page);
  });

  test('Sample game is on the board page only', async ({ page }) => {
    test.setTimeout(120_000);
    await openReview(page, defaultSize());
    await expectBoardPage(page);
    const sample = page.getByTestId('btn-review-sample');
    await expect(sample).toBeVisible();
    await expect(sample).toHaveText('Sample game');
    expect(await actionOrder(page)).toEqual([
      'select-review-preset',
      'btn-review-start',
      'btn-review-cancel',
      'btn-review-sample',
      'review-stored-help',
      'review-stored-error',
    ]);

    // Pressing it opens its game: the game page, with no Sample game
    await page.getByTestId('select-review-preset').selectOption('quick');
    await press(page, 'btn-review-sample');
    await expect(panel(page)).toHaveAttribute('data-state', 'running');
    await expectGamePage(page);
    expect(await mainLine(page)).toBe(33);
    expect(await actionOrder(page)).toEqual([
      'select-review-preset',
      'btn-review-start',
      'btn-review-cancel',
      'review-stored-help',
      'review-stored-error',
    ]);
    // Canceled: still that game's page
    await press(page, 'btn-review-cancel');
    await expect(panel(page)).toHaveAttribute('data-state', 'cancelled');
    await expectGamePage(page);

    // Back on the board page it is there again, after Cancel as before
    await boardTool(page, 'menu-new-board');
    await expectBoardPage(page);
    await press(page, 'review-shell-tab-review');
    await expect(sample).toBeVisible();
    await expect(sample).toBeEnabled();
    expect(await actionOrder(page)).toEqual([
      'select-review-preset',
      'btn-review-start',
      'btn-review-cancel',
      'btn-review-sample',
      'review-stored-help',
      'review-stored-error',
    ]);
  });

  test('Board tools: every item, from a game page, does what the toolbar does and leads to the board page', async ({
    page,
  }) => {
    await openReview(page, defaultSize());
    await importPgn(page, SHORT_PGN);
    await expectGamePage(page);

    // The menu: its name, its three items, each with its own test id (none of the toolbar's is repeated)
    const button = page.getByTestId('board-tools');
    await expect(button).toHaveAccessibleName('Board tools');
    await expect(button).toHaveAttribute('aria-haspopup', 'menu');
    await expect(button).toHaveAttribute('aria-expanded', 'false');
    await press(page, 'board-tools');
    await expect(button).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByTestId('board-tools-list')).toHaveAccessibleName('Board tools');
    await expect(page.getByTestId('board-tools-list').getByRole('menuitem')).toHaveText([
      'New board',
      'Edit position',
      'Load FEN or PGN',
    ]);
    await expect(page.getByTestId('board-tools-close')).toHaveAccessibleName('Close');
    for (const id of [...TOOLBAR, ...MENU_ITEMS, 'board-tools', 'btn-review-sample', 'pgn-sheet']) {
      expect(await page.getByTestId(id).count(), `${id} is in the page at most once`).toBeLessThanOrEqual(1);
    }

    // New board: the start position, no moves, the engine lines in view
    await press(page, 'menu-new-board');
    await expect(page.getByTestId('board-tools-popup')).toBeHidden();
    expect(await fen(page)).toBe(START_FEN);
    expect(await mainLine(page)).toBe(0);
    expect(await tab(page)).toBe('analysis');
    await expect(page.getByTestId('engine-lines-panel')).toBeVisible();
    await expectBoardPage(page);

    // Edit position: the editor takes the panel's place. The game is still open until a position is applied.
    await importPgn(page, SHORT_PGN);
    await expectGamePage(page);
    await boardTool(page, 'menu-edit-position');
    await expect(page.getByTestId('review-editor-view')).toBeVisible();
    await expect(page.getByTestId('review-tabs-view')).toBeHidden();
    await expect(page.getByTestId('position-editor-mount')).toBeVisible();
    await expect(layout(page)).toHaveAttribute('data-page', 'game');
    await expect(page.getByTestId('review-toolbar')).toBeHidden();
    expect(await mainLine(page)).toBe(6);
    // Done with nothing applied: the game page again, the game untouched
    await press(page, 'btn-editor-done');
    await expect(page.getByTestId('review-tabs-view')).toBeVisible();
    await expect(page.getByTestId('review-editor-view')).toBeHidden();
    await expectGamePage(page);
    expect(await mainLine(page)).toBe(6);
    // Opened again, a position applied: the board page
    await boardTool(page, 'menu-edit-position');
    await expect(page.getByTestId('review-editor-view')).toBeVisible();
    await press(page, 'btn-editor-kings-only');
    await expect.poll(() => fen(page)).toBe(KINGS_FEN);
    expect(await mainLine(page)).toBe(0);
    await expect(layout(page)).toHaveAttribute('data-page', 'board');
    await expect(page.getByTestId('review-toolbar')).toBeVisible();
    await expect(page.getByTestId('btn-toggle-editor')).toHaveAttribute('aria-expanded', 'true');
    await press(page, 'btn-editor-done');
    await expect(page.getByTestId('review-tabs-view')).toBeVisible();
    await expectBoardPage(page);

    // Load FEN or PGN: the sheet with this game's PGN; a FEN leads to the board page
    await importPgn(page, SHORT_PGN);
    await expectGamePage(page);
    await boardTool(page, 'menu-load-pgn');
    const sheet = page.getByTestId('pgn-sheet');
    await expect(sheet).toBeVisible();
    expect(await page.getByTestId('textarea-pgn').inputValue()).toContain('1. e4 e5 2. Nf3 Nc6 3. Bb5 a6');
    await page.getByTestId('textarea-pgn').fill(ENDGAME_FEN);
    await press(page, 'btn-import-pgn');
    await expect(sheet).toBeHidden();
    expect(await fen(page)).toBe(ENDGAME_FEN);
    expect(await tab(page)).toBe('analysis');
    await expectBoardPage(page);

    // The menu is on the board page too, and does the same there
    await boardTool(page, 'menu-load-pgn');
    await expect(sheet).toBeVisible();
    await page.getByTestId('textarea-pgn').fill(SHORT_PGN);
    await press(page, 'btn-import-pgn');
    await expect(sheet).toBeHidden();
    expect(await tab(page)).toBe('review');
    await expectGamePage(page);
    await boardTool(page, 'menu-new-board');
    await expectBoardPage(page);
    await boardTool(page, 'menu-new-board');
    await expectBoardPage(page);
    expect(await fen(page)).toBe(START_FEN);
  });

  test('Tab order: move navigation, Flip, Board tools, then the toolbar (board page) or the tabs (game page)', async ({
    page,
  }) => {
    await openReview(page, defaultSize());
    /** The controls that are shown, in page order (the order Tab follows: nothing here changes it). */
    const shownOrder = () =>
      page.evaluate(
        (ids) => {
          const els = ids
            .map((id) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`))
            .filter((el): el is HTMLElement => !!el && el.getClientRects().length > 0);
          els.sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
          const custom = [...document.querySelectorAll<HTMLElement>('[data-testid="analysis-layout"] [tabindex]')]
            .filter((el) => el.tabIndex > 0)
            .map((el) => el.getAttribute('data-testid') ?? el.tagName);
          return { order: els.map((el) => el.getAttribute('data-testid')), custom };
        },
        // Deliberately not in page order
        ['review-shell-tab-review', ...TOOLBAR, 'board-tools', 'btn-flip-board', 'btn-nav-end', 'btn-nav-start'],
      );
    const board = await shownOrder();
    expect(board.custom, 'no positive tabindex').toEqual([]);
    expect(board.order).toEqual([
      'btn-nav-start',
      'btn-nav-end',
      'btn-flip-board',
      'board-tools',
      'btn-reset-analysis',
      'btn-toggle-editor',
      'btn-load-pgn',
      'review-shell-tab-review',
    ]);
    await importPgn(page, SHORT_PGN);
    await expectGamePage(page);
    const game = await shownOrder();
    expect(game.custom, 'no positive tabindex').toEqual([]);
    expect(game.order).toEqual([
      'btn-nav-start',
      'btn-nav-end',
      'btn-flip-board',
      'board-tools',
      'review-shell-tab-review',
    ]);

    // With a keyboard (a phone has no Tab key)
    if (touch()) return;
    const focused = (id: string) => expect(page.getByTestId(id)).toBeFocused();
    // The game page: Flip, Board tools, then straight to the tabs
    await page.getByTestId('btn-flip-board').focus();
    await page.keyboard.press('Tab');
    await focused('board-tools');
    await page.keyboard.press('Tab');
    await focused('review-shell-tab-review');
    await page.keyboard.press('Shift+Tab');
    await focused('board-tools');
    // The menu by keyboard: Enter opens it on its first item, the arrows move, Escape gives the focus back
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('board-tools-popup')).toBeVisible();
    await focused('menu-new-board');
    await page.keyboard.press('ArrowDown');
    await focused('menu-edit-position');
    await page.keyboard.press('ArrowDown');
    await focused('menu-load-pgn');
    await page.keyboard.press('ArrowDown');
    await focused('menu-new-board');
    await page.keyboard.press('ArrowUp');
    await focused('menu-load-pgn');
    // (the arrows moved through the menu, not through the game)
    expect(await page.evaluate(() => window.__wizardChessAnalysis!.controller.getGameTree().currentNode.ply)).toBe(6);
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('board-tools-popup')).toBeHidden();
    await focused('board-tools');
    // Load FEN or PGN by keyboard; closing the sheet gives the focus back to Board tools
    await page.keyboard.press('Enter');
    await focused('menu-new-board');
    await page.keyboard.press('ArrowUp');
    await focused('menu-load-pgn');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('pgn-sheet')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('pgn-sheet')).toBeHidden();
    await focused('board-tools');
    // New board by keyboard: the board page, where the toolbar follows Board tools
    await page.keyboard.press('Enter');
    await focused('menu-new-board');
    await page.keyboard.press('Enter');
    await expectBoardPage(page);
    await focused('board-tools');
    for (const id of TOOLBAR) {
      await page.keyboard.press('Tab');
      await focused(id);
    }
    await page.keyboard.press('Tab');
    await focused('review-shell-tab-analysis');
    await page.keyboard.press('Shift+Tab');
    await focused('btn-load-pgn');
  });

  for (const size of SIZES) {
    test(`both pages fit at ${size.width}x${size.height}: the transport row, the toolbar, the Board tools menu, no sideways scroll`, async ({
      page,
    }) => {
      await openReview(page, size);
      for (const kind of ['board', 'game'] as const) {
        if (kind === 'game') {
          await importPgn(page, SHORT_PGN);
          await expectGamePage(page);
        } else {
          await expectBoardPage(page);
        }
        await page.evaluate(() => window.scrollTo(0, 0));
        const sideScroll = () =>
          page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        expect(await sideScroll(), `${kind}: no sideways scroll`).toBeLessThanOrEqual(0);

        // The transport row: six buttons in one row, left to right, none over another, each big enough to touch
        const row = await page.evaluate(
          (ids) =>
            ids.map((id) => {
              const el = document.querySelector<HTMLElement>(`[data-testid="${id}"]`)!;
              el.scrollIntoView({ block: 'center' });
              const r = el.getBoundingClientRect();
              const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
              return { id, x: r.left, y: r.top, w: r.width, h: r.height, reached: !!hit && el.contains(hit) };
            }),
          [...TRANSPORT],
        );
        for (const [i, b] of row.entries()) {
          expect(b.x, `${kind}: ${b.id} inside the screen`).toBeGreaterThanOrEqual(0);
          expect(b.x + b.w, `${kind}: ${b.id} inside the screen`).toBeLessThanOrEqual(size.width + 0.5);
          expect(b.w, `${kind}: ${b.id} width`).toBeGreaterThanOrEqual(44);
          expect(b.h, `${kind}: ${b.id} height`).toBeGreaterThanOrEqual(44);
          expect(Math.abs(b.y - row[0]!.y), `${kind}: ${b.id} in the same row`).toBeLessThanOrEqual(0.5);
          expect(b.reached, `${kind}: ${b.id} is not covered`).toBe(true);
          if (i > 0) {
            const before = row[i - 1]!;
            expect(b.x, `${kind}: ${b.id} right of ${before.id}`).toBeGreaterThanOrEqual(before.x + before.w - 0.5);
          }
        }

        // The toolbar on the board page: its three buttons inside the screen, no text cut
        if (kind === 'board') {
          for (const id of TOOLBAR) {
            const el = page.getByTestId(id);
            await el.scrollIntoViewIfNeeded();
            const box = (await el.boundingBox())!;
            expect(box.x, `${id} inside the screen`).toBeGreaterThanOrEqual(0);
            expect(box.x + box.width, `${id} inside the screen`).toBeLessThanOrEqual(size.width + 0.5);
            expect(box.height, id).toBeGreaterThanOrEqual(40);
            expect(await el.evaluate((n) => n.scrollWidth <= n.clientWidth), `${id} text fits`).toBe(true);
            // The label itself (the box that would show "…"): nothing of it is cut off, at 375 px too
            const label = await el.evaluate((n) => {
              const span = n.querySelector<HTMLElement>(':scope > span')!;
              // The width its own text needs (scrollWidth is a whole number, and less than a pixel short already
              // shows "…")
              let text = 0;
              for (const node of span.childNodes) {
                if (node.nodeType !== Node.TEXT_NODE) continue;
                const range = document.createRange();
                range.selectNodeContents(node);
                text += range.getBoundingClientRect().width;
              }
              return {
                scroll: span.scrollWidth,
                client: span.clientWidth,
                box: span.getBoundingClientRect().width,
                text,
              };
            });
            expect(label.scroll, `${id} label is not truncated`).toBeLessThanOrEqual(label.client);
            expect(label.text, `${id} label has the width its text needs`).toBeLessThanOrEqual(label.box + 0.05);
          }
          expect(await sideScroll(), 'board: no sideways scroll with the toolbar in view').toBeLessThanOrEqual(0);
        }

        // The menu: inside the screen, between the top bar and the bottom tab bar, every item whole
        await page.evaluate(() => window.scrollTo(0, 0));
        await press(page, 'board-tools');
        await expect(page.getByTestId('board-tools-popup')).toBeVisible();
        const menu = await page.evaluate(
          (ids) => {
            const popup = document.querySelector<HTMLElement>('[data-testid="board-tools-popup"]')!;
            const bar = document.querySelector<HTMLElement>('.wc-topbar');
            const nav = document.querySelector<HTMLElement>('.wc-nav');
            const navFixed = !!nav && getComputedStyle(nav).position === 'fixed';
            const p = popup.getBoundingClientRect();
            const close = document
              .querySelector<HTMLElement>('[data-testid="board-tools-close"]')!
              .getBoundingClientRect();
            return {
              top: p.top,
              bottom: p.bottom,
              left: p.left,
              right: p.right,
              bandTop: bar ? bar.getBoundingClientRect().bottom : 0,
              bandBottom: navFixed ? nav!.getBoundingClientRect().top : innerHeight,
              close: { w: close.width, h: close.height },
              items: ids.map((id) => {
                const el = document.querySelector<HTMLElement>(`[data-testid="${id}"]`)!;
                const r = el.getBoundingClientRect();
                const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
                return {
                  id,
                  top: r.top,
                  bottom: r.bottom,
                  left: r.left,
                  right: r.right,
                  h: r.height,
                  cut: el.scrollWidth > el.clientWidth,
                  reached: !!hit && el.contains(hit),
                };
              }),
            };
          },
          [...MENU_ITEMS],
        );
        expect(menu.left, `${kind}: menu inside the screen`).toBeGreaterThanOrEqual(-0.5);
        expect(menu.right, `${kind}: menu inside the screen`).toBeLessThanOrEqual(size.width + 0.5);
        expect(menu.top, `${kind}: menu below the top bar`).toBeGreaterThanOrEqual(menu.bandTop - 0.5);
        expect(menu.bottom, `${kind}: menu above the bottom tab bar`).toBeLessThanOrEqual(menu.bandBottom + 0.5);
        expect(menu.close.w).toBeGreaterThanOrEqual(44);
        expect(menu.close.h).toBeGreaterThanOrEqual(44);
        for (const item of menu.items) {
          expect(item.top, `${kind}: ${item.id} inside the menu`).toBeGreaterThanOrEqual(menu.top - 0.5);
          expect(item.bottom, `${kind}: ${item.id} inside the menu`).toBeLessThanOrEqual(menu.bottom + 0.5);
          expect(item.left, `${kind}: ${item.id} inside the menu`).toBeGreaterThanOrEqual(menu.left - 0.5);
          expect(item.right, `${kind}: ${item.id} inside the menu`).toBeLessThanOrEqual(menu.right + 0.5);
          expect(item.h, `${kind}: ${item.id} height`).toBeGreaterThanOrEqual(40);
          expect(item.cut, `${kind}: ${item.id} text fits`).toBe(false);
          expect(item.reached, `${kind}: ${item.id} is not covered`).toBe(true);
        }
        expect(await sideScroll(), `${kind}: no sideways scroll with the menu open`).toBeLessThanOrEqual(0);
        await press(page, 'board-tools-close');
        await expect(page.getByTestId('board-tools-popup')).toBeHidden();
      }
    });
  }
});
