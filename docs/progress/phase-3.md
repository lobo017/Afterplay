<!-- Archive of docs/PROGRESS.md lines 319-477 (verbatim). Phase 3 -->

## Phase 3 — 2D Board and Play Mode (Plan, Architecture & Verification)

### 1. Phase 3 Implementation Plan (Written Before Code)

#### Files to Add or Change
- `src/render/themes.ts` *(new)*:
  - 3 board themes (`marble-obsidian` from the `legacy/index.html` audit palette, `imperial-walnut`, and WCAG high-visibility `high-contrast`) and 3 SVG piece sets (`cathedral` marble/obsidian with gold/amethyst trim, `staunton`, and `high-contrast`).
- `src/render/piece-sets.ts` *(new)*:
  - Hand-crafted SVG vector templates for all 12 chess pieces (`w/b` × `p/n/b/r/q/k`) across all 3 piece sets (`cathedral`, `staunton`, `high-contrast`).
- `src/render/overlay.ts` *(new)*:
  - Imperative single-layer `<svg>` overlay (`BoardOverlay`) for square highlights (selected `#fbbf24`, hover `#38bdf8`, last move `#f59e0b`, king-in-check `#ef4444`, queued premove `#10b981`), legal move dots (`#38bdf8`) and capture rings (`#ef4444`), premove target dots, and arrows/circles (hint, premove, and user annotations).
  - Dirty-checked via a lightweight state signature so the SVG DOM redraws **only** when the overlay state actually changes (zero redraws while dragging within the same square or when idle).
- `src/render/particles.ts` *(new)*:
  - Fixed-pool `<canvas>` capture shatter particle system (`CaptureParticleSystem`) ported from `PooledShatterSystem` in `legacy/index.html`.
  - Pre-allocates a fixed pool of `180` particle structs (`54` triggered per capture: $2/3$ piece-colored stone fragments `#f8f5f0`/`#161925`, $1/3$ glowing `#f59e0b` embers) with zero per-frame object allocations.
  - Runs `requestAnimationFrame` only while `activeCount > 0` and stops immediately when all particles settle (`0` idle CPU).
- `src/render/audio.ts` *(new)*:
  - Procedural Web Audio synthesizer (`CathedralAudio`) ported from `CathedralAudioEngine` in `legacy/index.html` (`playSelect`, `playSlide(isLevitate)`, `playShatter`, `playCheck`, `playGameOver(victory)`).
  - Starts lazily on the first user gesture, routes through a master `GainNode` with a volume slider (`0.0–1.0`) and mute toggle, and pre-allocates/reuses a single `0.45s` white-noise `AudioBuffer` instead of allocating on the UI thread per move.
- `src/render/board-renderer.ts` *(new)*:
  - Imperative 2D board renderer (`BoardRenderer`) with zero framework re-renders.
  - Positions SVG piece elements exclusively via CSS `transform: translate3d(x, y, 0)` and animates moves with the Web Animations API (`element.animate()`).
  - Supports drag-to-move (compositor-only `translate3d` updates using cached board `DOMRect`, zero layout reads during `pointermove`) and click-to-move, legal-move dots/rings, cancellable promotion picker (`Queen`, `Rook`, `Bishop`, `Knight`) for both regular moves and premoves, `autoQueen` option, premoves (with right-click / Escape cancellation), board flip, and optional `confirmMove` staging (`Confirm` / `Cancel`).
- `src/ui/clock.ts` *(new)*:
  - High-precision chess clock controller (`ChessClock`) using `performance.now()` with time control presets (Bullet, Blitz, Rapid, Unlimited) and increment support, updating DOM text only when the displayed tenth-second or second string changes.
- `src/ui/play-controller.ts` *(new)*:
  - Full Play Mode controller (`PlayController`) integrating `RulesAdapter`, `GameTree`, `BoardRenderer`, `CaptureParticleSystem`, `CathedralAudio`, `ChessClock`, `EngineClient`, and `ChessBot`.
  - Handles vs-Bot games across all 5 rating tiers (`Novice`–`Master`, `400–2400`) and 3 styles (`Aggressive`, `Solid`, `Gambiteer`), takebacks (toggleable, aborting in-flight bot searches safely with generation IDs), resign, draw offers, limited hints (logged as `HintUsageRecord[]` for Phase 5 review), accurate captured pieces & material advantage accounting across promotions, and optional concurrent infinite engine analysis.
- `src/ui/dev-overlay.ts` *(modified)*:
  - Decouple `updateEngineStats()` and `recordCacheLookup()` from synchronous DOM writes so high-frequency UCI `info` lines from Stockfish `go infinite` never trigger layout/DOM mutations outside the `requestAnimationFrame` tick.
- `src/app.ts` & `src/styles/main.css` *(modified)*:
  - Mount the responsive 2D Cathedral Marble & Obsidian board and Play Mode side panel (desktop side-by-side, mobile stacked) while preserving all Phase 0–2 badges, test IDs, and global APIs.
- `scripts/perf-drag.mjs` & `package.json` *(new / modified)*:
  - Playwright performance benchmark script sampling `requestAnimationFrame` intervals during scripted piece drags and animated moves while Stockfish runs `go infinite` analysis, reporting `p50`, `p95`, `p99`, `fps`, `longTaskCount`, and idle `rAF` count.
- `tests/unit/phase3-board.test.ts` & `tests/e2e/phase3.spec.ts` *(new)*:
  - Unit and E2E tests covering a complete game vs the bot, all applicable legacy bug regression tests from `PROGRESS.md`, and drag smoothness under infinite analysis.

#### Risks & Mitigations
1. **Risk — Main-Thread Frame Drops During Dragging While Stockfish Runs `go infinite`**:
   - Stockfish emits bursts of UCI `info` messages at low depths, and calling `getBoundingClientRect()` or rebuilding SVG overlays on every `pointermove` would cause layout thrashing and push p95 frame time above `16.7 ms`.
   - *Mitigation*: Cache `boardRect` on `pointerdown` / `ResizeObserver`; update only `draggedPieceEl.style.transform = translate3d(...)` on `pointermove`; redraw `BoardOverlay` only when `hoveredSquare` changes to a different square (`0–63`); and coalesce engine telemetry / live evaluation UI updates onto `requestAnimationFrame`.
2. **Risk — Legacy Promotion, Premove, and Stale Worker Race Bugs**:
   - The legacy app left promoted pawns floating in mid-air with an uncancellable modal, hardcoded premove promotions to Queen, allowed stale worker moves to corrupt new games, and miscounted promoted pawns as captured pieces.
   - *Mitigation*: Explicitly design the state machine in `BoardRenderer` and `PlayController` to eliminate all 7 legacy bugs and write dedicated regression tests for each.

### 2. Phase 3 Technical Decisions, Legacy Regression Coverage & Measured Performance Numbers

#### Technical Decisions & Architecture
- **Compositor-Only Piece Movement & Web Animations API (`src/render/board-renderer.ts`)**:
  - Every chess piece is a pooled `<div class="wc-piece">` sized at `12.5% × 12.5%` (`top: 0; left: 0; will-change: transform; contain: layout style`) moved strictly via `transform: translate3d(${col * 100}%, ${row * 100}%, 0)` and animated via `element.animate([{ transform: from }, { transform: to }], { duration: 170, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' })`.
  - During `pointermove` dragging, `BoardRenderer` uses the cached `DOMRect` captured on `pointerdown` / `ResizeObserver` (zero layout reads during `pointermove`) to update `drag.element.style.transform = translate3d(pctX%, pctY%, 0) scale(1.08)` and computes the hovered square in $O(1)$ arithmetic.
- **Dirty-Checked Single-Layer SVG Overlay (`src/render/overlay.ts`)**:
  - Uses one `<svg class="wc-board-overlay" viewBox="0 0 800 800">` element with a dedicated `<rect data-testid="overlay-hover-square">` for hover changes and `<g data-testid="overlay-static-layer">` for square highlights, legal-move dots (`#38bdf8`), capture rings (`#ef4444`), king-in-check radial halo (`#ef4444`), premove highlights/arrows (`#10b981`), hint arrows (`#f59e0b`), and user-drawn circles/arrows.
  - While dragging within the same square, `BoardOverlay.render()` performs 0 DOM updates; when crossing square boundaries during a drag, only the single `<rect>` `x`/`y` attributes update without rebuilding the static SVG layer.
- **Fixed-Pool 2D `<canvas>` Capture Shatter System (`src/render/particles.ts`)**:
  - Pre-allocates `180` particle structs at startup (`54` triggered per capture: $2/3$ piece-colored stone fragments `#f8f5f0`/`#161925` with `#d4af37`/`#a855f7` trim, $1/3$ glowing `#f59e0b` embers) with 2.5D height bounce physics (`restitution: 0.42`, `friction: 0.72`).
  - Allocates zero objects per frame and runs `requestAnimationFrame` only while `activeCount > 0`.
- **Ported Cathedral Web Audio Synthesizer (`src/render/audio.ts`)**:
  - Ports `playSelect`, `playSlide(isLevitate)`, `playShatter`, `playCheck`, and `playGameOver(victory)` from `legacy/index.html`, wired through a master `GainNode` controlled by a volume slider (`0–100%`) and mute toggle.
  - Pre-allocates and caches the `0.45s` stone-slide white-noise `AudioBuffer` once on `AudioContext` initialization instead of regenerating `~20,000` floats per move.
- **Coalesced Telemetry During `go infinite` (`src/ui/dev-overlay.ts`, `src/ui/play-controller.ts`, `src/engine/engine-client.ts`)**:
  - `PlayController` coalesces streaming `onInfo` evaluation updates from `go infinite` onto `requestAnimationFrame`, `DevOverlayController.updateEngineStats()` updates only the text node when changed without re-sorting `frameSamples` on every UCI line, and `EngineClient.analyze()` automatically preempts background `infinite` searches when a `live` search (such as a hint or bot move) arrives.

#### Legacy Bug Regression Tests (`tests/unit/phase3-board.test.ts` & `tests/e2e/phase3.spec.ts`)
1. **Legacy Bug #1 (Runtime CDN Requests Break Offline Operation)**: Verified `0` external network requests across board rendering, themes, audio synthesis, capture particles, hints, and full vs-bot gameplay (`tests/e2e/phase3.spec.ts`).
2. **Legacy Bug #2 (Pawn Drag-Promotion Leaves Mesh Floating & Modal Uncancellable)**: Verified that dragging a pawn to `a8` with `autoQueen` off snaps the pawn cleanly back to its resting `translate3d(0%, 100%, 0px)` transform (without `.wc-piece-dragging`), opens `[data-testid="promotion-picker"]`, and cancels cleanly via `Escape`, the Cancel button, or backdrop click (`tests/e2e/phase3.spec.ts`).
3. **Legacy Bug #3 (Premove Promotion Hardcoded to Queen)**: Verified that queuing a promotion premove (`a7` $\rightarrow$ `a8`) while the bot is thinking opens the Premove Promotion picker when `autoQueen` is off, allows selecting Knight (`promote-n`), queues `{ from: 'a7', to: 'a8', promotion: 'n' }`, and executes `a8=N` upon the bot's move completion (`tests/e2e/phase3.spec.ts`).
4. **Legacy Bug #4 (In-Flight AI Worker Race Condition Across "New Game" / Color Switch)**: Verified that starting a new game while `isBotCurrentlyThinking() === true` aborts the in-flight Stockfish worker request and increments `gameGeneration` so the stale worker completion never executes a move or mutates the new game (`tests/e2e/phase3.spec.ts`).
5. **Legacy Bug #5 (Captured Pieces Tray Miscounts Promoted Pawns)**: Verified in both unit (`tests/unit/phase3-board.test.ts`) and E2E (`tests/e2e/phase3.spec.ts`) tests that promoting a pawn (`a8=Q`) adds zero phantom pawns to the opponent's captured tray (`capturedByBlack === []`, `netAdvantageWhite === +8`), and subsequent capture of the promoted Queen (`Rxa8`) accurately records `'q'` in `capturedByBlack`.
6. **Legacy Bug #6 (Stale Evaluation Bar After Undo / Takeback)**: Verified that clicking **Takeback** (`[data-testid="btn-takeback"]`) immediately restores `[data-testid="live-eval-score"]` to the prior position's evaluation (`+0.00`) and restores clock times (`tests/e2e/phase3.spec.ts`).
7. **Legacy Bug #7 & Hotspots #1–#4 (Memory Leaks, Idle Loop, Raycasting, Noise Buffer Allocation)**: Verified that `BoardOverlay.getRedrawCount()` does not increment when state is unchanged, `CaptureParticleSystem` uses a fixed pool of `180` shards and stops `rAF` when idle, `idleRafCallbacksIn500Ms === 0` when nothing is changing, and `CathedralAudio.getNoiseBufferAllocationCount() === 1` across 10+ grounded stone slides.

#### Measured Performance Numbers (Phase 3 — `npm run perf:drag`)
Measured via `scripts/perf-drag.mjs` (`npm run perf:drag`) under `npm run serve` (`http://127.0.0.1:4179`, COOP/COEP isolated) while **multi-threaded Stockfish 17.1 WASM (`4` threads, reaching depth `25` at `2,140,056` NPS / `2.14 MN/s`)** runs continuous `go infinite` MultiPV 3 analysis in the background during `280` frames of continuous multi-square piece dragging and move execution:
- **p95 Frame Time during drags + `go infinite`:** **`16.70 ms`** (budget: `≤ 16.7 ms` — **PASS**)
- **p50 (Median) Frame Time:** **`16.66 ms`** (`60.0 fps` locked)
- **Mean Frame Time / FPS:** **`16.73 ms`** (**`59.8 fps`**)
- **p99 Frame Time:** **`16.77 ms`**
- **Max Frame Time:** **`33.31 ms`**
- **Long Tasks (`> 50 ms`) during drags + `go infinite`:** **`0`** (budget: `0` — **PASS**)
- **Synchronous Input-to-Transform Latency (`pointerdown` + `pointermove` $\rightarrow$ `translate3d`):** **`1.20 ms`** (`< 0.08` frames; budget: `≤ 1 frame` — **PASS**)
- **Idle Render Work (`rAF` callbacks over `500 ms` when nothing is changing):** **`0`** (budget: `0` — **PASS**)
- **Cold Startup to Interactive 2D Board:** **`309.76 ms`** (budget: `≤ 1,500 ms` — **PASS**)
- **Production Bundle (`dist/`)**: JS `205.43 kB` (`60.15 kB` gzip), CSS `13.68 kB` (`3.50 kB` gzip), `0` runtime network requests.

#### Known Issues
- None.

---

### 3. Phase 3 Refinements — Bot Strength Scaling, Human-Like Think Time & Vertical Promotion Picker

#### 3.1 Root-Cause Investigation: Why Bots Played Far Above Their Rated Level
1. **Shared Engine Instance & Transposition Table (Hash) Contamination**:
   - `src/app.ts` and `src/ui/play-controller.ts` previously passed the same `sharedEngine` (`EngineClient`) to both `PlayController` (which runs full-strength `go infinite` background analysis and `requestHint` at `Skill Level 20`, `UCI_LimitStrength false`) and `ChessBot`.
   - Even though `ChessBot.chooseMove()` passed `useCache: false` (bypassing the JS `AnalysisCache`), Stockfish's internal WASM transposition table (`Hash`) retained deep, full-strength evaluations from `go infinite`, hints, and prior searches.
2. **`UCI_Elo` Minimum Floor (`1320`) & `MultiPV` Bypassing Stockfish's Internal Skill Perturbation**:
   - Stockfish 17.1's `UCI_Elo` option has a hard minimum of `1320` (`min 1320 max 3190`). Setting `uciLimitStrength = true` for `400–1200` Elo clamped `uciElo` to `1320`, so `UCI_Elo` alone cannot produce `400–1200` Elo play.
   - Furthermore, Stockfish's internal `Skill Level` / `UCI_LimitStrength` perturbation is only applied when Stockfish picks its final `bestmove` at the end of a search; the `info depth ... multipv k score cp ...` lines emitted during `MultiPV > 1` report **unperturbed, exact NNUE evaluations**. Because `ChessBot.chooseMove()` ignored `bestmove` and ran `selectHumanLikeMove()` on `analysis.lines`, Stockfish's internal skill noise had zero effect on the candidate line evaluations.
3. **Excessive Search Depth, No Node Limits (`go nodes`), and Capped `MultiPV 5`**:
   - `computeBotEngineParams` searched to `depth = 5` at 400 Elo and `depth = 6` at 600 Elo (`Novice`) with no node limit (`go depth 6` searches `~10,000–25,000` NNUE nodes), and `EngineClient.analyze()` clamped `multipv` to `Math.min(5, ...)`.
   - In a typical middlegame with `30+` legal moves, the top 5 Stockfish moves at depth 6 are all strong moves (often within `15–60 cp` of best), so `Novice` and `Casual` bots never even considered the moves where human inaccuracies, missed threats, or hanging-piece blunders occur.

#### 3.2 Implementation Plan (Written Before Code)

##### Files to Add or Change
- `src/engine/engine-client.ts` *(modified)*:
  - Add `nodes?: number` (`go nodes <N>`) and `resetGame?: boolean` (`ucinewgame` before search) to `EngineAnalyzeRequest`.
  - Expand `MultiPV` clamping from `1–5` to `1–12` so bot searches can request `MultiPV 6–8`.
- `src/engine/bot.ts` *(modified)*:
  - Rebuild `computeBotEngineParams`:
    - Use strict node budgets (`go nodes`) and `Skill Level` (`0–20`) for low/mid levels (`400–1319`), and enable `UCI_LimitStrength` / `UCI_Elo` **only** where valid (`rating >= 1320 && rating < 2400`).
    - Use `MultiPV` `6–8` at low levels (`8` at `400–799`, `7` at `800–1199`, `6` at `1200–1599`).
    - Add rating-scaled `temperatureCp` and `blunderChance` (`0.0` at `2350–2400` up to `0.45` at `400`).
  - Add a **Plausible Human Blunder** generator & evaluator (`findPlausibleHumanBlunderCandidates` / `scoreMoveHumanPlausibility`):
    - Identifies moves that look constructive to a human (developing a minor piece, advancing a central pawn, capturing a piece, giving check, or castling) **but** either miss the opponent's threat on another square or leave a piece/pawn hanging (`85–520 cp` loss).
    - Explicitly rejects random-looking moves (aimless king walks, rim rook shuffles, backward retreats to the back rank, or unprovoked Queen giveaways).
  - Add `computeBotThinkTimeMs(options)` to calculate human-like thinking delay based on time control, remaining bot clock + increment, position complexity (legal move count, available captures and checks, MultiPV eval tension), game phase (opening, middlegame, endgame), and forced/obvious replies (single legal move or immediate recapture), bounded by configurable `minDelayMs` and `maxDelayMs` (default `500–3000 ms` in untimed games).
- `src/ui/play-controller.ts` & `src/app.ts` *(modified)*:
  - Isolate bot searches onto a dedicated `botEngine: EngineClient` instance so the bot never shares transposition table state or analysis results with full-strength `go infinite` / hints.
  - Wire non-blocking human-like bot thinking time (`computeBotThinkTimeMs`) and UI inputs (`[data-testid="input-bot-min-delay"]` and `[data-testid="input-bot-max-delay"]`, defaulting to `0.5 s` and `3.0 s`) into `PlayController`, ensuring premoves can be queued and cancelled cleanly while the bot is thinking.
- `src/render/board-renderer.ts` & `src/styles/main.css` *(modified)*:
  - Replace the modal promotion box with a compact vertical column of 4 piece icons (`q`, `n`, `r`, `b`, no text) positioned directly on the promotion file (`left: ${col * 12.5}%; width: 12.5%; height: 50%`), anchored at the promotion square (`top: 0%` with `flex-direction: column` when `row < 4`, or `top: 50%` with `flex-direction: column-reverse` when `row >= 4`) so the Queen is always closest to the board edge and the column extends toward the center of the board.
  - Dim the rest of the board slightly (`rgba(7, 9, 14, 0.48)`), render on top of all board layers (`z-index: 60/65`), and cancel cleanly on `Escape` or outside click.
- `scripts/calibrate-bots.mjs` & `package.json` *(new / modified)*:
  - Add `"calibrate:bots": "node scripts/calibrate-bots.mjs"` outside `npm test`.
  - Runs self-play games across ratings `400`, `600` (`Novice`), `1000` (`Casual`), `1400` (`Club`), `1800` (`Expert`), `2200` (`Master`), and `2400` against reference levels on isolated Stockfish workers, using a separate full-strength Reference Oracle Stockfish instance (`Skill Level 20`, `UCI_LimitStrength false`, depth `10`) to measure **Average Centipawn Loss (ACPL)** and **Blunder Rate (`%` of moves with `cpLoss >= 100 cp`)** per level.
- `tests/unit/bot.test.ts` & `tests/e2e/phase3.spec.ts` *(modified)*:
  - Add unit tests for `computeBotThinkTimeMs`, human blunder generation (plausible vs random moves), and `UCI_Elo` validity gating (`>= 1320`).
  - Add E2E test queuing a premove during human-like bot thinking time and confirming immediate execution after the bot moves.
  - Add Playwright screenshot tests covering all **12 combinations** of promotion picker (`White` / `Black` × `unflipped` / `flipped` × files `a`, `d`, `h`) and visually inspect them.

#### 3.3 Bot Strength Self-Play Calibration Targets & Measured Results (`npm run calibrate:bots`)
Measured via `npm run calibrate:bots` (`scripts/calibrate-bots.mjs`, 6 self-play games per level across 6 diverse opening/middlegame structures = `50–54` evaluated bot moves per level, evaluated against an isolated full-strength depth-10 Stockfish 17.1 Oracle):

| Rating / Level | Ref Opponent | Search & Sampling Profile | Target ACPL (cp) | **Measured ACPL (cp)** | Target Blunder Rate (`≥ 100 cp`) | **Measured Blunder Rate** | Match Score vs Ref | Status |
|---|---|---|---|---|---|---|---|---|
| **400** (Novice Min) | `1000` | `Skill 0`, `go nodes 25`, `MultiPV 8`, `UCI_LimitStrength false`, `temp 112.2 cp`, `blunder 45%` | `118 – 165 cp` | **`127.0 cp`** | `36% – 48%` | **`45.1%`** | `1.0 / 6` | **PASS** |
| **600** (`Novice`) | `1000` | `Skill 2`, `go nodes 180`, `MultiPV 8`, `UCI_LimitStrength false`, `temp 90.7 cp`, `blunder 21%` | `88 – 122 cp` | **`100.0 cp`** | `26% – 36%` | **`32.0%`** | `0.5 / 6` | **PASS** |
| **1000** (`Casual`) | `1400` | `Skill 6`, `go nodes 1600`, `MultiPV 7`, `UCI_LimitStrength false`, `temp 54.7 cp`, `blunder 6.2%` | `55 – 85 cp` | **`68.4 cp`** | `18% – 30%` | **`28.8%`** | `3.0 / 6` | **PASS** |
| **1400** (`Club`) | `1400` | `Skill 10`, `UCI_Elo 1400`, `go nodes 3400`, `MultiPV 6`, `temp 28.2 cp`, `blunder 3.6%` | `26 – 48 cp` | **`31.0 cp`** | `7% – 15%` | **`9.4%`** | `3.5 / 6` | **PASS** |
| **1800** (`Expert`) | `1800` | `Skill 14`, `UCI_Elo 1800`, `go nodes 8500`, `MultiPV 4`, `temp 10.8 cp`, `blunder 1.2%` | `15 – 26 cp` | **`17.9 cp`** | `2.5% – 8%` | **`5.6%`** | `4.5 / 6` | **PASS** |
| **2200** (`Master`) | `1800` | `Skill 18`, `UCI_Elo 2200`, `go nodes 15500`, `MultiPV 3`, `temp 2.4 cp`, `blunder 0.4%` | `9 – 16 cp` | **`12.1 cp`** | `0% – 3.5%` | **`1.9%`** | `4.5 / 6` | **PASS** |
| **2400** (Master Max) | `2200` | `Skill 20`, `UCI_LimitStrength false`, `go nodes 60000`, `MultiPV 2`, `temp 1.4 cp`, `blunder 0%` | `0 – 10 cp` | **`8.2 cp`** | `0% – 2.0%` | **`1.9%`** | `3.5 / 6` | **PASS** |

- **Monotonic Progression**: **PASS** (`127.0 -> 100.0 -> 68.4 -> 31.0 -> 17.9 -> 12.1 -> 8.2 cp` ACPL and `45.1% -> 32.0% -> 28.8% -> 9.4% -> 5.6% -> 1.9% -> 1.9%` Blunder Rate).

#### 3.4 Human-Like Thinking Time & Promotion Picker Verification
- **Human-Like Bot Thinking Time (`computeBotThinkTimeMs` & `tests/e2e/phase3.spec.ts`)**:
  - Verified in unit tests (`tests/unit/bot.test.ts`) that forced moves (`1` legal reply) and immediate recaptures reply quickly near `minDelayMs`, sharp tactical middlegames pause longer than early opening plies, and low remaining clock time (`< 5 s`) caps think time (`≤ 120 ms`) so the bot never flags due to artificial delay.
  - Verified in E2E (`tests/e2e/phase3.spec.ts`) that setting `[data-testid="input-bot-min-delay"]` (`0.7 s`) and `[data-testid="input-bot-max-delay"]` (`1.4 s`), playing `1. e4`, and queuing a premove (`d2` $\rightarrow$ `d4`) while `isBotCurrentlyThinking() === true` highlights the premove during the non-blocking think delay and executes `2. d4` immediately after the bot moves.
- **Vertical Column Promotion Picker (`tests/e2e/phase3.spec.ts`)**:
  - Verified across all **12 combinations** (`White` / `Black` × `unflipped` / `flipped` × files `a`, `d`, and `h`, covering drag, click, and premove promotions) with Playwright bounding-box assertions and visual screenshot inspection (`promo-{w,b}-{unflipped,flipped}-file-{a,d,h}.png`):
    - Renders a vertical column of 4 piece icons (`promote-q`, `promote-n`, `promote-r`, `promote-b`) with zero text labels directly on the promotion file (`width = boardWidth / 8`, `height = boardHeight / 2`), completely contained within the board with zero clipping on edge files `a` and `h`.
    - Places the Queen (`q`) closest to the board edge (`top` edge when promoting at visual row `0`, `bottom` edge when promoting at visual row `7`) and extends toward the center of the board.
    - Dims the board behind the column (`rgba(7, 9, 14, 0.48)`) and cancels cleanly on `Escape` or clicking outside, returning the pawn to its square.

---

