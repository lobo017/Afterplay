<!-- Archive of docs/PROGRESS.md lines 478-558 (verbatim). Phase 4 -->

## Phase 4 — Analysis Board (Plan, Architecture & Verification)

### 1. Phase 4 Implementation Plan (Written Before Code)

#### Files to Add or Change
- `src/analysis/opening-lookup.ts` *(new)*:
  - Imports `data/openings.json` (`3,865` opening positions keyed by 4-field EPD).
  - Provides `lookupOpeningByFen(fen)`, `lookupGameOpening(tree, targetNodeId?)`, and `formatOpeningBadge(opening)` to resolve the ECO code and opening name for any position or game path.
- `src/analysis/eval-bar.ts` *(new)*:
  - `EvalBar` component (`[data-testid="eval-bar"]`) with smooth CSS height transitions, mate-aware score formatting (`M2`, `-M2`, `+0.35`, `-1.20`), and sigmoid win% calculation (`scoreToWhiteWinPercent(score)`).
  - Automatically flips orientation with the board (`setFlipped(flipped)`): when unflipped (`White` at bottom), the White bar grows upward from the bottom; when flipped (`Black` at bottom), the White bar grows downward from the top.
- `src/analysis/threat-detector.ts` *(new)*:
  - `ThreatDetector` performing a null-move search (`adapter.move('--')` when not in check) on Stockfish to identify what the opponent is threatening (`from`, `to`, `uci`, `san`, `scoreWhite`, `evalCp`, `pv`).
  - Supports `AbortSignal` cancellation and immediately returns `null` when the side to move is in check or has no legal null-move continuation.
- `src/analysis/engine-lines-panel.ts` *(new)*:
  - `EngineLinesPanel` rendering 1–5 live Stockfish MultiPV lines (`[data-testid="engine-line-row-1"]`..`5`), converting UCI PV sequences into numbered SAN move tokens (`[data-testid="engine-pv-move-k-m"]`).
  - Emits hover callbacks (`onHoverLine`) so hovering a line or move token previews the continuation with faded "ghost" pieces on the board, and click callbacks (`onSelectLine`) so clicking a line or move token plays those moves into the `GameTree` as a variation.
- `src/analysis/position-editor.ts` *(new)*:
  - Interactive `PositionEditor` panel with live FEN validation (`validateChessFen`), piece placement palette (`w/b` × `P/N/B/R/Q/K`, trash/clear square, pointer mode), presets (`Start Position`, `Clear Board` / `Kings Only`), turn selector, castling rights checkboxes (`K`, `Q`, `k`, `q`), and en-passant target square selector.
- `src/render/overlay.ts` & `src/render/board-renderer.ts` *(modified)*:
  - Add dedicated overlay rendering for `bestMoveArrow` (`[data-testid="overlay-best-move-arrow"]`), `threatMoveArrow` (`[data-testid="overlay-threat-arrow"]`), `ghostMoveArrows` (`[data-testid="overlay-ghost-arrow"]`), and user-drawn arrows (`[data-testid="overlay-user-arrow"]`) & circles (`[data-testid="overlay-user-circle"]`) with modifier keys (`Green` default, `Shift` = `Red`, `Alt` = `Blue`, `Ctrl`/`Meta` = `Yellow`/Amber) and PGN `[%cal]` / `[%csl]` color mapping (`G`, `R`, `B`, `Y`).
  - Add a dedicated `.wc-ghost-pieces-layer` (`[data-testid="board-ghost-layer"]`) in `BoardRenderer` (`setGhostPreview(fenOrMoves)`): renders faded ghost pieces (`[data-testid="ghost-piece-<sq>"]`) via `transform: translate3d(...)` and dims vacated origin squares, updating transforms automatically in both board orientations (`flipped: false` and `flipped: true`).
  - Add an optional `onSquareEdit` callback on `BoardRenderer` for interactive square clicking when the Position Editor palette is active, and `onUserAnnotationsChange` so user-drawn arrows/circles sync to the active `GameNode` for PGN export.
  - Guard `window` event listeners in `BoardRenderer` with `if (!this.boardEl.isConnected) return;` so detached mode views remain completely inert.
- `src/analysis/analysis-controller.ts` *(new)*:
  - Full Phase 4 `AnalysisController` integrating `BoardRenderer`, `EvalBar`, `EngineLinesPanel`, `ThreatDetector`, `PositionEditor`, `GameTree` variation tree viewer/navigator, `OpeningLookup`, PGN import/export (`[%eval]`, `[%cal]`, `[%csl]`, NAGs, comments, nested variations), and keyboard controls (`←`/`→`, `↑`/`↓`, `Home`/`End`, `F`, `Space`).
- `src/app.ts` & `src/styles/main.css` *(modified)*:
  - Add a mode switcher (`[data-testid="mode-tab-play"]` and `[data-testid="mode-tab-analysis"]`, plus `"Analyze Game"` button in Play Mode) that swaps the active mode container cleanly in the DOM so all Phase 0–3 selectors remain unique when Play Mode is active, and expose `window.__wizardChessAnalysis`.
- `tests/unit/phase4-analysis.test.ts` & `tests/e2e/phase4.spec.ts` *(new)*:
  - Unit and E2E tests covering opening lookup, eval bar math & mate formatting, null-move threat detection, MultiPV line SAN formatting & variation insertion, FEN position editor validation, keyboard navigation (`←`/`→`/`↑`/`↓`/`Home`/`End`/`F`/`Space`), PGN import/export with `[%eval]`/`[%cal]`/`[%csl]`, and Playwright screenshot verification of arrows (user, best-move, threat), the eval bar, and ghost previews in both board orientations (`unflipped` and `flipped`).

#### Risks & Mitigations
1. **Risk — Playwright Strict-Mode Selector Collisions Between Play Mode and Analysis Mode**:
   - Both Play Mode and Analysis Mode use `BoardRenderer` (`data-testid="chess-board"`, `piece-e2`, `square-e4`). Keeping both mounted in `document` simultaneously would cause `page.getByTestId('chess-board')` in Phase 3 or Phase 4 tests to match 2 elements and fail Playwright strict mode.
   - *Mitigation*: Mount only the active mode's root container in the DOM (detaching the inactive mode container on mode switch) and guard `BoardRenderer`'s `window` listeners with `this.boardEl.isConnected`.
2. **Risk — Null-Move Threat Search Contending With Infinite MultiPV Analysis**:
   - Running an `infinite: true` MultiPV search and a background null-move threat search on the same single-worker `EngineClient` queue would either starve the threat search or cancel the MultiPV stream.
   - *Mitigation*: Route `ThreatDetector` to the secondary `EngineClient` instance (`botEngine`, which is idle during Analysis Mode) when available, and fall back to running the fast depth-8 threat search before the main MultiPV search when sharing a single engine client.
3. **Risk — Ghost Previews, Arrows, or Eval Bar Misaligning When Board Is Flipped**:
   - If ghost piece `translate3d` coordinates, SVG arrow coordinates, or eval bar fill direction do not recompute on `setFlipped(true)`, flipped orientation visuals will be inverted.
   - *Mitigation*: Centralize coordinate calculation through `squareToBoardCoords(sq, this.flipped)` for both regular and ghost pieces/arrows, update `EvalBar.setFlipped(flipped)` on every board flip, and verify both orientations visually with Playwright screenshots.

### 2. Phase 4 Technical Decisions, Screenshot Verification & Measured Performance Numbers

#### Technical Decisions & Architecture
- **Animated, Mate-Aware Eval Bar (`src/analysis/eval-bar.ts`)**:
  - Converts White-perspective centipawn evaluations to win percentage via the spec sigmoid formula $\text{Win\%} = 50 + 50 \cdot \left(\frac{2}{1 + e^{-0.00368208 \cdot \text{cp}}} - 1\right)$, clamping non-mate scores to `[4%, 96%]` so both colors remain visible while forced mates (`M1`, `-M2`, etc.) fill `100%` or `0%`.
  - Flips seamlessly with the board (`setFlipped(flipped)`): when unflipped (`White` at bottom), the White fill grows upward from `bottom: 0%` and Black from `top: 0%`; when flipped (`Black` at bottom), the White fill grows downward from `top: 0%` and Black from `bottom: 0%`, placing the score badge at the winning side's end of the bar.
- **MultiPV 1–5 Live Engine Lines, Ghost Piece Previews & Variation Insertion (`src/analysis/engine-lines-panel.ts`, `src/render/board-renderer.ts`)**:
  - Streams live Stockfish 17.1 WASM MultiPV lines (`1`–`5` selectable via `[data-testid="select-multipv"]`), converting UCI principal variations into numbered SAN move tokens (`[data-testid="engine-pv-move-k-m"]`) with `requestAnimationFrame`-throttled UI updates.
  - Hovering any engine line or specific move token computes the post-move board state and renders faded ghost pieces (`.wc-ghost-piece`, `opacity: 0.62` with arcane cyan glow) positioned via `transform: translate3d(...)`, dims vacated origin pieces (`.wc-piece-ghost-vacated`), and draws dashed ghost trajectory arrows (`[data-testid="overlay-ghost-arrow"]`) on the single SVG overlay layer.
  - Clicking any engine line or move token inserts the PV sequence up to that ply into the `GameTree` as a variation (`addMove(uci, { fromNodeId })`) and updates the interactive variation tree.
- **Null-Move Opponent Threat Arrow & Modifier-Key User Annotations (`src/analysis/threat-detector.ts`, `src/render/overlay.ts`)**:
  - `buildNullMoveFen` executes a null move (`adapter.move('--')`) when the side to move is not in check and the game is not over; `detectOpponentThreat` runs a depth-10 Stockfish search on the secondary worker (`botEngine`) in parallel with main MultiPV analysis to render the opponent's tactical threat as a dashed red arrow (`[data-testid="overlay-threat-arrow"]`) and badge (`Threat: Qxf7#`).
  - Right-click and right-drag draw circles and arrows in 4 modifier colors (`Green` `#22c55e` / `G` default, `Shift` = `Red` `#ef4444` / `R`, `Alt` = `Blue` `#38bdf8` / `B`, `Ctrl`/`Meta`/`Shift+Alt` = `Yellow` `#eab308` / `Y`), automatically syncing with the current `GameNode`'s `[%cal]` and `[%csl]` PGN annotations.
- **Opening Lookup (`src/analysis/opening-lookup.ts`)**:
  - Looks up 4-field normalized EPD keys in `data/openings.json` (`3,865` positions) and walks the `GameTree` lineage so the deepest known ECO code and opening name remain displayed as play continues past book lines.
- **Position Editor with Live FEN Validation (`src/analysis/position-editor.ts`)**:
  - Supports arbitrary piece placement/removal (`pointer`, `trash`, `wK..bP`), side-to-move, castling rights (`K`, `Q`, `k`, `q` with automatic pruning if kings/rooks leave home squares), en-passant square, presets (`Start Pos`, `Kings Only`, `Clear Board`), and live `validateChessFen` validation (blocking invalid positions such as missing kings, pawns on ranks 1/8, or opponent king in check).

#### Playwright Visual Screenshot Verification (Both Board Orientations)
Verified via Playwright screenshots (`phase4-analysis-unflipped.png` and `phase4-analysis-flipped.png`) and programmatic geometry assertions in `tests/e2e/phase4.spec.ts`:
- **Unflipped Orientation (`data-flipped="false"`, White at bottom)**:
  - Eval bar White fill anchored at `bottom: 0%`, Black fill at `top: 0%`, score badge (`-0.06`) at `top` (`data-position="top"`).
  - Best-move arrow (`g8 -> f6` green), Null-move threat arrow (`f3 -> f7` red dashed, `startCx = 550, startCy = 550` in `800x800` SVG viewBox), user-drawn Alt blue arrow (`c6 -> d4`, `startCx = 250, startCy = 250`), user circles (`f7` green, `c4` red), and hovered line ghost pieces (`Nf6`, `Ne2`, `Na5`) + ghost arrows all align with unflipped square coordinates (`ranks 8..1`, `files A..H`).
- **Flipped Orientation (`data-flipped="true"`, Black at bottom)**:
  - Eval bar White fill anchored at `top: 0%`, Black fill at `bottom: 0%`, score badge (`-0.11`) at `bottom` (`data-position="bottom"`).
  - All SVG arrows (`overlay-best-move-arrow`, `overlay-threat-arrow` at `startCx = 250, startCy = 250`, `overlay-user-arrow` at `startCx = 550, startCy = 550`, `overlay-ghost-arrow`), circles, and ghost piece `translate3d(...)` transforms rotate 180° (`800 - unflippedCoord`) in lockstep with the flipped squares (`ranks 1..8`, `files H..A`).

#### Known Issues & Deviations
- **Deviations**: None.
- **Known Issues**: None.

#### Measured Performance Numbers (Phase 4)
- **Unit Test Suite (`npm test`)**: **11 test files, 92 tests passing** in `10.48s` (`tests/unit/phase4-analysis.test.ts` runs in `125 ms`).
- **End-to-End Test Suite (`npm run test:e2e`)**: **7 E2E specs passing** (`phase0`, `phase1`, `phase2`, `phase3` × 3, `phase4`) in `19.0s` (`phase4.spec.ts` completes in `5.7s` with `0` external network requests and `0` console errors).
- **Production Bundle (`dist/`)**: JS `1,228.34 kB` (`198.49 kB` gzip, includes `data/openings.json` 3,865-position dictionary, `RulesAdapter`, `GameTree`, `PGN`, `WizardChessStorage`, `EngineClient`, `ChessBot`, `BoardRenderer`, and `AnalysisController`), CSS `24.05 kB` (`5.32 kB` gzip), precache `12 entries (15,296.19 KiB)`.


---

