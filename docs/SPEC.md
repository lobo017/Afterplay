# Wizard's Chess — Offline Chess Learning Tool: Specification

## Goal
The best fully offline chess learning and analysis tool. It should be smooth (locked
60 fps, 120 on high-refresh screens), accurate (Stockfish-grade analysis), and built around
learning: every game you play becomes training material. A companion Chrome extension
captures games from Lichess and Chess.com so they're ready to analyze later.

## Stack
- Vite + TypeScript (strict mode).
- UI panels: Preact or vanilla TS. The board renderer is hand-written imperative code
  (no framework re-renders on the board).
- `chess.js` for move legality, SAN, and FEN.
- Our own PGN parser and writer, supporting variations, comments, annotation symbols
  (NAGs), and the `[%eval]`, `[%cal]`, `[%csl]` tags.
- The `stockfish` npm package. Use a "lite" NNUE WebAssembly build to keep the download
  small, with both single-threaded and multi-threaded variants.
- `idb` for IndexedDB storage.
- `vite-plugin-pwa` for offline caching (installable app).
- Testing and tooling: Vitest (unit tests), Playwright (end-to-end), ESLint, Prettier.

## Run modes
- `npm run dev` for development.
- `npm run build` produces `dist/`.
- `npm run serve` serves `dist/` on localhost with the COOP/COEP headers that
  multi-threaded Stockfish needs. This is the normal way to use the app offline.
- `npm run build:ext` produces the unpacked capture extension in `dist-ext/` (Phase 5b).
- Opening index.html directly from disk is NOT supported. Document why in README.
- Also make it installable as a PWA from localhost. Inside the installed app, use a
  service-worker isolation shim to enable threads. If the page isn't cross-origin
  isolated, fall back to single-threaded Stockfish.

## Hard constraints
- The website makes zero runtime network requests. All assets, the engine, and its
  network file are cached by the service worker.
- The only component allowed to touch the network at runtime is the capture extension
  (extension/, Phase 5b), and only to lichess.org, www.chess.com, and api.chess.com.
- The engine and all heavy work run in workers. No main-thread task over 50 ms.
- Exact chess rules: castling, en passant, promotion, threefold repetition, the 50-move
  rule, insufficient material, and Chess960 FEN round-trip.
- License: GPL-3.0-or-later (Stockfish is GPL). The LICENSES/ folder lists every
  dependency and dataset with its license.

## Architecture
```
src/
  core/        game tree (move nodes with SAN, FEN, comments, NAGs, arrows, eval,
               classification), PGN parser/writer, rules adapter around chess.js
  engine/      EngineClient: UCI over a worker; MultiPV 1–5; streaming info; a priority
               queue (live analysis > review > background); cancellation; thread/hash
               auto-config; result cache keyed by (normalized FEN, depth, multipv)
  render/      2D board renderer, arrow/highlight overlay, particle effects, animation
  analysis/    analysis board, eval bar, engine lines panel, threat detection,
               opening lookup
  review/      game review pipeline, formulas, classification, motif detectors,
               explanations
  trainers/    puzzles, spaced repetition, repertoire, endgames, visualization drills
  storage/     IndexedDB schema, versioned migrations, JSON backup/restore
  ui/          layout, settings, Games list / library, insights, Today screen
extension/     Chrome MV3 capture extension (Phase 5b): site extractors, queue, popup,
               localhost bridge
scripts/       dataset download and build scripts
data/          generated compact datasets
```

## Performance budgets (measure and record in PROGRESS.md)
- **Frame time:** p95 ≤ 16.7 ms during dragging and animated moves, while the engine runs
  infinite analysis.
- **Input latency:** ≤ 1 frame from input to visual response.
- **Idle:** no render work runs when nothing is changing.
- **Startup:** cold start from cache to an interactive board ≤ 1.5 s. The engine loads in
  the background without blocking input.
- **Memory:** no growth across 50 consecutive games (check with a heap snapshot).
- **Review speed:** a 40-move game reviewed on the Quick preset in about 30 s or less with
  a single thread. The UI stays responsive throughout.
- **Measurement:** a Playwright perf script samples requestAnimationFrame intervals while
  scripted drags run during analysis. Note that headless numbers are only indicative.
  - `npm run perf:drag` runs two scenarios and reports p95 frame time, dropped frames and
    long tasks for each:
    1. Play mode, drags while the engine runs `go infinite`, plus a burst of three
       premoves executing across three bot moves.
    2. Analysis board with MultiPV 5 and `go infinite`, drags while ghost previews are
       triggered, plus a rapid arrow-key sweep through a 40-move game.
  - The p95 check allows 0.5 ms for rAF timestamp jitter (pass at ≤ 17.2 ms on a 60 Hz
    display). A single dropped frame (33.3 ms) still fails.
  - Premove execution and navigation must not add long tasks. Engine-line updates reach
    the DOM at most once per frame.
- **Dev overlay** (toggle with the backtick key):
  - FPS and p95 frame time
  - long-task count
  - engine depth and nodes per second
  - cache hit rate

## Data sources (fetched by scripts in scripts/, outputs saved under data/)
- **Openings:** lichess-org/chess-openings (CC0). Convert to JSON keyed by position (EPD)
  and record each opening's ECO code, name, and moves.
- **Puzzles:** the Lichess puzzle database (CC0, a .csv.zst file).
  - Stream-decompress it and sample about 20k puzzles, stratified by theme and rating.
  - Write compact JSON (FEN, moves, rating, themes).
  - Gotcha: the puzzle FEN is the position BEFORE the opponent's move. The first move in
    the `Moves` field is the opponent's move; the solution starts at the second move.
- **Endgame positions:** hand-curated. A test confirms each one with the engine.
- **Out of scope for now:** Syzygy endgame tablebases (possible later stretch goal).

---

## Phases

### Phase 0 — Audit and scaffold
- **Audit:** write a short report on legacy/index.html into PROGRESS.md: what to port, any
  bugs, and performance hotspots.
- **Scaffold:** the Vite project, all npm scripts, linting, Vitest, Playwright, and a
  license file.
- **Data scripts:** write the dataset scripts and run them.

**Done when:** all checks pass on an empty app shell, the data files are generated, and
the work is committed.

### Phase 1 — Core
- **Rules adapter:** wraps chess.js, plus a perft test (start position: 20 / 400 / 8,902 /
  197,281; Kiwipete depth 1–3: 48 / 2,039 / 97,862) to confirm the adapter is correct.
- **Game tree:** add, promote, demote, and delete variations; comments and annotation
  symbols on any move.
- **PGN:** parse and write with variations, comments, annotation symbols, and the
  [%eval] / [%cal] / [%csl] tags.
- **Storage:** IndexedDB database with versioned schema migrations.

**Done when:** a PGN round-trip test passes on tricky fixtures (nested variations,
comments placed before moves, annotation symbols, promotions, castling, Chess960).

### Phase 2 — Engine
- **EngineClient:** everything listed under engine/ in the architecture, plus a UCI
  output parser covered by unit tests.
- **Thread detection:** check whether the page is cross-origin isolated and fall back to a
  single thread if not.
- **Thread (and hash) changes require a worker restart.** Never send
  `setoption name Threads` (or `Hash`) to a running engine: on the multi-threaded WASM
  build, a second Threads change sent soon after the worker boots hangs the page and
  then crashes it. Changing threads stops the engine, terminates the worker, boots a new
  one with the new value, and resumes the search that was running (same position,
  MultiPV and callbacks). Covered by an end-to-end test that changes threads during
  analysis and right after start-up.
- **Perft cross-check:** compare the rules adapter's perft counts against Stockfish's
  `go perft` (with UCI_Chess960 enabled where needed) to depth 3–4. Cover:
  - the standard start position and Kiwipete
  - at least 10 Chess960 starting positions
  - hand-built Chess960 positions where castling is blocked by attacked squares, where
    the castling rook shields the king from a check along the rank, and where king and
    rook swap or stay on their squares

  Any mismatch is a rules bug: fix it in the adapter, never in the test.
- **Playing bot:**
  - Strength 400–2400 with tiers Novice, Casual, Club, Expert, Master.
  - Combine Stockfish's built-in strength limits (UCI_Elo / Skill Level) with a
    "human-like" layer that picks among the top engine lines, weighted by how much worse
    each is, with randomness that scales with the target rating. Weak bots should make
    plausible mistakes, not random ones.
  - Bot styles as presets: aggressive, solid, gambiteer.

**Done when:** unit tests pass, the perft cross-check passes, and an end-to-end test
confirms the engine finds a mate-in-2 and wins a hanging piece.

### Phase 3 — 2D board and play mode
- **Pieces:** SVG pieces moved only with CSS transform, animated with the Web Animations
  API.
- **Overlay:** one SVG layer for arrows, highlights, and circles. It redraws only when
  something changes.
- **Input:** drag and click-to-move, legal-move dots, a promotion picker (with auto-queen
  option), premoves, board flip, and an optional confirm-move setting.
- **Drags survive board updates** (as on Lichess and Chess.com):
  - A board update (such as the opponent's move arriving) never cancels a drag in
    progress. If the held piece is still on its square, the drag continues: dropping it
    plays a normal move if legal, otherwise the piece snaps back. If the held piece was
    captured, the drag ends cleanly with no ghost piece left behind.
  - Dropping during the opponent's turn adds a premove.
- **Cancelling:**
  - Right-clicking during a drag cancels it, and the piece snaps back to its square with
    a short animation. Escape also cancels a drag, and so does dropping a piece off the
    board.
  - Clicking the selected piece again deselects it.
  - Right-clicking (not during a drag) clears all queued premoves. With no drag or
    premove involved, right-click still draws arrows and circles.
- **Premove queue:**
  - Several premoves can be queued, up to a "Max premoves" setting (default 10; 1 gives
    Lichess-style single premoves).
  - Each premove is planned on a hypothetical board where the earlier premoves have been
    played and the opponent has passed; the board shows that hypothetical position while
    premoves are queued. Destinations follow piece movement geometry, as in Lichess's
    board library: pawns may premove diagonally, and squares occupied by your own pieces
    are allowed. Real legality is checked only when the premove executes.
  - Queued premoves are shown as highlighted squares with order numbers (1, 2, 3…) in
    the premove color.
  - When the opponent moves, the next premove plays instantly, with no added delay, in
    the same frame as the board update, and the clock is charged the real elapsed time
    (about 0 ms, plus increment). An illegal premove is cancelled together with every
    premove queued after it, with a brief visual flash.
  - Bot think time does not apply to premoves.
- **Promotion picker:**
  - Compact vertical column of 4 piece icons (no text) sitting directly on the promotion
    file, starting at the promotion square and extending toward the center of the board,
    with the queen closest to the edge.
  - Dim the rest of the board slightly. `Esc` or clicking outside cancels the promotion
    and returns the pawn to its square.
  - Renders on top of everything and is never clipped across both colors, both board
    orientations, and every file `a–h` (including edge files), for drag, click, and
    premove promotions.
  - Covered by Playwright screenshot tests for both colors × both orientations × files
    `a`, `d`, and `h`.
- **Theme:** marble and obsidian look (palette and materials from the legacy audit in
  PROGRESS.md). 2–3 piece sets and board themes, including high contrast.
- **Capture effect:** optional particle effect on one canvas, using a fixed pool (no new
  objects created per frame).
- **Audio:** port the Web Audio synthesizer from legacy/. Start audio on the first
  gesture; add a volume slider.
- **Bot strength scaling & calibration:**
  - Every bot level runs its own limited search on a separate engine instance (or a fully
    reset one), never reusing full-strength infinite analysis or cached results.
  - Uses node limits (`go nodes`) and `Skill Level` for low levels, and `UCI_Elo` only
    where it is valid (`≥ 1320`).
  - Uses `MultiPV` 6–8 at low levels, sampling moves with a rating-scaled temperature
    weighted by centipawn loss.
  - Includes a rating-dependent chance of a "human blunder": a plausible move that misses
    the opponent's threat or leaves a piece hanging (never a random-looking move).
  - Calibrated via `npm run calibrate:bots` (kept outside `npm test` since it is slow),
    measuring average centipawn loss (ACPL) and blunder rate per level in self-play
    against reference levels from 400 to 2400.
- **Bot human-like thinking time:**
  - Varies with the time control, position complexity (number of legal moves, captures,
    and checks available), and game phase; replies quickly to forced and obvious moves and
    pauses longer in sharp positions.
  - Respects the bot's own clock in timed games and provides UI settings for minimum and
    maximum delay (default `0.5–3.0 s` in untimed games).
  - Never blocks the main thread, and premoves work during the thinking delay (verified by
    an end-to-end test that queues a premove while the bot is thinking and confirms it
    executes immediately after the bot moves).
- **Play mode:**
  - time controls with increment, using clocks based on performance.now()
  - takebacks (toggleable), resign, draw offers
  - limited hints, which are logged for the review
- **Layout:** responsive (desktop: board plus side panel; mobile: stacked).
- **Legacy regression tests:** for each legacy bug in PROGRESS.md that applies to this
  phase, write a test that would have failed on the old app.

**Done when:** an end-to-end test plays a full game against the bot, premoves during bot
thinking time and promotion picker screenshot tests pass, `npm run calibrate:bots` hits
the documented targets, the legacy regression tests pass, and the perf numbers are
recorded. End-to-end tests also cover: a drag held through an opponent move and then
dropped plays the move; right-click and Escape both cancel a drag; three queued premoves
all execute across three bot moves; an illegal premove cancels the rest of the queue;
right-click clears the premove queue.

### Phase 4 — Analysis board
- **Eval bar:** animated, mate-aware, flips with the board.
- **Engine lines panel:**
  - Shows 1–5 lines, live.
  - Hover a line to preview it with faded "ghost" pieces.
  - Click a line to play it in as a variation.
- **Arrows:**
  - User-drawn arrows and circles (right-drag and right-click, modifier keys for colors).
  - Best-move arrow.
  - Threat arrow, from a null-move search showing what the opponent is threatening.
- **Position editor:** with FEN validation.
- **Keyboard controls:**

  | Key | Action |
  |-----|--------|
  | ← / → | Previous / next move |
  | ↑ / ↓ | Switch variation |
  | Home / End | Start / end of game |
  | F | Flip board |
  | Space | Engine on/off |

- **Openings:** show the opening name and ECO code from the openings dataset.
- **Stable layout while navigating:** zero layout shift while stepping through moves,
  verified by a Playwright test that steps through a 40-move game with
  `PerformanceObserver('layout-shift')` and reports which elements shifted.
  - Keeping the current move in view scrolls only the move list, never the page.
  - Text that changes per move (eval, engine lines, opening name, depth and node
    counts, clocks) has fixed widths, tabular-nums digits, reserved heights and ellipsis
    truncation. Scrollable panels use `scrollbar-gutter: stable`. No panel resizes based
    on its contents.
- **Navigation animation:**
  - Stepping one move forward or back animates that move over about 100 ms (backward
    plays it in reverse), with the last move highlighted.
  - Jumps (Home/End, clicking a distant move) snap instantly.
  - When a key is held or pressed rapidly, animations are shortened or skipped so
    navigation never lags behind input. An interrupted animation always ends with the
    board in the correct position.
  - A "Navigation animation" setting offers off / fast / normal.

**Done when:** end-to-end tests cover analysis, variations, the editor, and PGN export;
the layout-shift test records zero shifts across a 40-move game; and holding an arrow key
through a game ends on the correct position with no layout shift.

### Phase 5 — Game review
- **Analysis budget per position:**

  | Preset | Time per position |
  |--------|-------------------|
  | Quick | 0.2 s |
  | Standard | 0.6 s |
  | Deep | 1.5 s |

  - Analyze with MultiPV 2.
  - Show a progress bar and allow cancelling.
  - The win% chart fills in live; clicking it jumps to that move.
- **Formulas** (explain them in an in-app tooltip). They follow Lichess's implementation
  (lila `WinPercent`, `AccuracyPercent`, `Accuracy`), so that given Lichess's evaluations
  they reproduce Lichess's numbers; a regression test checks this on a real game:
  - Win% = 50 + 50·(2/(1+e^(−0.00368208·cp)) − 1), with cp clamped to ±1000. A forced
    mate counts as ±1000 cp (97.5% / 2.5%).
  - Move accuracy = 103.1668·e^(−0.04354·win%drop) − 3.1669 + 1 (Lichess's uncertainty
    bonus), clamped to 0–100.
  - Game accuracy = Lichess-style volatility-weighted average blended with the harmonic
    mean.
  - ACPL = per side, the rounded mean over every move of max(0, eval before − eval after)
    for the mover, evaluations clamped to ±1000 cp and mates counted as ±1000.
  - An approximate bot-level comparison for each side (the in-app bot whose calibrated
    ACPL matches), clearly labelled as approximate. It is not a performance rating: the
    bots are calibrated against Stockfish, not people, and there is no human
    ACPL-to-rating data offline (see docs/classification.md).
- **Classification** (rules documented in docs/classification.md, with test fixtures for
  each class):
  - Thresholds, by win% drop. Inaccuracy / Mistake / Blunder are Lichess's (a winning-
    chance drop of 0.1 / 0.2 / 0.3), the reference users compare reviews against:

    | Class | Win% drop |
    |-------|-----------|
    | Best | Matches the engine's top move |
    | Excellent | ≤ 2 |
    | Good | more than 2, less than 5 |
    | Inaccuracy | ≥ 5 |
    | Mistake | ≥ 10 |
    | Blunder | ≥ 15 |

    Already-decided positions (beyond ±95%) must not produce false blunders.
  - **Great:** the only move that keeps the result.
  - **Brilliant:** a Best or Great move that gives up material, in a position that isn't
    trivially winning.
  - **Book:** the position is in the openings dataset.
  - **Miss:** the opponent blundered and the player failed to punish it.
- **Motif detectors and explanations:**
  - Detect:
    - hanging piece
    - fork
    - pin / skewer
    - discovered attack
    - back-rank weakness
    - missed mate
    - trapped piece
    - promotion threat
  - Write one rule-based sentence per mistake, e.g. "Hangs the knight on f6 to Bxf6".
    Name a motif only when the engine's best line realizes it (the material really
    changes hands, or the trapped piece is really lost); otherwise use a general sentence.
    Name the best move once.
- **Imported annotations:** a review replaces earlier engine annotations on the reviewed
  line (Lichess's or an earlier review's evals, move-quality NAGs, engine comments and the
  engine's "best" variations). Plain human comments are kept, separated from the review
  text, so every move's NAG matches the app's classification.
- **Key moments:** the 3–5 biggest swings, with jump buttons.
- **Review tools:**
  - Retry This Mistake
  - Show Refutation
  - Play vs Bot Here
  - Annotated PGN export
  - A built-in sample game
- **Review perspective:** a "Review as: White / Black / Both" control.
  - Default: if the PGN's White or Black header matches one of my usernames (Lichess
    `Lobo017` for now; Phase 5b adds a settings field), my side; otherwise Both.
  - With one side selected:
    - The summary shows that side's stats prominently.
    - Key moments and the mistake list show only that side's errors, including Misses
      (the opponent's blunders that side failed to punish).
    - The board flips to that side, and the win% chart is drawn from that side's point of
      view (its advantage up).
    - Retry This Mistake and next / previous-mistake navigation cycle through only that
      side's moves.
  - Both keeps the two-sided behavior. The choice applies to the current review only and
    never re-runs the engine.
- **Summary panel:**
  - Player headers from the PGN headers (e.g. "Lobo017 · 1397 · Black"), with accuracy as
    the large number and ACPL small beneath it. "Bot level (approx.)" lives in the info
    tooltip.
  - Classification counts as one table: label (icon + name) | White | Black, with the
    player names as column headers. Rows in a fixed order: Brilliant, Great, Best,
    Excellent, Good, Book, Inaccuracy, Mistake, Miss, Blunder. Zero counts are dimmed.
    With one perspective selected, that side's column is emphasized. Clicking a count
    jumps through those moves.
  - Key moments: each entry shows the move, its classification icon and its one-sentence
    explanation.
  - Status line kept short ("Reviewed · Deep · 124 s"); details such as positions, depth
    and replaced annotations go in a tooltip.
  - No layout shift when switching perspective; works at phone width.
- **Board badges:** in review, the current move's classification icon appears on the
  corner of its destination square (both orientations, every class), in addition to the
  move list.

**Done when:** fixture tests cover every class and every motif, and an end-to-end test
reviews the sample game. End-to-end tests cover each perspective (White, Black, Both),
including zero layout shift while switching.

### Phase 5b — Capture extension + Games list
The website stays fully offline (zero runtime network requests, unchanged). A separate
Chrome extension captures games from Lichess and Chess.com. It is the ONLY component
allowed to touch the network.

**Extension** (`extension/`, built with `npm run build:ext` into `dist-ext/`, loaded
unpacked):
- Manifest V3, with minimal permissions:
  - access to lichess.org, www.chess.com, and api.chess.com
  - access to the analysis site's localhost URL (for the bridge only)
  - storage
  - no remotely hosted code
- **Capture** (a content script per site, behind one shared extractor interface, each
  method in its own file):
  - **Lichess:** detect a finished game and fetch the PGN, with clock times, from the
    official game-export endpoint using the game ID from the URL.
  - **Chess.com:** detect a finished game and extract the PGN from the game data the page
    itself loads (decode Chess.com's compact move format if needed). If that fails, fall
    back to the site's own share/PGN feature.
- **Triggers:**
  - auto-capture when a game I played ends (on/off setting)
  - a "Save game" button injected on game pages
  - a right-click menu entry on game links
- **Fallback popup:** if extraction fails, show a notification that opens the extension
  popup. There I can paste a game link or the raw PGN.
  - Lichess links resolve through the export endpoint.
  - Chess.com links resolve through the official monthly archive API. Games that aren't
    there yet show as "pending" and retry periodically (the archive can lag up to 12 h).
  - Pasted PGN is validated before saving.
- **Queue:** captured games are stored in the extension's storage with site, game ID,
  PGN, captured-at time, and status (pending / ready / delivered). The toolbar badge
  shows the number of undelivered games. The popup lists recent captures and their
  status.
- **History backfill:** an "Import my history" button for both sites (Lichess games
  export; Chess.com monthly archives).
  - Fetch only what's new, one request at a time.
  - Respect ETag headers and back off on 429 errors.
  - Backfilled games go into the same queue.
- **Settings:** my Lichess and Chess.com usernames (to recognize my own games), the
  analysis site's localhost URL and port, and the auto-capture toggle.

**Bridge to the website:**
- A content script that runs only on the configured localhost URL relays messages
  between the page and the extension.
- Protocol:
  1. The page announces it's ready (handshake with a version number).
  2. The extension sends ready games in batches.
  3. The page saves them to IndexedDB, skipping duplicates by site + game ID.
  4. The page replies with the saved IDs, and the extension marks only those as
     delivered.
- Check message origin and shape on both sides.
- Sync runs when the page opens and whenever its tab regains focus.
- The website must work normally when the extension isn't installed.

**Website — Games list (the minimal version of Phase 8's library):**
- All captured and imported games: source icon, date, my color, opponent and ratings,
  result, time control, opening name, and an Analyzed / Not analyzed badge.
- Sort and filter by source, result, and analyzed status.
- Select one or more games → "Analyze" queues them for game review on the chosen preset.
  Opening an analyzed game shows its saved review.
- An optional "Auto-analyze new games" toggle (off by default).
- Also: a "Paste PGN" button and drag-and-drop of PGN files.

**Tests:**
- Unit-test every extractor against recorded page data and API responses in
  `tests/fixtures/` (no live network in tests).
- Unit-test the bridge protocol, including partial-failure cases (the page saves some
  games and not others).
- A Playwright test loads the unpacked extension. On mocked game pages it captures a
  game, checks that the badge updates, opens the site, and confirms the game appears in
  the Games list exactly once and can be analyzed.
- The offline end-to-end test for the website still passes.

**Document in README:** how to load the extension, how to set the site URL, and which
capture methods are unofficial and may break when the sites change.

### Phase 6 — Puzzles and spaced repetition
- **Personal puzzles:** every Mistake, Blunder, or Miss becomes a puzzle. Reject a
  position if the second-best move is nearly as good as the best.
- **Bundled puzzles:** the Lichess subset, with themed drills. Accept alternative moves
  that also mate or keep a decisive advantage.
- **Puzzle rating:** Glicko-2.
- **Spaced repetition:** FSRS (or SM-2 with a written justification).
- **Today screen:** shows what's due across all trainers.

**Done when:** tests cover the spaced-repetition scheduler and puzzle validation, and an
end-to-end test solves a puzzle.

### Phase 6b — UX redesign (Chess.com-style usability)
**Goal:** make the app as easy and fluid to use as Chess.com, keeping its own visual
identity (marble and obsidian theme, original icons). Borrow interaction patterns, never
Chess.com's branding, icon designs, or assets.

**Focus areas, in priority order:**

1. **Board feel (top priority).** The board currently feels "sticky" (like Lichess) rather
   than fluid (like Chess.com). Rework piece handling:
   - **Lift:** a picked-up piece lifts visibly (slight scale-up and shadow) and stays
     centered under the cursor. On touch screens it's offset above the finger so it stays
     visible.
   - **Drag start:** a small, tuned threshold, so drags start immediately but clicks are
     never misread as drags.
   - **While dragging:** the square under the piece is highlighted.
   - **Drop:** forgiving near square edges, with a short smooth glide into place. An
     illegal drop slides back smoothly.
   - **Cursors:** grab and grabbing cursors on desktop.
   - **Click-to-move:** large, clear legal-move hints.
   - **Board size:** resizable by dragging its corner; the size is remembered.
   - **Tuning panel:** a "Board feel" section in Settings with live sliders (drag
     threshold, lift scale, snap duration, drop tolerance, touch offset, animation speed)
     and "Reset to defaults". The defaults are the values I approved (3 px, 1.12×, 110 ms,
     0.2 squares, 0.8 squares, 170 ms). (First built in the dev overlay for tuning.)
   - **Drop rule:** if the pointer is over a legal square, the piece lands there; the drop
     tolerance applies only when the pointer is over an illegal square (or just off the
     board) near a legal one. For a touch drag, "the pointer" is where the piece is drawn.
   - **Lift on press:** pressing a piece lifts it at once; the drag threshold only decides
     click vs drag.
   - Must keep every existing input behavior and test: premove queue, drag cancel,
     drag through opponent moves.

2. **Layout:** board on the left, one tidy panel on the right with tabs (moves, analysis,
   review), stacked on phones.

3. **Fewer, clearer controls:** bigger buttons, one primary action per screen, and
   secondary options moved into menus.

4. **Coach-style review:** walk me through the key moments one at a time, each with its
   explanation and a "Try it" button, instead of only showing a summary panel.

5. **Navigation:** clear top-level navigation between Play, Puzzles, Review, and Games.
   The extension's capture features fit into Games.

**Navigation and settings (decided while building Phase 6b):**
- **Four destinations:** Play, Train, Review, Games, in a top bar on desktop and a bottom tab
  bar on phones, with a Settings button. Routes `#play`, `#train`, `#review`, `#games`; the
  earlier `#analysis`, `#today` and `#puzzles` links still open Review and Train.
- **Review** holds the analysis board and the game review: tabs Review / Analysis / Moves.
  Free analysis stays one click away with no game needed: New board, Edit position, and Load
  FEN / PGN.
- **Train** holds the Today screen (what's due) and the puzzles; Phase 7's trainers join it.
  Its tab shows how many reviews and new puzzles are waiting.
- **Play:** new-game choices (opponent, style, time, colour, think time, takebacks) apply only
  when Play is pressed; changing them never ends a game in progress, and starting a new game
  while one is in progress asks first.
- **Settings:** one sheet for everything that isn't part of starting a game: Board (theme,
  piece set, size), Board feel (the six sliders and "Reset to defaults"; this replaces the
  dev overlay's tuning panel), Moves (auto-queen, confirm move, max premoves, Review's move
  animation), Sound & effects, Your data (JSON backup and restore), and About & diagnostics
  (the former header badges and diagnostics cards, and the performance overlay switch; the
  backtick key still toggles the overlay, which shows performance numbers only).
- **Remembered:** every setting, the new-game choices, the board feel and the board size are
  kept on this device and included in the JSON backup; a restore brings them back.

**Process:**
1. **Audit:** take screenshots of every current screen and list the usability problems.
2. **Board feel first:** build the tuning panel and the new defaults, then wait for me to
   tune and approve before moving on.
3. **Proposal:** propose the new layout, navigation, and shared components, with
   screenshots or mockups of the key screens. Get my approval before implementing.
4. **Build:** implement it as shared components that Phases 7 and 8 reuse.

**Done when:**
- All earlier tests pass.
- The layout-shift and perf budgets still hold.
- Phone-width screenshots have been checked.

### Phase 7 — Repertoire, endgame, and visualization trainers
- **Repertoire trainer:**
  - Build White and Black repertoire trees by playing moves or importing PGN.
  - Drill them with spaced repetition.
  - Flag in the review when a game leaves the repertoire.
- **Endgame trainer:**
  - Positions: K+Q v K, K+R v K, K+P opposition, Lucena, Philidor, R+P v R.
  - Each has a target result. Track completions and moves needed versus best possible.
- **Visualization drills:**
  - coordinate trainer
  - blindfold mode
  - "guess the move" through my own games

### Phase 8 — Library, insights, settings, offline
- **Library:** extend the Phase 5b Games list into the full library.
  - Every played, captured, or imported game is included.
  - Filter by result, color, opening, date, and accuracy.
  - Bulk PGN import runs in a worker.
  - JSON backup and restore of all data.
- **Insights dashboard:**
  - accuracy by game phase
  - blunders per 10 moves over time
  - most common motifs
  - results by opening
  - puzzle rating over time

  Clicking any data point opens the positions behind it.
- **Settings:** everything configurable in one panel.
- **Accessibility:**
  - Screen readers announce moves (ARIA live region).
  - Everything works from the keyboard.
  - Classifications use icons and labels, not color alone.
- **Offline:** service worker precaching and installable PWA.

**Done when:** an end-to-end test switches the browser offline and confirms that play,
analysis, review, puzzles, and the Games list all still work.

### Phase 9 — Performance pass and final audit
- Profile and fix until every performance budget is met. Record the numbers.
- Audit every requirement in this spec as Done, Partial, or Missing. Fix the gaps, and
  write the final state into PROGRESS.md and README.

### Phase 10 (optional) — Native engine mode
The app keeps working exactly as today with the WebAssembly engine. When available, it can
also use a native Stockfish for stronger, faster analysis.

- **Native engine:** `npm run serve` can launch a native Stockfish 17.1 program (full NNUE
  network) and connect it to the page over a local WebSocket on localhost only.
  - A setup script downloads the official build for the current OS and records its version
    and checksum. The program and network file stay out of git.
- **Same interface:** EngineClient gets a native backend behind the same API. Analysis,
  review, and the bots work unchanged; thread and hash changes still restart the engine
  cleanly.
- **Fallback:** if the native engine isn't available (no server, an installed PWA, the
  setup step not run), use the WebAssembly engine automatically. A small engine badge
  shows which one is active.
- **Settings:** an engine choice of Auto / Native / WebAssembly, defaulting to Auto.
- **Comparison:** review my Lichess fixture game with the native engine and report
  accuracy and ACPL next to Lichess's numbers and the WebAssembly result.
- **Safety:** the WebSocket only accepts connections from the app's own page. The native
  engine process is cleaned up on every exit path, following the AGENTS.md process rules.

**Done when:** unit and end-to-end tests pass on both backends, the fallback is tested,
and the comparison is recorded in PROGRESS.md.