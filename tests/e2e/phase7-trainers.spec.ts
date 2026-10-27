import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type Page, type Request } from '@playwright/test';
import { Chess } from 'chess.js';
import { ensureOracle, exactMateDistance } from '../helpers/dtm-oracle';
import { bestAttackerMove, blackToMoveValue } from '../helpers/dtm-play';

// Phase 7: the repertoire, endgame and visualization trainers in the Train hub. One drill of
// each is completed through the UI; they feed the same Today schedule as puzzles; the review
// says where a game of mine leaves my repertoire. Desktop and phone screenshots go to
// test-results/phase7-screens/.
const SCREENSHOT_DIR = path.join('test-results', 'phase7-screens');
fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
const shot = (page: Page, name: string, fullPage = false) =>
  page.screenshot({ path: path.join(SCREENSHOT_DIR, name), fullPage });

function trackNetwork(page: Page): string[] {
  const external: string[] = [];
  page.on('request', (r: Request) => {
    const url = new URL(r.url());
    if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') external.push(r.url());
  });
  return external;
}

async function openTrain(page: Page, width = 1440, height = 900): Promise<void> {
  await page.setViewportSize({ width, height });
  await page.goto('/#train');
  await page.evaluate(() => window.__wizardChessDrillsReady);
  await expect(page.getByTestId('today-screen')).toHaveAttribute('data-state', 'ready');
}

async function squareCenter(page: Page, scope: string, sq: string) {
  const box = await page.getByTestId(scope).getByTestId(`square-${sq}`).boundingBox();
  if (!box) throw new Error(`square-${sq} has no box in ${scope}`);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/** Plays a move by clicking its two squares. */
async function clickMove(page: Page, scope: string, from: string, to: string): Promise<void> {
  const a = await squareCenter(page, scope, from);
  await page.mouse.click(a.x, a.y);
  const b = await squareCenter(page, scope, to);
  await page.mouse.click(b.x, b.y);
}

async function noSidewaysScroll(page: Page, width: number): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
}

const WHITE_REPERTOIRE = `[Event "Ruy Lopez"]
[Result "*"]

1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 (3... Nf6 4. O-O) 4. Ba4 Nf6 *

[Event "Sicilian"]
[Result "*"]

1. e4 c5 2. Nf3 d6 *`;

/** Imports a PGN through the trainer's own Import button. */
async function importRepertoire(page: Page, pgn: string): Promise<void> {
  await page.getByTestId('btn-rep-import').click();
  await page.getByTestId('rep-import-text').fill(pgn);
  await page.getByTestId('btn-rep-import-run').click();
}

test.describe('Phase 7 — the Train hub', () => {
  test('lists the four trainers and adds their cards to Today, with nothing waiting on a fresh profile', async ({
    page,
  }) => {
    const external = trackNetwork(page);
    await openTrain(page);
    for (const kind of ['puzzles', 'repertoire', 'endgames', 'visualization']) {
      await expect(page.getByTestId(`trainer-tile-${kind}`)).toBeVisible();
      await expect(page.getByTestId(`btn-trainer-${kind}`)).toBeEnabled();
    }
    await expect(page.getByTestId('trainer-tile-endgames-detail')).toHaveText('0 of 6 completed');
    // Today carries a card for each new trainer, nothing to do yet
    for (const kind of ['repertoire', 'endgame', 'visualization']) {
      await expect(page.getByTestId(`today-${kind}-count`)).toHaveText('0');
      await expect(page.getByTestId(`btn-today-${kind}`)).toBeDisabled();
    }
    // Still one primary button, and a fresh profile looks as before
    await expect(page.getByTestId('train-hub').locator('.wc-btn-primary:visible')).toHaveCount(1);
    await expect(page.getByTestId('nav-train-count')).toBeHidden();
    await expect(page.getByTestId('train-start-detail')).toHaveText('Rated puzzles near 1500');
    await shot(page, 'desktop-train-hub.png', true);
    expect(external).toEqual([]);
  });

  test('the trainers are their own chunks: not loaded until opened', async ({ page }) => {
    const requests: string[] = [];
    page.on('request', (r) => requests.push(new URL(r.url()).pathname));
    await openTrain(page);
    await page.waitForTimeout(300);
    for (const name of ['repertoire-trainer', 'endgame-trainer', 'visualization-trainer']) {
      expect(
        requests.some((p) => p.includes(name)),
        name,
      ).toBe(false);
    }
    await page.getByTestId('btn-trainer-endgames').click();
    await expect(page.getByTestId('endgame-trainer')).toBeVisible();
    expect(requests.some((p) => p.includes('endgame-trainer'))).toBe(true);
    expect(requests.some((p) => p.includes('repertoire-trainer'))).toBe(false);
  });

  test('phone: the hub fits', async ({ page }) => {
    await openTrain(page, 390, 844);
    await noSidewaysScroll(page, 390);
    const tile = (await page.getByTestId('trainer-tile-repertoire').boundingBox())!;
    expect(tile.width).toBeGreaterThan(300);
    await shot(page, 'phone-train-hub.png', true);
  });
});

test.describe('Phase 7 — repertoire trainer', () => {
  test('builds by importing and by playing moves, then drills every line with spaced repetition', async ({ page }) => {
    test.setTimeout(150_000);
    const external = trackNetwork(page);
    await openTrain(page);
    await page.getByTestId('btn-trainer-repertoire').click();
    await expect(page.getByTestId('repertoire-trainer')).toBeVisible();
    await expect(page.getByTestId('rep-summary')).toContainText('White repertoire: empty');
    await expect(page.getByTestId('rep-tab-build')).toHaveAttribute('aria-selected', 'true');
    await shot(page, 'desktop-repertoire-empty.png');

    // Import: every game and variation goes in (13 moves, 3 lines, 6 positions to answer)
    await importRepertoire(page, WHITE_REPERTOIRE);
    await expect(page.getByTestId('rep-summary')).toHaveText(
      'White repertoire: 13 moves in 3 lines, 6 positions to answer.',
    );
    await expect(page.getByTestId('rep-import-result')).toContainText('Imported 2 games: 13 new moves.');
    await expect(page.getByTestId('rep-moves').getByRole('button', { name: 'Bb5' })).toBeVisible();
    // Importing the same text again adds nothing
    await importRepertoire(page, WHITE_REPERTOIRE);
    await expect(page.getByTestId('rep-import-result')).toContainText('0 new moves');

    // Walk the tree: forward to the end of the main line, and click a move in the list
    await page.getByTestId('btn-rep-last').click();
    await expect(page.getByTestId('rep-moves').locator('[aria-current="true"]')).toHaveText('Nf6');
    await page.getByTestId('rep-moves').getByRole('button', { name: 'Bb5' }).click();
    expect(
      await page.evaluate(
        () => window.__wizardChessDrills!.getRepertoire()!.getBoard().getPieceElement('b5') !== undefined,
      ),
    ).toBe(true);
    await shot(page, 'desktop-repertoire-build.png');

    // Build by playing: a Black repertoire, 1.e4 e5 on the board
    await page.getByTestId('rep-color-b').click();
    await expect(page.getByTestId('rep-summary')).toContainText('Black repertoire: empty');
    await clickMove(page, 'repertoire-trainer', 'e2', 'e4');
    await clickMove(page, 'repertoire-trainer', 'e7', 'e5');
    await expect(page.getByTestId('rep-summary')).toHaveText(
      'Black repertoire: 2 moves in 1 line, 1 position to answer.',
    );
    // The tree is stored: a reload keeps it
    await page.evaluate(async () => {
      const api = await window.__wizardChessDrillsReady!;
      const due = await api.store.repertoire.due('b');
      if (due.total !== 1) throw new Error(`expected 1 Black card, got ${due.total}`);
    });
    // A mistaken move can be deleted
    await page.getByTestId('btn-rep-delete').click();
    await expect(page.getByTestId('rep-summary')).toHaveText(
      'Black repertoire: 1 move in 1 line, 0 positions to answer.',
    );
    await page.getByTestId('rep-color-w').click();

    // What's waiting shows on the Train tab and in Today
    await expect(page.getByTestId('nav-train-count')).toHaveText('6');

    // Drill: lines are played from the start; every position is answered until nothing is due
    await page.getByTestId('rep-tab-drill').click();
    await expect(page.getByTestId('rep-drill-new')).toHaveText('6');
    await expect(page.getByTestId('rep-drill-lines')).toHaveText('3');
    const trainer = page.getByTestId('repertoire-trainer');
    const remaining = () =>
      page.evaluate(
        async () => (await (await window.__wizardChessDrillsReady!).store.repertoire.due('w')).ordered.length,
      );
    let lines = 0;
    let shotTaken = false;
    let refused = false;
    while (lines < 6 && (await remaining()) > 0) {
      await expect(page.getByTestId('btn-rep-start')).toBeEnabled({ timeout: 15_000 });
      await page.getByTestId('btn-rep-start').click();
      // The previous line's 'done' goes away once this drill starts
      await expect(trainer).not.toHaveAttribute('data-rep-state', 'done');
      for (;;) {
        await expect.poll(() => trainer.getAttribute('data-rep-state'), { timeout: 20_000 }).toMatch(/asking|done/);
        if ((await trainer.getAttribute('data-rep-state')) === 'done') break;
        const move = await page.evaluate(() => {
          const m = window.__wizardChessDrills!.getRepertoire()!.getDrill()!.expected()[0]!;
          return { from: m.uci.slice(0, 2), to: m.uci.slice(2, 4) };
        });
        if (!shotTaken && lines === 0) {
          await shot(page, 'desktop-repertoire-drill.png');
          shotTaken = true;
        }
        // A wrong move first: it is refused, said so, and the position stays
        if (!refused) {
          refused = true;
          await clickMove(
            page,
            'repertoire-trainer',
            move.from === 'a2' ? 'h2' : 'a2',
            move.from === 'a2' ? 'h3' : 'a3',
          );
          await expect(page.getByTestId('rep-status')).toContainText('Not a move from your repertoire');
          await expect(trainer).toHaveAttribute('data-rep-state', 'asking');
        }
        await clickMove(page, 'repertoire-trainer', move.from, move.to);
        await expect(trainer).not.toHaveAttribute('data-rep-state', 'asking');
      }
      lines++;
      await expect(page.getByTestId('rep-result')).toContainText('right first time');
      // The last answers are written to the store a moment after the line ends
      await page.waitForTimeout(400);
    }
    // Three lines in the tree (the main line, its variation, the Sicilian): each walked once
    expect(lines).toBe(3);
    await expect(page.getByTestId('rep-drill-new')).toHaveText('0');
    await expect(page.getByTestId('rep-drill-due')).toHaveText('0');
    // Every position was graded: the first one I got wrong comes back in ten minutes, the rest in days
    const cards = await page.evaluate(async () => {
      const api = await window.__wizardChessDrillsReady!;
      return (await api.store.repertoire.cards('w')).map((c) => ({ state: c.state, reps: c.reps }));
    });
    expect(cards).toHaveLength(6);
    expect(cards.every((c) => c.state !== 'new')).toBe(true);
    await page.getByTestId('rep-tab-build').click();
    await page.getByTestId('rep-tab-drill').click();
    await expect(page.getByTestId('rep-status')).toHaveText('Nothing due right now');
    await shot(page, 'desktop-repertoire-done.png');
    await expect(page.getByTestId('nav-train-count')).toBeHidden();

    // Nothing is due, so "Practise anyway" stands in for "Start drill": it asks every position of a
    // line, and grades nothing (the schedule stays as it was)
    await expect(page.getByTestId('btn-rep-start')).toBeHidden();
    await expect(page.getByTestId('btn-rep-practise')).toBeVisible();
    await expect(page.getByTestId('btn-rep-practise')).toHaveClass(/wc-btn-primary/);
    await expect(page.getByTestId('rep-prompt')).toContainText('nothing is graded');
    await shot(page, 'desktop-repertoire-practise.png');
    const schedule = () =>
      page.evaluate(async () => {
        const api = await window.__wizardChessDrillsReady!;
        return (await api.store.repertoire.cards('w'))
          .map((c) => ({ id: c.id, state: c.state, reps: c.reps, dueDate: c.dueDate }))
          .sort((a, b) => a.id.localeCompare(b.id));
      });
    const before = await schedule();
    await page.getByTestId('btn-rep-practise').click();
    let asked = 0;
    let missed = false;
    for (;;) {
      await expect.poll(() => trainer.getAttribute('data-rep-state'), { timeout: 20_000 }).toMatch(/asking|done/);
      if ((await trainer.getAttribute('data-rep-state')) === 'done') break;
      const move = await page.evaluate(() => {
        const m = window.__wizardChessDrills!.getRepertoire()!.getDrill()!.expected()[0]!;
        return { from: m.uci.slice(0, 2), to: m.uci.slice(2, 4) };
      });
      if (!missed) {
        missed = true;
        await clickMove(page, 'repertoire-trainer', move.from === 'a2' ? 'h2' : 'a2', move.from === 'a2' ? 'h3' : 'a3');
        await expect(page.getByTestId('rep-status')).toContainText('Not a move from your repertoire');
      }
      await clickMove(page, 'repertoire-trainer', move.from, move.to);
      asked++;
      await expect(trainer).not.toHaveAttribute('data-rep-state', 'asking');
    }
    expect(asked).toBeGreaterThanOrEqual(2);
    await expect(page.getByTestId('rep-status')).toHaveText('Practice line complete');
    await expect(page.getByTestId('rep-result')).toContainText(
      `of ${asked} position${asked === 1 ? '' : 's'} right first time.`,
    );
    await expect(page.getByTestId('btn-rep-practise')).toHaveText('Practise another line');
    await page.waitForTimeout(400);
    expect(await schedule()).toEqual(before);
    expect(await remaining()).toBe(0);
    expect(external).toEqual([]);
  });

  test('the Today card and Start training open the repertoire drill', async ({ page }) => {
    await openTrain(page);
    await page.evaluate(async () => {
      const api = await window.__wizardChessDrillsReady!;
      const tree = new window.__wizardChessCore!.GameTree();
      for (const san of ['e4', 'e5', 'Nf3']) tree.addMove(san);
      await api.store.repertoire.save('b', tree);
    });
    // The tree has e4, e5 and Nf3: as a Black repertoire, ...e5 is the one position of mine
    await page.getByTestId('mode-tab-play').click();
    await page.getByTestId('mode-tab-train').click();
    await expect(page.getByTestId('nav-train-count')).toHaveText('1');
    await expect(page.getByTestId('today-repertoire-count')).toHaveText('1');
    await expect(page.getByTestId('today-repertoire-detail')).toHaveText('0 due · 1 new');
    await expect(page.getByTestId('train-start-detail')).toHaveText('Your 1 repertoire position');
    await page.getByTestId('btn-train-start').click();
    const trainer = page.getByTestId('repertoire-trainer');
    await expect(trainer).toHaveAttribute('data-rep-color', 'b');
    await expect(trainer).toHaveAttribute('data-rep-tab', 'drill');
    await expect(trainer).toHaveAttribute('data-rep-state', 'asking', { timeout: 20_000 });
    // The drill plays White's first move, then asks for ...e5 as Black
    await expect(page.getByTestId('rep-line')).toHaveText('1. e4');
    await clickMove(page, 'repertoire-trainer', 'e7', 'e5');
    await expect(trainer).toHaveAttribute('data-rep-state', 'done', { timeout: 20_000 });
    await expect(page.getByTestId('rep-result')).toHaveText('1 of 1 position right first time.');
  });

  test('the review says where a game of mine leaves my repertoire (only my own games)', async ({ page }) => {
    test.setTimeout(150_000);
    await openTrain(page);
    await page.getByTestId('btn-trainer-repertoire').click();
    await importRepertoire(page, WHITE_REPERTOIRE);
    await expect(page.getByTestId('rep-summary')).toContainText('13 moves');
    await page.getByTestId('rep-color-b').click();
    await clickMove(page, 'repertoire-trainer', 'e2', 'e4');
    await clickMove(page, 'repertoire-trainer', 'e7', 'e5');
    await expect(page.getByTestId('rep-summary')).toContainText('2 moves');

    const game = (white: string, black: string, moves: string, id: string) =>
      `[Event "Casual"]\n[Site "https://lichess.org/${id}"]\n[Date "2026.10.20"]\n[White "${white}"]\n[Black "${black}"]\n[Result "*"]\n\n${moves} *`;
    const review = async (pgn: string): Promise<void> => {
      await page.evaluate(async (text) => {
        const lib = await window.__wizardChessLibraryReady!;
        const out = await lib.library.importPgnText(text);
        if (out.saved.length !== 1) throw new Error(`not imported: ${JSON.stringify(out)}`);
        await lib.openGame(out.saved[0]!);
        await window.__wizardChessReview!.panel.start();
      }, pgn);
    };

    // I (Lobo017, White) played 3.d4 where my repertoire has 3.Bb5
    await review(game('Lobo017', 'Opponent', '1. e4 e5 2. Nf3 Nc6 3. d4 exd4 4. Nxd4', 'LeaveW01'));
    const note = page.getByTestId('review-repertoire');
    await expect(note).toBeVisible();
    await expect(note).toHaveAttribute('data-kind', 'left');
    await expect(page.getByTestId('review-repertoire-text')).toHaveText(
      'You left your White repertoire at 3.d4. Your repertoire plays Bb5 there.',
    );
    await shot(page, 'desktop-review-repertoire-left.png');
    // The button goes to that move
    await page.getByTestId('btn-review-repertoire-jump').click();
    expect(await page.evaluate(() => window.__wizardChessAnalysis!.controller.getGameTree().currentNode.san)).toBe(
      'd4',
    );

    // The opponent leaves my White repertoire at move 1
    await review(game('Lobo017', 'Opponent', '1. e4 d5 2. exd5 Qxd5', 'OppLvW01'));
    await expect(note).toHaveAttribute('data-kind', 'opponent-left');
    await expect(page.getByTestId('review-repertoire-text')).toContainText(
      'Your opponent left your White repertoire at 1...d5',
    );

    // As Black I played 1...c5 where my Black repertoire has 1...e5
    await review(game('Opponent', 'Lobo017', '1. e4 c5 2. Nf3 d6', 'LeaveB01'));
    await expect(note).toHaveAttribute('data-kind', 'left');
    await expect(page.getByTestId('review-repertoire-text')).toHaveText(
      'You left your Black repertoire at 1...c5. Your repertoire plays e5 there.',
    );

    // A game I followed to the end of a line
    await review(game('Lobo017', 'Opponent', '1. e4 c5 2. Nf3 d6 3. d4 cxd4', 'EndLin01'));
    await expect(note).toHaveAttribute('data-kind', 'ended');

    // Not my game (neither player is one of my usernames): no flag at all
    await review(game('Alice', 'Bob', '1. e4 e5 2. Nf3 Nc6 3. d4 exd4', 'NotMin01'));
    await expect(note).toBeHidden();
  });

  test('phone: build and drill fit the screen', async ({ page }) => {
    await openTrain(page, 390, 844);
    await page.getByTestId('btn-trainer-repertoire').click();
    await expect(page.getByTestId('repertoire-trainer')).toBeVisible();
    await importRepertoire(page, WHITE_REPERTOIRE);
    await expect(page.getByTestId('rep-summary')).toContainText('13 moves');
    const frame = (await page.getByTestId('repertoire-trainer').getByTestId('chess-board-frame').boundingBox())!;
    expect(frame.width).toBeGreaterThanOrEqual(370);
    await noSidewaysScroll(page, 390);
    await shot(page, 'phone-repertoire-build.png', true);
    await page.getByTestId('rep-tab-drill').click();
    await page.getByTestId('btn-rep-start').click();
    await expect(page.getByTestId('repertoire-trainer')).toHaveAttribute('data-rep-state', 'asking', {
      timeout: 20_000,
    });
    await noSidewaysScroll(page, 390);
    await shot(page, 'phone-repertoire-drill.png', true);
  });
});

const ENDGAME_OPTIMAL: Record<string, number> = { 'kq-vs-k': 7, 'kr-vs-k': 14, 'kp-opposition': 11 };

test.describe('Phase 7 — endgame trainer', () => {
  /** Plays the drill with the engine's own moves (the Hint) until it ends. */
  async function playOut(page: Page, moves = 40): Promise<string> {
    const trainer = page.getByTestId('endgame-trainer');
    for (let i = 0; i < moves; i++) {
      await expect
        .poll(() => trainer.getAttribute('data-endgame-state'), { timeout: 30_000 })
        .toMatch(/playing|reached|failed/);
      const state = (await trainer.getAttribute('data-endgame-state'))!;
      if (state !== 'playing') return state;
      await page.getByTestId('btn-endgame-hint').click();
      await expect(trainer).toHaveAttribute('data-hint', /^[a-h][1-8][a-h][1-8]/);
      const hint = (await trainer.getAttribute('data-hint'))!;
      if (i === 1) await shot(page, 'desktop-endgame-hint.png');
      await clickMove(page, 'endgame-trainer', hint.slice(0, 2), hint.slice(2, 4));
      // A promotion asks which piece
      if (hint.length > 4) await page.getByTestId(`promote-${hint[4]}`).click();
    }
    throw new Error('the drill did not end');
  }

  test('lists the six positions with what each needs; K+Q v K is played to mate and recorded', async ({ page }) => {
    test.setTimeout(120_000);
    const external = trackNetwork(page);
    await openTrain(page);
    await page.getByTestId('btn-trainer-endgames').click();
    const trainer = page.getByTestId('endgame-trainer');
    await expect(trainer).toHaveAttribute('data-endgame-id', 'kq-vs-k');
    await expect(page.getByTestId('endgame-list').getByRole('radio')).toHaveCount(6);
    await expect(page.getByTestId('endgame-item-kq-vs-k')).toContainText('ideal 7');
    await expect(page.getByTestId('endgame-item-kr-vs-k')).toContainText('ideal 14');
    await expect(page.getByTestId('endgame-item-kp-opposition')).toContainText('ideal 11');
    await expect(page.getByTestId('endgame-item-lucena-position')).toContainText('Convert the win');
    await expect(page.getByTestId('endgame-item-philidor-position')).toContainText('Hold the draw');
    await expect(page.getByTestId('endgame-goal')).toContainText('Best possible: 7 moves');
    await expect(page.getByTestId('endgame-status')).toHaveText('Your move as White');
    await expect(page.getByTestId('btn-endgame-draw')).toBeHidden();
    await shot(page, 'desktop-endgame-start.png');

    // A move the queen can't make changes nothing (a knight's step)
    await clickMove(page, 'endgame-trainer', 'd1', 'e3');
    await expect(page.getByTestId('endgame-moves')).toHaveText('0 moves');

    expect(await playOut(page)).toBe('reached');
    await expect(page.getByTestId('endgame-status')).toHaveText('Target reached!');
    await expect(page.getByTestId('endgame-result')).toContainText('Checkmate!');
    await expect(page.getByTestId('endgame-result')).toContainText('best possible is 7');
    await expect(page.getByTestId('btn-endgame-next')).toHaveClass(/wc-btn-primary/);
    await expect(page.getByTestId('endgame-item-kq-vs-k')).toHaveAttribute('data-completed', 'true');
    await expect(page.getByTestId('endgame-stat-done')).toHaveText('1 of 6');
    await shot(page, 'desktop-endgame-done.png');

    const saved = await page.evaluate(async () => {
      const api = await window.__wizardChessDrillsReady!;
      const progress = await api.store.endgames.getProgress('kq-vs-k');
      const cards = await api.store.endgames.listCards();
      return { progress, cards: cards.map((c) => ({ id: c.id, state: c.state, reps: c.reps })) };
    });
    // The hints made it a drill without a best count; it is still a completion
    expect(saved.progress).toMatchObject({
      completed: 1,
      attempts: 1,
      completions: 1,
      bestMoves: null,
      optimalMoves: 7,
      lastReached: true,
    });
    expect(saved.progress!.lastMoves).toBeGreaterThanOrEqual(1);
    expect(saved.cards).toEqual([{ id: 'endgame:kq-vs-k', state: 'review', reps: 1 }]);
    expect(external).toEqual([]);

    // Next position: the next one not completed yet
    await page.getByTestId('btn-endgame-next').click();
    await expect(trainer).toHaveAttribute('data-endgame-id', 'kr-vs-k');
  });

  // The three mate drills are answered from exact tables, not the engine: whatever the player
  // does, the opponent's reply keeps the mate as far away as it can be, so playing the best
  // moves mates in exactly the stored "best possible" count.
  for (const [id, label] of [
    ['kq-vs-k', 'K+Q v K'],
    ['kr-vs-k', 'K+R v K'],
    ['kp-opposition', 'K+P v K'],
  ] as const) {
    test(`${label}: the opponent always plays the DTM-optimal defence, so best play mates in the stored count`, async ({
      page,
    }) => {
      test.setTimeout(180_000);
      await ensureOracle();
      const external = trackNetwork(page);
      await openTrain(page);
      await page.getByTestId('btn-trainer-endgames').click();
      await page.getByTestId(`endgame-item-${id}`).click();
      const trainer = page.getByTestId('endgame-trainer');
      await expect(trainer).toHaveAttribute('data-endgame-id', id);
      await expect(trainer).toHaveAttribute('data-endgame-state', 'playing');
      const optimal = ENDGAME_OPTIMAL[id]!;
      const sessionFen = () => page.evaluate(() => window.__wizardChessDrills!.getEndgames()!.getSession()!.fen);
      let played = 0;
      for (;;) {
        const fen = await sessionFen();
        const pick = bestAttackerMove(fen);
        expect(pick.moves, `distance from ${fen}`).toBe(optimal - played);
        const after = new Chess(fen);
        after.move(pick.san);
        const expected = blackToMoveValue(after.fen());
        await clickMove(page, 'endgame-trainer', pick.from, pick.to);
        if (pick.promotion) await page.getByTestId(`promote-${pick.promotion}`).click();
        played++;
        if (pick.moves === 1) break;
        // The reply arrives: it must be the one the exact solver rates as the longest resistance
        await expect.poll(async () => (await sessionFen()) !== after.fen(), { timeout: 20_000 }).toBe(true);
        await expect(trainer).toHaveAttribute('data-endgame-state', 'playing');
        const replied = await sessionFen();
        expect(exactMateDistance(replied), `reply to ${after.fen()}: ${replied}`).toBe(expected);
      }
      await expect(trainer).toHaveAttribute('data-endgame-state', 'reached');
      await expect(page.getByTestId('endgame-result')).toContainText(
        `Mate in ${optimal} moves; best possible is ${optimal}.`,
      );
      await expect
        .poll(() =>
          page.evaluate(
            async (endgameId) =>
              (await (await window.__wizardChessDrillsReady!).store.endgames.getProgress(endgameId)) ?? null,
            id,
          ),
        )
        .toMatchObject({ completed: 1, bestMoves: optimal, optimalMoves: optimal, lastMoves: optimal });
      expect(external).toEqual([]);
    });
  }

  test('giving up, restarting and offering a draw too early', async ({ page }) => {
    await openTrain(page);
    await page.getByTestId('btn-trainer-endgames').click();
    await page.getByTestId('endgame-item-philidor-position').click();
    const trainer = page.getByTestId('endgame-trainer');
    await expect(trainer).toHaveAttribute('data-endgame-id', 'philidor-position');
    await expect(page.getByTestId('endgame-status')).toHaveText('Your move as Black');
    expect(await page.evaluate(() => window.__wizardChessDrills!.getEndgames()!.getBoard().isFlipped())).toBe(true);
    await expect(page.getByTestId('btn-endgame-draw')).toBeVisible();
    await page.getByTestId('btn-endgame-draw').click();
    await expect(page.getByTestId('endgame-status')).toContainText(
      'Too early to offer a draw: make 10 more moves first.',
    );

    // Ra6 holds; then give up
    await clickMove(page, 'endgame-trainer', 'a3', 'a6');
    await expect(trainer).toHaveAttribute('data-endgame-state', 'playing', { timeout: 20_000 });
    await expect(page.getByTestId('endgame-moves')).toHaveText('1 move');
    await page.getByTestId('endgame-menu').click();
    await page.getByTestId('btn-endgame-giveup').click();
    await expect(trainer).toHaveAttribute('data-endgame-state', 'failed');
    await expect(page.getByTestId('endgame-result')).toContainText('Given up');
    const saved = await page.evaluate(async () => {
      const api = await window.__wizardChessDrillsReady!;
      return {
        progress: await api.store.endgames.getProgress('philidor-position'),
        cards: await api.store.endgames.listCards(),
      };
    });
    expect(saved.progress).toMatchObject({ completed: 0, attempts: 1, completions: 0, lastReached: false });
    expect(saved.cards[0]).toMatchObject({ id: 'endgame:philidor-position', state: 'learning' });

    // Restart: a fresh drill of the same position, nothing recorded for it
    await page.getByTestId('endgame-menu').click();
    await page.getByTestId('btn-endgame-restart').click();
    await expect(trainer).toHaveAttribute('data-endgame-state', 'playing');
    await expect(page.getByTestId('endgame-moves')).toHaveText('0 moves');
    expect(
      await page.evaluate(
        async () =>
          (await (await window.__wizardChessDrillsReady!).store.endgames.getProgress('philidor-position'))?.attempts,
      ),
    ).toBe(1);
  });

  test('R+P v R: a position without a mate count is won by converting it (promote, and the engine agrees it is decided)', async ({
    page,
  }) => {
    test.setTimeout(240_000);
    await openTrain(page);
    await page.getByTestId('btn-trainer-endgames').click();
    await page.getByTestId('endgame-item-rp-vs-r').click();
    const trainer = page.getByTestId('endgame-trainer');
    await expect(trainer).toHaveAttribute('data-endgame-id', 'rp-vs-r');
    await expect(page.getByTestId('endgame-goal')).toHaveText(
      'Promote the pawn, or win the last piece, and keep the win.',
    );
    expect(await playOut(page, 60)).toBe('reached');
    const end = await page.evaluate(() => window.__wizardChessDrills!.getEndgames()!.getSession()!.end!);
    expect(['converted', 'checkmate']).toContain(end.how);
    expect(end.result).toBe('1-0');
    // No move count is kept for it: only that the result was reached
    const progress = await page.evaluate(async () =>
      (await window.__wizardChessDrillsReady!).store.endgames.getProgress('rp-vs-r'),
    );
    expect(progress).toMatchObject({
      completed: 1,
      bestMoves: null,
      optimalMoves: null,
      lastMoves: null,
      lastReached: true,
    });
    await expect(page.getByTestId('endgame-result')).not.toContainText('best possible');
  });

  test('Lucena: the bridge is built and the pawn promoted; the drill ends as converted with no move count', async ({
    page,
  }) => {
    test.setTimeout(240_000);
    await openTrain(page);
    await page.getByTestId('btn-trainer-endgames').click();
    await page.getByTestId('endgame-item-lucena-position').click();
    const trainer = page.getByTestId('endgame-trainer');
    await expect(trainer).toHaveAttribute('data-endgame-id', 'lucena-position');
    expect(await playOut(page, 60)).toBe('reached');
    const end = await page.evaluate(() => window.__wizardChessDrills!.getEndgames()!.getSession()!.end!);
    expect(['converted', 'checkmate']).toContain(end.how);
    const progress = await page.evaluate(
      async () => await (await window.__wizardChessDrillsReady!).store.endgames.getProgress('lucena-position'),
    );
    expect(progress).toMatchObject({ completed: 1, bestMoves: null, optimalMoves: null, lastMoves: null });
  });

  test('Philidor: after ten moves of holding, a draw offer is accepted and the draw is the result', async ({
    page,
  }) => {
    test.setTimeout(240_000);
    await openTrain(page);
    await page.getByTestId('btn-trainer-endgames').click();
    await page.getByTestId('endgame-item-philidor-position').click();
    const trainer = page.getByTestId('endgame-trainer');
    await expect(trainer).toHaveAttribute('data-endgame-id', 'philidor-position');
    for (let i = 0; i < 10; i++) {
      await expect
        .poll(() => trainer.getAttribute('data-endgame-state'), { timeout: 30_000 })
        .toMatch(/playing|reached|failed/);
      if ((await trainer.getAttribute('data-endgame-state')) !== 'playing') break;
      await page.getByTestId('btn-endgame-hint').click();
      await expect(trainer).toHaveAttribute('data-hint', /^[a-h][1-8][a-h][1-8]/);
      const hint = (await trainer.getAttribute('data-hint'))!;
      await clickMove(page, 'endgame-trainer', hint.slice(0, 2), hint.slice(2, 4));
    }
    await expect
      .poll(() => trainer.getAttribute('data-endgame-state'), { timeout: 30_000 })
      .toMatch(/playing|reached|failed/);
    if ((await trainer.getAttribute('data-endgame-state')) === 'playing')
      await page.getByTestId('btn-endgame-draw').click();
    await expect(trainer).toHaveAttribute('data-endgame-state', 'reached', { timeout: 20_000 });
    const end = await page.evaluate(() => window.__wizardChessDrills!.getEndgames()!.getSession()!.end!);
    expect(end.result).toBe('1/2-1/2');
    expect(['draw-agreed', 'repetition', 'fifty-moves', 'stalemate', 'insufficient']).toContain(end.how);
    await expect(page.getByTestId('endgame-item-philidor-position')).toHaveAttribute('data-completed', 'true');
  });

  test('a position that comes due appears on Today, the Train tab and Start training', async ({ page }) => {
    await openTrain(page);
    await page.evaluate(async () => {
      const api = await window.__wizardChessDrillsReady!;
      // A failed drill 11 minutes ago: back in the schedule now (Again → 10 minutes)
      await api.store.endgames.record(
        {
          id: 'lucena-position',
          title: 'Lucena',
          category: 'Lucena',
          fen: '1K1k4/1P6/8/8/8/8/r7/2R5 w - - 0 1',
          sideToMove: 'w',
          targetResult: '1-0',
          optimalMoves: null,
          description: '',
        },
        { reached: false, moves: 6, hintsUsed: 0 },
        Date.now() - 11 * 60_000,
      );
    });
    await expect(page.getByTestId('nav-train-count')).toHaveText('1');
    await page.getByTestId('mode-tab-play').click();
    await page.getByTestId('mode-tab-train').click();
    await expect(page.getByTestId('today-endgame-count')).toHaveText('1');
    await expect(page.getByTestId('btn-today-endgame')).toBeEnabled();
    await expect(page.getByTestId('train-start-detail')).toHaveText('Your 1 due endgame drill');
    await expect(page.getByTestId('trainer-tile-endgames-detail')).toContainText('1 due');
    await page.getByTestId('btn-train-start').click();
    await expect(page.getByTestId('endgame-trainer')).toHaveAttribute('data-endgame-id', 'lucena-position');
    await expect(page.getByTestId('endgame-goal')).toContainText('Promote the pawn');
    await shot(page, 'desktop-endgame-lucena.png');
  });

  test('phone: the endgame drill fits the screen', async ({ page }) => {
    await openTrain(page, 390, 844);
    await page.getByTestId('btn-trainer-endgames').click();
    await expect(page.getByTestId('endgame-trainer')).toHaveAttribute('data-endgame-state', 'playing');
    const frame = (await page.getByTestId('endgame-trainer').getByTestId('chess-board-frame').boundingBox())!;
    expect(frame.width).toBeGreaterThanOrEqual(370);
    await noSidewaysScroll(page, 390);
    await shot(page, 'phone-endgame.png', true);
  });
});

test.describe('Phase 7 — visualization drills', () => {
  const MY_GAME = `[Event "Casual"]
[Site "https://lichess.org/GuessG01"]
[Date "2026.10.20"]
[White "Lobo017"]
[Black "Opponent"]
[Result "*"]

1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7 6. Re1 b5 7. Bb3 d6 *`;

  test('coordinates: a round is scored and recorded', async ({ page }) => {
    const external = trackNetwork(page);
    await openTrain(page);
    await page.getByTestId('btn-trainer-visualization').click();
    const trainer = page.getByTestId('visualization-trainer');
    await expect(trainer).toHaveAttribute('data-viz-mode', 'coordinates');
    // The board is empty, with no labels, until a round starts
    await expect(trainer.locator('.wc-piece')).toHaveCount(0);
    await expect(trainer.locator('.wc-board-coords')).toBeHidden();
    await page.getByTestId('btn-coord-start').click();
    await expect(trainer).toHaveAttribute('data-coord-state', 'running');
    for (let i = 0; i < 5; i++) {
      const target = await page.evaluate(() => window.__wizardChessDrills!.getVisualization()!.getRound()!.target);
      await expect(page.getByTestId('viz-coord-target')).toHaveText(target);
      if (i === 2) await shot(page, 'desktop-viz-coordinates.png');
      const p = await squareCenter(page, 'visualization-trainer', target);
      await page.mouse.click(p.x, p.y);
      await expect(page.getByTestId('viz-coord-score')).toContainText(`${i + 1} right`);
    }
    // One wrong click
    const wrongTarget = await page.evaluate(() => window.__wizardChessDrills!.getVisualization()!.getRound()!.target);
    const other = wrongTarget === 'a1' ? 'h8' : 'a1';
    const w = await squareCenter(page, 'visualization-trainer', other);
    await page.mouse.click(w.x, w.y);
    await expect(page.getByTestId('viz-coord-score')).toHaveText('5 right · 1 wrong');
    await page.getByTestId('btn-coord-start').click(); // Finish round
    await expect(trainer).toHaveAttribute('data-coord-state', 'done');
    await expect(page.getByTestId('viz-coord-result')).toContainText('5 right · 1 wrong · 83% accuracy.');
    await expect(page.getByTestId('viz-coord-result')).toContainText('New best!');
    await expect(page.getByTestId('viz-coord-best')).toHaveText('Best round: 5 right · 1 round played.');
    const stats = await page.evaluate(async () => {
      const api = await window.__wizardChessDrillsReady!;
      return {
        stats: await api.store.visualization.coordinateStats(),
        cards: (await api.store.visualization.listCards()).map((c) => c.id),
      };
    });
    expect(stats.stats).toMatchObject({ rounds: 1, best: 5 });
    expect(stats.cards).toEqual(['visualization:coordinates']);
    expect(external).toEqual([]);
  });

  test('coordinates from Black’s side, and the 30 second clock ends a round by itself', async ({ page }) => {
    test.setTimeout(90_000);
    await openTrain(page);
    await page.getByTestId('btn-trainer-visualization').click();
    await page.getByTestId('viz-orient-b').click();
    expect(await page.evaluate(() => window.__wizardChessDrills!.getVisualization()!.getBoard().isFlipped())).toBe(
      true,
    );
    await page.getByTestId('btn-coord-start').click();
    await expect(page.getByTestId('viz-coord-time')).toHaveText(/^(30|29)$/);
    await expect(page.getByTestId('visualization-trainer')).toHaveAttribute('data-coord-state', 'done', {
      timeout: 40_000,
    });
    await expect(page.getByTestId('viz-coord-result')).toContainText('0 right · 0 wrong');
  });

  test('blindfold: the moves are read out on an empty board, then pieces are found by clicking', async ({ page }) => {
    test.setTimeout(90_000);
    await openTrain(page);
    await page.getByTestId('btn-trainer-visualization').click();
    await page.getByTestId('viz-tab-blindfold').click();
    const trainer = page.getByTestId('visualization-trainer');
    await expect(page.getByTestId('viz-blind-level')).toContainText('Level: 8 moves');
    await page.getByTestId('btn-blind-start').click();
    await expect(trainer).toHaveAttribute('data-blind-state', 'reading');
    await expect(page.getByTestId('viz-blind-progress')).toHaveText(/^1\/8$/);
    await expect(page.getByTestId('viz-blind-stage')).toContainText(/(White|Black): /);
    await expect(trainer.locator('.wc-piece')).toHaveCount(0);
    await shot(page, 'desktop-viz-blindfold-reading.png');
    while ((await trainer.getAttribute('data-blind-state')) === 'reading')
      await page.getByTestId('btn-blind-start').click();
    await expect(trainer).toHaveAttribute('data-blind-state', 'asking');
    await expect(page.getByTestId('viz-blind-stage')).toHaveText(/^Where is the (white|black) /);
    let answered = 0;
    for (;;) {
      await expect.poll(() => trainer.getAttribute('data-blind-state'), { timeout: 15_000 }).toMatch(/asking|done/);
      if ((await trainer.getAttribute('data-blind-state')) === 'done') break;
      const square = await page.evaluate(
        () => window.__wizardChessDrills!.getVisualization()!.getBlindfoldQuestion()!.squares[0]!,
      );
      if (answered === 1) await shot(page, 'desktop-viz-blindfold-question.png');
      const p = await squareCenter(page, 'visualization-trainer', square);
      await page.mouse.click(p.x, p.y);
      answered++;
      await expect(page.getByTestId('viz-blind-feedback')).toContainText('Yes:');
    }
    expect(answered).toBe(5);
    await expect(page.getByTestId('viz-blind-result')).toContainText('5 of 5 right.');
    // The board shows where the pieces really are, and the level went up
    await expect(trainer.locator('.wc-piece').first()).toBeVisible();
    await expect(page.getByTestId('viz-blind-level')).toContainText('Level: 10 moves');
    const saved = await page.evaluate(async () => {
      const api = await window.__wizardChessDrillsReady!;
      return {
        stats: await api.store.visualization.blindfoldStats(),
        cards: (await api.store.visualization.listCards()).map((c) => c.id),
      };
    });
    expect(saved.stats).toEqual({ level: 10, drills: 1, bestLevel: 8 });
    expect(saved.cards).toEqual(['visualization:blindfold']);
  });

  test('guess the move: my own game, move by move, with the result kept', async ({ page }) => {
    test.setTimeout(90_000);
    await openTrain(page);
    await page.evaluate(async (pgn) => {
      const lib = await window.__wizardChessLibraryReady!;
      const out = await lib.library.importPgnText(pgn);
      if (out.saved.length !== 1) throw new Error('not imported');
    }, MY_GAME);
    await page.getByTestId('btn-trainer-visualization').click();
    await page.getByTestId('viz-tab-guess').click();
    const trainer = page.getByTestId('visualization-trainer');
    await page.getByTestId('btn-guess-start').click();
    await expect(trainer).toHaveAttribute('data-guess-state', 'asking');
    await expect(page.getByTestId('viz-guess-game')).toHaveText('Lobo017 vs Opponent · 2026-10-20');
    await expect(page.getByTestId('viz-guess-progress')).toHaveText('1/6');
    await shot(page, 'desktop-viz-guess.png');

    let guessed = 0;
    for (;;) {
      await expect.poll(() => trainer.getAttribute('data-guess-state'), { timeout: 15_000 }).toMatch(/asking|done/);
      if ((await trainer.getAttribute('data-guess-state')) === 'done') break;
      const move = await page.evaluate(() => {
        const g = window.__wizardChessDrills!.getVisualization()!.getGuess()!;
        const p = g.positions[g.index]!;
        return { uci: p.uci, san: p.san };
      });
      // The first guess is a wrong one, the others are the move played
      const from = guessed === 0 ? 'a2' : move.uci.slice(0, 2);
      const to = guessed === 0 ? 'a3' : move.uci.slice(2, 4);
      await clickMove(page, 'visualization-trainer', from, to);
      await expect(page.getByTestId('viz-guess-feedback')).toContainText(new RegExp(`ou played ${move.san}`));
      guessed++;
    }
    expect(guessed).toBe(6);
    await expect(page.getByTestId('viz-guess-result')).toContainText('5 of 6 moves matched.');
    const saved = await page.evaluate(async () => {
      const api = await window.__wizardChessDrillsReady!;
      return {
        stats: await api.store.visualization.guessStats(),
        cards: (await api.store.visualization.listCards()).map((c) => c.id),
      };
    });
    expect(Object.values(saved.stats)).toMatchObject([{ hits: 5, total: 6 }]);
    expect(saved.cards).toHaveLength(1);
    expect(saved.cards[0]).toMatch(/^visualization:guess:lichess:GuessG01$/);
    await shot(page, 'desktop-viz-guess-done.png');
  });

  test('guess the move with no games of mine says so, and points to the Games list', async ({ page }) => {
    await openTrain(page);
    await page.getByTestId('btn-trainer-visualization').click();
    await page.getByTestId('viz-tab-guess').click();
    await page.getByTestId('btn-guess-start').click();
    await expect(page.getByTestId('viz-guess-empty')).toBeVisible();
    await expect(page.getByTestId('viz-guess-status')).toHaveText('No game to guess through');
    await page.getByTestId('btn-viz-open-games').click();
    await expect(page.getByTestId('app-shell')).toHaveAttribute('data-mode', 'games');
  });

  test('due drills feed Today in the same order as puzzles: reviews, repertoire, endgames, then visualization', async ({
    page,
  }) => {
    await openTrain(page);
    // Each trainer has a card that came due 11 minutes ago
    await page.evaluate(async () => {
      const api = await window.__wizardChessDrillsReady!;
      const ago = Date.now() - 11 * 60_000;
      await api.store.visualization.recordCoordinates({ correct: 0, wrong: 0 }, ago);
    });
    await page.getByTestId('mode-tab-play').click();
    await page.getByTestId('mode-tab-train').click();
    await expect(page.getByTestId('today-visualization-count')).toHaveText('1');
    await expect(page.getByTestId('train-start-detail')).toHaveText('Your 1 due visualization drill');
    await expect(page.getByTestId('nav-train-count')).toHaveText('1');

    await page.evaluate(async () => {
      const api = await window.__wizardChessDrillsReady!;
      const ago = Date.now() - 11 * 60_000;
      await api.store.endgames.record(
        {
          id: 'kq-vs-k',
          title: 'x',
          category: 'K+Q v K',
          fen: '8/8/8/4k3/8/8/8/3QK3 w - - 0 1',
          sideToMove: 'w',
          targetResult: '1-0',
          optimalMoves: 7,
          description: '',
        },
        { reached: false, moves: 1, hintsUsed: 0 },
        ago,
      );
    });
    await expect(page.getByTestId('train-start-detail')).toHaveText('Your 1 due endgame drill');
    await expect(page.getByTestId('nav-train-count')).toHaveText('2');

    await page.evaluate(async () => {
      const api = await window.__wizardChessDrillsReady!;
      const tree = new window.__wizardChessCore!.GameTree();
      tree.addMove('e4');
      await api.store.repertoire.save('w', tree);
    });
    await expect(page.getByTestId('train-start-detail')).toHaveText('Your 1 repertoire position');
    await expect(page.getByTestId('nav-train-count')).toHaveText('3');

    // A due puzzle review comes first
    await page.evaluate(async () => {
      const api = await window.__wizardChessPuzzlesReady!;
      const entry = {
        id: 'TstDue7',
        fen: '7k/6pp/8/8/8/8/6PP/R6K w - - 0 1',
        moves: ['h8g8', 'a1a8'],
        rating: 900,
        themes: ['mateIn1'],
        popularity: 0,
        plays: 0,
      };
      await api.store.recordAttempt(
        entry as never,
        'lichess',
        { solved: false, hintUsed: false, mistakes: 1, timeMs: 5000, grade: 1 },
        Date.now() - 11 * 60_000,
      );
    });
    await expect(page.getByTestId('train-start-detail')).toHaveText('Your 1 due review');
    await expect(page.getByTestId('nav-train-count')).toHaveText('4');
    await shot(page, 'desktop-train-hub-due.png', true);

    // The cards on Today each open their own trainer
    await page.getByTestId('btn-today-visualization').click();
    await expect(page.getByTestId('visualization-trainer')).toBeVisible();
    await expect(page.getByTestId('visualization-trainer')).toHaveAttribute('data-viz-mode', 'coordinates');
  });

  test('phone: the visualization drills fit the screen', async ({ page }) => {
    await openTrain(page, 390, 844);
    await page.getByTestId('btn-trainer-visualization').click();
    await expect(page.getByTestId('visualization-trainer')).toBeVisible();
    const frame = (await page.getByTestId('visualization-trainer').getByTestId('chess-board-frame').boundingBox())!;
    expect(frame.width).toBeGreaterThanOrEqual(370);
    await page.getByTestId('btn-coord-start').click();
    await noSidewaysScroll(page, 390);
    await shot(page, 'phone-viz-coordinates.png', true);
    await page.getByTestId('viz-tab-blindfold').click();
    await page.getByTestId('btn-blind-start').click();
    await noSidewaysScroll(page, 390);
    await shot(page, 'phone-viz-blindfold.png', true);
  });
});
