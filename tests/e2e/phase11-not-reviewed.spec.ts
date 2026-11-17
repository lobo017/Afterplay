import { expect, test, type Page } from '@playwright/test';

// One meaning of "not reviewed" in the Train tab's card and the Games list: a game counts as reviewed when it has a
// review summary stored in advance or a review made here, and the variant games the Story leaves out (Chess960) never
// count as waiting for a review. Every game here is invented.
const touch = () => test.info().project.name === 'webkit-iphone';

async function press(page: Page, testId: string): Promise<void> {
  const el = page.getByTestId(testId);
  if (touch()) await el.tap();
  else await el.click();
}

const STANDARD = (n: number) => `[Event "Live Chess"]
[Site "Chess.com"]
[Date "2026.10.0${n}"]
[White "Ada"]
[Black "Opponent${n}"]
[Result "1-0"]

1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7 6. Re1 b5 7. Bb3 d6 8. c3 O-O 9. h3 Nb8 10. d4 Nbd7 1-0`;

const CHESS960 = `[Event "Live Chess - Chess960"]
[Site "Chess.com"]
[Date "2026.10.09"]
[White "Ada"]
[Black "Opponent9"]
[Result "1-0"]
[Variant "Chess960"]
[SetUp "1"]
[FEN "bbqnnrkr/pppppppp/8/8/8/8/PPPPPPPP/BBQNNRKR w KQkq - 0 1"]

1. g3 g6 2. Nf3 Nf6 3. d4 d5 1-0`;

function record(id: string, pgn: string, analysis: unknown) {
  const n = Number(id.slice(-1));
  return {
    id: `chesscom:${id}`,
    white: 'Ada',
    black: `Opponent${n}`,
    playerColor: 'w',
    result: '1-0',
    date: `2026.10.0${n}`,
    openingEco: '',
    openingName: '',
    accuracy: null,
    pgn,
    tags: [],
    source: 'chesscom',
    analysis,
  };
}

const SUMMARY = {
  preset: null,
  savedAt: 1,
  depth: 18,
  summaryOnly: true,
  plies: 20,
  whiteAccuracy: 80,
  blackAccuracy: null,
  sides: { w: { moves: 10, acpl: 40, inaccuracy: 1, mistake: 0, blunder: 0, miss: 0, brilliant: 0, great: 0 } },
};

test.describe('Phase 11 — not reviewed means the same everywhere', () => {
  test('the Train card and the Games list agree, and Chess960 is not waiting for a review', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('play-layout')).toBeVisible();
    await page.evaluate(
      async (records) => {
        const api = await window.__wizardChessLibraryReady!;
        await api.library.saveSyncedGames(records as never);
      },
      [
        record('1', STANDARD(1), null), // standard, no review: counts
        record('2', STANDARD(2), null), // standard, no review: counts
        record('3', STANDARD(3), SUMMARY), // reviewed in advance
        record('4', STANDARD(4), SUMMARY), // reviewed in advance
        record('5', STANDARD(5), { preset: 'quick', savedAt: 1, whiteAccuracy: 70, blackAccuracy: 60 }), // reviewed here
        record('9', CHESS960, null), // a variant: never counts
      ],
    );

    // Train: two games wait for a review, not three
    await press(page, 'mode-tab-train');
    await expect(page.getByTestId('today-games-count')).toHaveText('2');

    // Games › Library: the same two, and the summary line and the filters say the same
    await press(page, 'mode-tab-games');
    await press(page, 'games-tab-library');
    await expect(page.getByTestId('games-summary')).toHaveText('6 games · 3 reviewed');
    await page.getByTestId('games-filter-analyzed').selectOption('not-analyzed');
    await expect(page.getByTestId('games-row')).toHaveCount(2);
    await expect(page.getByTestId('games-count')).toHaveText('2 of 6 games');
    await page.getByTestId('games-filter-analyzed').selectOption('analyzed');
    await expect(page.getByTestId('games-row')).toHaveCount(3);
    await expect(page.getByTestId('games-count')).toHaveText('3 of 6 games');
    // Not reviewed + reviewed + the variant game = every game
    await page.getByTestId('games-filter-analyzed').selectOption('all');
    await expect(page.getByTestId('games-row')).toHaveCount(6);
  });
});
