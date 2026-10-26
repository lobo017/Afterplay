<!-- Archive of docs/PROGRESS.md lines 212-318 (verbatim). Phase 2 -->

## Phase 2 — Engine (Plan, Architecture & Verification)

### 1. Phase 2 Implementation Plan (Written Before Code)

#### Files to Add or Change
- `vite.config.ts` *(modified)*:
  - Add `stockfishAssetsPlugin` to serve `/stockfish/stockfish-17.1-lite-51f59da.js`, `/stockfish/stockfish-17.1-lite-51f59da.wasm` (multi-threaded Lite NNUE WASM), `/stockfish/stockfish-17.1-lite-single-03e3232.js`, and `/stockfish/stockfish-17.1-lite-single-03e3232.wasm` (single-threaded Lite NNUE WASM) from `node_modules/stockfish/src/` during `npm run dev` and emit them into `dist/stockfish/` during `npm run build` so `vite-plugin-pwa` precaches both engine variants for zero-network offline operation.
- `src/core/rules.ts` *(modified)*:
  - Fix `matchChess960CastleInput` so a 1-square king move onto `g1`/`c1` when the castling rook is on `h1`/`a1` (e.g. `f1g1` when King is on `f1` and Rook is on `h1`) is not hijacked as castling (`f1h1`), only matching `to === g1`/`c1` as castling when `to === rookSq` or `|toFile - kingFile| > 1`.
  - Fix `mapChessJsMove` in Chess960 mode so `after` reflects the post-move FEN when called from `verboseMoves()`.
  - Optimize Chess960 `perft()`, `undo()`, and rank-shielded castling checks to avoid redundant `new Chess()` / `this.chess.load()` allocations on every node.
- `src/engine/uci-parser.ts` *(new)*:
  - Complete UCI protocol parser covering `id`, `option`, `uciok`, `readyok`, `info` (depth, seldepth, multipv, `score cp` / `score mate` with upperbound/lowerbound, `wdl`, `nodes`, `nps`, `hashfull`, `tbhits`, `time`, `currmove`, `currmovenumber`, `pv`, and `info string`), `bestmove` (including `ponder` and `(none)`), and `go perft` divide/total lines (`<move>: <nodes>` and `Nodes searched: <total>`), plus score perspective normalization helpers.
- `src/engine/cache.ts` *(new)*:
  - `AnalysisCache` keyed by `(normalized FEN, depth, multipv)` with bounded LRU eviction, hit/miss counters, hit-rate calculation, and telemetry hook for `DevOverlayController`.
- `src/engine/engine-client.ts` *(new)*:
  - `EngineClient` implementing UCI over Web Worker (with pluggable `EngineTransport` for Node child-process Stockfish and unit-test mocks).
  - Cross-origin isolation detection (`window.crossOriginIsolated` + `SharedArrayBuffer`) with automatic selection of multi-threaded vs single-threaded Stockfish Lite WASM and runtime fallback if multi-threaded initialization fails.
  - Thread and hash auto-configuration (`Threads`, `Hash`, `MultiPV` 1–5, `UCI_Chess960`, `Skill Level`, `UCI_LimitStrength`, `UCI_Elo`).
  - Priority queue (`live` > `review` > `background`), streaming `info` callbacks, `AbortSignal` / task ID cancellation that synchronizes on `stop` $\rightarrow$ `bestmove` before starting the next search, result caching, and `perft()` execution.
- `src/engine/bot.ts` *(new)*:
  - `ChessBot` and human-like candidate move selector covering ratings `400–2400` across tiers `Novice` (600), `Casual` (1000), `Club` (1400), `Expert` (1800), and `Master` (2200), plus style presets (`aggressive`, `solid`, `gambiteer`).
  - Combines Stockfish `UCI_Elo` / `Skill Level` with a Boltzmann-weighted MultiPV candidate selector that weights top engine lines by centipawn loss, caps absurd blunders when plausible mistakes exist, scales randomness with target rating, and applies style biases.
- `src/app.ts` & `src/styles/main.css` *(modified)*:
  - Expose `EngineClient`, `ChessBot`, `AnalysisCache`, and UCI parser on `window.__wizardChessEngine` and wire live engine telemetry into `DevOverlayController` while preserving all Phase 0 and Phase 1 selectors and tests.
- `tests/unit/uci-parser.test.ts`, `tests/unit/engine-client.test.ts`, `tests/unit/bot.test.ts`, `tests/unit/perft-crosscheck.test.ts` *(new)*:
  - Unit tests for UCI output parsing, `EngineClient` priority queue/cancellation/caching/MultiPV, `ChessBot` rating tiers & style presets, and the Stockfish `go perft` vs `RulesAdapter.perft` cross-check suite (standard startpos, Kiwipete, 10+ Chess960 start positions, and hand-built Chess960 castling edge cases) with strict per-test timeouts.
- `tests/e2e/phase2.spec.ts` *(new)*:
  - Playwright E2E test under `npm run serve` verifying that BOTH single-threaded (`stockfish-17.1-lite-single-03e3232.js`) and multi-threaded (`stockfish-17.1-lite-51f59da.js`) Stockfish WASM builds load with zero external network requests, recording which variant is active by default and measuring NPS for both, and confirming the engine finds a forced mate-in-2 and wins a hanging piece.

#### Risks & Mitigations
1. **Risk — Multi-Threaded Stockfish Worker Pthread Path Resolution**:
   - `stockfish-17.1-lite-51f59da.js` spawns pthreads by loading itself with `#<wasmUrl>,worker` hash and resolves `.wasm` by replacing `.js` with `.wasm` on `location.pathname`.
   - *Mitigation*: Serve the unmodified `stockfish-17.1-lite-51f59da.js` and `.wasm` pair from `/stockfish/` with `COOP: same-origin`, `COEP: require-corp`, and `CORP: same-origin` headers rather than bundling the worker through Rollup.
2. **Risk — UCI State Desynchronization on Cancelled Searches**:
   - Sending `position` and `go` immediately after `stop` before Stockfish emits `bestmove` for the aborted search causes the old `bestmove` to be misattributed to the new search.
   - *Mitigation*: `EngineClient` transitions an aborted active task into a `stopping` state and waits for the corresponding `bestmove` line before dispatching the next queued task.
3. **Risk — Perft Cross-Check Performance or Stalls**:
   - Unoptimized FEN serialization or `npx` network prompts can cause slow or stalled test runs.
   - *Mitigation*: Optimize `RulesAdapter` Chess960 perft/undo in-place, reuse a persistent Stockfish child process across the perft cross-check suite, and enforce explicit per-test timeouts (`15_000 ms`–`30_000 ms`) on every test case.

### 2. Phase 2 Technical Decisions, RulesAdapter Fixes & Measured Performance Numbers

#### Technical Decisions & Architecture
- **Dual-Variant Stockfish 17.1 Lite NNUE WASM (`vite.config.ts`, `src/engine/engine-client.ts`)**:
  - Added `stockfishAssetsPlugin` in `vite.config.ts` to serve both `stockfish-17.1-lite-51f59da.{js,wasm}` (multi-threaded) and `stockfish-17.1-lite-single-03e3232.{js,wasm}` (single-threaded) directly from `node_modules/stockfish/src/` during `npm run dev` and emit them into `dist/stockfish/` during `npm run build` where Workbox (`vite-plugin-pwa`) precaches all 4 files (`14.19 MiB` total precache).
  - `EngineClient` inspects `detectEngineCapabilities()` (`window.crossOriginIsolated` + `SharedArrayBuffer`) and selects `multi-threaded` by default when isolated (auto-configuring `Threads = clamp(1, 4, floor(hardwareConcurrency / 2))` and `Hash = 64 MB`) or falls back to `single-threaded` (`Threads = 1`, `Hash = 32 MB`) if isolation is unavailable or if the multi-threaded Worker fails during startup handshake.
- **Priority Queue & Synchronized Cancellation (`src/engine/engine-client.ts`)**:
  - Implements a 3-tier priority queue (`live` > `review` > `background`).
  - When an active search is cancelled via `AbortSignal` or `cancel(taskId)`, `EngineClient` transitions the active task to `stopping`, sends `stop` once, rejects the caller's promise immediately with `EngineCancelledError`, and waits for Stockfish's corresponding `bestmove` line (followed by an `isready` $\rightarrow$ `readyok` barrier) before starting the next queued search so stale `info`/`bestmove` output never leaks into subsequent requests.
- **LRU Position Cache (`src/engine/cache.ts`)**:
  - `AnalysisCache` keys entries by `(normalizeFenForCache(fen), multipv)` where `normalizeFenForCache` keeps the 4 positional FEN fields (`board turn castling ep`). A cached entry with `cached.depth >= requestedDepth` and `cached.multipv >= requestedMultipv` satisfies the query and replays the top `multipv` lines to `onInfo` without re-searching.
- **Human-Like Bot Across 400–2400 Elo (`src/engine/bot.ts`)**:
  - Supports 5 rating tiers (`Novice` 400–799, `Casual` 800–1199, `Club` 1200–1599, `Expert` 1600–1999, `Master` 2000–2400) and 3 style presets (`aggressive`, `solid`, `gambiteer`).
  - Combines Stockfish's `Skill Level` (`0–20`) and `UCI_LimitStrength` / `UCI_Elo` (`1320–2400`) with a Boltzmann-weighted candidate selector (`selectHumanLikeMove`) over MultiPV lines (`multipv = 4–5`), filtering out catastrophic blunders when plausible minor mistakes exist and applying style bonuses (checks/captures/king-zone attacks for `aggressive`, development/castling/safety for `solid`, contested central advances and sacrifices for `gambiteer`).

#### RulesAdapter Bugs Found & Fixed via Perft Cross-Check (`src/core/rules.ts`)
1. **Chess960 1-Square King Move onto `g1`/`c1` Hijacked as Castling (`matchChess960CastleInput`)**:
   - *Bug*: When a King started on `f1` and the kingside castling rook was on `h1` (e.g. `1r3k1r/pppppppp/8/8/8/8/PPPPPPPP/1R3K1R w HBhb - 0 1`), `matchChess960CastleInput` matched `to === 'g1'` as kingside castling (`O-O`) even when `from === 'f1'` was a 1-square king step and the rook was on `h1`. Consequently, calling `adapter.move('f1g1')` executed `O-O` (`f1h1`) instead of `Kg1`.
   - *Fix*: `to === 'g1'` / `'c1'` (`'g8'` / `'c8'`) now matches castling only when `to === rookSq` (king captures own rook on `g1`/`c1`) or `Math.abs(toFile - kingFile) > 1` (standard 2+ square castling jump). Added an explicit unit test in `tests/unit/rules.test.ts` and cross-checked in `tests/unit/perft-crosscheck.test.ts`.
2. **`verboseMoves()` Post-Move `after` FEN in Chess960 Mode (`mapChessJsMove`)**:
   - *Bug*: `mapChessJsMove` set `after: this.fen()`, which was only post-move when called inside `this.move()`, whereas inside `verboseMoves()` `this.fen()` returned the *pre-move* FEN in Chess960 mode.
   - *Fix*: `mapChessJsMove` now computes the post-move Chess960 castling rights via `computeC960StateAfterRegularMove(m)` and serializes `m.after` with the updated Shredder/X-FEN castling token.
3. **Chess960 `perft()` Performance & `chess.load()` History Preservation**:
   - *Optimization*: In `RulesAdapter.perft()`, depth-1 leaf counts now use `this.chess.perft(1) + castlingCount` directly without executing/undoing each leaf move; subtrees where all castling rights are exhausted delegate directly to `this.chess.perft(depth)`; castled child branches run on a lightweight child `RulesAdapter` so `this.chess.load()` never wipes `this.chess._history` mid-tree; and `canChess960Castle()` scans back-rank ray attacks directly instead of allocating a temporary `new Chess()` on every castling check.

#### Stockfish Verification Under `npm run serve` (Both Variants)
Verified in Chromium via `tests/e2e/phase2.spec.ts` served by `scripts/serve.mjs` (`http://127.0.0.1:4173`) with `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` and **zero external network requests**:
- **Active Default Variant**: **`multi-threaded`** (`crossOriginIsolated: true`, `sharedArrayBufferAvailable: true`, `hardwareConcurrency: 8`, auto-configured `Threads: 4`, `Hash: 64 MB`).
- **Multi-Threaded Stockfish (`stockfish-17.1-lite-51f59da.js` + `.wasm`, 4 threads)**:
  - Engine ID: `Stockfish 17.1 Lite WASM Multithreaded`
  - Benchmark (`startpos`, depth 12, MultiPV 2): **`1,767,959` – `2,358,573` NPS** (`~1.77–2.36 MN/s`, `130,829–176,893` nodes in `74–89 ms`; peak telemetry during depth-8 bot search: **`3,809,700` – `4,864,900` NPS**).
- **Single-Threaded Stockfish (`stockfish-17.1-lite-single-03e3232.js` + `.wasm`, 1 thread)**:
  - Engine ID: `Stockfish 17.1 Lite WASM`
  - Benchmark (`startpos`, depth 12, MultiPV 1): **`347,377` – `372,190` NPS** (`~347–372 kN/s`, `15,632` nodes in `42–45 ms`).
- **Tactical & Bot E2E Verification (`tests/e2e/phase2.spec.ts`)**:
  - **Mate-in-2** (`r2qkb1r/pp2nppp/3p4/2pNN1B1/2BnP3/3P4/PPP2PPP/R2bK2R w KQkq - 1 1`): Finds `d5f6` (`1. Nf6+ gxf6 2. Bxf7#`) with `{ type: 'mate', value: 2 }`.
  - **Hanging Piece** (`r1b1kbnr/pppp1ppp/2n5/4p3/3qP3/5N2/PPP2PPP/RNBQKB1R w KQkq - 0 4`): Finds `f3d4` (`Nxd4` winning the undefended Queen) with `+566 cp`.
  - **Human-Like Bot (`Master` tier)**: Plays `Nxd4` (`f3d4`).

#### Perft Cross-Check Suite (`tests/unit/perft-crosscheck.test.ts`)
- **29 tests** comparing `RulesAdapter.perft` and move-by-move root divide counts against Stockfish 17.1 WASM `go perft` (with `UCI_Chess960` enabled for Chess960 positions) with strict per-test timeouts (`15s`–`30s`):
  - **Standard Positions (2 tests)**: Standard Start Position (depths 1–4: `20 / 400 / 8,902 / 197,281`) and Kiwipete (depths 1–3: `48 / 2,039 / 97,862`).
  - **Chess960 Starting Positions (12 tests)**: SP `#000`, `#057`, `#125`, `#198`, `#284`, `#351`, `#442`, `#518`, `#619`, `#734`, `#840`, `#959` tested to depth 3, with SP `#000`, `#198`, and `#959` tested to **depth 4** (`671,625` nodes across the three depth-4 Chess960 trees).
  - **Hand-Built Chess960 Castling Edge Cases (15 tests, depths 1–3)**:
    - Transit square (`d1`/`f1`) attacked by enemy rook/bishop while King and Rook are safe.
    - Destination square (`g1`/`c1`/`g8`) attacked by enemy knight or pawn.
    - Castling while King is in check (forbidden).
    - Rook start square attacked by enemy bishop while King path is safe (allowed).
    - Rook transit square (`b1`) attacked while King path (`e1`$\rightarrow$`c1`) is safe (allowed).
    - Castling rook on `f1` shields King on `e1` from enemy rook on `h1` along the 1st rank (`O-O-O` exposes King to check along rank 1 $\rightarrow$ forbidden; `O-O` captures/blocks inside $\rightarrow$ allowed).
    - Castling rook on `d1` shields King on `e1` from enemy queen on `a1` along the 1st rank (`O-O` exposes King to check $\rightarrow$ forbidden; `O-O-O` moves King to `c1` and Rook to `d1`, maintaining the shield $\rightarrow$ allowed).
    - King on `f1` and Rook on `g1` swap squares during `O-O` (`f1`$\leftrightarrow$`g1`).
    - King on `g1` stays on `g1` while Rook on `h1` jumps to `f1` during `O-O`.
    - King on `e1` jumps to `g1` while Rook on `f1` stays on `f1` during `O-O`.
    - King on `c1` stays on `c1` while Rook on `a1` jumps to `d1` during `O-O-O`.
    - King on `b1` and Rook on `a1` swap/jump (`b1`$\rightarrow$`c1`, `a1`$\rightarrow$`d1`) during `O-O-O`.
    - Black Chess960 mirror (`1r3kr1/pppppppp/8/8/8/8/PPPPPPPP/1R3KR1 b GBgb - 0 1`) with `f8`$\leftrightarrow$`g8` swap.
    - Non-castling rook on `f1` blocking `O-O` with outer castling rook on `h1`.
    - 1-square King step `f1g1` (`Kg1`) vs castling `f1h1` (`O-O`) when King is on `f1` and castling rook is on `h1`.
- **Total Perft Cross-Check Execution Time**: **~9.08s** for all 29 tests.

#### Known Issues
- None.

---

