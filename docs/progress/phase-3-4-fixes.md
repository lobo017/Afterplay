<!-- Archive of docs/PROGRESS.md lines 559-1178 (verbatim). Phase 3-4 fixes, bot worker, perf/e2e harness hardening -->

## Phase 3–4 Fixes — Handover Baseline (2026-10-16)

A new agent took over the project at commit `02865aa`. Every check was re-run before any
change, on Windows 11 with system Chrome (Playwright 1.64.1) and Node 22.18.0.

| Check | Result |
|-------|--------|
| `npm run typecheck` | PASS |
| `npm run lint` | PASS (0 warnings) |
| `npm test` | PASS — 11 files, 92 tests (11.7 s) |
| `npm run build` | PASS — JS 1,228.34 kB (198.49 kB gzip), CSS 24.05 kB |
| `npx playwright test` | PASS — 7 specs (21.7 s) |
| `npm run perf:drag` (scenario 1: Play mode drag + `go infinite`) | **FAIL (exit 1) in 6 of 6 runs** — see below |
| perf scenario 2 (analysis board, MultiPV 5, ghost previews) | Did not exist at baseline (Phase 4 never added it) |

**perf:drag scenario 1, 6 runs at baseline:**

| Run | p50 | p95 | p99 | max | long tasks | budgetPassed |
|-----|-----|-----|-----|-----|------------|--------------|
| 1 | 16.67 | 16.71 | 16.81 | 33.35 | 0 | false |
| 2 | 16.67 | 16.75 | 33.34 | 33.35 | 0 | false |
| 3 | 16.66 | 16.76 | 16.80 | — | 0 | false |
| 4 | 16.67 | 16.75 | 16.79 | — | 0 | false |
| 5 | 16.66 | 16.76 | 16.78 | — | 0 | false |
| 6 | 16.66 | 16.74 | 16.81 | — | 0 | false |

Idle rAF callbacks: 0. Startup to interactive: 331–609 ms. Input latency: about 1.0 ms.

The only failing condition is `p95FrameMs <= 16.7`. Headless Chrome runs rAF at 60 Hz,
so one vsync is 16.667 ms, and the cutoff leaves only 0.033 ms for timestamp jitter. The
measured p95 is still one vsync interval: no frames are dropped at the 95th percentile.
Phase 3 recorded p95 = 16.70 ms, a pass by 0.00 ms; today's runs land 0.01–0.09 ms over.

**User decision (2026-10-16):** keep 16.7 ms as the frame budget, but pass when
p95 ≤ 16.7 ms + 0.5 ms jitter allowance (17.2 ms). Also report dropped frames
(intervals > 1.5 × vsync). One dropped frame is 33.3 ms, so real jank still fails.

**Measured before any app change (same build as above):**

- *Layout shift while navigating* (new test `tests/e2e/phase4-navigation.spec.ts`, 81 plies
  forward then back, MultiPV 5): **694 layout-shift entries, cumulative score 10.95**.
  Elements that shifted:

  | Element | Count | Cause |
  |---------|-------|-------|
  | `.wc-moves-panel`, `.wc-annotation-bar`, `.wc-editor-section`, `.wc-pgn-section` | 409 each | Engine lines panel changes height (one "Analyzing…" row ↔ five lines), moving everything below it by ~138 px |
  | `.wc-diagnostics-strip` | 359 | Page height follows the side panel |
  | `eval-bar-white-fill` | 174 | `height` transition on a bottom-anchored fill moves its top edge |
  | `analysis-nps` badge | 95 | Depth text width ("Depth 9" → "Depth 12") moves the NPS badge |
  | `threat-move-badge` | 42 | Width follows its text |
  | `eval-bar-score` | 3 | Score label jumps top ↔ bottom using `top`/`bottom` |
  | `analysis-eval-pill` | 1 | Width follows its text |

- *Perf scenario 2* (analysis board, MultiPV 5, `go infinite`, ghost previews every 3rd
  frame of the drag sweep; run on the old build with a temporary copy of the new script):

  | Metric | Drag + ghosts | Navigation sweep (1 key per frame, 81 plies × 2) |
  |--------|---------------|------------------------------------------------|
  | p50 / p95 / p99 frame | 16.67 / **33.36** / 49.99 ms | 33.42 / **83.35** / 83.38 ms |
  | Dropped frames | 34 / 279 (12.2%) | 108 / 162 (66.7%) |
  | Long tasks | **1 (281 ms)** | 0 |
  | Input latency (first pickup) | **279.9 ms** | — |
  | Max engine-line DOM updates per frame | 1 | — |

  Every navigation step re-renders the whole move tree, re-serializes the PGN, rebuilds the
  hidden position editor, and restarts the engine, so a step costs 30–80 ms. The 281 ms
  long task is the first pointer-down on the analysis board, which creates a second
  `AudioContext` synchronously.

### Plan (written before code)

**Files to change**

- `src/render/board-renderer.ts`
  - The drag survives `setPosition`. The held element is never re-positioned or recycled
    while it still holds the same piece. If the piece is gone (captured), the drag ends
    and the element is released, so no ghost is left. Selection, legal dots, and premove
    dots are recomputed for the new position.
  - Drag cancel: right-click during a drag (chorded `mousedown`/`pointermove` with
    button 2), Escape, or a drop off the board. The piece snaps back with a ~120 ms WAAPI
    animation. Clicking the selected piece again deselects it.
  - Right-click (no drag) clears the premove queue; otherwise it still draws arrows and
    circles.
  - Premove queue (`maxPremoves`, default 10). Destinations come from piece geometry
    (chessground style) on a hypothetical board: real position plus my earlier premoves,
    with the opponent passing. The hypothetical board is what is drawn while premoves
    are queued (chess.com style), so a piece moved by premove 1 can be picked up again
    for premove 2. Queued premoves get numbered highlights. A failed premove flashes,
    then clears the rest of the queue.
  - Position changes animate from a board diff (match vanished and appeared pieces of
    the same colour and type, nearest first, as chessground does). This covers forward,
    reverse, castling, en passant, and premove snap-back. Elements whose square changes
    cancel their running animation first, so an interrupted animation always ends on
    the right square.
- `src/render/overlay.ts`: numbered premove highlights and the premove failure flash.
- `src/ui/play-controller.ts`: premove execution moves into one helper. After the
  opponent's move it plays the next premove in the same task (same frame), through the
  normal clock path (elapsed ≈ 0 ms plus increment). An illegal premove clears the
  queue with a flash. Adds a "Max premoves" setting.
- `src/analysis/analysis-controller.ts`
  - Navigation is incremental: toggle the active tree node instead of re-rendering, and
    scroll only the move-tree container.
  - Step ±1 animates (reverse when going back). Home/End, distant clicks, and variation
    switches snap. Key repeat or input faster than the animation snaps.
  - Adds a "Navigation animation" setting (off / fast / normal) and a public
    `setAnalysisDepth()` (used by perf scenario 2).
  - Debounces engine restarts and tree/PGN serialization off the per-keystroke path.
- `src/analysis/engine-lines-panel.ts`: five persistent row slots with reserved height,
  updated in place. Updates are coalesced to at most one DOM write per frame (with a
  render counter). Identical ghost hovers are skipped.
- `src/analysis/eval-bar.ts`: fills animate with `transform: scaleY` instead of
  `height`. The score label uses fixed top and bottom slots toggled with `visibility`.
- `src/styles/main.css`: tabular-nums, fixed widths and ellipsis for the eval pill,
  depth/NPS badges, threat pill, opening name, status banners and clocks. Fixed-height
  move tree and move list with `scrollbar-gutter: stable`. FEN readout no longer
  toggles a scrollbar. The active move no longer turns bold, which changed its width.
- `src/render/audio.ts` / `src/app.ts`: one shared `CathedralAudio` for both modes, so
  the first pickup on the analysis board doesn't build a second `AudioContext`.
- `scripts/perf-drag.mjs`: two scenarios (Play + `go infinite` drag and premove burst;
  analysis + MultiPV 5 + ghost hovers drag and navigation sweep), using the jitter
  allowance above.
- Tests: `tests/e2e/phase4-navigation.spec.ts` (layout shift, held arrow key), new
  `tests/e2e/phase3-premoves.spec.ts` (drag through opponent move, right-click/Esc
  cancel, 3-premove queue, illegal premove cancels the rest, right-click clears queue),
  plus unit tests for premove geometry on the hypothetical board and the diff
  animation planner.
- `tests/e2e/phase4.spec.ts`: screenshots move from a hard-coded folder outside the
  repo (`C:/Users/ethan/.gemini/...`, left by the previous agent) to
  `test-results/screenshots/`. The assertions don't change.

**Risks**

- Existing Phase 3 tests use `getPremove()` / `setPremove()`. These are kept as
  "first queued premove" wrappers, so the old assertions still hold.
- Drawing the hypothetical board while premoves are queued changes what Play mode
  shows during the opponent's turn. This is the main UX decision; recorded under
  Decisions.
- Chorded right-click during a left-button drag doesn't fire `pointerdown`, so it's
  handled through `mousedown` and `pointermove` with `button === 2`.

### Result

**Status: done.** All checks pass, run by the agent on 2026-10-17:

| Check | Result |
|-------|--------|
| `npm run typecheck` | PASS |
| `npm run lint` | PASS (0 warnings) |
| `npm test` | PASS — 12 files, 103 tests (11 new in `tests/unit/premove-queue.test.ts`) |
| `npm run build` | PASS — JS 1,245.77 kB (203.02 kB gzip), CSS 25.95 kB (5.69 kB gzip), 12 precache entries |
| `npx playwright test` | PASS — 16 specs, two consecutive full runs, no flakes (7 earlier + 6 in `phase3-premoves.spec.ts` + 3 in `phase4-navigation.spec.ts`) |

**New end-to-end coverage**
- `phase3-premoves.spec.ts`:
  - A drag held through the bot's move, then dropped, plays the move.
  - A held piece that gets captured ends the drag with no ghost element.
  - Right-click, Escape, and an off-board drop cancel a drag (with the snap-back animation).
  - Clicking the selected piece again deselects it.
  - Three queued premoves (one planned by dragging the piece premove 1 moved) all execute
    across three bot moves. Each lands in the same frame as the bot's move, and the clock
    is charged ~0 ms plus increment.
  - An illegal premove cancels the whole queue with a flash.
  - Right-click clears the queue, but still draws circles when nothing is queued.
  - Max premoves = 1 refuses a second premove.
  - Escape clears the queue.
- `phase4-navigation.spec.ts`:
  - Layout-shift test over the 81-ply game, forward then back: **0 entries, score
    0.00000** (baseline 694 entries, 10.95), in every run.
  - Holding → / ← through the game (auto-repeat every 33 ms) ends on the exact position:
    piece elements match the FEN, no animation still running, no layout shift.
  - A one-move step animates c2→c4 in 100 ms and c4→c2 in reverse with the last move
    highlighted. Home/End and the "off" setting snap.

**Measured performance (`npm run perf:drag`, 3 runs, headless Chrome 60 Hz, MT Stockfish ×4):**

| Window | p50 | p95 | p99 | Dropped | Long tasks |
|--------|-----|-----|-----|---------|------------|
| 1 · Play drag + `go infinite` | 16.66–16.67 | **16.72–16.76** | 16.78–16.84 | 0–0.4% | **0** |
| 1 · 3-premove burst (3 bot moves) | 16.67–16.68 | 16.76 / **33.27** / 16.80 | 16.84–50.07 | 0–5.2% | **0** |
| 2 · Analysis drag, MultiPV 5, `go infinite`, ghost hover every 3rd frame | 16.67 | **16.71–16.73** | 16.81–33.34 | 0.7–1.8% | **0** |
| 2 · Navigation sweep (81 plies at 1 key/frame, back at 1 key/2 frames) | 16.67–16.68 | **16.82–16.88** | 33.35–33.39 | 1.7–4.5% | **0** |

- Premove execution: 3/3 premoves played in the bot move's frame in every run. Premove
  execution itself takes 5–7 ms of main-thread time.
- Engine-line DOM updates: at most **1 per frame**. Ghost previews shown: 93/93.
- Input latency: 0.8–1.2 ms. Idle rAF: 0. Startup: 283–314 ms. Engine peak 2.4–2.8 MN/s,
  depth 22–24.
- Against the baseline, scenario 2 drag p95 went from 33.36 → 16.72 ms, its 281 ms long
  task is gone, and first-pickup latency went from 280 → ~1 ms. The navigation sweep p95
  went from 83.35 → ~16.85 ms.
- The analysis sweep's backward half first sampled two-frame intervals as one; that
  measurement bug was fixed before these numbers were taken.

### Decisions

- **Hypothetical board is displayed while premoves are queued** (chess.com style). This
  lets a piece moved by premove 1 be picked up again for premove 2, where it is shown.
  Lichess (single premove) shows the real board; with Max premoves = 1 the only
  difference is that the premoved piece is drawn on its target square.
- **Left-clicking an empty square no longer clears premoves.** Before, it cleared the
  single premove. With a queue of up to 10, a stray click wiping the whole queue felt
  wrong. Right-click and Escape clear the queue, as the brief specifies.
- Max premoves accepts 1–20, default 10.
- Navigation animation: normal = 100 ms, fast = 60 ms, off = 0. A step that arrives
  while the previous animation is still running, or a key auto-repeat, snaps. A step
  within twice the duration gets half the duration. Engine restarts wait 120 ms after
  steps that come less than 150 ms apart. The PGN textarea refreshes 400 ms after
  navigation stops, and never while it has focus.
- Piece animation now comes from a board diff (chessground-style nearest matching, plus
  pawn ↔ promoted-piece pairing) instead of a single move descriptor. That one planner
  covers forward and reverse steps, castling, en passant, takebacks, and premove
  snap-back.
- On a position change, engine rows from the old position are hidden immediately
  (`visibility`, no layout effect) so a click in the frame before the next flush can't
  act on a stale line. That is one attribute write outside the per-frame batch.
- One shared `CathedralAudio` is used by both modes. It is pre-warmed on the first
  `pointermove`, because the `AudioContext` constructor blocks the main thread for
  ~210 ms in this Chrome. Sound still starts on the first gesture.

### Deviations from the spec and changes to existing code

- **Perf budget:** p95 passes at ≤ 17.2 ms (16.7 ms + 0.5 ms jitter allowance), by the
  user's decision at handover. Written into SPEC.md.
- **`tests/e2e/phase4.spec.ts` (assertions unchanged):**
  1. It clicked engine line 2's first move to create a variation. When Stockfish puts
     `1... e5` (the existing main-line move) on line 2, nothing is inserted; this
     reproduced after the new rendering changed timing. The test now clicks the first
     line whose first move isn't `1... e5`, as its own comment already said ("Line 2 (or
     Line 1 if different from e5)").
  2. Its screenshots went to a hard-coded folder outside the repo
     (`C:/Users/ethan/.gemini/antigravity-cli/brain/...`, left by the previous agent).
     They now go to `test-results/screenshots/`.
- **`RulesAdapter.isCheckmate()` / `isStalemate()`:** standard chess now uses chess.js's
  internal check instead of `verboseMoves()`. Building SAN and two FEN strings for every
  legal move made this the largest cost of a navigation step (~3 ms). Chess960 keeps the
  old path. Added `RulesAdapter.sanMoves()`.
- **Bot blunder scan (`findPlausibleHumanBlunderCandidates`):** it caused a ~105 ms main
  thread long task on every bot move, found while measuring the premove burst.
  - Fix: reply scanning uses SAN-only move lists, and the post-move position loads from
    the verbose move's `after` FEN instead of `clone()` + `move()`.
  - Checked against the previous implementation on 860 random positions with two seeds:
    identical output, average 59.5 → 15.9 ms in Node.
  - Bot calibration (`npm run calibrate:bots`) was not re-run; with identical selection
    output, the measured ACPL targets are unaffected.

### Known issues

- **Bot move selection still runs on the main thread.** It takes ~15–40 ms per bot move
  in the browser (Node: average 15.9 ms, max 112 ms over 560 random positions). That is
  under 50 ms in every perf run, so no long tasks, but it can drop 1–3 frames when the
  bot finishes thinking. This is why the premove-burst window's p95 reached 33.27 ms in
  1 of 3 runs. Premove execution itself is 5–7 ms. The spec-compliant fix is to run
  `selectHumanLikeMove` in a worker. That is a Phase 3 bot change outside this task;
  waiting on the user's go-ahead.
- A promotion picker opened for a premove is still closed when the opponent's move
  arrives (unchanged behavior). The pawn returns to its square and nothing is queued.

---

## Phase 3 — Bot Move Selection in a Worker (2026-10-17)

User approved moving `selectHumanLikeMove` off the main thread (the last known issue
above).

### Plan (written before code)

**Files**
- `src/engine/bot-selection.worker.ts` *(new)*: a module worker that runs
  `selectHumanLikeMove` and posts the decision back.
- `src/engine/bot-selection-client.ts` *(new)*: `BotSelectionClient`. It owns the lazily
  created worker, plus a synchronous fallback where `Worker` doesn't exist (Node:
  `npm test`, `npm run calibrate:bots`) or the worker fails to start.
- `src/engine/bot.ts`: `ChessBot.chooseMove` hands the selection to the client.
- `src/app.ts`: expose `BotSelectionClient` on `window.__wizardChessEngine` for the e2e
  proof.
- Tests:
  - `tests/helpers/bot-golden-cases.ts` (deterministic case generator).
  - `tests/fixtures/bot-selection-golden.json`: expected moves, generated once from
    the original Phase 3 implementation (`02865aa`).
  - `tests/unit/bot-selection-golden.test.ts` (sync path).
  - `tests/e2e/phase3-bot-worker.spec.ts` (real worker in Chrome).

**Keeping moves identical:** the random source is a function and can't cross into a
worker. The client pre-draws a buffer of values from the caller's `rng`. The worker
replays them and reports how many it used; unused values are kept, per `rng`, and handed
out first on the next call. The `rng` stream is therefore consumed exactly as if
`selectHumanLikeMove` had called it directly. That matters for calibration, which
shares one seeded stream across a whole game. If the buffer runs out, the worker reports
it and the client retries with a larger buffer (selection is deterministic given its
inputs).

**Risks:** the worker's result must be structured-cloneable (it is all plain objects).
The worker chunk must be precached for offline use; it matches the `**/*.js` glob. A
pending selection after New Game/Takeback is dropped by the existing generation check.

### Result

**Status: done.** All checks pass, run by the agent:

| Check | Result |
|-------|--------|
| `npm run typecheck` | PASS |
| `npm run lint` | PASS (0 warnings) |
| `npm test` | PASS — 13 files, 106 tests (3 new in `bot-selection-golden.test.ts`) |
| `npm run build` | PASS — main JS 1,248.44 kB (203.88 kB gzip), new `bot-selection.worker` chunk 61.86 kB, precache 13 entries (was 12; the worker is cached for offline use) |
| `npx playwright test` | PASS — 18 specs (2 new in `phase3-bot-worker.spec.ts`), 0 external requests, 0 console errors |

`ChessBot` now takes an injectable `selectMove`. PlayController passes a
`BotSelectionClient`, so play-mode bot moves are selected in the worker; the e2e test
checks the client's counters (worker ≥ 1, inline 0). Node callers (`npm test`,
`npm run calibrate:bots`) keep the inline default. The worker imports only `bot.ts`.
Having the client in `bot.ts` would have put a `new Worker(...)` reference inside the
worker's own bundle.

**Moves are unchanged**
- `tests/fixtures/bot-selection-golden.json` holds the moves the original Phase 3 code
  (`02865aa`, before both optimizations) picks for 860 deterministic cases. The cases
  come from `tests/helpers/bot-golden-cases.ts`: seeded random games, two to eight
  synthetic MultiPV lines each, all seven rating bands from 400 to 2400 and all three
  styles.
- There are two passes. *Independent*: one `mulberry32(case.seed)` stream per case.
  *Shared stream*: one seeded stream consumed across all 860 calls in order, the way
  calibration uses it.
- The fixture is sensitive to randomness: 221 of 860 cases pick a move other than line
  1, and 262 cases differ between the two passes.
- Identical results, all 1,720 selections in each:
  - the current inline `selectHumanLikeMove`
  - `BotSelectionClient` inline fallback (unit test)
  - the real module worker in Chrome (e2e)
- In the e2e run, the 860 independent requests are issued at once, then the 860
  shared-stream requests in sequence: 1,720 selections in ~3.2–3.6 s, **0 main-thread
  long tasks**.
- Mutation check: making the client drop unused random values instead of keeping them
  made the e2e test fail (245 of 860 shared-stream moves differed). The test therefore
  guards the stream accounting, not just the selection code.

**Premove burst, 10 runs** (`PERF_SCENARIOS=play npm run perf:drag`, each in a fresh
browser):

| Run | p50 | p95 | p99 | Dropped | Long tasks | Same-frame premoves |
|-----|-----|-----|-----|---------|------------|---------------------|
| 1 | 16.66 | **16.79** | 16.95 | 0/67 | 0 | 3/3 |
| 2 | 16.67 | **16.81** | 49.99 | 1/70 | 0 | 3/3 |
| 3 | 16.68 | **16.78** | 16.82 | 0/71 | 0 | 3/3 |
| 4 | 16.67 | **16.77** | 33.40 | 2/71 | 0 | 3/3 |
| 5 | 16.67 | **16.76** | 33.34 | 1/72 | 0 | 3/3 |
| 6 | 16.68 | **16.78** | 17.47 | 0/75 | 0 | 3/3 |
| 7 | 16.67 | **16.69** | 16.75 | 0/92 | 0 | 3/3 |
| 8 | 16.68 | **16.82** | 49.94 | 2/71 | 0 | 3/3 |
| 9 | 16.66 | **16.81** | 33.30 | 1/68 | 0 | 3/3 |
| 10 | 16.67 | **16.78** | 49.90 | 1/76 | 0 | 3/3 |

Every run passes the 17.2 ms limit (worst p95 16.82 ms). The Play-mode drag window in the
same runs had p95 16.71–16.74 ms and 0 long tasks.

**Both scenarios** (3 full runs, then 4 more full runs and 4 runs of scenario 2 alone):
- Scenario 1 drag: p95 16.70–16.72 ms, 0 dropped frames, 0 long tasks, input latency
  1.0–1.1 ms.
- Scenario 1 premove burst: p95 16.78–16.85 ms, 0 long tasks.
- Scenario 2 navigation sweep: p95 16.81–16.92 ms, 0 long tasks.
- Engine-line DOM updates: ≤ 1 per frame. Ghost previews: 93/93.
- Idle rAF: 0. Startup: 260–284 ms.
- **Scenario 2 drag (MultiPV 5 + ghost hovers + `go infinite`) fails the p95 limit in 8
  of 11 runs:** p95 33.32–33.33 ms with 3–7% dropped frames, and 0 long tasks in every
  run. The 3 passing runs were at 16.70–16.73 ms.

### Known issues

- **Scenario 2's drag window misses its p95 budget under current machine load. This is
  not caused by the worker change.** An A/B run of the previous commit (`6afceb9`, no
  worker) under the same conditions failed 4 of 4 times, with *more* dropped frames
  (7.1–12.5%) than the worker build (0.7–7.1%). In this morning's runs, the same commit
  passed 3 of 3 (0.7–1.8% dropped). The machine was at 10–30% CPU while idle during these
  runs (VS Code, several Chrome processes, Zoom).
- The drops are single frames with no main-thread long task, so the cost is probably
  rendering or compositing (ghost layer + overlay + dragged piece every frame) competing
  with four engine threads. This needs a trace-level profile to pin down; Phase 9 is
  the place for it.
- Separate from the drops above: the premove burst still shows 0–2 isolated dropped
  frames per ~70-frame window (p99 up to 50 ms) around bot moves. p95 is unaffected.
- Calibration was not re-run. In Node, `ChessBot` uses the inline selector, which the
  golden test shows is unchanged.

---

## Perf / E2E Harness Hardening (2026-10-17)

### Why

A background thread-count experiment (`PERF_ENGINE_THREADS` × `PERF_GHOSTS`, 20 runs) was
stopped by Claude Code because the machine ran critically low on memory. It produced no
data:
- The two runs that finished had failed with a generic `Error`, and their details were
  overwritten by the next run.
- The stop left an orphaned `perf-drag.mjs` with its server and a headless Chrome
  running `go infinite` on four threads. They were found and killed by hand, which freed
  ~900 MB.
- Earlier perf numbers in this log were taken without checking for such leftovers, so
  their background load isn't fully accounted for.

### What was found (reproduced)

- **Force-killing a node process takes its node-spawned children with it** on Windows
  (libuv job object). Chrome and the perf server died with a force-killed `perf-drag.mjs`.
- **Killing the launching shell does not.** For `bash → npm/npx → cmd → node`, the node
  chain survives the shell and keeps running, and its direct parent stays alive. This
  is how the perf run was orphaned. The Playwright suite behaves the same way: with its
  shell dead it ran the whole (throwaway) test to completion, 1.5 minutes, with nobody
  watching.
- **Playwright's web server escaped the runner's process tree.** It is started through a
  shell; force-killing the runner left `serve.mjs --port 4173` running, and later runs
  would have silently reused it (`reuseExistingServer`).
- Windows never re-parents, so a `ParentProcessId` can name a process that exited long
  ago (Git Bash's fork emulation leaves such gaps). An ancestor watchdog has to ignore
  ancestors that are already dead when it starts; the first version didn't, and fired
  falsely.

### Changes

- **`scripts/lib/process-guard.mjs`** *(new, with `.d.mts` types)*:
  - process listing (PowerShell CIM / `ps`)
  - leftover detection: Playwright headless Chrome, other `perf-drag.mjs` /
    `calibrate-bots.mjs`, Playwright runners/workers, `serve.mjs` on the perf port
  - tree kill
  - `installCleanup()`: runs cleanup once, on normal exit, uncaught errors,
    Ctrl+C/Ctrl+Break, SIGTERM/SIGHUP, **death of any live ancestor**, or a hard
    deadline
  - `exitWithParent()`
- **`scripts/perf-drag.mjs`**:
  - Refuses to start (exit 2) if leftovers exist, listing each with a `taskkill`
    command. Other `serve.mjs` instances on other ports are reported but left alone.
  - Checks free memory at start and before each scenario. Aborts (exit 3) under 3 GB.
  - Every run writes its own log, `test-results/perf-logs/<time>_<scenarios>_<threads>_<ghosts>_pid<n>.log`.
    It records config, memory, server output, page errors, the full report, and complete
    error stacks. Lines are written synchronously so a crash can't lose them.
  - Kills every child tree on every way out, and confirms "no child processes left" at
    exit. Chrome is launched with Playwright's own signal handlers off, so one handler
    owns shutdown.
  - Hard deadline `PERF_MAX_RUN_MS` (default 15 min; a full run takes 1–3 min), exit 4.
  - New knobs: `PERF_ENGINE_THREADS=n` (applied while the engine is idle) and
    `PERF_GHOSTS=off`.
- **`scripts/serve.mjs`**: exits when the process named in `WC_EXIT_WITH_PARENT_PID`
  dies.

### Verification (each run in this session; temporary harness scripts deleted afterwards)

| Case | Result |
|------|--------|
| Free memory 2.41 GB | abort, exit 3, clear message, log written |
| Stand-in `serve.mjs --port 4179` running | refused, exit 2, listed with its `taskkill` command |
| Normal exit / thrown error | 0 leftovers; log has the full stack trace |
| SIGINT / SIGTERM (emitted in-process; real Ctrl+C delivery can't be scripted here) | handler ran, Chrome + server killed, 0 leftovers |
| Force kill of `perf-drag.mjs` only | 0 leftovers (job object + server watchdog) |
| Kill of the launching bash only (`bash → node → perf`, npm-like chain) | watchdog: "ancestor exited", killed Chrome + server, perf and the npm stand-in exited, 0 leftovers |
| `PERF_MAX_RUN_MS=6000` | exit 4 after 6 s, 0 leftovers |
| Real full run at 3.72 GB free | exit 0, "no child processes left"; p95 16.73 / 16.80 / 16.69 / 16.87 ms, 0 long tasks |

These cleanup tests ran on a blank page (Chrome launched, no app or Stockfish loaded), with
a temporary 1 GB memory floor, because free memory was under 3 GB at the time.

### E2E suite: the same orphan risk, fixed

Reproduced on the current config with a throwaway spec that holds a blank page open (no
app or engine):

| Experiment | Before | After |
|------------|--------|-------|
| A: force-kill the Playwright runner only | worker + Chrome died (job object); **`serve.mjs --port 4173` survived** | nothing left |
| B: kill only the shell that launched `npx playwright test` | npx, cmd, runner, worker, Chrome and server **kept running**; the test ran to completion (1.5 min) | guard logged "ancestor process … exited", killed 2 child trees (worker + Chrome, server); npx exited; nothing left |

**Fixes (`playwright.config.ts`, `tests/e2e/global-setup.ts`)**
- `webServer.env.WC_EXIT_WITH_PARENT_PID`: the server exits when the runner dies.
- Global setup (it runs in the runner process; experiment B confirms this):
  - Refuses to start while leftover headless Chrome or other perf/test runs exist,
    listing them with kill commands. Checked with a stand-in leftover: the run refused
    before any test started.
  - Installs the ancestor watchdog. Ctrl+C is left to Playwright, which already shuts
    down gracefully. A server on 4173 is not a leftover: `reuseExistingServer` reuses
    your own `npm run serve` on purpose.
- `outputDir: test-results/playwright`: Playwright wipes its output folder on every
  run, which used to delete `test-results/perf-logs/`. Confirmed: a perf log survived a
  full e2e run afterwards. Before the change, an e2e run in this session wiped 16
  cleanup-test logs.

Full checks after the change: typecheck, lint, 106 unit tests, build, 18/18 e2e — all PASS
(4.27 GB free).

### Known issues / notes

- The thread × ghost matrix is still not run. Next step, once memory allows (the perf
  script now enforces ≥ 3 GB free): 3 rounds round-robin of
  `PERF_SCENARIOS=analysis PERF_ENGINE_THREADS={4,3,2}` and `PERF_GHOSTS=off` at 4
  threads.
- The SIGINT/SIGTERM paths were verified by emitting the signals in-process. Real
  console Ctrl+C delivery couldn't be scripted from this environment.
- **Agent mistake during verification:** a cleanup lookup for a stand-in leftover
  matched its own command line and returned its own PID (4028). By the time `taskkill`
  ran, that PID had apparently been reused, and `taskkill` reported terminating a
  process with it. An unrelated process may have been killed; it couldn't be
  identified afterwards (no Application-log errors). From then on, PIDs were only
  killed after re-checking the command line at kill time.

### Clean baseline: scenario 2 drag at 4 threads (2026-10-17)

Checked before each run: no leftover browser/server/runner processes, 5.0–6.6 GB free.
Runs were sequential and in the foreground, with no overlapping work.

| Run | Threads | p95 | p99 | Dropped | Long tasks | Ghost previews | Result |
|-----|---------|-----|-----|---------|------------|----------------|--------|
| 1 | 4 (auto) | 16.69 ms | 16.72 ms | 2/280 (0.71%) | 0 | 93 | PASS |
| 2 | 4 (auto) | 16.69 ms | 16.79 ms | 2/280 (0.71%) | 0 | 93 | PASS |
| 3 | 4 (auto) | 16.69 ms | 16.76 ms | 1/280 (0.36%) | 0 | 93 | PASS |

**Conclusion:** with no orphaned processes and enough free memory, scenario 2's drag passes
3/3 at the default 4 threads. The earlier 8/11 failures (3–7% dropped frames) were most
likely background load from orphaned perf runs and memory pressure, not the app.
Orphaned runs with their own Chrome and four Stockfish threads were found and killed
during that period, and free memory was 1.1–2.6 GB. **The default stays at 4 threads**
(`clamp(1, 4, floor(hardwareConcurrency / 2))`). The reduced-thread and ghosts-off
matrix wasn't needed.

**`PERF_ENGINE_THREADS` doesn't work and now aborts immediately.** The first baseline
attempt used `PERF_ENGINE_THREADS=4`. All 3 runs failed in the step that calls
`engine.configure({ threads })`:
- Re-sending `setoption Threads` to the running multi-threaded WASM Stockfish hung the
  page for ~5 minutes, then crashed it (`page.evaluate: Target crashed`; 2 runs), or ran
  into the 15-minute run limit (1 run).
- This happened even with the current value.
- Cleanup worked each time (exit code 1 / 4, child trees killed, full logs written).
- It is most likely also the cause of the two generic `Error` runs in the aborted matrix,
  so that matrix would not have measured anything.

The script now rejects the setting with a clear message (exit 2) instead of hanging.
Varying the thread count needs a count chosen before the engine starts (an
`EngineClient` construction option set from the page). That's for Phase 9 if it is
ever needed. `PERF_GHOSTS=off` works.

**The analysis-board engine shares the machine with a background review.** Phase 5 hasn't
started. Whether to drop threads while a review runs is open and should be measured
then, since the baseline gives no reason to change the default now.

### Engine thread changes restart the worker (2026-10-17)

**Who can change threads while the engine runs:** nothing in the app UI. No settings,
analysis or review code calls `EngineClient.configure()`. It is public API (exposed as
`window.__wizardChessPlay.engine`) and was used only by the perf script. Phase 5 review
and Phase 8 settings would be the first real callers, so the fix lives in
`configure()` itself.

**What actually crashes (reproduced on the original code with a throwaway spec):**

| Situation | Original `configure()` |
|-----------|------------------------|
| Fresh page, engine just booted, same value (4) | hung > 20 s |
| Fresh page, engine just booted, new value (2) | hung > 20 s |
| Engine already warmed by a search, same value (4) | fine (20 ms) |
| Threads changed mid-analysis on a warmed engine | fine |

So the trigger is a second `setoption name Threads` arriving soon after the worker
boots, probably while the WASM pthread pool from boot is still starting. It is not
"changing threads while running". This corrects the earlier explanation in this log.

**Fix (`src/engine/engine-client.ts`).** `configure({ threads, hashMb })` never sends
`setoption Threads/Hash` to a live engine:
- An unchanged value is a no-op.
- A change restarts the worker: stop, terminate, boot a new worker with the new
  values, and resume.
- On resume, the running search goes back to the front of the queue with its results
  cleared. Its promise, `onInfo` stream and abort signal carry over. The new worker
  starts from default options, so the task re-applies MultiPV, UCI_Chess960 and
  strength settings.
- A search being stopped to resolve (`stopActiveSearch`) finishes with its lines so
  far; a cancelled one is rejected.
- Pending `readyok` waiters are released.
- A transport generation counter drops any late line from the replaced worker.

**Tests**
- `tests/unit/engine-client.test.ts`: mid-search threads change.
  - The old worker never receives a second Threads command and is terminated.
  - The new worker boots with `Threads 2` and re-sends `MultiPV 3`, the same position
    and `go infinite`.
  - Late output from the old worker is ignored; the same promise resolves from the new
    worker.
  - An unchanged value creates no new worker.
- `tests/e2e/phase2-engine-restart.spec.ts` (real multi-threaded Stockfish):
  - During MultiPV 5 infinite analysis, threads 4 → 2 → 4: each restart takes well
    under 10 s, analysis resumes on the same position with 5 lines to depth ≥ 10, no
    crash and no page errors.
  - Threads set to 4 and to 2 right after start-up: no hang, then a depth-10 MultiPV 3
    search completes.
- Mutation check against the original `engine-client.ts`: both start-up tests fail
  (20 s hang); the mid-analysis test passes either way. It is kept as the check that a
  running analysis survives a restart.

**Not changed:** the perf script's `PERF_ENGINE_THREADS` guard still aborts (harness
left as is, as instructed). Its message now overstates the problem. With this fix the
setting could be re-enabled, since `configure()` is safe now.

All checks: typecheck, lint, 107 unit tests, build, 21/21 e2e — PASS.

### `PERF_ENGINE_THREADS` re-enabled (2026-10-17)

The perf script's guard is removed. `PERF_ENGINE_THREADS=n` goes through
`EngineClient.configure()`, the same worker-restart path the app uses. The run now fails
if the engine doesn't report the requested thread count.

One end-to-end check (`PERF_SCENARIOS=analysis PERF_ENGINE_THREADS=2`, no leftovers,
6.8 GB free):
- Engine: multi-threaded, **2 threads** confirmed, peak depth 23, peak 1.55 MN/s
  (~2.4–2.9 MN/s at 4 threads).
- Analysis drag: p95 16.71 ms, p99 33.34 ms, 4/280 dropped (1.43%), 0 long tasks, 93/93
  ghost previews, ≤ 1 engine-line DOM update per frame.
- Navigation sweep: p95 16.78 ms, 0.41% dropped, 0 long tasks.
- Exit 0, "no child processes left".

The thread-count matrix was not run; Phase 5 will compare thread counts for background
review itself.

---

