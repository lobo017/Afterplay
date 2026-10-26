<!-- Archive of docs/PROGRESS.md lines 2648-2821 (verbatim). Phase 6 -->

## Phase 6 — Puzzles and spaced repetition (2026-10-19)

### Baseline before Phase 6 (commit 6d12256, `npm run build`)
- Main bundle `dist/assets/index-D-Q97A8a.js`: **1,355.74 kB** (238.39 kB gzip). CSS 45.87 kB
  (9.26 kB gzip). `data/puzzles.json` (4.03 MB) is not imported anywhere yet.

### Plan (written before code)

**Puzzle format (one loader for both kinds).** A stored puzzle keeps the Lichess layout:
`fen` = the position *before* the opponent's move, `moves[0]` = the opponent's move,
`moves[1..]` = the solution (player, reply, player, …; always ends on a player move, so it has
odd length). `trainers/puzzle-format.ts` `preparePuzzle()` plays `moves[0]` on `fen` and returns
the start position, the player's color (the side to move *after* `moves[0]`), the setup move (to
animate) and the solution. Personal puzzles are stored the same way: `fen` = the position before
the opponent's last move, `moves` = [that move, my best move].

**Files**
- `src/trainers/puzzle-format.ts` (pure): loader/validator for the Lichess layout, solution
  matching by resulting position (castling notation, promotion piece).
- `src/trainers/puzzle-session.ts` (pure): the solving state machine (expected move → reply,
  wrong move, alternative to check, solved, failed, hint, show solution).
- `src/trainers/puzzle-validation.ts` (pure): `judgeAlternative()` — a move other than the
  solution is accepted when it mates, when the engine sees a forced mate for the player after
  it, or (non-mate puzzles) when it keeps a decisive advantage (player's win% ≥ 90) or is as good
  as the solution (within 2 win% points, the Excellent band). Mate puzzles accept only mates.
  An accepted alternative ends the puzzle as solved. `isClearBest()` for personal puzzles.
- `src/trainers/personal-puzzles.ts` (pure): puzzles from a saved review: only moves
  classified Mistake, Blunder or Miss, only by my color (`myColor`: a player name equals one of
  my usernames for the game's site — captured games included), only when the best move beats
  the second-best by ≥ 10 win% points (the Mistake band; "second-best nearly as good" is
  rejected), only when both MultiPV lines exist, the best move isn't the move played, and there
  is an opponent move before it (ply ≥ 2). Solution = the best move; the engine's best line is
  shown after solving.
- `src/trainers/fsrs.ts` (pure): FSRS-5 with its published default parameters (R, interval at
  90% retention, S0, D0, difficulty with linear damping and mean reversion to D0(4), recall and
  forgetting stability, same-day stability). Again → back in 10 minutes (learning/relearning).
- `src/trainers/glicko2.ts` (pure): Glicko-2 (Glickman's paper; τ = 0.5), one rating period per
  rated puzzle, puzzle RD fixed at 75, player RD clamped to 45–350.
- `src/trainers/puzzle-dataset.ts` (pure) + `puzzle-dataset.worker.ts` + `puzzle-dataset-client.ts`:
  the 20k bundled puzzles live only in the worker (the worker imports `data/puzzles.json`, so
  the data is in the worker's own chunk); the worker indexes them by theme and rating and picks
  the next one (rating window around my rating, widening; theme or mix; skips puzzles already
  tried). The worker is created the first time puzzles are opened.
- `src/trainers/puzzle-store.ts`: IndexedDB through `WizardChessStorage` — puzzle records,
  `srs_cards` (deck `puzzle`), my rating + history (settings), attempt outcomes, today's counts,
  and the personal-puzzle sync (per game: added, updated, removed when the game no longer yields
  them; a sync signature of my accounts so a username change re-checks every reviewed game).
  No schema change: the v2 `puzzles` and `srs_cards` stores already have what's needed; new
  optional fields on `StoredPuzzleRecord`.
- `src/trainers/puzzle-trainer.ts` (UI, loaded with `import()` on first open): board
  (`BoardRenderer`), side panel: mode (Due reviews / My mistakes / Rated, theme select),
  prompt, status, Hint, Show solution, Retry, Next, Analyze (opens the position on the analysis
  board), rating with change, source line.
- `src/trainers/today-screen.ts`: Today tab: reviews due now (by kind), new puzzles from my
  mistakes, rated puzzles solved today, next review time, games not analyzed yet; each with a
  button that opens the matching session or the Games list.
- `src/app.ts`: tabs "☀ Today" and "🧩 Puzzles"; the library's review saves feed the
  personal-puzzle sync; `window.__wizardChessPuzzles` for tests.
- Grades: wrong move or solution shown → Again; hint → Hard; clean → Good; clean and quick
  (≤ 10 s per player move) → Easy. Rated: a bundled puzzle's first attempt only (win = clean
  solve, loss = wrong move or solution shown; a hint makes it unrated). Personal puzzles are
  unrated. Bundled puzzles get a card when failed or hinted (so they come back); personal
  puzzles always have one.

**Tests**
- Unit: the loader on real dataset entries (the first move is the opponent's: start position,
  player color, solution) and over all 20,000 (every move legal, solution odd-length and ending
  with the player's move, mate puzzles end in mate); session state machine; `judgeAlternative`;
  personal puzzles (my side only, username mismatch → none, classes, near-equal second best
  rejected, single line rejected); FSRS; Glicko-2 against Glickman's worked example; dataset
  index (theme, rating window, exclusions); store (attempt → rating, card, today counts, sync).
- E2E `phase6.spec.ts`: no puzzle chunk requested before Puzzles is opened, then requested;
  the main bundle file doesn't contain puzzle data; solve a multi-move bundled puzzle by clicking
  (rating changes, attempt stored); a wrong move → failed → due review on Today; an alternative
  mate accepted; a captured game (through the bridge save path) reviewed on Quick → puzzles
  only from my side → solve one from Today; phone width without horizontal scroll; zero
  external requests; screenshots.

**Risks**
- Main-thread budget: the dataset is parsed and searched only in the worker; the main thread
  gets one puzzle per request.
- Alternative-move checks need the engine (the shared live engine, 0.5 s per position); the
  board is locked while it runs.
- FSRS is implemented from the published formulas, not checked against the reference
  implementation (no new dependency); tests check the formulas and their properties.

### Result (2026-10-19)

Built as planned; no new dependency, no schema change (new optional fields on
`StoredPuzzleRecord`; `WizardChessStorage` gained `deletePuzzle`, `deleteSrsCard`,
`listSrsCards`).

**The Lichess first-move gotcha.** One loader (`preparePuzzle`) for both kinds: it plays
`moves[0]` for the opponent on `fen`, takes the side to move after it as the player, and checks
the solution ends on a player move. Tests (`puzzle-loader.test.ts`): on `0ND4A` the stored FEN has
White to move, `e1f1` (Rxf1) is White's move, the player is Black and the solution is `Rxf1#`;
playing `moves[0]` as if it were the player's move is illegal in the puzzle position; on the
multi-move `1yy9U` the replies alternate correctly; over **all 20,000** bundled puzzles,
`moves[0]` moves a piece of the FEN's side to move and every solution is odd-length; a fixed
1-in-10 sample (2,000) is fully replayed (every move legal, player opposite the FEN's side,
every `mate`-themed puzzle ends in mate). The full replay of all 20,000 takes 69 s with
chess.js (~3.4 ms per puzzle, mostly chess.js's own move generation) and starved Vitest's
worker RPC, so it was split into the structural check over all and the replay of the sample.

**Personal puzzles** (`personal-puzzles.ts`): only my color (`myColor`: a player name equals one of
my usernames *for the game's site*, so a Lichess username doesn't match a Chess.com game), only
Mistake / Blunder / Miss, only when MultiPV 2's best line beats the second by ≥ 10 win% points.
Made when a review is saved (the library's `updated` event, from the Games list queue and from
the board) and re-checked on opening Today / My mistakes (`syncAll`: per game by review time, all
games again when my accounts change; puzzles that no longer apply are removed with their cards).
Captured games are covered: the e2e test delivers games through `saveBridgeGames`, the extension's
save path.

**Deviations / decisions**
1. Personal puzzles are one move (the best move); the review only knows the second-best at the
   root, so later moves can't be checked for uniqueness. The engine's best line and the review's
   explanation are shown after solving.
2. Personal puzzles are unrated (rating 0); my Glicko-2 rating moves only on a bundled puzzle's
   first attempt without a hint. Hint → unrated, graded Hard.
3. A retry is practice: nothing recorded.
4. FSRS: Again → back in 10 min (no further learning steps); `S'forget` capped at S; Hard ≤ Good ≤
   Easy enforced per review. Implemented from the published FSRS-5 formulas (checked against the
   algorithm page, not against the reference code).
5. Glicko-2: τ = 0.5, puzzle RD fixed at 75, my RD kept in 45–350, no idle-time RD growth
   between sessions.
6. Header tabs now wrap on narrow screens (`flex-wrap`, tabs `nowrap`): two more tabs pushed
   "Analyze Game →" 68 px past a 390 px viewport. Desktop layout unchanged.

**Main bundle (the measurement asked for)** — `npm run build`:

| | Before (6d12256) | After |
|---|---|---|
| Main bundle `index-*.js` | 1,355.74 kB (238.39 kB gzip) | **1,375.38 kB (244.65 kB gzip)**, +19.6 kB: store, Today, FSRS, Glicko-2, personal puzzles |
| CSS | 45.87 kB (9.26 kB gzip) | 49.60 kB (9.84 kB gzip) |
| Puzzle trainer UI | — | `puzzle-trainer-*.js` 21.4 kB, loaded on first open |
| Bundled puzzles | not loaded | `puzzle-dataset.worker-*.js` 4,034 kB, a worker started on first open |
| PWA precache | 15,574 KiB | 19,557 KiB |

The e2e test checks the main bundle doesn't contain puzzle ids (the worker chunk does), and that
neither chunk is requested before Puzzles is opened (Today included) and both are after.

**Tests**: unit +42 (`puzzle-loader` 7, `puzzle-session` 12 incl. alternatives and the dataset
index, `srs-rating` 10 incl. Glickman's worked example 1464.06 / 151.52 / 0.05999,
`personal-puzzles` 9 on the reviewed Lichess fixture game incl. the store, `serve-origin` 4).
E2E `phase6.spec.ts` (8): lazy chunks and main bundle; a multi-move puzzle solved by clicking
(setup move first, board flipped for Black, rating up); an alternative mate accepted (`064LL`,
Qh7# instead of Qxg5#); a wrong move checked by the engine, failed, taken back, card due in 10
min and on Today; a captured Lichess game and a Chess.com one reviewed on Quick → puzzles only
from the Lichess game and only Black's (my) moves, including the missed 2…Bxg4 set up by 2.Qg4,
solved from Today, unrated, all rescheduled days ahead; phone width; the two redirect tests.

**Screenshots looked at** (`test-results/phase6-screens/`): `puzzle-desktop-start.png`,
`puzzle-desktop-solved.png`, `puzzle-personal-solved.png`, `today-desktop.png`, `puzzle-phone.png`,
`today-phone.png`. Fixed after looking: the phone header overflow (above); the turn prompt was
cut off on phones ("Your turn: find the best mov…" → "Find the best move for Black"); a
personal puzzle's move number didn't show it was Black's move ("move 2" → "move 2…").

**Known issues**
- Puzzles from my mistakes need a review saved with the game (Games list Analyze / auto-analyze,
  or a review run on the board for a list game). A review of a game that isn't in the Games list
  (e.g. the sample game) makes none.
- The engine check of an alternative move takes ~0.5–1 s (two 0.5 s searches; one when the move
  reaches a forced mate).

**Checks (final run, 2026-10-19):** typecheck, lint, **438 unit tests** (39 files; +42), `npm run
build`, `npm run build:ext`, **68/68 e2e** (60 earlier + 8 in `phase6.spec.ts`; one worker, 7.3
min): all pass. An earlier full run had 65/68: the three redirect tests (two new, and the Phase 5b
test that opens the site as `localhost`) failed because a `serve.mjs` started before this change
was still holding port 4173 and Playwright reused it; with that server stopped, Playwright started
the new one and all three passed, then the full run above.

**Serve fix result:** as planned (`scripts/lib/canonical-origin.mjs`, used by `scripts/serve.mjs`;
also listens on `::1`). Unit `serve-origin` (4) and the e2e tests above.

