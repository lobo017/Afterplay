# Wizard's Chess — Offline Chess Learning Tool: Specification

## Goal
The best fully offline chess learning and analysis tool. It should be smooth (locked
60 fps, 120 on high-refresh screens), accurate (Stockfish-grade analysis), and built around
learning: every game you play becomes training material.

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
- Opening index.html directly from disk is NOT supported. Document why in README.
- Also make it installable as a PWA from localhost. Inside the installed app, use a
  service-worker isolation shim to enable threads. If the page isn't cross-origin
  isolated, fall back to single-threaded Stockfish.

## Hard constraints
- Zero runtime network requests. All assets, the engine, and its network file are cached
  by the service worker.
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
  ui/          layout, settings, library, insights, Today screen
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
- **Playing bot:**
  - Strength 400–2400 with tiers Novice, Casual, Club, Expert, Master.
  - Combine Stockfish's built-in strength limits (UCI_Elo / Skill Level) with a
    "human-like" layer that picks among the top engine lines, weighted by how much worse
    each is, with randomness that scales with the target rating. Weak bots should make
    plausible mistakes, not random ones.
  - Bot styles as presets: aggressive, solid, gambiteer.

**Done when:** unit tests pass, and an end-to-end test confirms the engine finds a
mate-in-2 and wins a hanging piece.

### Phase 3 — 2D board and play mode
- **Pieces:** SVG pieces moved only with CSS transform, animated with the Web Animations
  API.
- **Overlay:** one SVG layer for arrows, highlights, and circles. It redraws only when
  something changes.
- **Input:** drag and click-to-move, legal-move dots, a promotion picker (with auto-queen
  option), premoves, board flip, and an optional confirm-move setting.
- **Theme:** marble and obsidian look. 2–3 piece sets and board themes, including high
  contrast.
- **Capture effect:** optional particle effect on one canvas, using a fixed pool (no new
  objects created per frame).
- **Audio:** port the Web Audio synthesizer from legacy/. Start audio on the first
  gesture; add a volume slider.
- **Play mode:**
  - time controls with increment, using clocks based on performance.now()
  - takebacks (toggleable), resign, draw offers
  - limited hints, which are logged for the review
- **Layout:** responsive (desktop: board plus side panel; mobile: stacked).

**Done when:** an end-to-end test plays a full game against the bot. Record the perf
numbers.

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

**Done when:** end-to-end tests cover analysis, variations, the editor, and PGN export.

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
- **Formulas** (explain them in an in-app tooltip):
  - Win% = 50 + 50·(2/(1+e^(−0.00368208·cp)) − 1). A forced mate counts as 0 or 100.
  - Move accuracy = 103.1668·e^(−0.04354·win%drop) − 3.1669, clamped to 0–100.
  - Game accuracy = Lichess-style volatility-weighted average blended with the harmonic
    mean.
  - Estimated performance rating for each side.
- **Classification** (rules documented in docs/classification.md, with test fixtures for
  each class):
  - Starting thresholds, by win% drop:

    | Class | Win% drop |
    |-------|-----------|
    | Best | Matches the engine's top move |
    | Excellent | ≤ 2 |
    | Good | ≤ 5 |
    | Inaccuracy | ≤ 10 |
    | Mistake | ≤ 20 |
    | Blunder | > 20 |

    Tune them so already-decided positions (beyond ±95%) don't produce false blunders.
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
- **Key moments:** the 3–5 biggest swings, with jump buttons.
- **Review tools:**
  - Retry This Mistake
  - Show Refutation
  - Play vs Bot Here
  - Annotated PGN export
  - A built-in sample game

**Done when:** fixture tests cover every class and every motif, and an end-to-end test
reviews the sample game.

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
- **Library:**
  - Every game saves automatically.
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
analysis, review, and puzzles all still work.

### Phase 9 — Performance pass and final audit
- Profile and fix until every performance budget is met. Record the numbers.
- Audit every requirement in this spec as Done, Partial, or Missing. Fix the gaps, and
  write the final state into PROGRESS.md and README.