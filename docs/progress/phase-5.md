<!-- Archive of docs/PROGRESS.md lines 1179-1870 (verbatim). Phase 5 -->

## Phase 5 — Game Review (2026-10-17)

### Plan (written before code)

**Order of work:** fixtures first (classification and motif), then the code that makes them
pass. Expected labels come from what the move means in chess (hangs a piece, only move,
sound sacrifice, …), written down with a rationale before the classifier exists. If a
fixture fails, the label or the rule is re-examined and the outcome written down; the
thresholds are not nudged to fit.

**Files to add**
- `src/review/formulas.ts`: win%, move accuracy, Lichess-style game accuracy
  (volatility-weighted mean blended with the harmonic mean), ACPL and estimated
  performance rating.
- `src/review/board.ts`: a small FEN board model for detectors: attack sets, x-ray aware
  static exchange evaluation (SEE), material count, pins along lines.
- `src/review/classification.ts`: thresholds as named constants and a pure
  `classifyMove()` (Best / Excellent / Good / Inaccuracy / Mistake / Blunder, plus Great,
  Brilliant, Book, Miss).
- `src/review/motifs.ts`: hanging piece, fork, pin / skewer, discovered attack,
  back-rank weakness, missed mate, trapped piece, promotion threat.
- `src/review/explain.ts`: one rule-based sentence per Inaccuracy / Mistake / Blunder /
  Miss.
- `src/review/review-game.ts`: builds the per-ply review from engine results (pure), key
  moments, annotated PGN.
- `src/review/review-runner.ts`: runs the engine over a game's main line (MultiPV 2,
  Quick 0.2 s / Standard 0.6 s / Deep 1.5 s per position), progress, cancel, partial
  results.
- `src/review/review-panel.ts` + CSS: progress bar and cancel, live win% chart (click
  jumps), accuracy and performance rating per side with a formulas tooltip, key moments,
  per-move class badge and explanation, Retry This Mistake, Show Refutation, Play vs Bot
  Here, annotated PGN export, built-in sample game.
- `src/review/sample-game.ts`: Morphy vs. Duke Karl / Count Isouard, Paris 1858 (public
  domain).
- `scripts/record-review-fixtures.mjs`: runs Node Stockfish (single-threaded lite build,
  fixed depth, fresh hash) over the fixture lines and writes the engine results, so
  unit tests are deterministic and don't need a live engine.
- `scripts/perf-review.mjs`: measures review runs with and without live analysis at
  different review thread counts (the thread decision below).
- Fixtures: `tests/fixtures/review/classification-fixtures.json`,
  `tests/fixtures/review/classification-evals.json` (generated),
  `tests/fixtures/review/motif-fixtures.json`.
- Tests: `tests/unit/review-*.test.ts`, `tests/e2e/phase5-review.spec.ts`.
- `docs/classification.md`: every rule and threshold with its justification.

**Files to change**
- `src/analysis/analysis-controller.ts`: mounts the review panel, shows class badges in
  the move tree, exposes a move hook for Retry This Mistake.
- `src/app.ts`: a separate review `EngineClient` (created on first review), Play vs Bot
  Here hand-off to Play mode, `window.__wizardChessReview` for tests.
- `src/engine/engine-client.ts`: when a request passes `moves`, the side to move (used to
  turn scores into White's view) must come from the position after those moves, not the
  root FEN. The review sends the game's move history so Stockfish sees repetitions.

**Thread decision (to measure):** review on its own engine instance. Compare review
threads 1 / 2 / 4 alone and alongside live 4-thread MultiPV analysis: review time, depth
reached per position, live-analysis NPS, frame times and long tasks.

**Risks**
- Engine results at a fixed movetime vary run to run, so fixtures use recorded fixed-depth
  results; the e2e test checks structure, not exact classes.
- Per-ply classification and motif work on the main thread must stay well under 50 ms
  per task; measured, and moved to a worker if not.
- The review panel must not break the Phase 4 zero-layout-shift test: fixed heights,
  nothing resizes per move.
- Two multi-threaded engines at once use more memory; measured in the thread comparison.

### Status at pause (2026-10-17, first session; superseded by the result below)

**Done**
- Fixtures written before the classifier:
  - `tests/fixtures/review/classification-fixtures.json`: 24 lines, every class covered.
  - `tests/fixtures/review/motif-fixtures.json`: 31 cases, each motif has positive and
    negative cases.
- `scripts/record-review-fixtures.mjs` (`npm run fixtures:review`): single thread, depth
  18, MultiPV 2, hash cleared. The output is reproducible: two runs gave identical numbers.
- `src/review/{types,formulas,board,motifs,classification}.ts`.
- `src/engine/engine-client.ts`: the side to move now accounts for `request.moves`, with a
  regression test.
- Tests:
  - `review-classification.test.ts`: 35 pass, using the spec thresholds unchanged.
  - `review-motifs.test.ts`: 33 pass.
  - Mutation checks: removing the recapture exclusion, the short-mate floor, the Miss rule,
    the Miss "not worse than before the gift" bound, or the pending-threat subtraction
    each makes a test fail.

**Fixture corrections after recording.** My depth-14/16 probes were wrong about these;
the thresholds did not change:
- At depth 18 the top move in the Italian position is a4 (+25), not h3 (+24), so the Best
  fixture now plays a4.
- At depth 18, Bg5 is only about 10 cp worse than the best move, which is Excellent, not
  Good. Replaced by Bd2 (passive development, drop 2.9).
- "Misses mate in one but still mates": after h3 the mate is about 11 moves away, not
  "a few". Relabelled Inaccuracy (forced mate moved beyond the 5-move horizon) and
  rationale corrected.
- The back-rank fixture was +696 cp (below 95%, so not decided). Added a white knight;
  it is now +863.

**Left to do**
- `explain.ts` (sentence rules are designed; fixture sentences are in the JSON) and its
  tests.
- `review-game.ts`: per-ply review, key moments, annotated PGN.
- `review-runner.ts`: engine loop, progress, cancel.
- Review panel UI: chart, tools, sample game, formulas tooltip.
- `formulas` unit tests.
- `docs/classification.md`.
- `scripts/perf-review.mjs` and the review-thread decision measurements.
- `tests/e2e/phase5-review.spec.ts`, screenshots.
- Full check run (build and e2e were not run in this session).

### Resumed session plan (2026-10-17, written before code)

**Baseline at resume:** typecheck, lint, 176 unit tests, build and 21/21 e2e all pass on
bd65045.

**Engine sign bug, impact on Phase 4 (checked before any change):** `extractSideToMove`
was only wrong when a request passes `moves`. No Phase 2–4 caller does: the analysis
board (`analysis-controller.ts` `startPositionAnalysis`), the threat detector, the bot
and play-mode live eval all send the current node's own FEN, which already names the side
to move. Requests with `moves` are also never cached (`hasCustomMoves`), so no wrong
score could have been cached and replayed. **The Phase 4 eval bar and engine lines were
not affected.** Phase 5 is the first caller that passes `moves`, and the review writes
`[%eval]` onto tree nodes, which the eval bar shows on navigation. The Phase 5 e2e test
therefore checks the sign on a Black-to-move position reached through move history, in
the review chart, the move card, the eval bar and the engine lines.

**Remaining work, in order**
1. Fixtures: add a line that throws away a forced mate entirely (mate in 1 → a drawn
   rook ending with no mate); correct the smothered-mate rationale (at depth 18 White
   still mates in 16 after Kf1, so the mate is pushed past the horizon, not gone).
   Re-record `classification-evals.json`.
2. `src/review/explain.ts` + `tests/unit/review-explain.test.ts` (fixture sentences).
3. `tests/unit/review-formulas.test.ts`.
4. `src/review/review-game.ts` (pure: per-ply review, Book prefix, ACPL, performance,
   key moments, annotated PGN) + `tests/unit/review-game.test.ts`.
5. `src/review/review-runner.ts` (engine loop, MultiPV 2, preset movetime or fixed depth,
   progress, cancel with partial results) + unit test with a mock engine.
6. `src/review/sample-game.ts`, `src/review/review-panel.ts`, CSS; mount in
   `analysis-controller.ts` (class badges in the tree, move hook for Retry, line insert
   for Show Refutation); `app.ts` (review engine, Play vs Bot Here,
   `window.__wizardChessReview`).
7. `tests/e2e/phase5-review.spec.ts`: reviews the sample game; zero layout shift while
   stepping through the reviewed game; tools; sign check; screenshots.
8. `scripts/compare-review-presets.mjs`: the sample game at Quick (0.2 s, 1 thread) and
   at the fixture settings (depth 18, 1 thread, MultiPV 2), per-class agreement →
   `docs/classification.md`.
9. `scripts/perf-review.mjs` + the review-thread measurement (1 / 2 / 4 threads, alone
   and next to live MultiPV 5 analysis).
10. Full check run, commit "Phase 5: game review".

**Risks:** main-thread time per reviewed ply (motif detection uses chess.js move
generation; measured in the e2e with a long-task observer); two multi-threaded engines
at once (memory, measured in step 9); the review panel must not shift the layout while
navigating (fixed heights, checked in the e2e).

### Result (2026-10-17)

**New files**
- `src/review/explain.ts`: one sentence per Inaccuracy / Mistake / Blunder / Miss (7 rules
  in order, docs/classification.md), plus the motifs found, tagged `played` /
  `refutation` / `missed` (new optional `Motif.role`).
- `src/review/review-game.ts`: pure review assembly. Per-move classification, Book only
  for the unbroken opening run, ACPL and performance per side, Lichess game accuracy,
  key moments (3–5 biggest White win% swings, ≥ 5 points, in game order), and the
  annotated PGN (`[%eval]`, class NAGs, comments, the best line as a variation after each
  Mistake / Blunder / Miss, a summary in the game comment, `[Annotator]`). Moves are
  cached between progress updates, so each is classified and explained once.
- `src/review/review-runner.ts`: engine loop over the main line (MultiPV 2, preset
  movetime or fixed depth, move history sent, `priority: 'review'`, no cache),
  progress, cancel with the partial review, and **verification searches** (below).
- `src/review/review-panel.ts`: the panel (preset, start / cancel / sample game, progress
  bar, live win% chart that jumps on click, accuracy / performance / ACPL per side,
  formulas tooltip, class counts, key moments, current-move card, Retry This Mistake,
  Show Refutation, Play vs Bot Here, Export Annotated PGN (PGN box + download)).
- `src/review/review-analysis.worker.ts` + `review-analysis-client.ts`: per-move
  classification, explanation and motifs (`analyzeMove`) run in a module worker, with an
  inline fallback where `Worker` doesn't exist (Node), like the bot-selection worker.
- `src/review/sample-game.ts`: Morphy vs. Duke Karl / Count Isouard, Paris 1858.
- `scripts/compare-review-presets.mjs` (`npm run review:compare`),
  `scripts/perf-review.mjs` (`npm run perf:review`), `scripts/lib/node-stockfish.mjs`
  (the Node Stockfish transport, moved out of the fixture recorder; re-recording after
  the move gives byte-identical evals).
- Tests: `review-explain` (20), `review-formulas` (17), `review-game` (7),
  `review-runner` (5) unit tests; `tests/e2e/phase5-review.spec.ts` (4 tests).
- `docs/classification.md`: every rule and number with its reason, the fixtures, and the
  Quick vs. depth-18 agreement.

**Changed**
- `analysis-controller.ts`: review mount slot; `onNavigate`, `onTreeReplaced`,
  `setMoveInterceptor` (Retry), `addLine` (Show Refutation; `forceNewVariation` option),
  `deleteNode`, `applyReview` (classifications + evals onto the tree, badges patched in
  during the run, one re-render at the end), `showPgnText`; class badges in the move
  tree (icon + `aria-label`, not color alone).
- `app.ts`: a separate review `EngineClient`, created on the first review;
  Play vs Bot Here starts a Play game from the position with the side to move as the
  player; `window.__wizardChessReview`.
- `motifs.ts`: trapped-piece is never reported for a side in check (found while
  checking the explanation motifs: Qd8+ made the e2 rook look "trapped"); new negative
  fixture `not-trapped-only-in-check`, which failed before the fix.
- `process-guard.mjs`: perf-review / review-compare / fixture-recorder runs count as
  leftovers (e2e and perf refuse to start next to them).
- `eslint.config.js`: `setInterval` / `clearInterval` globals.

**Fixtures**
- Added `blunder-throws-away-mate-entirely`: Rd8# is mate in one; after h3 it is a level
  rook ending (depth 18: Black +0.50, no mate anywhere). Blunder, "Misses mate in 1 with
  Rd8#."
- Corrected the `decided-misses-smothered-mate` rationale: at depth 18 White still mates
  in 16 after Kf1 (the mate moves past the horizon; the label, Inaccuracy, stands).
- Re-recorded: the 24 existing lines are byte-identical, the new one was added.

**Engine sign bug and Phase 4:** not affected (see the plan above: no Phase 2–4 caller
passes `moves`, and such requests are never cached). The new e2e test reviews
1.e4 e5 2.Qh5 Nc6 3.Qxe5+?? Nxe5 and checks, at the Black-to-move node after 3.Qxe5+
reached through move history: review win% < 10 for White, the move card's eval goes
negative, the eval bar (seeded from the review's `[%eval]`, then live) shows a negative
score below 20% for White, the first two engine lines are negative, the eval pill is
negative, and the annotated PGN writes `[%eval -x.xx]` there. It passes.

**Verification searches (new rule, docs/classification.md).** The Quick vs. depth-18
comparison found a false Blunder: in one of three Quick runs Morphy's 15.Bxd7+ (part of
the forced mate) dropped 21.6 points, because the 0.2 s search before the move saw the
mate and the one after it didn't. Thresholds were not touched. Instead, when a move's
first-pass class is Mistake / Blunder / Miss or a short mate appears or disappears across
it, both positions are searched again (Quick 1 s, Standard 2 s, Deep 3 s; each position
once; the deeper result is kept). Unit test with a scripted engine: the false Blunder
becomes Excellent. After the change, no Quick run produced a Blunder that depth 18
didn't.

**Quick vs. depth 18 (single thread, 3 Quick runs):** sample game 78/99 labels agree
(79%); per class: Brilliant 100%, Great 100%, Best 92%, Book 100%, Inaccuracy 61%,
Excellent 50%, Good 17% (2 moves). With Fischer–Spassky 1972 g6 added (114 moves in
total): Best 78%, Excellent 52%, Good 57%, Inaccuracy 63%, the rest 100%. The small-drop
classes straddle the 2 / 5 thresholds at 0.2 s. Full tables in docs/classification.md.

**Main-thread cost (long tasks found and fixed twice).**
1. The first version of Sample Game ran the PGN import (27–33 ms) and the review start
   (~20 ms) in one click task: a 55 ms long task. They now run as two tasks.
2. Repeating the e2e three times then showed 64 ms and 52 + 54 ms long tasks in two of
   three runs. Instrumented: classifying and explaining one move took up to 24 ms warm
   (chess.js move generation in the sacrifice check and motif detectors), more on a cold
   JIT or with two engines busy. That work now runs in the review worker; the main thread
   only assembles results (chart, summary, card: ≤ 9 ms per update). Afterwards three
   repeats had zero long tasks, and the e2e test asserts zero long tasks and that every
   move was analyzed in the worker (none inline).

**UI checks (screenshots looked at):** `test-results/phase5-screens/`: the sample game
reviewed at 16.Qb8+ (Brilliant, M2 → M1), the panel on a Black error (9...b5, explanation,
best line and refutation), and Retry solved ("✓ Bc4 is the best move."). Fixed after
looking: key-moment labels used "…", which looked like "9_b5" in the monospace font; the
key-moment strip reserved an empty second row.

**Bugs found by the e2e and fixed**
- Show Refutation extended the game: when the refutation started with the move actually
  played (3...Nxe5), the rest of the line was appended after the game's last move and
  became part of the main line (and of the annotated export). The line now goes into a
  variation of its own whenever it would run past the end of the main line; the e2e
  test checks the main line stays at 6 plies.

### Review engine threads (`npm run perf:review`, 2026-10-17)

The review has its own `EngineClient` (multi-threaded build under COOP/COEP), so live
analysis keeps its worker. Each run: fresh page, the 81-ply Fischer–Spassky game on
Quick, review threads 1 / 2 / 4, either alone or next to live MultiPV 5 `go infinite`
(4 threads) on the analysis board. No leftover processes before any pass; the machine
(8 logical cores, 16 GB) also ran OneDrive sync, Edge and Spotify, which varied between
passes.

**Pass 1** (review analysis still on the main thread; 4.7–5.2 GB free):

| Scenario | Threads | Review time | Mean / min depth | Live kN/s before → during | p95 / p99 frame | Long tasks |
|---|---|---|---|---|---|---|
| alone | 1 | 18.1 / 18.4 s | 15.5 / 15.4 | — | 16.8 / 16.9–17.1 ms | 0 / 0 |
| alone | 2 | 18.3 / 17.9 s | 15.2 / 15.5 | — | 16.8 / 16.8–16.9 ms | 0 / 0 |
| alone | 4 | 18.0 / 18.7 s | 15.3 / 15.1 | — | 16.8 / 16.8 ms | 0 / 0 |
| live | 1 | 18.5 / 18.8 s | 15.0 / 14.5 | 2262 → 2138, 1722 → 1722 | 16.7 / 16.8 ms | 0 / 0 |
| live | 2 | 18.5 / 19.2 s | 14.8 / 13.9 | 2187 → 2119, 1800 → 1691 | 16.7 / 16.8–33.3 ms | 0 / 0 |
| live | 4 | 19.1 / 19.3 s | 14.2 / 13.6 | 2179 → 1841, 1797 → 1531 | 16.7 / 33.2–33.3 ms | 52 / 50 ms |

Speed check (review alone, one round, node counts added): Quick 1 / 2 / 4 threads search
861 / 1599 / 2323 kN/s at mean depth 16.0 / 15.9 / 15.2; Standard (0.6 s) 851 / 1603 /
2452 kN/s at mean depth 18.9 / 18.5 / 17.8 (51 s per review at every count). The threads
do run; at these time budgets the extra nodes don't turn into depth.

**Pass 2** (final code, analysis in the worker; machine busier: 4.8 GB free at start,
3.0 GB at the end, every speed lower):

| Scenario | Threads | Review time | Mean depth | Review kN/s | Live kN/s before → during | p99 frame | Long tasks |
|---|---|---|---|---|---|---|---|
| alone | 1 | 17.9 / 18.3 s | 15.6 / 14.8 | 712 / 542 | — | 16.9 ms | 0 / 0 |
| alone | 2 | 18.2 / 18.2 s | 15.1 / 14.9 | 1145 / 1130 | — | 16.9 ms | 0 / 0 |
| alone | 4 | 18.4 / 18.7 s | 14.3 / 14.1 | 1755 / 1575 | — | 16.8–16.9 ms | 0 / 0 |
| live | 1 | 18.8 / 19.4 s | 14.2 / 13.8 | 368 / 309 | 1466 → 1470, 1715 → 1431 | 16.9 / 33.3 ms | 0 / 54 ms |
| live | 2 | 19.1 / 20.5 s | 14.2 / 13.0 | 743 / 528 | 1651 → 1445, 1521 → 1333 | 16.8 / 33.3 ms | 0 / 55, 59, 62 ms |
| live | 4 | 19.2 / 19.7 s | 13.2 / 13.5 | 1212 / 1018 | 1518 → 1295, 1404 → 1200 | 16.8 / 33.3 ms | 0 / 76 ms |

p95 was 16.7–16.8 ms in every run of both passes. Free memory before vs. lowest during a
review moved by 0.1–0.6 GB in every configuration, too noisy to price the second engine.

**Decision: the review engine runs 1 thread** (`REVIEW_ENGINE_THREADS` in `app.ts`).
- More threads buy no depth at the review's time budgets (both passes, Quick and
  Standard), so they don't improve the review.
- They do cost live analysis: next to live analysis, 4 review threads cut its speed by
  15% in all four runs and produced long tasks in three of four; 2 threads cost 3–12%.
  1 thread cost nothing in three of four runs (−17% in the loaded pass).
- Review time is the same at every count (time-limited): 17.9–19.4 s for the 81-ply
  game on Quick with 1 thread, inside the spec's ~30 s budget.

### Checks (final run, 2026-10-17)

typecheck, lint, **227 unit tests** (19 files; 176 at the start of the session), build,
**25/25 e2e** (21 earlier + 4 Phase 5): all pass. Phase 4's layout-shift test still
records zero shifts; the Phase 5 test steps through the reviewed sample game with zero
shifts and zero page scroll. The Phase 5 spec also passed 3 × 3 repeats after the worker
change.

One threshold in the new sign test was set while the review still ran 2 threads
(White's win% after 3.Qxe5+ < 10). With 1 thread, Quick read −5.8 (10.4%). The bound
is now < 25 for the review series, the move and the eval bar: the test checks the sign,
and a flipped sign would put White near 90%.

### Known issues

- **Quick grades small drops loosely.** Excellent / Good / Inaccuracy agree with depth 18
  only about half the time (docs/classification.md); errors and the wide-margin classes
  agree. Standard / Deep are the presets for fine grading.
- **Occasional 50–76 ms long tasks with live MultiPV 5 `go infinite` plus a review**,
  under background load. The review's own main-thread work is ≤ 9 ms per update and the
  per-move analysis runs in a worker; the long tasks carry no attribution (container
  "window", name "unknown") and also appeared with 1 review thread in one of four runs
  on a loaded machine. Probably CPU contention (4 + 1 engine threads on 8 logical cores
  plus the page). For the Phase 9 profiling pass.
- The second engine's memory cost isn't measured: free system memory moved 0.1–0.6 GB
  per review in every configuration, which is noise from other applications.
- `importPgn` of the 33-move sample game is 27–33 ms on the main thread (Phase 1/4
  parse + render): under 50 ms, but the largest single task the review flow causes.
- A Chess960 game goes through the same path (`chess960` is passed to every search and
  board helper), but no Chess960 game is in the review tests.

## Phase 5 — Lichess comparison fixes (2026-10-18)

### Plan (written before code)

Reference game: https://lichess.org/Bjl39T9x (Lichess analysis: accuracy White 56% /
Black 63%, ACPL 149 / 104; players rated 1374 / 1397).

1. **Thresholds** → Lichess's (`lila` `Advice.scala`: winning-chance drop ≥ 0.1 / 0.2 /
   0.3, i.e. win% drop ≥ 5 / 10 / 15). Excellent stays ≤ 2, Good is 2–5. Constants that
   were tied to the old bands (Great gap, Miss bounds, Retry success) follow the new
   bands. Re-check every classification fixture; relabel with a rationale where the
   meaning of the band moved. SPEC.md and docs/classification.md updated.
2. **Imported annotations**: before a review, the reviewed main line is cleaned of
   engine-generated annotations (Lichess `(a → b) Mistake. X was best.` comments,
   `[%eval]`, move-quality NAGs 1–6, the engine variation that names the "best" move,
   and the app's own earlier review comments). Plain human comments stay, and the
   app's review text is written after them behind a fixed `Review:` marker, so it can be
   told apart and stripped again on the next review. The export runs the same cleaning,
   so it is idempotent. Unit test on a Lichess-annotated PGN plus an e2e check.
3. **Explanations**: a motif is named only when the engine's best line realizes it
   (material actually changes hands along the line, or the trapped piece is actually
   lost); otherwise a general sentence. The three positions from the game become
   negative motif/explanation fixtures. The best move is named once ("Best: X") and only
   if the sentence doesn't already name it.
4. **Accuracy / ACPL**: `scripts/fetch-lichess-game.mjs` saves the game (PGN with evals
   and the JSON analysis) as `tests/fixtures/review/lichess-Bjl39T9x.json`. Compare our
   formulas with `lila` (`AccuracyPercent.scala`, `Accuracy.scala`, `WinPercent.scala`):
   eval ceiling ±1000 cp, mate as ±1000 cp, the +1 accuracy bonus, start eval, ACPL
   averaging and which moves count. Fix and add a regression test that reproduces
   56 / 63 and 149 / 104 from Lichess's evals.
5. **Performance rating**: check the ACPL → rating mapping against this game (794 / 1050
   for 1374 / 1397). Recalibrate if possible; otherwise label it as approximate or hide
   it.

**Risks:** the network fetch may be blocked in this environment (then the command is
handed over); changing win%'s mate value and thresholds moves many existing results
(fixtures, e2e expectations, the Quick vs. depth-18 tables, which get re-measured).

### Result (2026-10-18)

**Reference data.** Lichess now redirects anonymous game exports to `/signup` (JSON:
"Login required"), so `scripts/fetch-lichess-game.mjs` takes a personal API token in
`LICHESS_TOKEN` (no scopes needed). The game page was not scraped to get around the
login. The user ran the script; the fixture is `tests/fixtures/review/lichess-Bjl39T9x.json`
(PGN with evals, clocks and Lichess's annotations, plus the JSON analysis).

**1. Thresholds.** `CLASS_THRESHOLDS` = Excellent ≤ 2, Inaccuracy ≥ 5, Mistake ≥ 10,
Blunder ≥ 15 (Lichess's, inclusive). Great now needs a gap ≥ 15, Miss an opponent error
≥ 10 and a drop ≥ 5, Retry succeeds below 5. Win% clamps cp to ±1000 and counts a mate as
±1000 (lila), so a mate is 97.5%, not 100. Fixture changes, each with a rationale:
`mistake-nh4` → `blunder-nh4-drops-e4-pawn` (16.2); new Mistake fixture
`mistake-g3-drops-e4-pawn` (4.g3? in the Two Knights, 13.5; h4 in the Italian was tried
first and recorded at 9.7, too close to the line); `best-punishes-hanging-knight` would
have become Great, so taking material that was simply en prise is now excluded from
Great, like recaptures. SPEC.md and docs/classification.md updated.

**2. Imported annotations.** New `src/review/annotations.ts`. Review start strips the
reviewed main line (live tree; the status line says how many annotations were replaced)
and the export strips its copy: `[%eval]`, NAGs $1–$6, Lichess `Advice` comments
(`(a → b) Mistake. X was best.`, the mate sentences), the app's own `Review:` text, and the
variation that starts with the move the comment named as best. Human comments and
`[%clk]` stay; review text follows them as `— Review: …`. Tests: `review-annotations`
(Lichess-style PGN with a human note, idempotent re-export), `review-lichess` (the real
Lichess PGN: one NAG per move equal to the app's class, one eval per move, at most one
"best" variation and only after the app's own errors, idempotent), and an e2e test that
imports the real game, reviews it with the app's engine and checks the live move list
and the export.

**3. Explanations.** Motifs and material claims are used only when realized along the
engine's line, counted from before the move where the material settles (first two quiet
plies after the first capture, with no profitable capture pending), backed by the
evaluation (it must move by at least half the material claimed), and for a trapped piece
only if it is actually captured. Detector fixes found on the reference game: hanging-piece
needs a gain worth the piece (17.Nc4: the SEE line Nxc4 dxc4 Qxc4 nets a pawn, not a
knight); trapped-piece needs that no legal reply keeps the piece (20.cxd4 Rxd4: Bd2
blocks). The fallback sentences no longer repeat the best move; the export adds
"Best: X." once, only if the sentence doesn't name it. The three positions are negative
motif fixtures (a negative case with a square rules the motif out on that square only)
and classification fixtures with `explanationNot`. The live Quick review then still wrote
"winning the knight on c4" for 17.Nc4 (its line stopped at 18.Qa4, before dxc4); the
evaluation-backing rule fixed it, with a unit test on those numbers.

**4. Accuracy and ACPL from Lichess's evals** (`review-lichess.test.ts`):

| | Lichess | App, from Lichess's evals |
|---|---|---|
| Accuracy White / Black | 56 / 63 | 55.63 / 63.38 → 56 / 63 |
| ACPL White / Black | 149 / 104 | 149.00 / 103.52 → 149 / 104 |
| White inaccuracies / mistakes / blunders | 4 / 3 / 3 | 4 / 3 / 2 + 1 Miss (11.Na3) |
| Black inaccuracies / mistakes / blunders | 3 / 1 / 4 | 3 / 1 / 4 |

Differences from lila found and fixed: no +1 accuracy bonus (53.8 / 61.7 without it);
no ±1000 cp ceiling and mates as 100 / 0; ACPL filtered to ±650 cp positions, capped at
420 and with mates as ±(10000 − 10·n) (88.5 / 94.2 here); ACPL truncated instead of
rounded (103.52 → 104). Kept on purpose: the app's own start evaluation instead of
Lichess's 15 cp, and the Miss / Great / Brilliant / Book classes. Every move but 11.Na3
gets Lichess's label.

**5. Performance rating → "Bot level (approx.)".** The mapping is the in-app bots'
calibrated ACPL, not a human rating model. On this game it gives ≈768 / ≈708 from
Lichess's evals (≤400 / ≈609 on Lichess's ACPL scale; 794 / 1050 from the app's own
review) for players rated 1374 / 1397. It can't be made reasonable without human
(ACPL, rating, time control) data, which an offline app doesn't have: limited Stockfish
loses far less per move than a person of the same nominal rating, and one game's ACPL is
dominated by a few big losses (two of White's moves are 55% of its total). It is now
labelled "Bot level (approx.)" with a tooltip saying it is not a rating, formatted
"≈708", computed on the calibration's own scale (`calibrationCentipawnLoss`); the shown
ACPL is Lichess's. SPEC.md changed accordingly.

**Side effect found while re-measuring: false error on 15.Bxd7+ again.** With the Blunder
line at 15, the 1 s verification search after Morphy's 15.Bxd7+ (+3.9 instead of mate) was
again enough for a false Blunder in one of three Quick runs. Added a same-root check
(`review-runner.ts`): when the position before a suspicious move holds a short forced mate
for the mover, the played move is searched from there with `searchmoves` to depth 2n + 6;
if it still mates and the search after the move missed it, the after position takes that
result. Two intermediate versions were measured and rejected: a time-limited same-root
search applied to any score (fixed Bxd7+ but mixed lines from different searches, so
16.Qb8+ lost Brilliant in two of three runs), and a time-limited one for mates only (one
run still gave Bxd7+ a Mistake). Unit test with a scripted engine.

**Quick vs. depth 18, re-measured** (docs/classification.md): sample game 79/99 labels
agree (80%; 78/99 before the changes); Brilliant 3/3, Great 8/9, Best 34/36, Book 15/15;
no Quick run gives a Mistake, Blunder or Miss that depth 18 doesn't. The small-drop
classes (Excellent / Good / Inaccuracy) still agree only about half the time at 0.2 s.

**Known issues**
- The app's own engine and Lichess's disagree on some drops (15...axb5: 12.2 here, 19.0 on
  Lichess; 17.Nc4: 9.2 vs 11.3), so a review of the same game can still label a few
  moves one band apart from Lichess. Fed Lichess's evaluations, the labels match.
- Lichess's `MateAdvice` and the app's 5-move horizon differ on mates that only got
  longer (Lichess: no error; app: Inaccuracy if a mate within 5 moves was lost).
- The bot level is approximate by design; there is no human calibration data offline.

**Bug found by the e2e and fixed:** the PGN box refresh scheduled 400 ms after a review's
last update replaced an annotated PGN exported within that window with the plain game.
`showPgnText` now cancels the pending refresh; the Lichess e2e test reads the box after
the refresh would have fired.

**Checks (final run, 2026-10-18):** typecheck, lint, **252 unit tests** (21 files), build,
**26/26 e2e** — all pass. In the first full e2e run the sample-game review recorded one
50 ms long task; four repeats of that test and the next two full runs had none (the
unattributed long tasks under load noted for Phase 9). Screenshots looked at:
`test-results/phase5-screens/lichess-review-panel.png` (the reference game reviewed in
the app: "Bot level (approx.)", 17.Nc4 "Lets part of the advantage slip.") and
`lichess-review-tooltip.png` (formulas tooltip with the Lichess formulas).

## Phase 5 — Review perspective and summary redesign (2026-10-18)

### Plan (written before code)

Requirements are in SPEC.md, Phase 5 ("Review perspective", "Summary panel").

**Files to add**
- `src/review/perspective.ts` (pure): `ReviewPerspective` (`'w' | 'b' | 'both'`), my
  accounts (Lichess `Lobo017` until the Phase 5b settings field), the default perspective
  from the PGN headers, player name / rating from the headers, the moves and errors a
  perspective covers, key moments per side, the chart series from a side's point of view,
  and the "next / previous in cycle" step used by mistake navigation and count clicks.
- `tests/unit/review-perspective.test.ts`.

**Files to change**
- `src/review/review-game.ts`: `findKeyMoments` takes an optional side (that side's moves
  that lowered its win%).
- `src/review/review-panel.ts`: the perspective control; player headers (name · rating ·
  color, accuracy large, ACPL small); bot level moved into the info tooltip; one counts
  table (rows in the spec's order, zero counts dimmed, the perspective's column
  emphasized, counts are buttons that cycle through those moves); key moments as a list
  with badge, move and explanation; previous / next-mistake navigation (new, filtered by
  perspective; while retrying it moves the retry on to the next mistake); Retry enabled
  only on the perspective side's errors; chart drawn from the side's point of view, with
  that side's markers only; short status line with the details in a tooltip.
- `src/analysis/analysis-controller.ts` + `src/app.ts`: `setOrientation(color)` on the
  review host, so the board and eval bar flip to the perspective side.
- `src/styles/main.css`: the new summary styles; fixed sizes for everything that changes
  with the perspective; phone-width rules.
- `tests/e2e/phase5-review.spec.ts`: a test per perspective, layout shift recorded while
  switching, desktop and phone screenshots. Two existing assertions read the status line
  ("34 positions", "replaced"); they move to the status tooltip, which now holds that text.

**Risks**
- Flipping the board while switching perspective must not count as a layout shift (pieces
  move by transform; to verify in the e2e).
- The counts table and key-moment list are taller than before; the reviewed-game
  navigation test (zero shift) must still pass.
- The Lichess fixture game has Black = Lobo017, so that e2e test now starts in the Black
  perspective (board flipped); its assertions don't depend on orientation.

### Result (2026-10-18)

**Review perspective** (`src/review/perspective.ts`, panel, `setOrientation` on the host)
- "Review as: White / Black / Both" is a radio group above the chart. At review start the
  default comes from the PGN headers: my side if exactly one player is one of my accounts
  (`DEFAULT_USER_ACCOUNTS`: Lichess `Lobo017`, case-insensitive, ignored when the Site
  header names another site), otherwise Both. A new game resets it to Both.
- One side: that side's player card is emphasized (gold border, gold accuracy) and the
  other dimmed; key moments are that side's biggest drops (`findKeyMoments(moves, side)`:
  its own moves that lowered its win%, Misses included); the chart is drawn from that
  side (Black: `100 − White's win%`, dark area = Black's share, label "Black ↑") with that
  side's markers only; the board and eval bar flip to that side.
- Previous / next error navigation is new (there was none): "◀ Prev · Black errors · 3 / 8 ·
  Next ▶", wrapping around, over the perspective's Inaccuracies, Mistakes, Misses and
  Blunders. While retrying (or right after solving a retry) it moves the retry on to the
  next error, so Retry cycles through that side's mistakes. Retry is disabled on the
  other side's errors (tooltip says why); Show Refutation stays available on every error.
- Switching only re-renders: the review object and run result are the same objects
  before and after (checked in the e2e), nothing is sent to the engine. Both leaves the
  board orientation as it is.
- The spec's "mistake list" had no separate widget before this change; the error
  navigation, the chart markers and the key moments are the lists the perspective filters.
  The move tree keeps both sides' class badges.

**Summary panel**
- Player cards: "GEU3 · 1374 · White" from the PGN headers (name only / "White" when the
  headers have none), accuracy large, ACPL small beneath. On a narrow panel (container
  query, < 26rem) rating and color move under the name instead of being cut off.
- Bot level (approx.) moved into the "i" tooltip, as its first line with both names.
- Counts: one `<table>` (label with icon | White | Black, player names as column heads), rows
  Brilliant … Inaccuracy, Mistake, Miss, Blunder. Zero counts are dimmed and disabled; the
  perspective's column is tinted and the other dimmed. Each count is a button that jumps to
  the next move of that class by that side, wrapping around.
- Key moments: a list of up to 5 rows, each with the class icon, the move and its sentence
  (the explanation, or the class sentence for non-errors), 2-line clamp, full text in the
  title. Side by side with the counts table when the panel is ≥ 32rem wide, stacked below.
- Status line: "Reviewed · Quick · 29 s" (one decimal under 10 s). Positions, time, mean
  depth, time per position and replaced annotations are in its tooltip (`title`).
- The panel header (preset and buttons) now wraps at phone width; "Sample Game" was clipped
  at 390 px before.

**No layout shift.** Everything the perspective changes has a fixed size: the 5 key-moment
rows are always reserved, the table is fixed (10 rows), the error label is ellipsized, the
side cards only change border/opacity/color. The e2e switches W → B → Both → W → Both → B at
1440 × 900 and again at 390 × 844 with the layout-shift observer: zero shifts, no scroll
change, no horizontal scroll at phone width. Flipping the board (transforms) records none.

**Tests**
- `tests/unit/review-perspective.test.ts` (6): default perspective (Lichess name, case,
  missing / other Site, both / neither players, a passed-in Chess.com account), names and
  ratings, errors per side with Misses, key moments per side, the chart series, cycling.
- `tests/e2e/phase5-review.spec.ts`, new "Review perspective" block on my Lichess game
  (Bjl39T9x, Lobo017 as Black): **Black** (default; flipped board; chart from Black;
  headings; moments, markers and error navigation Black-only with wrap-around; Retry
  disabled on White's error, Retry → Next retries the next Black error; count clicks cycle;
  zero counts disabled), **White** (switch; board unflipped; White-only moments, markers,
  navigation and Retry; review not re-run), **Both** (all errors; moments equal the game's;
  zero layout shift while switching, desktop and phone; screenshots).
- Changed existing assertions (moved, not weakened): the sample-game test read
  "34 positions" from the status line and the Lichess test read "replaced"; both now read
  the status tooltip, which holds that text. The sample-game test also checks it opens in
  Both with Morphy's name in the headings.

**Screenshots looked at** (`test-results/phase5-screens/`): `perspective-black-desktop-*`,
`perspective-white-desktop-*`, `perspective-both-desktop-*`, `perspective-black-phone-*`,
`perspective-both-phone-*` (`-panel.png` and full `-page.png`). Fixed after looking: the
"Review as" buttons sat far from their label; the phone player headings cut the rating
("Lobo017 · 139…"); the phone move-card title was cut by the fixed eval width; the
clipped "Sample Game" button.

**Known issues**
- The status details are in a `title` tooltip, which touch screens don't show.
- Some sentences are weak for the class they explain (6...Be6, a Blunder in one Quick run,
  reads "Lets part of the advantage slip."). That is the existing fallback in
  `explain.ts`; this change only displays it.

**Checks (final run, 2026-10-18):** typecheck, lint, **258 unit tests** (22 files), build,
**29/29 e2e** (26 earlier + 3 perspective): all pass. The sample-game review recorded zero
long tasks; Phase 4's navigation test and the Phase 5 stepping test still record zero
layout shifts. The 46-move Lichess game reviews in 29–31 s on Quick.

## Phase 5 — Explanation wording and phone fixes (2026-10-18)

### Plan (written before code)

1. **Fallback sentences** (`src/review/explain.ts`, rule 7 and the Miss fallback in rule 4):
   name the side, how the standing changed and how badly, the evaluation change (White's
   view, as on the eval bar), and the move that kept it. Standing from the mover's win%:
   winning ≥ 67 (about +1.9), better ≥ 56, equal 44–56, worse ≥ 33, losing below. One
   sentence per (from → to) pair; inside one band the class sets the amount ("some of" /
   "much of" / "a large part of"). The best move is joined with a semicolon so the
   explanation stays one sentence (spec: one sentence per mistake; the explain test checks
   it): "Throws away Black's winning advantage (−1.6 → +0.1); Bf5 kept it." This reverses
   the earlier decision to keep the best move out of fallback sentences; the export
   already skips its own "Best: X." when the sentence names it.
   Tests: a table test per class (Inaccuracy, Mistake, Blunder, Miss) and per transition;
   two existing expectations that quote the old sentences get the new text.
   docs/classification.md updated.
2. **Tap-to-open tooltips** (`review-panel.ts`, CSS): the formulas "i" button already
   toggles on click but never closes on an outside tap or Escape; add both. The status
   line becomes a button-like toggle that shows its details in a tooltip of the same
   style (tap, outside tap, Escape; hover and focus still work on desktop). Only one open
   at a time.
3. **Clipped "Sample Game"**: already fixed in 04592d1 (the panel header wraps); verified
   again in the phone screenshots.

**Risks:** an absolutely positioned status tooltip must not cause layout shift or page
overflow at 390 px; the explanation fixtures that pin exact sentences.

### Result (2026-10-18)

**1. Fallback sentences.** `explain.ts`: `standingFromWin`, `formatEvalShort`,
`fallbackSentence`. Rule 7 and the Miss fallback (rule 4 with no capture or motif) now
say the side, how its standing changed, the evaluation change and the move that kept it.
Severity follows the class: within a band "some of / much of / a large part of", and a
Blunder "throws away" what another class "lets slip". The table is in
docs/classification.md. 6...Be6 of the reference game, fed Lichess's evals, now reads
"Throws away Black's winning advantage (−2.0 → 0.0); Bf5 kept it." (regression test).
- **Deviation from the request, on purpose:** the best move is joined with a semicolon
  instead of a second sentence, so the spec's "one sentence per mistake" and the existing
  one-sentence test still hold.
- Tests: 27 new cases in `review-explain.test.ts` (every transition, each error class and
  Miss, both sides, no-best-move, formatting); the 17.Nc4 expectation and the old 4-case
  fallback test quoted the old sentences and now quote the new ones.
- Three tests used any "→" in an exported PGN as a sign of a leftover Lichess comment
  (`(a → b) Mistake.`). The new sentences contain "→", so those checks now strip the app's
  own `Review:` text first and still fail on a "→" anywhere else; the "was best" /
  "Checkmate is now unavoidable" / "Inaccuracy." checks are unchanged. The Lichess comment
  stripper itself needs `(a → b)` followed by a judgement word, so it can't eat the app's
  sentences (idempotent re-export tests still pass).

**2. Tap-to-open tooltips.** Both tooltips are driven by one state in the panel
(`data-tip-open`): a tap/click toggles, a tap outside or Escape closes, only one is open.
Hover shows them only on devices that can hover (`@media (hover: hover)`), keyboard focus
via `:focus-visible`. The old `:focus-within` rule is gone: a tapped button keeps focus,
so it kept the tooltip open after a second tap. The status line is now focusable when it
has details (Enter / Space), shows a small "i", and its details moved from `title` to a
tooltip of the same style (`review-status-tooltip`). On a narrow panel the formulas
tooltip spans the summary; anchored to the "i" it ran off the left edge of a 390 px
screen (seen in the first phone screenshot). "replaced 1 earlier engine annotations" is
now singular.

**3. "Sample Game" clipped:** already fixed in 04592d1 (the header wraps). The new phone
test checks that every header control is inside the panel, not truncated and not covered.

**Tests:** new e2e "Review panel on a phone" (390 × 844, touch, `isMobile`, no hover):
header fits; status and formulas tooltips open on tap, close on an outside tap, a second
tap and Escape; one at a time; both stay on screen; no layout shift and no horizontal
scroll. The sample-game test checks hover still opens the status tooltip on desktop. The
two assertions that read the status details from `title` read the tooltip instead.

**Screenshots looked at** (`test-results/phase5-screens/`): `phone-status-tooltip.png`,
`phone-formulas-tooltip.png`, `phone-panel.png`, `perspective-black-phone-panel.png`
(card on 6...Be6 with the new sentence), desktop perspective screenshots.

**Known issue (existing, not changed):** live analysis stores its eval on the current
move for PGN export, so reviewing a plain PGN after the engine has looked at a position
reports "replaced 1 earlier engine annotation". The count is accurate (it is an engine
eval the review replaces), but it can surprise.
- At phone width the key-moment rows clamp longer sentences to two lines (the move card
  and the row's title show the full sentence).

**Checks (final run, 2026-10-18):** typecheck, lint, **286 unit tests** (22 files), build,
**30/30 e2e** (29 earlier + the phone test): all pass; the sample-game review recorded
zero long tasks.

