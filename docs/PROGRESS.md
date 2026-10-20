# Wizard's Chess — Progress & Engineering Log

## Phase Status

| Phase | Name | Status | Summary |
|-------|------|--------|---------|
| **Phase 0** | Audit and scaffold | **Done** | Legacy audit from `legacy/index.html` (3D Gothic Cathedral Edition), Vite + TS strict scaffold, GPL-3.0 licensing, dataset scripts & generated data (`openings.json`, `puzzles.json`, `endgames.json`) |
| **Phase 1** | Core | **Done** | Rules adapter (`chess.js` + Chess960 + perft), game tree, adversarial PGN parser/writer (`[%eval]`, `[%cal]`, `[%csl]`), IndexedDB v1$\rightarrow$v2$\rightarrow$v3 migrations |
| **Phase 2** | Engine | **Done** | Stockfish 17.1 WASM worker client (MT + ST), MultiPV 1–5, priority queue, LRU cache, human-like bot (400–2400), Stockfish `go perft` cross-check suite |
| **Phase 3** | 2D board and play mode | **Done** | Imperative SVG board (`translate3d` + Web Animations API), dirty-checked SVG overlay, 180-shard fixed `<canvas>` pool, Web Audio synth, clocks, vs-bot Play Mode, legacy bug regression suite. **2026-10-17 fixes:** drags survive board updates, drag cancel (right-click / Esc / off-board), premove queue (max 10) on a hypothetical board, same-frame premove execution |
| **Phase 4** | Analysis board | **Done** | Animated mate-aware eval bar, live MultiPV 1–5 lines + ghost preview, best/threat/user arrows, variation tree & keyboard navigation, FEN position editor, ECO opening lookup. **2026-10-17 fixes:** zero layout shift while navigating (was 694 shifts), ~100 ms step animation with reverse and snap-on-repeat, engine lines batched to ≤ 1 DOM update per frame |
| **Phase 5** | Game review | **Done** | MultiPV 2 review pipeline on its own 1-thread engine with verification searches, win%/accuracy/ACPL/performance formulas, 10 move classes (docs/classification.md), 8 motif detectors, one-sentence explanations computed in a worker, review panel (live win% chart, key moments, Retry / Refutation / Play vs Bot / annotated PGN, sample game). **2026-10-18:** Lichess-matched formulas and thresholds; "Review as" White / Black / Both perspective and redesigned summary |
| **Phase 5b** | Capture extension + Games list | **Done** | Chrome MV3 capture extension (Lichess, Chess.com, queue, popup, backfill), localhost bridge, Games list with background review queue, IndexedDB v4. **2026-10-19 live capture fixes:** end of game from the sites' own data (Lichess game stream, Chess.com game data), finished games captured on open and on leaving the page, Chess.com play pages, background sync of recent games, delivery without focus, Debug this tab, local dates |
| **Phase 6** | Puzzles & spaced repetition | **Done** | Personal mistake puzzles, bundled 20k Lichess puzzles, Glicko-2, FSRS scheduler, Today screen |
| **Phase 6b** | UX redesign | **In progress** | Audit done; board feel (lift on press, drop tolerance and glide, touch offset, cursors, larger hints, resizable board) with live tuning (approved, defaults kept); board badges. Layout proposal written; waiting for approval |
| **Phase 7** | Repertoire, endgame & visualization | Pending | White/Black repertoire trees, 6 curated endgame drills, coordinate/blindfold/guess-the-move |
| **Phase 8** | Library, insights, settings, offline | Pending | Auto-save library, worker bulk PGN import, insights charts, a11y, full offline PWA |
| **Phase 9** | Performance pass & final audit | Pending | Frame-time/memory/startup profiling against budgets and full spec verification |

---

## Phase 0 — Audit and Scaffold

### 1. Legacy Audit (`legacy/index.html` — *Wizard's Chess 3D: Gothic Cathedral Edition*)

> **Note on Audit Revision:** The initial Phase 0 audit was written before `legacy/index.html` existed in the repository, and an intermediate revision audited a test-bench file that had been placed in `legacy/` by mistake. The audit below replaces both and is based strictly on the actual 3,130-line (`126,322`-byte) original `legacy/index.html` (*"Wizard's Chess 3D — Gothic Cathedral Edition"*).

#### Overview of `legacy/index.html`
- A single-file 3D chess application (`3,130` lines) built with Three.js (`r128`), `OrbitControls`, GSAP (`3.12.5`), `chess.js` (`0.10.3`), Tailwind CDN, a procedural Web Audio API synthesizer (`CathedralAudioEngine`), procedural 2D canvas marble/obsidian textures, a Three.js `InstancedMesh` capture shatter particle pool (`PooledShatterSystem`), and an inline Blob Web Worker running a 1–5 ply Alpha-Beta + Quiescence search calibrated to 400–2400 Elo.

#### What to Port into the New Architecture

1. **Procedural Web Audio Synthesizer (`CathedralAudioEngine`, lines `478–664`) $\rightarrow$ Port to `src/render/audio.ts` (Phase 3)**:
   - **Initialization (`init()`, lines `484–492`)**:
     - Lazily instantiates `window.AudioContext || window.webkitAudioContext` on the first user gesture and calls `this.ctx.resume()` when `this.ctx.state === 'suspended'`.
     - *Phase 3 addition*: Route all synth outputs through a master `GainNode` wired to a persistent volume slider (`0.0–1.0`) in addition to the mute toggle (`this.enabled`).
   - **`playSelect()` (lines `494–513` — piece selection chime)**:
     - Waveform: `sine` oscillator.
     - Frequency sweep: `528 Hz` at `now` $\rightarrow$ exponential ramp to `792 Hz` at `now + 0.14s` (a $3:2$ perfect fifth).
     - Gain envelope: `0.11` at `now` $\rightarrow$ exponential ramp to `0.001` at `now + 0.16s`; oscillator stops at `now + 0.17s`.
   - **`playSlide(isLevitate = false)` (lines `515–579` — piece movement)**:
     - **Levitation branch (`isLevitate === true`, lines `521–537`, used for Knights, Bishops, and Queens)**:
       - Waveform: `triangle` oscillator (ethereal arcane hum).
       - Frequency contour: `190 Hz` at `now` $\rightarrow$ exponential ramp to `280 Hz` at `now + 0.25s` $\rightarrow$ exponential ramp to `160 Hz` at `now + 0.55s`.
       - Gain envelope: `0.01` at `now` $\rightarrow$ linear ramp to `0.12` at `now + 0.18s` $\rightarrow$ exponential ramp to `0.001` at `now + 0.58s`; stops at `now + 0.60s`.
     - **Stone slide + thud branch (`isLevitate === false`, lines `538–578`, used for Pawns, Rooks, and Kings)**:
       - **Grinding stone noise (`lines 540–565`)**: `0.45s` mono `AudioBuffer` (`sampleRate * 0.45`) filled with white noise `(Math.random() * 2 - 1) * 0.6`, passed through a `bandpass` `BiquadFilterNode` (`frequency`: `140 Hz` at `now` $\rightarrow$ linear ramp to `210 Hz` at `now + 0.35s`; `Q.value = 2.2`) and `GainNode` (`0.01` at `now` $\rightarrow$ linear ramp to `0.22` at `now + 0.08s` $\rightarrow$ exponential ramp to `0.005` at `now + 0.44s`). *(In Phase 3, pre-allocate and reuse the white-noise `AudioBuffer` once on `AudioContext` init instead of regenerating per move.)*
       - **Settling stone thud (`lines 567–577`)**: `sine` oscillator starting at `now + 0.36s`, frequency `95 Hz` $\rightarrow$ exponential ramp to `38 Hz` at `now + 0.52s`, `thudGain` `0.24` at `now + 0.36s` $\rightarrow$ exponential ramp to `0.001` at `now + 0.54s`; stops at `now + 0.55s`.
   - **`playShatter()` (lines `581–619` — capture impact & stone fracture)**:
     - **1. Heavy impact bass boom (`lines 588–599`)**: `sawtooth` oscillator at `130 Hz` (`now`) $\rightarrow$ exponential ramp to `28 Hz` (`now + 0.45s`); `boomGain` `0.35` (`now`) $\rightarrow$ exponential ramp to `0.001` (`now + 0.48s`); stops at `now + 0.50s`.
     - **2. Crystalline / stone fracture bursts (`lines 601–618`)**: `9` staggered oscillators (`i = 0..8`), each delayed by `delay = i * 0.038 + Math.random() * 0.025` s:
       - Waveform: alternates `i % 2 === 0 ? 'triangle' : 'sine'`.
       - Frequency: `baseFreq = 700 + Math.random() * 1900` Hz at `now + delay` $\rightarrow$ exponential ramp to `baseFreq * 0.45` at `now + delay + 0.14s`.
       - Gain: `0.14 / (1 + i * 0.25)` at `now + delay` $\rightarrow$ exponential ramp to `0.001` at `now + delay + 0.15s`; stops at `now + delay + 0.16s`.
   - **`playCheck()` (lines `621–640` — cathedral tubular bell alert)**:
     - 3 `sine` oscillators at `[440, 466.16, 880]` Hz (`A4`, `Bb4` minor second dissonance, `A5` octave), staggered by `idx * 0.04s`.
     - Gain: `0.15` at `now + idx * 0.04s` $\rightarrow$ exponential ramp to `0.0008` at `now + 1.1s`; stops at `now + 1.15s`.
   - **`playGameOver(victory = true)` (lines `642–661` — endgame chord)**:
     - 4 `triangle` oscillators staggered by `i * 0.12s`:
       - `victory === true`: C-major arpeggio `[261.63, 329.63, 392.00, 523.25]` Hz (`C4, E4, G4, C5`).
       - `victory === false`: A-minor / harmonic inflection `[220.00, 261.63, 329.63, 415.30]` Hz (`A3, C4, E4, Ab4`).
     - Gain: `0.12` at `now + i * 0.12s` $\rightarrow$ exponential ramp to `0.0008` at `now + 2.0s`; stops at `now + 2.05s`.

2. **Visual Theme Colors, Materials & Procedural Textures (`lines 23–163`, `1000–1078`, `1181–1506`, `2007–2109`) $\rightarrow$ Port to `src/styles/` & `src/render/` (Phase 3)**:
   - **Cathedral Dark Glass HUD & Chrome (`lines 41–96`, `1113`, `162`)**:
     - App background: `#07080c` (`body, html`), scene backdrop `#06080e`, radial vignette `rgba(3, 5, 10, 0.68)` at edges, primary text `#f1f5f9`.
     - `.md-glass`: `background: rgba(15, 18, 26, 0.78)`, `backdrop-filter: blur(16px)`, `border: 1px solid rgba(255, 255, 255, 0.11)`, `box-shadow: 0 12px 32px -4px rgba(0, 0, 0, 0.6), 0 2px 6px rgba(0, 0, 0, 0.4)`.
     - `.md-glass-subtle`: `background: rgba(22, 26, 38, 0.65)`, `backdrop-filter: blur(12px)`, `border: 1px solid rgba(255, 255, 255, 0.08)`.
     - `.md-chip-active`: fill `rgba(245, 158, 11, 0.22)`, border `rgba(245, 158, 11, 0.65)`, text `#fcd34d`; range slider thumb `#f59e0b` with `2px solid #fffbeb` border and `0 0 10px rgba(245, 158, 11, 0.6)` glow.
   - **Marble & Obsidian Board Surface Palette (`createMarbleTexture`, lines `1000–1078`, `1181–1381`)**:
     - **Light Squares (Veined Marble)**: base `#f2ede4`, mineral grain `rgba(150, 140, 125, 0..0.075)`, `14` organic veins in `rgba(110, 102, 90, 0.09..0.23)`, inner chamfer highlight `rgba(255, 255, 255, 0.65)`, inner frame line `rgba(120, 105, 85, 0.35)`, outer tile seam `rgba(8, 10, 15, 0.85)`.
     - **Dark Squares (Volcanic Obsidian)**: base `#121620`, mineral grain `rgba(255, 255, 255, 0..0.03)`, `10` arcane violet veins in `rgba(139, 92, 246, 0.07..0.18)` (`#8b5cf6`), inner chamfer `rgba(148, 163, 184, 0.22)`, inner gold hairline `rgba(212, 175, 55, 0.22)`, outer tile seam `rgba(8, 10, 15, 0.85)`.
     - **Board Frame, Grout & Inlays**: outer bronze trim `#926c2c`, dark stone frame `#161922`, carved stone `#1f2430`, recessed grout bed `#090b10`, inlaid brass/gold grid dividers `#c59b27` (emissive `#785610`), and `#d4af37` gold `A–H` / `1–8` coordinates.
   - **Marble & Obsidian Piece Palette (`lines 1475–1505`)**:
     - **White Pieces (Marble & Gold)**: body `#f8f5f0` with subtle `#38bdf8` cool sheen; trim/accents `#d4af37` metallic gold.
     - **Black Pieces (Obsidian & Arcane Amethyst)**: body `#161925` with `#9333ea` emissive sheen; trim/accents `#a855f7` purple (emissive `#7e22ce`, turn gem `#a855f7` glow).
   - **Board Markers & Highlights (`lines 1436–1468`, `2007–2109`)**:
     - Selected square ring: `#fbbf24` (`opacity: 0.90`).
     - Hover square highlight: `#38bdf8` (`opacity: 0.22`).
     - Last-move square highlight: `#f59e0b` (`opacity: 0.25`).
     - Legal move dot: `#38bdf8` (`opacity: 0.82`); legal capture ring: `#ef4444` (`opacity: 0.88`).
     - King-in-check halo & badge: `#ef4444` (`opacity: 0.85`, pulsing `1.4s`).
     - Queued premove squares: `#10b981` (`opacity: 0.26` origin / `0.42` target), target ring `#34d399` (`opacity: 0.95`), and premove target dots `#10b981` (`opacity: 0.65`).
   - **Fixed-Pool Capture Shatter Physics (`PooledShatterSystem`, lines `1696–1871`)**:
     - Fixed pool of `180` shards (`54` triggered per capture: $2/3$ piece-colored stone fragments `#f8f5f0`/`#161925`, $1/3$ glowing `#f59e0b` embers) with radial + attacker-direction impulse, gravity, surface bounce (`restitution: 0.42`, `friction: 0.72`), and scale fade over the final `35%` of life (`1.25–2.10s`) — to port as a zero-allocation 2D `<canvas>` particle pool in Phase 3.
   - **Bot Rating Tiers (`lines 265–286`, `898–910`, `2885–2891`)**:
     - 5 rating presets across `400–2400` Elo (`Novice` 600, `Casual` 1000, `Club` 1400, `Expert` 1800, `Master` 2200) and candidate perturbation concept — to combine with Stockfish `UCI_Elo` / `Skill Level` and MultiPV weighting in Phase 2.

#### Concrete Bugs Found in `legacy/index.html`
1. **Runtime CDN Requests Break Offline Operation (`lines 9–20`, `674`)**:
   - Loads Tailwind CSS (`cdn.tailwindcss.com`), Google Fonts (`fonts.googleapis.com`), `three.min.js`, `OrbitControls.js`, `gsap.min.js`, and `chess.min.js` (both in `<head>` at line `20` and inside the Web Worker via `importScripts(...)` at line `674`) over the internet at runtime. With network disabled, the app cannot render, animate, validate moves, or start the AI worker.
2. **Pawn Drag-Promotion Leaves Mesh Floating & Modal Uncancellable (`lines 411–434`, `2494–2498`, `2588–2590`, `2637–2654`)**:
   - Dragging a pawn onto the promotion rank sets the mesh position to `y = 0.85` with velocity tilt (`lines 2588–2590`) and calls `attemptMoveOrPremove(startSq, dropSq, true)` (`line 2637`). When `matchingMoves[0].promotion` is truthy (`line 2494`), `attemptMoveOrPremove` opens `#promotion-modal` and returns `true` (`line 2497`), skipping the snap-back block (`line 2640`). The pawn stays frozen in mid-air while the modal is open, and `#promotion-modal` has no close/cancel button, backdrop click handler, or `Escape` key handler.
3. **Premove Promotion Hardcoded to Queen (`lines 1912–1920`, `2507–2511`)**:
   - `getPremoveTargetsForSquare` (`line 1918`) and `attemptMoveOrPremove` (`line 2510`) hardcode `promotion: 'q'` for all promotion premoves, making underpromotion impossible when premoving.
4. **In-Flight AI Worker Race Condition Across "New Game" / Color Switch (`lines 2371–2403`, `2943–2966`)**:
   - Starting a new game or switching colors while `isBotThinking === true` resets `isBotThinking = false` (`line 2952`) without cancelling the worker search or checking a game/request generation ID in `aiWorker.onmessage` (`line 2385`). When the stale worker search finishes, its `setTimeout` callback overwrites `#telemetry-depth`, `#telemetry-nodes`, and the eval bar (`lines 2395–2397`) and, if `chess.turn() !== playerColor` (e.g., after clicking "Play as Black"), executes the stale move from the previous position if legal (`line 2399`).
5. **Captured Pieces Tray Miscounts Promoted Pawns (`lines 2754–2783`)**:
   - `updateHUD()` computes captured pieces as `Math.max(0, startCounts[t] - currentCounts[color][t])` (`lines 2778, 2781`). When a pawn promotes to a Queen, `currentCounts[color].p` decreases by 1 even though the pawn was promoted rather than captured, falsely adding a shattered pawn icon to the opponent's capture tray (and masking captures of promoted pieces).
6. **Stale Evaluation Bar After Undo (`lines 2989–3006`)**:
   - Clicking `#undo-btn` reverts the moves on the board and updates the move list, but never updates `#eval-score` or `#eval-bar-white`, leaving the undone position's evaluation displayed.
7. **Three.js Geometry & Material GPU Memory Leak (`lines 1974–1999`, `2002–2091`, `2208`)**:
   - `updateBoardMarkers()` (called on every click, move, premove, and right-click) and `syncBoardMeshesFromState()` (called on Undo and New Game) remove meshes from the scene and allocate new `PlaneGeometry`, `RingGeometry`, `CircleGeometry`, `LatheGeometry`, and `MeshBasicMaterial` instances without calling `.dispose()`, leaking WebGL buffers over consecutive games.

#### Performance Hotspots Found in `legacy/index.html`
1. **Perpetual 60 FPS WebGL Render Loop When Idle (`animate()`, lines `3077–3120`)**:
   - Runs `requestAnimationFrame(animate)` unconditionally forever, updating 4 `PointLight` intensities, mutating all `260` dust particle vertices (`posAttr.needsUpdate = true` uploading to the GPU every frame), iterating all `180` shatter shard slots even when `0` shards are active (`shatterSystem.update(dt)`), and rendering the full shadow-mapped (`2048x2048` `PCFSoftShadowMap`) 3D cathedral scene every frame when nothing on the chessboard is changing.
2. **Unthrottled Recursive 3D Raycasting on Every `pointermove` Event (`lines 2446–2467`, `2560–2619`)**:
   - Whenever the pointer moves while not dragging (`line 2607`), `getHoveredSquare(e.clientX, e.clientY, false)` allocates a new array `[...tileMeshes, ...piecesGroup.children]` (`line 2452`) and runs `raycaster.intersectObjects(targets, true)` across all 64 tiles and all 32 multi-mesh 3D piece groups on every raw `pointermove` event.
3. **Full Move History DOM Rebuild via `.innerHTML` on Every Move (`updateHUD()`, lines `2813–2838`)**:
   - Calls `chess.history({ verbose: true })` and regenerates the entire `#move-history-container.innerHTML` HTML string from move 1 on every half-move instead of incrementally appending/updating move nodes.
4. **Per-Move Main-Thread `AudioBuffer` Allocation & PRNG Loop (`playSlide()`, lines `540–545`)**:
   - Allocates a fresh `0.45s` `AudioBuffer` (`~20,000` floats) and populates it with `Math.random()` on the UI thread on every non-levitating move instead of reusing a cached noise buffer.

---

### 2. Phase 0 Implementation Plan & Decisions

#### Files Added / Changed
- `docs/PROGRESS.md`: Engineering log, legacy audit from `legacy/index.html`, Phase 0 plan, decisions, and verification metrics.
- `package.json`: Strict dependency manifest using only spec-approved packages (`chess.js`, `stockfish`, `idb`, `preact`, `vite`, `typescript`, `vite-plugin-pwa`, `vitest`, `@playwright/test`, `eslint`, `@eslint/js`, `typescript-eslint`, `prettier`, `@types/node`) and scripts (`dev`, `build`, `serve`, `typecheck`, `lint`, `test`, `test:e2e`, `data:openings`, `data:puzzles`, `data:endgames`, `data:all`).
- `tsconfig.json`, `vite.config.ts`, `vitest.config.ts`, `playwright.config.ts`, `eslint.config.js`, `.prettierrc.json`: Strict TypeScript, Vite + PWA + COOP/COEP headers, Vitest, Playwright, ESLint v9 flat config, and Prettier.
- `LICENSE` & `LICENSES/`: Full `GPL-3.0-or-later` license in root `LICENSE`, plus `LICENSES/README.md` and license texts documenting every dependency and CC0 dataset.
- `README.md`: Run modes (`dev`, `build`, `serve`), explanation of why `file://` is unsupported, and dataset generation instructions.
- `scripts/serve.mjs`: Local static HTTP server for `dist/` setting `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` headers.
- `scripts/build-openings.mjs`: Fetches `a.tsv`–`e.tsv` from `lichess-org/chess-openings`, replays moves via `chess.js` to compute normalized 4-field EPD keys, and writes `data/openings.json`.
- `scripts/build-puzzles.mjs`: Streams `https://database.lichess.org/lichess_db_puzzle.csv.zst` in memory (never writing the raw `.csv.zst` to disk), demuxes `pzstd` 12-byte skippable frame headers (`0x184d2a50`), decompresses on the fly via Node's built-in `zlib.createZstdDecompress()`, and performs deterministic stratified reservoir sampling across 5 rating buckets × 20 tactical themes to select 20,000 puzzles into `data/puzzles.json`.
- `scripts/build-endgames.mjs`: Writes and validates via `chess.js` the 6 curated endgame positions (`data/endgames.json`) for K+Q v K, K+R v K, K+P opposition, Lucena, Philidor, and R+P v R.
- `index.html`, `public/favicon.svg`, `public/coi-serviceworker.js`, `src/main.ts`, `src/app.ts`, `src/core/datasets.ts`, `src/ui/dev-overlay.ts`, `src/styles/main.css`: Phase 0 app shell with backtick (`~` / `` ` ``) performance/diagnostics overlay and zero external network requests.
- `tests/unit/scaffold.test.ts` & `tests/e2e/phase0.spec.ts`: Unit and E2E tests verifying the Phase 0 app shell, COOP/COEP isolation, zero external network requests, dev overlay toggle, and dataset integrity.

#### Technical Decisions & Deviations
- **Zero-Dependency In-Memory Zstd Streaming (`pzstd` Demuxer)**: Instead of adding an external zstd npm dependency not named in `docs/SPEC.md` or saving a 307 MB `.csv.zst` download to disk, `scripts/build-puzzles.mjs` streams the HTTP response directly through Node 22's built-in `zlib.createZstdDecompress()` paired with a 35-line `Transform` stream that strips `pzstd`'s 12-byte skippable frame headers (`0x184d2a50`). `.gitignore` also explicitly blocks `*.zst`, `*.csv`, and `*.tsv`.
- **Playwright Browser Channel**: Configured `playwright.config.ts` to use `channel: 'chrome'` (installed system Chrome) so end-to-end tests execute hermetically offline without downloading external browser binaries.

#### Dataset Sizes, Repository Sizes & Performance Measurements (Phase 0 Baseline)
- `data/endgames.json`: **2,241 bytes** (`2.19 KiB`) — 6 validated fundamental endgame positions.
- `data/openings.json`: **994,077 bytes** (`970.78 KiB` / `0.95 MiB`) — 3,865 unique opening positions keyed by 4-field EPD.
- `data/puzzles.json`: **4,031,832 bytes** (`3,937.34 KiB` / `3.85 MiB`) — 20,000 stratified Lichess puzzles across 5 rating bands (`<1000` to `2200+`) and 20 tactical themes.
- **Total `data/` Directory Size**: **5,028,150 bytes** (`4.80 MiB`); raw `.csv.zst` download is streamed in memory and not stored on disk or tracked by git.
- **Total Git-Tracked Files Size**: **~5.28 MiB** (`~6.86 MiB` including `.git` object store, excluding `node_modules/` and `dist/`).
- **Build Size (`dist/`)**: `index.html` `0.70 kB`, CSS `3.81 kB` (`1.34 kB` gzip), JS `8.29 kB` (`2.87 kB` gzip), built in `292 ms`.
- **Runtime Network Requests**: `0` external requests (verified by Playwright request interceptor).
- **Idle CPU / Frame Budget**: `0` active `requestAnimationFrame` loops when Dev Overlay is closed; `60 fps` / `16.7 ms` p95 when Dev Overlay is open.

---

## Phase 1 — Core (Plan, Architecture & Verification)

### 1. Phase 1 Implementation Plan (Written Before Code)

#### Files to Add or Change
- `src/core/rules.ts` *(new)*:
  - `RulesAdapter` wrapping `chess.js` (`Chess`) for standard chess while adding full **Chess960 (Fischer Random)** support (Shredder-FEN `[A-Ha-h]` and X-FEN `[KQkq]` castling rights, Chess960 castling move generation/execution/undo where King and Rook start on arbitrary back-rank squares including overlapping/non-moving King or Rook cases, and exact FEN round-tripping).
  - Exact rule methods: `moves()`, `verboseMoves()`, `move()`, `undo()`, `fen()`, `load()`, `reset()`, `clone()`, `perft()`, `inCheck()`, `isCheckmate()`, `isStalemate()`, `isThreefoldRepetition()`, `isDrawByFiftyMoves()`, `isInsufficientMaterial()`, `isDraw()`, `isGameOver()`, `isAttacked()`, `attackers()`, plus null-move (`--` / `Z0`) support when not in check.
- `src/core/game-tree.ts` *(new)*:
  - `GameTree` and `GameNode` data structures storing SAN, UCI, FEN, `preComment` (comments placed before a move), `comment` (comments placed after a move / root game comment), sorted `nags` (`number[]`), `eval` (`[%eval]`), `arrows` (`[%cal]`), `highlights` (`[%csl]`), optional `classification`, and `variationResult`.
  - Tree operations: `addMove`, `addVariation`, `promoteVariation`, `promoteToMainLine`, `demoteVariation`, `deleteVariation`, `deleteNode`, navigation (`goToStart`, `goToEnd`, `goBack`, `goForward`, `goToNode`), and annotation mutators (`setComment`, `setPreComment`, `addNag`, `removeNag`, `setNags`, `setEval`, `setArrows`, `setHighlights`).
- `src/core/pgn.ts` *(new)*:
  - Hand-written lexical scanner, recursive variation parser (`parsePgn`, `parsePgnGames`), and canonical PGN serializer (`writePgn`).
  - Supports nested and sibling variations, pre-move and post-move comments, semicolon `;` rest-of-line comments, `%` column-0 escape lines, NAGs (`$1`–`$255` and `!`/`?`/`!!`/`??`/`!?`/`?!`), embedded `[%eval]`, `[%cal]`, and `[%csl]` tags mixed with prose, over-disambiguated / under-formatted SAN in real-world PGNs (`0-0`, `e8Q`, `e8(Q)`, `e.p.`, `Nge7` when sibling knight is pinned, double disambiguation `Qh4e1`, null moves `--`/`Z0`), escaped quotes/backslashes in header tags, and Chess960 games.
- `src/storage/db.ts` *(new)*:
  - IndexedDB storage layer built on `idb` with versioned schema migrations (`v1` $\rightarrow$ `v2` $\rightarrow$ `v3`) covering `games`, `settings`, `schema_meta`, `puzzles`, `srs_cards`, `repertoires`, and `endgame_progress`, plus typed CRUD and JSON backup/restore helpers.
- `src/app.ts` & `src/styles/main.css` *(modified)*:
  - Expose core module diagnostics in the app shell (without breaking any Phase 0 selectors or tests) so Playwright E2E tests can exercise PGN round-tripping, perft, and native Chromium `IndexedDB` migrations in the browser.
- `tests/unit/rules.test.ts`, `tests/unit/game-tree.test.ts`, `tests/unit/pgn.test.ts`, `tests/unit/storage.test.ts`, `tests/unit/helpers/indexeddb-polyfill.ts` *(new)*:
  - Unit test suites covering perft (Start position depth 1–4: `20 / 400 / 8,902 / 197,281`; Kiwipete depth 1–3: `48 / 2,039 / 97,862`), exact chess rules & Chess960 FEN round-trip, GameTree variation promotion/demotion/deletion, adversarial PGN fixtures & round-trips, and IndexedDB versioned schema migrations (`v1` $\rightarrow$ `v2` $\rightarrow$ `v3`).
- `tests/e2e/phase1.spec.ts` *(new)*:
  - Playwright E2E test verifying Phase 1 core modules and native browser `IndexedDB` version upgrades and PGN round-tripping.

#### Risks & Mitigations
1. **Risk — `chess.js` v1.0.0 Rejects Chess960 FENs & Non-Standard Castling**:
   - `chess.js`'s built-in `validateFen()` rejects Shredder-FEN castling strings (`HAha`, `FBfb`), and its `_updateCastlingRights()` clears castling rights whenever Kings are not on `e1`/`e8` or Rooks are not on `a1`/`h1`/`a8`/`h8`.
   - *Mitigation*: `RulesAdapter` intercepts FEN parsing/serialization and manages Chess960 castling rights and legal castling moves when a position uses Shredder-FEN or non-standard back-rank King/Rook squares, while delegating standard positions directly to `chess.js`'s fast 0x88 engine.
2. **Risk — Naive PGN Parsers Break on Real-World PGN Edge Cases**:
   - Real-world PGNs from Lichess, ChessBase, TWIC, and FICS include comments containing `(variations)` and `1-0`, comments placed *before* moves (`1. e4 ( { pre-comment } 1. d4 )` or `1. { comment } e4`), multiple consecutive `{ comment }{ blocks }`, `;` end-of-line comments, `%` escape lines, `[%eval -4.20,24]` with depth suffixes, glued move numbers (`1...c5`), over-disambiguated SAN (`Nge7` when the `c6` knight is pinned), and result markers inside variations (`(4... Qxf2# 0-1)`).
   - *Mitigation*: Implement a dedicated state-machine lexer and parser in `src/core/pgn.ts` with explicit `preComment` and `comment` fields on `GameNode`, permissive SAN resolution fallback in `RulesAdapter`, and an adversarial fixture suite testing every case.
3. **Risk — Testing `idb` in Node (`vitest`) Without Adding Unapproved Dependencies**:
   - `vitest` runs in `environment: 'node'` where `globalThis.indexedDB` is not built in, and `AGENTS.md` forbids adding dependencies not listed in `docs/SPEC.md` without asking.
   - *Mitigation*: Implement a lightweight, spec-compliant in-memory `IDBFactory` polyfill in `tests/unit/helpers/indexeddb-polyfill.ts` for fast unit tests AND run real browser `window.indexedDB` migration tests in `tests/e2e/phase1.spec.ts`.

### 2. Phase 1 Technical Decisions, Adversarial PGN Edge Cases & Measurements

#### Technical Decisions & Deviations
- **Hybrid Standard + Chess960 Rules Adapter (`src/core/rules.ts`)**:
  - Standard positions execute directly on `chess.js`'s 0x88 engine with zero overhead.
  - When a FEN uses Shredder-FEN castling tokens (`A–H` / `a–h`), non-standard King/Rook back-rank coordinates, or `chess960: true`, `RulesAdapter` manages Fischer Random castling state (`kSide` / `qSide` rook files and notation order `kq` vs `alpha`) and generates/validates/executes Chess960 `O-O` and `O-O-O` moves (including overlapping King/Rook swap `f1`$\leftrightarrow$`g1`, King-in-place `g1` castling, king-captures-own-rook UCI/MoveInput, and post-castle discovered-check validation).
- **Adversarial PGN Edge Cases Included in `tests/unit/pgn.test.ts`**:
  1. **Deeply Nested & Sibling RAVs**: 3+ levels of nested variations, multiple sibling variations on the same move, and variation termination markers (`1-0`, `0-1`, `1/2-1/2`, `*`) inside parentheses.
  2. **Pre-Move Comments & Root Comments**: Comments placed before move 1 (`root.comment`), at the start of a variation `( { pre } 1... c5 )`, or between a move number and SAN move (`1. { pre } e4`, `2. { pre } Nf3`) stored in `node.preComment` and round-tripped losslessly.
  3. **Comment Syntax Torture**: Brace comments containing fake `(1. d4 (2. c4) 1-0)` variations, `[Event "Fake"]` header tags, `[sic]`, `;` semicolons, and `$14` NAGs; consecutive `{ comment 1 } { comment 2 }` blocks; `;` rest-of-line comments; and `%` column-0 PGN spec escape lines.
  4. **Embedded Visual & Engine Annotations**: `[%eval]` (centipawns, `0.00`, mate `#3`/`#-2`, and depth suffixes `,24`), `[%cal]` multi-arrow lists, and `[%csl]` square highlights interleaved with human commentary.
  5. **Real-World SAN & Move-Number Quirks**: Glued move numbers (`1.e4`, `4...Nge7`), over-disambiguated moves where a sibling piece is pinned (`4...Nge7` when the `c6` knight is pinned by `Bb5`), full-square disambiguation (`Ng1f3`), three-queen double disambiguation (`Qh4e1`), zero-castling (`0-0` / `0-0-0`), `e.p.` suffixes, promotions in 4 wild formats (`=Q+`, `(Q)+`, `R+`, `=b`), and null moves (`--`, `Z0`).
  6. **Escaped Header Values & Black-to-Move FEN Starts**: Escaped quotes `\"` and backslashes `\\` in headers, padded header brackets, CRLF line endings, missing EOF result tokens, Black-to-move `[FEN]` setups (`6... O-O`), Chess960 castling checkmate (`1. O-O#`), and multi-game PGN streams.
- **Versioned IndexedDB Migrations (`src/storage/db.ts`)**:
  - Implemented 3 sequential schema versions (`v1` $\rightarrow$ `v2` $\rightarrow$ `v3`) using `idb`, recording migration history in `schema_meta` and backfilling `schemaVersion: 3` on legacy `v1`/`v2` game records during upgrade.

#### Known Issues
- None.

#### Measured Performance Numbers (Phase 1)
- **Perft (Standard Start Position)**:
  - Depth 1 (`20` nodes), Depth 2 (`400` nodes), Depth 3 (`8,902` nodes), Depth 4 (`197,281` nodes): **~737 ms** total in Vitest (`~267k` leaf nodes/sec in JS).
- **Perft (Kiwipete Position)**:
  - Depth 1 (`48` nodes), Depth 2 (`2,039` nodes), Depth 3 (`97,862` nodes): **~303 ms** total in Vitest (`~323k` leaf nodes/sec in JS).
- **Adversarial PGN Suite (11 fixtures, double parse + serialize round-trip each)**: **~397 ms** total across all 11 fixtures.
- **IndexedDB `v1 -> v2 -> v3` Upgrade & Backup/Restore**: **~67 ms** in unit tests; **474 ms** full Chromium E2E test (`tests/e2e/phase1.spec.ts`).
- **Production Bundle (`dist/`)**: JS `88.19 kB` (`28.50 kB` gzip, includes `chess.js`, `idb`, `RulesAdapter`, `GameTree`, `PGN`, and `WizardChessStorage`), CSS `3.81 kB` (`1.34 kB` gzip), `0` runtime network requests.

---

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

## Phase 5b — Capture extension + Games list (2026-10-18)

### Findings before the plan (probed from this machine, 2026-10-18)

- **Lichess single-game export needs a login.** Anonymous `GET /game/export/{id}` answers
  303 → `/signup` (PGN) or 401 `{"error":"Login required"}` (JSON). Two official
  endpoints still answer anonymously: `POST /api/games/export/_ids?clocks=true` (PGN with
  `[%clk]`) and `GET /api/games/user/{name}` (history, NDJSON with `pgnInJson=true`).
- **Lichess game pages embed the whole game.** `<script type="application/json"
  id="page-init-data">` → `data.game` (id, variant, speed, status, winner, createdAt),
  `data.clock` (initial, increment), `data.player` / `data.opponent` (user, rating,
  ratingDiff; for a spectator `player` is White) and `data.treeParts` (one entry per ply:
  `san`, `uci`, `fen`, `clock` in centiseconds after the move, increment included). No
  opening name. A non-browser User-Agent gets a reduced page without this script.
- **Session cookies and extension fetches** (probe with an unpacked extension in Chrome 155,
  a `SameSite=Lax; HttpOnly; Secure` cookie on lichess.org): a fetch from a content script
  on lichess.org carries the cookie; the same fetch from the extension's service worker
  (`credentials: 'include'`) does not. So the logged-in export can only run on a
  lichess.org page; links and backfill (service worker) use the anonymous endpoints.
- **Chess.com game pages don't embed the game.** The HTML of `/game/live/{id}` has only
  meta tags; the client loads `/callback/live/game/{id}` (or `/callback/daily/game/{id}`):
  `game.moveList` (TCN: two characters per ply), `game.pgnHeaders`, `game.moveTimestamps`
  (live: clock left after each ply, deciseconds; daily: `game.timestamps`), `isFinished`,
  `colorOfWinner`, `gameEndReason`, `initialSetup` (Chess960), `players.top/bottom`.
  TCN castling is king → rook square in Chess960 (`db` = Kd1×Rb1).
- **Chess.com archive API**: `api.chess.com/pub/player/{u}/games/archives` and
  `/games/{YYYY}/{MM}`, with `ETag` and `Last-Modified`; each game has `pgn` and `tcn`, so
  the TCN decoder can be checked against Chess.com's own PGN. It rejects requests without a
  User-Agent (403).
- **Loading an unpacked extension in tests:** branded Chrome ignores `--load-extension`
  since Chrome 137. Chrome 155 started by Playwright with `--enable-unsafe-extension-debugging`
  loads it through CDP `Extensions.loadUnpacked`; `context.route` intercepts page,
  content-script and service-worker requests, and `chrome.scripting.registerContentScripts`
  works. No new browser download is needed.

Recorded with `node scripts/record-capture-fixtures.mjs` into `tests/fixtures/capture/`
(Lichess: two game pages, the anonymous export answer, two `_ids` exports, 4 history lines;
Chess.com: two live and two daily callbacks incl. a Chess960 game, two trimmed monthly
archives with the same games, an archive list).

### Plan (written before code)

**Extension** (`extension/`, TypeScript, built by `scripts/build-extension.mjs` with Vite's
build API, one IIFE bundle per entry, into `dist-ext/`; `npm run build:ext`)
- `extension/manifest.json` (MV3). Permissions: `storage`; `alarms` (pending Chess.com
  retries, backfill resume: MV3 service workers can't keep timers); `contextMenus` (the
  link menu); `notifications` (extraction-failure notice); `scripting` (registers the bridge
  only on the configured site URL). Hosts: lichess.org, www.chess.com, api.chess.com,
  `http://localhost/*`, `http://127.0.0.1/*` (any port: the site URL is a setting).
- `extension/src/chrome.d.ts`: hand-written types for the chrome.* calls used (no
  `@types/chrome` dependency).
- Extractors behind one interface (`extractors/types.ts`), one file per method:
  - `lichess-session-export.ts` (content script: `/game/export/{id}?clocks=true` with the
    page's session; detects the login wall),
  - `lichess-ids-export.ts` (`POST /api/games/export/_ids`, used where there is no session:
    links, the popup),
  - `lichess-page-data.ts` (`page-init-data` → PGN with `[%clk]`, headers from the data),
  - `chesscom-callback.ts` + `chesscom-tcn.ts` (callback JSON → PGN, clocks for live games),
  - `chesscom-share.ts` (fallback: the page's own Share → PGN dialog),
  - `chesscom-archive.ts` (links and backfill: monthly archive; `pending` until it appears).
  Order on a Lichess page: session export → page data (the user's instruction). Links:
  `_ids` export → page data from the fetched page.
- Content scripts `content/lichess.ts`, `content/chesscom.ts`: game-ID detection from the
  URL, finished-game detection (page data / callback; DOM observer for a game that ends
  while the page is open, then a single fetch), auto-capture only when the game ended live
  and I played it (username settings), an injected "Save game" button (shadow DOM).
- `background.ts`: the queue, badge (undelivered count), context menu on game links,
  notifications, alarms, backfill runner, bridge registration, messages.
- `queue.ts` (pure, storage adapter injected): one key per game plus a small index;
  statuses pending / ready / delivered; a delivered game drops its PGN, keeps its index row
  (dedupe, popup list).
- `backfill.ts`: Lichess history (`since` = newest game seen, `sort=dateAsc`, pages of
  200), Chess.com archives (months from the last one finished; ETag / `If-None-Match`,
  304 = nothing new). One request at a time, a pause between requests, 429 → back off
  (Lichess: ≥ 60 s; doubling), and a pause while ≥ 1000 games wait for the site (keeps
  `chrome.storage.local` under its 10 MB quota).
- `popup.html` / `popup.ts`: settings (usernames, site URL, auto-capture), paste link or
  PGN (validated with the app's own PGN parser), recent captures with status, Import my
  history per site with progress, retry for pending games.
- `bridge.ts` (content script on the configured origin only).

**Bridge protocol v1** (`src/capture/protocol.ts`, shared): page → `hello {version}`;
bridge → `hello-ack {version, extensionVersion, accounts}` then `games {batchId, games[]}`
(≤ 50 per batch); page → `saved {batchId, saved[], duplicates[], failed[]}`; the extension
marks saved + duplicates delivered (a duplicate is already stored on the site, otherwise
it would be re-sent forever), keeps failed ones ready for the next sync. Both sides check
`event.source === window`, the origin, and the message shape. The page says hello on load,
on `focus` and when its tab becomes visible; the bridge announces itself when it loads.

**Website**
- `src/library/game-record.ts` (pure): a stored game from a PGN (+ capture metadata):
  id `lichess:<id>` / `chesscom:<id>` (from the capture, or the PGN's Site / Link header),
  `paste:<hash>` otherwise; my color from my accounts; opponent, ratings, result, time
  control, opening (the app's openings dataset), date.
- `src/storage/db.ts`: optional fields on `StoredGameRecord` (`source`, `siteGameId`,
  `timeControl`, ratings, `review`). **No schema change**: the id already makes
  site + game ID unique, and nothing needs a new index yet (Phase 8 may add some).
- `src/library/library.ts`: save with duplicate check, list, save a review.
- `src/library/bridge-client.ts`: the page side of the protocol.
- `src/library/review-queue.ts`: background reviews on the review engine (ReviewRunner on a
  parsed tree, no board), one at a time; results saved in the game record.
- `src/library/games-list.ts` + CSS: a "Games" workspace tab: columns as in the spec, sort
  and filter (source, result, analyzed), multi-select → Analyze with a preset picker
  (default **Standard**), per-game queue state, Auto-analyze new games toggle (off; uses
  **Quick**), Paste PGN, drag-and-drop of .pgn files, extension status. Opening a game loads
  it on the Analysis board; an analyzed one shows its saved review (no engine run).
- `src/review/review-panel.ts`: `showSavedReview()` (remaps node IDs by ply after checking
  the moves match) and a completion hook so a review run from the board on a library game
  is saved too.
- `src/review/perspective.ts`: accounts come from the extension's settings (sent in
  `hello-ack`, kept in the site's settings store); the built-in `Lobo017` stays only as the
  fallback until an extension has sent usernames.

**Tests**
- Unit: TCN decoder against the archives' own PGNs (all recorded games: castling both ways,
  promotions, Chess960); each extractor against its fixture (page data vs. the `_ids`
  export of the same game: same moves and clocks; callback vs. archive PGN; login-wall
  detection); queue; backfill (pagination, ETag 304, 429 backoff, one request at a time,
  with a fake fetch and clock); bridge protocol both sides incl. partial failure; game
  records (ids, my color, metadata, dedupe).
- E2E (site only): Games list without the extension: paste, drop a file, metadata, filters,
  Analyze on Standard, saved review on open without an engine run, auto-analyze on Quick,
  zero network requests.
- E2E (extension): loads `dist-ext/` (CDP), mocked Lichess and Chess.com pages from the
  fixtures, captures a game, badge updates, the site shows it exactly once (also after a
  second sync) and analyzes it; popup paste; a live game that ends while the page is open.

**Risks**
- Chess.com's game-over DOM, its Share dialog and Lichess's live-game end markers can't be
  recorded without a live game; those parts are tested on mocked pages modelled on what the
  sites render and are marked unofficial in the README.
- MV3 service workers stop when idle: everything long-running (retries, backfill) is
  driven by alarms and stored state, not timers.
- The site's existing e2e tests must not change: the Games tab is a new mode, and the
  Lichess review test still opens as Black through the fallback account.

### Result (2026-10-18)

Built in the order asked for: (1) queue and bridge, tested with pasted PGN; (2) Lichess
capture; (3) Chess.com capture; (4) history backfill; (5) Games list polish. A WIP commit
after step 2 (16ab006).

**Extension** (`extension/`, `npm run build:ext` → `dist-ext/`, plain IIFE bundles, no
remote code; the build checks for `importScripts` / remote `import()`)
- Manifest V3. Permissions and why: `storage` (queue, settings, import progress);
  `alarms` (pending retries every 15 min, waking a rate-limited or interrupted import:
  service workers can't keep timers); `contextMenus` (the link menu); `notifications`
  (extraction failures); `scripting` (registers the bridge on the configured site URL only).
  Hosts: lichess.org, www.chess.com, api.chess.com, and `http://localhost/*`,
  `http://127.0.0.1/*` (any port, since the site URL is a setting; only the configured origin
  gets the bridge).
- `chrome.d.ts`: the chrome.* calls used, typed by hand (no new dependency).
- Extractors behind one interface (`extractors/types.ts`, `runExtractors`: first PGN wins,
  stops early on "game in progress"), one file per method: `lichess-session-export`,
  `lichess-ids-export`, `lichess-page-data`, `chesscom-callback` (+ `chesscom-tcn`),
  `chesscom-share`, `chesscom-archive`.
- Content scripts `content/lichess.ts`, `content/chesscom.ts` on a shared runner
  (`content/capture-page.ts`): Save button in a shadow root on `<html>`; a game in progress
  shows "Game in progress" and is watched (Lichess `.result-wrap`; Chess.com game-over
  dialog selectors plus a 30 s check of the game data while the tab is visible); when it
  ends, auto-capture if the setting is on and it is my game (my username for that site, or
  for Lichess the page's own non-spectator view). Chess.com changes games without reloading:
  the URL is checked every second and the runner restarts.
- `queue.ts` (index + one key per waiting PGN; a delivered game drops its PGN), badge =
  pending + ready, `capture-service.ts` (PGN checks with the app's own parser before
  anything is queued, link resolution, pending retries, last failure), `background.ts`
  (messages with sender checks: game sites, the popup, the configured site origin for the
  bridge), `backfill.ts`, popup.

**Lichess and the login-gated export (the question asked).** Measured here:
- Anonymous `GET /game/export/{id}` → 303 `/signup` (401 `{"error":"Login required"}` as
  JSON); recorded in `tests/fixtures/capture/lichess/export-anonymous.json`.
- In Chrome 155 with the unpacked extension and a `SameSite=Lax; HttpOnly; Secure` session
  cookie: a **content-script** fetch on lichess.org carries the cookie, the **service
  worker's** fetch (`credentials: 'include'`) does not.
- So on a Lichess game page the extension asks the export with your session first; the e2e
  test serves the export only when the `lila2` cookie is present and checks it was sent and
  used (method `lichess-session-export`). If the export wants a login, it falls back to the
  game page's own data (`page-init-data`), as instructed; that PGN matches Lichess's export
  of the same game exactly in moves and clocks and in 16 headers (unit test, both recorded
  games).
- **Not verified with a real Lichess login** (no access to your session from here). The
  queue records which method produced each game; the popup shows it, so the first game you
  save on Lichess while logged in tells you whether the session export worked
  ("Lichess export (your session)") or the page data was used.
- Links (popup, context menu, pending retries) run in the service worker, which has no
  session cookie: they use the official, still-anonymous `POST /api/games/export/_ids`
  (added, see deviations), then the page data from the fetched game page.

**What Chess.com's pages load** (recorded 2026-10-18; fixtures in `tests/fixtures/capture/chesscom/`)
- The HTML of `/game/live/{id}` has no game data (meta tags, login links). The page loads
  `GET /callback/live/game/{id}` (daily: `/callback/daily/game/{id}`), JSON `{ game, players }`.
  It answered 200 to a browser User-Agent without cookies; a fake ID gives 404
  `{"message":"Game is not found."}`.
- `game.moveList`: TCN, two characters per ply from
  `a–z A–Z 0–9 ! ?` = squares a1…h8 (index = file + 8·rank). A second character ≥ 64 is a
  promotion: piece = `qnrb`[(c − 64) / 3], target file offset (c − 64) % 3 − 1 (capture
  left / straight / capture right). Castling is the king's move: e1→g1 in standard chess,
  **onto its own rook in Chess960** (`db` = Kd1×Rb1 for O-O-O). Characters above index 75
  in the first position are crazyhouse drops (not supported).
- `game.moveTimestamps` (live): the clock left after each ply in deciseconds
  ("1800,1800,1763,…" for 3+0); Chess.com's own PGN writes these as `[%clk 0:02:56.3]`.
  Daily games have `game.timestamps` instead (deciseconds too, up to 864000 for a one-day
  move limit), which don't match the `[%clk]` Chess.com's archive PGN writes for daily games,
  so daily captures carry no clocks.
- `game.pgnHeaders`: Event, Site, Date, White, Black, Result, ECO, WhiteElo, BlackElo (numbers),
  TimeControl, EndTime ("9:34:36 GMT+0000"), Termination, and for every game SetUp/FEN (the
  start position even for standard games); Chess960 adds Variant and `initialSetup`
  (Shredder castling `FBfb`). Values escape apostrophes as `\'` ("Let\'s Play!").
- Other fields used: `isFinished`, `colorOfWinner`, `gameEndReason`, `endTime` (s), `type`
  (`chess` / `chess960`), `plyCount`, `initialSetup`; `players.top/bottom` (username, color,
  rating; the recorder keeps only these).
- The archive API (`api.chess.com/pub/player/{u}/games/{YYYY}/{MM}`) has `pgn` **and** `tcn`
  for every game, plus `initial_setup` (X-FEN `KQkq` for Chess960, unlike the PGN's FEN
  header); answers carry `ETag`, `Last-Modified`, `cache-control: public, max-age=60`; it
  refused the default curl User-Agent (403). The TCN decoder reproduces Chess.com's own PGN
  for all 42 recorded archive games (promotions, both castlings, a Chess960 game).
- A game page's in-page navigation (next game) changes the URL without a reload.

**Bridge** (protocol v1 as planned). Found and fixed while testing: the page's `hello` and
the bridge's `bridge-ready` cross at startup, so the page says hello twice; the first version
queued a second full sync for that. A hello during a sync is now ignored: the running sync
reads the queue afresh for every batch, so games captured meanwhile go out with it (unit
test). Also found by the first browser run: the bridge kept `setTimeout` in an object and
called it as a method, which browsers reject ("Illegal invocation") and Node doesn't.

**Website**
- **Games** tab (`library/games-list.ts`): source, date (the PGN's UTC date), my color, opponent
  with ratings (or "White vs Black" when I'm not in the game), result from my side (W/L/D; a
  game I'm not in shows its result as played), time control ("2+1", "3+0", "1 day"), opening
  (the app's openings dataset), and Analyzed / Not analyzed / Queued / Analyzing n% / Failed.
  Filters (source, result, analysis), sort (newest, oldest, opponent, accuracy), select /
  select all → **Analyze** on the preset picked, **default Standard**; **Auto-analyze new
  games** (off by default, remembered) reviews on **Quick**. Paste PGN, Open PGN file…, drag
  and drop. 200 rows per page with "Show more". Phone layout: two-line cards.
- `library/library.ts` + `game-record.ts`: keys `lichess:<id>`, `chesscom:<live|daily>-<n>`,
  `paste:<hash of players, date, moves>`; a pasted Lichess or Chess.com PGN gets its site
  key from Site/GameId/Link, so pasting a game the extension later captures stores it once.
  Imports yield between games (no single long task).
- `library/review-queue.ts`: background reviews on the review engine, one game at a time.
  `library/saved-review.ts`: the finished review is stored and shown again on open
  (`ReviewPanel.showSavedReview`, node IDs mapped by ply after checking the moves match);
  a review run on the board for a list game is saved too.
- "Review as": my accounts are the usernames the extension sends (`hello-ack`), kept in the
  site's settings; the built-in `Lobo017` is only the fallback until then (Phase 5's tests
  rely on it, unchanged).

**Deviations from the spec / plan (with reasons)**
1. **IndexedDB schema v4** (the plan said no schema change): a stored review is ~100 kB and
   the list loads every game record, so reviews got their own `reviews` store. Two earlier
   tests hard-coded v3; they now pin their v1→v2→v3 steps to version 3 and add a v3→v4 step
   (stores, migration history, data kept). The header badges read "IDB v4". Extended, not
   weakened; backup/restore includes the reviews.
2. **Lichess `POST /api/games/export/_ids`** for links and the popup: the service worker has
   no Lichess session (measured), and this official endpoint still answers anonymously.
   On game pages the order is the one asked for: session export, then page data.
3. **Chess.com links** read the game's own data (the callback) to know whose archive and
   which month to look in, then take the PGN from the official archive. Without it, my
   archive for this month and the last. Pending games are retried every 15 min and no
   longer automatically after 48 h (Retry now still works).
4. Extra permissions beyond the spec's list (alarms, contextMenus, notifications, scripting):
   each is needed by a feature the spec asks for (see above).
5. A game the site already had is acknowledged as stored (`duplicates`), so the extension
   marks it delivered instead of sending it forever.
6. History imports aren't auto-analyzed (they are not "new games"; a full Lichess history can
   be thousands of games).
7. Auto-capture is on by default; on Chess.com it needs my username (the page's player
   isn't readable from the extension's isolated world).
8. Lichess clocks are rounded to the nearest second, as Lichess's export does (floor gave
   23 mismatches of 46 against the recorded export, rounding none).
9. The e2e test loads the unpacked extension through CDP `Extensions.loadUnpacked`
   (`--enable-unsafe-extension-debugging`): branded Chrome ignores `--load-extension` since
   Chrome 137, and the suite uses the installed Chrome.

**Tests** — unit: `capture-game-id` (8), `capture-queue` (6), `capture-bridge` (10, incl.
partial failure, failures not re-offered in the same sync, duplicates, foreign batch / keys,
spoofed origin and window, reply timeout), `capture-lichess` (10), `capture-chesscom-tcn` (3),
`capture-chesscom` (12, incl. ETag / 304 / 429 / pending / 48 h), `capture-backfill` (8,
incl. pagination, since, ETag, 429 doubling and cap, queue-full pause, one request at a
time across both sites), `library` (8), storage extended. E2E: `phase5b-extension.spec.ts`
(12: pasted PGN round trip + focus sync; Lichess without login → page data, Games list,
Analyze, saved review on open; Lichess logged-in live game ending → session export
auto-capture; someone else's game not captured; Lichess link; Chess.com Save (TCN);
Share-dialog fallback; Chess.com live game after in-page navigation; Chess.com link pending
→ ready via the context-menu handler and Retry; extraction failure → notification + popup;
history import of both sites; settings incl. site URL re-registration and auto-capture off),
`phase5b-games.spec.ts` (4, no extension: paste / drop / file picker, metadata, filters, sort,
selection, zero network; Analyze on Standard, opening the saved review makes no engine
call, "Review as" from the extension's Chess.com username, auto-analyze on Quick, toggle
remembered; review run on the board saved; phone width with no horizontal scroll and no
layout shift). Mocked pages: the recorded Lichess HTML without its scripts and styles; for
Chess.com a minimal page (its HTML has no game data anyway) and a mocked Share dialog.

**Measured** — bundles: background 216 kB, Chess.com content script 145 kB (chess.js for
TCN → SAN), Lichess 27 kB, bridge 6 kB, popup 9 kB. The Chess.com Save → badge → site test
runs in 2.8 s including the browser start. Quick review of the 46-ply Lichess game from the list: the whole test 35 s.
History import of 44 games (4 Lichess + 40 Chess.com, 3 requests) and their delivery to the
site: 10 s for the test.

**Screenshots looked at** (`test-results/phase5b-screens/`): `games-list-desktop.png`,
`games-list-phone.png`, `games-list-analyzed.png`, `saved-review-opened.png` (board flipped
to Black for hikaru, "Reviewed · Standard"), `lichess-save-button.png`, `popup-after-paste.png`,
`popup-pending.png`, `popup-backfill-done.png`. Fixed after looking: dates were the day
before (UTC date shown in local time); a game I'm not in showed "W" from White's side; the
Black color dot was invisible on the dark row; an empty message line left a gap; a pending
link showed only its URL (now the players from the game data).

**Known issues**
- Unofficial methods can break silently when the sites change: Lichess `page-init-data` and
  `.result-wrap`; Chess.com's callback endpoint, its game-over dialog selectors and the Share
  dialog selectors. The last two could not be recorded (no live game, no logged-in page);
  they are tested on mocked pages modelled on the site and are the most likely to need
  updating. A failure always ends in the notification → popup paste path.
- The logged-in Lichess export is verified with a simulated session cookie, not a real login
  (see above).
- The popup shows the 40 newest entries; delivered entries keep a ~150-byte index row each
  (dedupe), never pruned.
- The Games list's background reviews and a review started on the board share the one review
  engine; both run, interleaved, each slower.
- Parsing a big pasted or imported PGN runs on the main thread, one game per task (Phase 8
  moves bulk import to a worker).

**Checks (final run, 2026-10-18):** typecheck, lint, **351 unit tests** (30 files), `npm run build`,
`npm run build:ext`, **46/46 e2e** (30 earlier, Phase 1's migration test now extended to v4, + 16 Phase 5b;
5.8 min, one worker): all pass.
- A first full run was stopped by the environment (the machine ran low on memory) after 31
  tests, all passing.
- The user's full run then had 45/46: the extraction-failure test read the notifications
  right after the Save button turned "failed", but the content script set the button before
  telling the background, which creates the notification. The content script now reports
  the failure first, and the test polls; the failure-path tests passed 3 times in a row, then
  the full run above.

## Phase 5b — Live capture fixes (2026-10-19)

Report from live testing: every capture in the popup came from "Lichess history" or
"Chess.com archive", none from a game page; finished games only arrived after pressing the
import buttons.

### Diagnosis (before the plan)

Where the content scripts run: the manifest injects `lichess.js` on `https://lichess.org/*`
and `chesscom.js` on `https://www.chess.com/*`, so every page of both sites gets the script
(including chess.com/play/online, /game/live/…, lichess.org/{id}, /{id}{player},
/{id}/white|black). URL coverage at the manifest level is not the problem. What goes wrong is
what the scripts do once they run:

1. **Auto-capture only fires for a game the script saw in progress and then saw end, on the
   same URL, with the page still open.** A game first seen already finished only gets the Save
   button. That misses: a page that reaches the game URL only after the end (Chess.com moves
   between /play/online and /game/live/{id} in the page, without a reload), a reload after the
   end, and opening the game from a notification or the home page.
2. **Chess.com /play/online and other /play pages have no game ID in the URL**, so the
   script does nothing there (`parseGameUrl` → null).
3. **Leaving soon after the end loses the capture.** After the end signal the script waits
   1.5 s, then checks up to 3 times 2 s apart. "New opponent" / "New game" / "Rematch" or
   closing the tab in that window kills the script before it captures, and nothing else
   picks the game up.
4. **End detection rests on CSS selectors.** Lichess: `.result-wrap`. Chess.com: four
   game-over dialog class names (never seen on a live page), backed by a 30 s re-check that
   runs only while the tab is visible.
5. **Tabs open while the extension is loaded or reloaded never get a working script.**
   Chrome injects manifest content scripts only into pages loaded afterwards; after a reload
   of the unpacked extension, the scripts in open tabs are orphaned (every
   `chrome.runtime.sendMessage` throws "Extension context invalidated") but keep their Save
   button on screen.
6. **Delivery waits for focus**: the site syncs on load, `focus` and `visibilitychange`; a
   game captured while the site's tab is in the background waits until it is clicked.

Probed from this machine (no login, no personal data sent):
- A live Lichess game page (TV game, spectator view) has `page-init-data` with
  `game.status = {id: 20, name: "started"}`: the page data is there while the game runs.
- `GET https://lichess.org/api/stream/game/{id}` (official, anonymous, NDJSON): the first
  line describes the game (no `status` field while it runs), then one line per move
  (`fen`, `lm`, `wc`, `bc`), and when the game ends one more description line with
  `status` (e.g. `{"id":35,"name":"outoftime"}`) and `winner`, then the stream closes. For a
  finished game it sends the description, the moves and the final line at once. Recorded:
  `tests/fixtures/capture/lichess/stream-7hMjEFmU-live.ndjson` (a TV UltraBullet game,
  recorded until it ended) and `stream-Bjl39T9x-finished.ndjson`.
- Chess.com live and daily IDs are separate number ranges that overlap:
  `/callback/live/game/1033338800` answers with a different (live) game than the daily game
  1033338800. `/game/{n}` without a type therefore stays "live", as before.
- Not verifiable from here: what chess.com/play/online does to the URL during a game, and
  which requests it makes. The Debug button (below) shows it on the live site.

### Plan (written before code)

**Content scripts** (`extension/src/content/`)
- `page-runner.ts` (new, both sites): watches the URL (every second and on `popstate`) and
  restarts the capture for a new game; one live instance per tab (a token on `<html>`; an
  older or orphaned instance stops itself and its button goes); reports the page's state
  to the background (`page-state`: URL, game ID, state, players, mine, seen in progress,
  end time); answers the popup's `debug-tab` request.
- `debug-log.ts` (new): the last 30 detection events with times, and the snapshot the
  Debug button shows.
- `capture-page.ts`: end signals carry their source; one from the site's data (stream line,
  game data) is checked at once without the 1.5 s settle. A game first seen **finished**
  is captured automatically when it is mine and ended (or started) in the last 6 hours.
  A PGN with result `*` is treated as "in progress" (the session export answers for running
  games too).
- `lichess.ts`: end detection from the official game stream (reconnects with a back-off when
  it closes early or fails), `.result-wrap` kept as a second, faster signal.
- `lichess-stream.ts` (new): the NDJSON reader and line classifier.
- `chesscom.ts`: end detection by polling the game's own data (the callback) every 10 s while
  the game runs (30 s while the tab is hidden) and on visibility changes; the game-over
  dialog selectors kept as a second signal. On /play pages (no ID in the URL): game IDs from
  the page's own requests (Resource Timing entries for `/callback/live/game/{id}`-style
  URLs), the newest one taken as the current game.

**Background**
- `tab-tracker.ts` (new, pure): what a tab was showing (from `page-state` and
  `tabs.onUpdated`, kept in `chrome.storage.session`), and what to do when it leaves a
  game page (tab closed, other URL): capture the game directly and/or sync the site.
- Leaving a game page: the game is resolved from the service worker (Lichess `_ids` export,
  then page data; Chess.com game data, then the archive) and queued if it is finished and
  mine (and recent, unless the page saw it in progress). Then a sync of that site.
- `auto-sync.ts` (new): the safety net. Lichess: `GET /api/games/user/{me}` since the
  newest game seen (`ongoing=true`, so a game still running holds the cursor back until it
  ends), pages of 100. Chess.com: the current month's archive (and the previous one at a
  month change) with ETag (304 = nothing new), games that ended since the cursor minus 12 h
  (archive lag). First run for an account starts 24 h back (the history import is still the
  way to get older games). Skips a site while its history import runs, while rate-limited
  (429 → back off, at least 60 s), and while 1000 games wait. Same queue, same dedupe.
- Alarm every 3 min: syncs each site that has a tab open, or had a game page left in the
  last 30 min (Chess.com's archive lags). Also on browser start-up. Needs auto-capture on
  and the username for that site.
- Install / update: the content scripts are injected into the Lichess and Chess.com tabs
  already open (`chrome.scripting.executeScript`).
- Delivery: when games become ready, the background messages the bridge in every tab of the
  configured site URL; the bridge says `bridge-ready` and the page syncs (protocol
  unchanged). A nudge during a sync starts another sync after it.
- Queue entries get `trigger` (game ended on the page, left the page, background sync, Save
  button, history import, link, pasted) and `playedAt` (ms, from the PGN's UTC headers).

**Popup**: "Debug this tab" (URL, page kind, game ID and where it came from, game state and
source, players and whether it's mine, what is being watched, the button state, the last
detection event and the event log, plus the background's view: settings, the site's sync
state, the queue entry; Copy report; "Start capture on this tab" when no script runs there).
Counts reworded: "N games ready to send to the analysis site", what that means, whether
the site is open in a tab, an "Open the analysis site" button; pending and delivered counts
separate. Entry lines say how each game was captured.

**Dates**: `src/capture/pgn-time.ts` (shared): UTCDate + UTCTime → ms (then Date +
StartTime, then EndDate + EndTime; Chess.com's "16:37:15 GMT+0000" accepted), shown in local
time: the Games list ("2026-10-18 14:05"; tooltip with the time zone) and the popup. The
Chess.com game-data PGN gets EndDate / EndTime from `endTime`.

**Tests**: unit: stream reader (both fixtures), tab tracker decisions, auto-sync (cursor, seed,
ongoing hold-back, pagination, ETag 304, month change, archive-lag window, 429, import
running, dedupe), capture on leaving (mine / not mine / in progress / not recent), bridge
nudge (idle, during a sync), PGN time + local formatting with a fixed time zone, queue
`playedAt` / `trigger`. E2E (extension): Lichess end from the stream with no DOM marker;
Chess.com game first seen finished and recent → auto; Chess.com /play page with the game ID
from its requests; tab closed before the end is seen → captured on leaving; background sync
on the alarm while a site tab is open and after leaving a page, and none with no tab open;
delivery to an open site tab with no focus or visibility event; Debug button (game tab,
non-site tab, tab without a script → start it); popup wording; dates in a fixed time zone
(Asia/Tokyo) in the popup and the Games list.

**Risks**
- The Lichess stream sends ongoing games a few seconds late (3–60 s by time control); the
  `.result-wrap` signal stays as the fast path, the stream as the reliable one.
- Polling Chess.com's game data every 10 s during a game: ~6 requests a minute to the same
  endpoint the page itself uses; only while a game is in progress on that tab.
- Resource Timing on /play pages relies on the page fetching a URL with the game ID; if it
  doesn't, the leave-page sync and the 3-minute sync still bring the game in.
- Chrome's alarm minimum (30 s) and the service worker stopping are fine: everything is
  driven by alarms, tab events and stored state.

### Result (2026-10-19)

Built as planned; no new dependency, no new permission (tab URLs, `tabs.query` with URL
patterns and `scripting.executeScript` work through the existing host permissions;
`chrome.storage.session` comes with `storage`).

**Content scripts**
- `page-runner.ts` follows the URL (1 s and `popstate`) on both sites, keeps one live instance
  per tab (`data-wc-capture` token on `<html>`; an orphaned or replaced instance stops and
  removes its button), reports `page-state` to the background (debounced 150 ms) and answers
  `debug-tab` with its status and the last 30 events (`debug-log.ts`).
- `capture-page.ts`: end signals say where they came from; one from the site's data is
  checked at once (2 checks, no settle), one from the page markup keeps the 1.5 s settle and 3
  checks. A finished game is auto-captured on open when mine and ended (or started) in the
  last 6 h (`capture-rules.ts`); older ones get the Save button. A PGN with result `*` counts
  as in progress, for the Save button too (the Lichess exports answer for running games).
- Lichess: the official game stream (`lichess-stream.ts`: NDJSON reader, line classifier,
  reconnects after 3 / 10 / 30 / 60 s, 60 s after a 429; a normal close without the end line
  triggers one check of the page data), `.result-wrap` kept as the fast hint. The end time
  of a game read from the page is estimated from `createdAt` + the sum of `moveCentis`.
- Chess.com: the game data (callback) every 10 s while the game runs (30 s while hidden, and
  at once on visibility changes; `poller.ts`), the four game-over selectors kept as the fast
  hint. On `/play/…` pages the game ID comes from Resource Timing entries of the page's own
  requests (`/callback/live/game/{n}`, `/game/live/{n}`, `/live/game/{n}`; the newest wins).

**Background**
- Tabs (`tab-tracker.ts`, `chrome.storage.session`): from `page-state` reports and
  `tabs.onUpdated` (URL changes, including in-page ones; a page off the game sites has no URL
  for the extension, which counts as leaving). A report whose URL isn't the tab's current page
  is ignored (sent just before a navigation). Leaving (`onRemoved`, another page) a game page:
  `captureFinished` with the leave resolvers (Lichess `_ids` export → page data; Chess.com game
  data → archive) and `leaveCaptureCheck` (mine; seen in progress, or recent); then a sync of
  that site 5 s later, and on every alarm for 30 min. The last leave and its result are kept
  for the Debug view.
- `auto-sync.ts` as planned (60 s minimum between alarm runs, 10 s after leaving a page,
  none for "Check for new games now"; at most 5 Lichess pages and 3 Chess.com months per run).
  Methods `lichess-sync` / `chesscom-archive-sync`, trigger `sync`. These count as new games
  for the site's auto-analyze (unlike history imports).
- `auto-sync` alarm every 3 min (created in `init()`, so also on update); on browser start
  one sync per site. Install / update injects the content scripts into open tabs.
- Delivery: `onQueueChanged` → `nudgeSite()` (200 ms debounce, only while games are ready) →
  `bridge-nudge` to every tab of the site URL → `ExtensionBridge.nudge()` posts `bridge-ready`
  (during a sync: once, after it). The page's code is unchanged; it already answers
  `bridge-ready` with `hello`.
- Queue entries: `trigger` (kept from the first capture when a pending game resolves) and
  `playedAt` (only when the PGN has a time of day).

**Popup**: header "N games waiting for the analysis site" / "No games waiting · N games on
the analysis site", the sentence saying what waiting means and where they go, pending ones
explained separately, whether the site is open in a tab, Open / Show the analysis site;
entry status labels "ready to send" / "not available yet" / "on the site" (with tooltips);
each entry's line has the played date and time (local), the method and the trigger
("auto: game ended on the page", "auto: after leaving the game page", "auto: background
check", "history import", …). "Automatic capture" section with each site's last check and
"Check for new games now". "Debug this tab" with Copy report and Start capture on this tab.
`popup.html?tab=<id>` debugs that tab (used when the popup is open as a page of its own, and
by the tests).

**Dates**: `src/capture/pgn-time.ts` (`playedAtDetail`, `localDateTime`, `formatPlayedAt`,
`readPgnHeaders`, the last moved from the queue). Games list: date over time in the local
zone (the column keeps its width), tooltip "Started 2026-10-18 05:30 (Asia/Tokyo)" (or
"Ended" for PGNs that only have the end); a date-only PGN is shown as written. The Chess.com
game-data PGN gets `EndDate` / `EndTime` (UTC) from `endTime`.

**Changes to existing tests (behaviour changed as asked, nothing weakened)**
- `phase5b-extension.spec.ts`, first test: a game captured while the site is open now
  arrives without the focus event, so the step that waited for badge "1" before dispatching
  `focus` would race; it now expects the row right away. The focus-triggered sync is still
  exercised in the same test (the duplicate check after it).
- `phase5b-games.spec.ts` runs with `timezoneId: 'UTC'` and expects "2026-10-04 05:33" (date
  and time) instead of "2026-10-04".
- The e2e helpers gained `setUsernames` / `queueEntry` (moved from the spec), `tabIdOf`,
  `openPopup(session, debugTab?)` (waits for the popup's `data-loaded` instead of the old
  "waiting" wording), and `launchWithExtension({ timezoneId, beforeLoad })`.
- `scripts/record-capture-fixtures.mjs` also records the finished game's stream, and with
  `--live-stream` a live TV game's stream until it ends.

**Checked that the new e2e tests catch the bugs**: with the install-time injection and the
bridge nudge switched off, "Tabs open before the extension was installed…" and "Delivery…"
fail; with them on, they pass.

**Known issues**
- Still unverified on the live sites (no login from here): which URL Chess.com's play page
  shows during a game and which requests it makes; whether the Lichess session export answers
  for a logged-in user. The Debug view shows both (Game ID source, method of each capture).
- Lichess correspondence games in progress don't hold the sync cursor back (they would for
  days); one that ends later is captured when its page is left, by Save, or by the history
  import.
- The Chess.com sync reads at most 3 archive months per run: after more than ~2 months
  without a sync, older months need Import my history.
- Lichess sends a running game's stream a few seconds late (3–60 s by time control); the page's
  result block is the faster signal while it lasts.
- `npm run format:check` fails on most files, as before this change (the code uses longer
  lines than `.prettierrc.json`'s 100); not one of the required checks, left alone.

**Checks (final run, 2026-10-19):** typecheck, lint, **382 unit tests** (33 files; +31:
`capture-live` 16, `capture-autosync` 8, `capture-dates` 5, bridge nudge 2), `npm run build`,
`npm run build:ext`, **55/55 e2e** (46 earlier + 9 in `phase5b-live-capture.spec.ts`; 6.5 min,
one worker): all pass.

**Measured**: bundles: background 247 kB (was 216), Lichess content script 46 kB (was 27),
Chess.com 160 kB (was 145), popup 26 kB (was 9), bridge 7 kB. New e2e tests take 1.3–8.2 s each
(the leave test waits for the 5 s sync after leaving).

## Phase 5b — Chess.com in-progress games (2026-10-19)

Report from live testing: Lichess works; on Chess.com two back-to-back games were not captured
live and only arrived later through the archive check. The Debug report showed the game page
`https://www.chess.com/game/185558711264` (no live/daily segment), "Game state: not found on the
site", event "Chess.com has no game live-185558711264", and on leaving the previous game "synced
only: the site has no such game".

### Diagnosis (probed from this machine, no login)

- Both reported games (185558645780, 185558711264) and the earlier one (185556791450) now
  answer 200 from `/callback/live/game/{id}` (finished, `isLiveGame: true`) and 404 `[]` from
  `/callback/daily/game/{id}`. So the type was right ("live"); the data simply wasn't there yet.
- Recent game IDs (they are multiples of 4, issued at roughly 440 per second): of 32 IDs from
  the last 4 minutes, 9 answered and **every one was already finished** (some had ended 2–4 s
  earlier); the other 23 answered 404 `{"message":"Game is not found."}`. No in-progress game
  ever answered. Conclusion: **Chess.com's game data answers 404 while a live game is running
  and 200 within seconds of its end.**
- The content script treated that 404 as final ("not-found": no watching, no button), and the
  background refused to fetch a game left in that state. Both paths therefore did nothing.
- URLs without the type (`/game/{n}`) map to live, which is right for these 12-digit IDs. Live
  IDs are 12 digits now and daily ones 10; for shorter untyped IDs the two ranges overlap
  (`/callback/live/game/1033338800` is a different, live game than daily 1033338800), so the
  data's own `isLiveGame` decides.

### Plan (written before code)

- `extractors/chesscom-callback.ts`: `fetchChessComGame(ref, fetch, untyped)`: for an untyped
  URL, the types to try by ID length (≥ 11 digits: live only; shorter: live, then daily), each
  accepted only when `isLiveGame` matches.
- Content (`chesscom.ts`, `capture-page.ts`): a 404 on a game page is "not available yet"
  (new state `not-available`): Save button "Game in progress", players unknown (not "not my
  game"), seen in progress; the game data keeps being checked every 10 s (30 s hidden), and the
  page's own requests that mention the game ID (Resource Timing, other than our own game-data
  requests) trigger a check at once and are listed in the Debug log. When the data appears and
  says finished: auto-capture as for any game that ended on the page. The ref is corrected to
  daily when the data says so.
- Background: leaving a `not-available` page captures (it no longer stops at "no such game").
  Chess.com's game data 404 (or a game still in progress) on leaving → retries of the game data
  after 10 s, 30 s, 1 min, 2 min and 5 min (`game-retry.ts`, kept in `chrome.storage.session`,
  woken by a timer and an alarm), then left to the archive check. Shown in Debug ("Retrying").
- Tests: unit (type candidates and `isLiveGame`, retry schedule incl. give-up and restart,
  `captureFinished` retry flag, leave action for `not-available`); e2e replaying the reported
  sequence: an untyped `/game/{id}` page answering 404 `{"message":"Game is not found."}`
  while the game runs, then the finished data → captured on the page (by the 10 s check, and at
  once after a page request about the game); leaving while it is still 404 → captured by a
  background retry. Fixture: the recorded 404 body.

Risks: the 10 s check of a page whose ID never exists keeps running while the page is open
(same cost as during a game); retries are capped at 5.

### Result (2026-10-19)

- Confirmed before coding (see Diagnosis), plus a second probe: 23 recent IDs that answered
  404 were asked again 4 minutes later; 13 now answered with a finished game whose end time
  came after the first probe. A 404 is "still being played".
- Built as planned. The content script's first check of a 404 page logs "Chess.com has no
  data for this game yet: it shares a live game's data once the game has ended"; each change
  of the game-data answer is logged ("Game data check: not available yet (404).", "…:
  finished."), and so is every distinct page request about the game ("Page request about this
  game: /analysis/game/live/…"). Debug shows the state "not available yet", My game "unknown
  until the site has the game's data", and the watchers with their check count and last
  answer.
- Background: `captureLeftGame` (shared by leaving and the retries); the Chess.com leave
  resolver maps a game-data 404 (and a rate limit) to "in progress" → `retry`; other
  failures still go to the archive lookup. Retries record each try in "Last game page left"
  and are listed as "Retrying" in Debug. Lichess games left in progress get the same retries.
- Tests: unit +6 (`capture-live`: the recorded 404, type candidates and `isLiveGame`, leave
  action and check for `not-available`, the retry flag, the retry schedule incl. give-up and a
  worker restart). E2E +3 (`phase5b-live-capture.spec.ts`, "Chess.com games with no data until
  they end": the page keeps checking through 404s and captures on the end; a page request about
  the game triggers the check at once (captured within 7 s, well before the 10 s check); closing
  the tab while it is still 404 → captured by the 10 s retry). With the old handling (404 =
  "no such game") all three fail.
- Checks: typecheck, lint, **388 unit tests**, build, build:ext, **58/58 e2e** (one worker,
  7.1 min): all pass.
- Known issue: whether Chess.com's page makes a request about the game when it ends is not
  known (it can't be recorded without playing); the 10 s check doesn't depend on it.

## Phase 5b — Delivery outcomes (2026-10-19)

Report: the popup has said "21 games waiting for the analysis site" for hours; reloading the
site or the extension never delivers them. The site is open at http://127.0.0.1:4173.

### Diagnosis

Read from a copy of the extension's own storage (Chrome profile, `Local Extension Settings`,
read only; LevelDB log + tables decoded with a throwaway script in the scratchpad), then each
waiting PGN run through the site's own `checkPgnText`:

- Queue: 8984 delivered, **21 ready**, all from history imports. Settings: site URL
  `http://127.0.0.1:4173` (the one in use), so the URL is not the cause.
- **15 Lichess games are variants** (2021 history): 9 Antichess, 5 Atomic, 1 Crazyhouse
  (`[Variant "…"]`). The site plays them as standard chess and fails on the first move that's
  illegal in standard chess ("Illegal move: Qc5 in position …"). The history import does not
  filter Lichess variants (the Chess.com one keeps chess and chess960 only).
- **6 Chess.com games have no moves**: 5 games of the 2022 Daily Chess Championship won on time
  before the opponent moved, 1 live game drawn by agreement at move 0. The site answers "no
  moves."
- What happens on each sync: the page answers `saved` with these keys under `failed` (with
  the reason); the bridge keeps failed games **ready** (only skipped for the rest of that sync),
  so every sync offers them again, they fail again, and they stay "waiting" forever. The
  reason is never stored or shown.
- Also found while probing: two kinds of unusual header lines make a standard game fail to
  parse (`[Event "The "big" one"]` with unescaped quotes, and `[Event 'x']` with single
  quotes): the tag line is read as moves. 23 other unusual header forms already import
  (lowercase or unknown tags, duplicates, `????.??.??`, missing / empty / contradicting
  Result, BOM, CRLF, tags on one line, `%` lines, `;` comments, FEN without SetUp, …).
- Site URL: the bridge runs only on the configured origin. `localhost` and `127.0.0.1` are the
  same server but different origins (and different IndexedDB libraries), so opening the site
  under the other name never received anything.

### Plan (written before code)

- `src/capture/pgn-games.ts` (shared by the site and the extension): `importProblemOf(pgn)`:
  an unsupported variant (anything but Standard, Chess960, From Position) or no moves at all;
  `checkPgnText` repairs malformed tag lines (quotes inside, single quotes) and parses again
  before giving up.
- Protocol: a failed delivery carries `kind`: `variant`, `no-moves`, `invalid` (won't parse)
  or `error` (couldn't store; worth another try). Optional field, same protocol version.
- Site (`library.saveBridgeGames`): already on the site → `duplicates`; a problem → `failed`
  with its kind; a standard game with unusual headers is saved.
- Extension queue: new status `rejected` (`rejectKind`, `rejectReason`; `dismissed`), not
  counted as waiting. The bridge marks `variant` / `no-moves` / `invalid` games rejected
  (`bridge-rejected`), keeps `error` ones ready, and marks already-stored ones delivered as
  before. Games with a variant or no moves are classified when they enter the queue (history,
  sync, Save) and never offered; games already waiting are classified when the extension
  starts. A rejected game isn't revived by history imports or the sync, only by Save / a link
  / paste or Retry.
- Popup: a "Not imported" section: "not imported (variant: Antichess)", "not imported (no
  moves)" with Dismiss; "rejected: <reason>" with Retry and Dismiss. Dismiss keeps the game's
  index row (so it isn't imported again) and drops its PGN.
- Site URL: the bridge is registered on both `127.0.0.1:<port>` and `localhost:<port>`, the
  background accepts both, and the popup's "open in a tab" check looks for both. The popup says
  which one received the games, since their libraries are separate.
- Tests: unit (classification, header repair, every page outcome incl. already on the site,
  bridge marking per kind, queue rejected / retry / dismiss / no revival / start-up
  classification, protocol `kind`, site origins); e2e: the reported set (variants, no-move
  games) plus a normal game, a game already on the site, unusual headers and an invalid game,
  with the popup's outcomes, Retry and Dismiss; delivery to `localhost` with `127.0.0.1`
  configured.

### Result (2026-10-19)

Built as planned.
- `importProblemOf` (variant / no moves), `describeImportProblem`, `repairTagLines`;
  `checkPgnText` re-reads a repaired text when the first reading has errors and keeps the
  reading with more games or, as many, fewer errors (a broken tag line can split one game in
  two).
- The site answers `failed` with `kind` (`variant`, `no-moves`, `invalid`, `error`; a page that
  throws while storing → `error`). The bridge (`rejectionOf`) marks `variant` / `no-moves` /
  `invalid` rejected through `bridge-rejected`; `error`, failures without a kind (an older,
  cached page) and unanswered keys stay ready for the next sync, as before.
- Queue: status `rejected` with `rejectKind`, `rejectReason`, `dismissed`; `markRejected`
  (variant / no-moves lose their PGN, invalid keeps it), `retryRejected`, `dismissRejected`,
  `classifyWaiting` (run in `init()`, i.e. on install, update and browser start: the reported
  21 are rejected as soon as the updated extension loads, before any sync). `addReady` rejects
  variants and no-move games on the way in (outcome `not-importable`) and doesn't revive a
  rejected game unless the trigger is Save, a link or a paste (`already-rejected`). Counts gain
  `rejected` (not dismissed); the badge still counts pending + ready only.
- Popup: "Not imported" section (reason per game, Retry for `invalid`, Dismiss for all), the
  header adds "· N not imported", entries say "not imported"; the Save button on a game page
  says "Not imported" with the reason; a paste says "not imported (…)".
- Site URL: `siteOrigins` / `siteMatchPatterns`; the bridge is registered on both loopback names
  (compared regardless of order: Chrome returns the patterns in its own order), the background
  accepts both origins, tab lookups use both.
- **Also fixed (Phase 5 test failing on this machine, before this change too):** the review
  test's "no main-thread task over 50 ms" check failed 3 of 3 on the previous commit while the
  machine was busy (OneDrive sync). Long Animation Frame attribution and a CPU profile pointed
  at the Review-sample click: `importPgn` (parse + render at the last position, 34–60 ms) then
  `goToNode(root)` (another render) in one task. New `AnalysisController.importPgnFromStart`
  parses in one task and shows the game from its start in the next (one render);
  `ReviewPanel.loadSampleGame` uses it. 5 of 5 runs then had no long task.
- **Test changes:** `capture-chesscom-tcn` "reproduces Chess.com's own PGN … (42 games)" got an
  explicit 30 s timeout, like the other heavy unit tests (`bot-selection-golden`,
  `perft-crosscheck`): it takes ~2 s alone but passed the 5 s default in the parallel run on the
  busy machine; no assertion changed. Exact `counts()` expectations gained `rejected: 0`. The
  bridge test of a page that throws now expects `kind: 'error'`. The settings e2e expects both
  loopback patterns, compared sorted. Fixture-free: the delivery tests use synthetic PGNs of the
  reported games' shape (no personal games recorded).
- Tests: unit `capture-delivery` (8: classification, header repair, every page outcome incl.
  already on the site and a storage error, protocol kind, the reported set through a real
  bridge + library sync with Retry and Dismiss, a storage error retried, queue-time and start-up
  classification, no revival, both site origins). E2E `phase5b-delivery.spec.ts` (2: the
  reported set — 6 waiting → none waiting, 2 on the site, 4 not imported with their reasons;
  Retry and Dismiss; the site opened as localhost with 127.0.0.1 configured).
- Known issue: `localhost` and `127.0.0.1` are separate libraries in the browser (IndexedDB is
  per origin); games go to whichever is open.
- Checks (2026-10-19): typecheck, lint, **396 unit tests** (34 files), build, build:ext,
  **60/60 e2e** (one worker, 8.8 min): all pass. A run before that had 59/60 (the Phase 3
  bot-worker test hit its 120 s limit in a 21-minute run while the machine was busy; it passed
  alone in 33 s and in the full run above).

## `npm run serve`: one origin (2026-10-19)

`localhost` and `127.0.0.1` are separate browser origins, so each has its own IndexedDB game
library (see "Delivery outcomes", known issue). Plan: `scripts/serve.mjs` answers every request
whose Host is `localhost` (or `[::1]`) with a `307` redirect to the same path on
`http://127.0.0.1:<port>` (`Cache-Control: no-store`, so nothing sticks if the port is later
used by something else), and also listens on `::1` so a browser that resolves `localhost` to
IPv6 first reaches the redirect. README note. Test: an e2e request to `localhost:4173` gets the
redirect (path, query kept), and the Phase 5b test that opens the site as `localhost` now
checks it lands on `127.0.0.1` (the hash survives the redirect) and gets its games there.

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

## Phase 6b — UX redesign (2026-10-19)

### Audit (screenshots before any change)

`tests/e2e/phase6b-screens.spec.ts` captures every screen at desktop (1440×900) and phone
(390×844) width into `test-results/phase6b-screens/`: Play (start, a piece selected, mid-drag),
Analysis (empty), Review (sample game reviewed on Quick, first key moment), Games (empty, two
games), Today, Puzzles. It also checks the page never scrolls sideways. Looked at all 16.

**Usability problems found**

Whole app
1. The header spends a full row on five technical badges (COOP/COEP, "Zero-Network Offline
   Shell", "Core Rules · PGN · IDB v4", Stockfish, Dev Overlay). On a phone they stack into five
   rows: the board starts ~330 px down the page.
2. An eight-card diagnostics strip (threading, network, datasets, rules, PGN, storage, engine,
   bot) sits under every screen. It means nothing to a player and doubles the page length on a
   phone.
3. Navigation is five tabs plus "Analyze Game →", which looks like a tab but is an action.
   There is no "Review" destination: review lives inside the Analysis Board panel. Today and
   Puzzles are separate tabs. On a phone the tabs wrap onto two rows.
4. The tab icons are emoji (⚔ 🔍 📚 ☀ 🧩); they render differently per OS and don't match the
   marble and obsidian theme.

Board feel (Play, Analysis, Puzzles share one renderer)
5. A dropped piece appears on its square instantly (no glide), and a piece doesn't lift until
   the pointer has moved: pressing a piece shows nothing but the selection ring. That's the
   "sticky" feel.
6. The lift is a 1.08 scale with a faint shadow; mid-drag the piece barely stands out
   (`desktop-play-dragging.png`).
7. A drop counts only on the exact square under the pointer: a drop a few pixels past the edge
   of the intended square lands on the neighbour (illegal → snaps back).
8. On touch screens the dragged piece sits under the finger, hidden.
9. No grab / grabbing cursors.
10. Legal-move dots are small (31% of a square) and capture rings thin; on the light marble
    squares the blue dots are low contrast.
11. The board size is fixed by the layout (600 px on desktop); it can't be resized.

Play
12. Eleven settings (bot tier, style, rating, min/max think, time control, color, board theme,
    piece set, max premoves, six toggles, volume) are always open under the move list.
    Changing color or time control silently restarts the game.
13. Six equal buttons (New Game, Flip, Hint, Takeback, Draw, Resign): no primary action.
14. Phone: the Piece Set select overflows the viewport, so the page scrolls sideways by 58 px.
15. Phone: the board is 290 px wide in a 390 px viewport (frame + panel padding).

Analysis and review
16. The right panel is one ~1,400 px column: engine lines, the whole review, the move tree,
    annotation buttons, comment box, editor buttons, PGN import/export, and two unlabeled theme
    selects. While reviewing, the move list is below the fold.
17. The review summary is dense (chart, two accuracy cards, a 10-row table, five truncated key
    moments, a card, four buttons). Nothing walks you through the key moments one at a time.
18. The board doesn't show the move's classification; you have to look at the move list.
19. Phone: engine lines are cut off; tree buttons wrap ("Main / Line", "Position / Editor").

Games, Today, Puzzles
20. Games: the extension status is a small grey line; capture features aren't visible.
21. Today: four equal cards and buttons, no single next step; "–" while loading.
22. Puzzles: a large empty gap between the status and the buttons; six equal buttons.

Not a bug: `desktop-today.png` shows the Games tab highlighted. The tabs have a 120 ms colour
transition and the screenshot was taken mid-fade; the spec now waits for transitions to end.

### Plan — step 2: board feel (written before code)

**Files**
- `src/render/board-feel.ts` (new): the tunable values, their ranges, defaults, and one shared
  store (subscribe, set, reset), persisted in `localStorage` (key `wc.boardFeel.v1`, every value
  clamped on load, all access in try/catch) so tuning survives a reload. `resolveDropSquare()`
  (pure): the drop square for a point, given the legal targets and the drop tolerance.
- `src/render/board-size.ts` (new): the remembered board size (`localStorage`
  `wc.boardSize.v1`), a CSS variable `--wc-board-size` on `<html>`, and the corner resize handle.
- `src/render/board-renderer.ts`:
  - Lift on press: pressing a movable piece lifts it at once (scale + shadow) and centres it
    under the pointer; the drag threshold decides only click vs drag. A click lets the piece
    glide back to its square.
  - Touch: once a touch drag starts, the piece is drawn `touchOffset` squares above the finger
    and the drop square is the one under the piece. On touch the threshold is doubled, so a
    tap never turns into an offset drag.
  - While dragging: the drop square (after tolerance) is highlighted, strongly when it's a
    legal target.
  - Drop: tolerance picks the nearest legal target within `dropTolerance` squares of the
    pointer when the square under it isn't one (also just off the board edge). A legal drop
    glides from where it was released to its square (`snapMs`), for moves, premoves and
    confirm-move; an illegal one slides back (`snapMs`, was a fixed 120 ms).
  - Cursors: `grab` over a movable piece (mouse only, from the cached board rect), `grabbing`
    during a drag anywhere on the page.
  - Move animations use `animationMs` unless a caller passes its own duration (the analysis
    board's step animation keeps its off / fast / normal setting, as Phase 4 specifies).
  - Live updates from the store; unsubscribed in `destroy()`.
- `src/render/overlay.ts`: larger legal-move dots with a dark rim (contrast on light marble),
  thicker capture rings, the new drag-target highlight.
- `src/ui/dev-overlay.ts`: a "Board feel" section: six sliders (drag threshold, lift scale,
  snap duration, drop tolerance, touch offset, animation speed) with live values, "Copy values"
  (JSON to the clipboard, so you can send them to me) and "Reset".
- `src/styles/main.css`: lift shadow, cursors, resize handle, layouts sized from
  `--wc-board-size`, the phone Piece Set overflow (problem 14).
- Board badges (spec, Phase 5): `BoardRenderer.setSquareBadge()` (one badge layer above the
  pieces); the analysis controller shows the current move's class icon (the review's existing
  icons) on the top-right corner of its destination square, inside the square so the board
  edge never clips it.

**Tests**
- Unit: `resolveDropSquare` (exact square, tolerance near an edge and just off the board, none
  outside tolerance, nearest of two), the feel store (clamping, persistence, reset, bad JSON),
  board-size clamping.
- E2E `phase6b-board-feel.spec.ts`: the panel's sliders change the board live; press lifts
  the piece (scaled) before any movement; a click still selects and a second click deselects;
  a drop 20% of a square past the intended square plays the move, with tolerance 0 it doesn't;
  a legal drop glides (a running animation ending on the square); touch drag (synthetic touch
  pointer events) draws the piece above the finger and drops on the square under the piece; a
  tap doesn't move; grab cursor over a movable piece; the board resize handle changes the size
  and it's remembered after a reload; board badges for every class in both orientations.
- Every earlier e2e test (premove queue, drag cancel, drag through opponent moves) unchanged.

**Risks**
- Lift on press writes a transform on pointerdown; must stay within the one-frame input budget
  (it's one style write). `npm run perf:drag` re-run.
- The glide on drop means the piece is mid-animation for `snapMs` after a drop; earlier tests
  that read piece positions right after a drop read `style.transform`, which is final at once.
- `localStorage` is used for these two per-device preferences only (the spec doesn't name a
  store for UI settings; Phase 8's settings panel can move them).

### Result — step 2: board feel and board badges (2026-10-19)

Built as planned. **Waiting for you to tune and approve** before the layout proposal (step 3).

**How to tune:** `npm run build && npm run serve`, open the app, press the backtick key (or the
"Dev Overlay" button). The "Board feel" panel at the bottom of the overlay has six sliders that
apply live to every board (Play, Analysis, Puzzles); changed values turn gold. Values are kept on
this device across reloads. "Copy values" puts them on the clipboard as JSON (the same line is
shown under the sliders); send them to me and they become the defaults. "Reset to defaults"
forgets them.

| Value | Default | Range | What it does |
|---|---|---|---|
| Drag threshold | 3 px | 0–12 | Travel before a press counts as a drag (doubled on touch) |
| Lift scale | 1.12× | 1–1.35 | Size of a held piece (was a fixed 1.08) |
| Snap duration | 110 ms | 0–300 | Glide into the square after a drop, and back home after an illegal one (was a fixed 120 ms back, no glide in) |
| Drop tolerance | 0.20 sq | 0–0.5 | How far past a legal square's edge a drop still lands on it |
| Touch offset | 0.80 sq | 0–1.5 | How far above the finger a touch-dragged piece is drawn |
| Animation speed | 170 ms | 0–400 | Played moves (bot, opponent, premoves); unchanged default |

**What changed in piece handling** (`board-renderer.ts`, `overlay.ts`, `board-feel.ts`)
- Press lifts at once: the piece scales up, gets a deep shadow with a faint gold glow and centres
  under the pointer before any movement. The threshold now only decides click vs drag; a click
  lets the piece glide back and selects it as before.
- Drop: the square under the piece is framed (faint on any square, bright blue on a legal one).
  The drop square comes from `resolveDropSquare()`: the square under the point if legal, else the
  nearest legal square within the tolerance (also just off the board's edge). A legal drop glides
  in from the release point (moves, premoves, confirm-move); an illegal one slides back.
- Touch: once a touch drag starts, the piece is drawn above the finger and drops where it is
  drawn. A tap selects without moving.
- Cursors: `grab` over a piece you can pick up (your pieces; on the opponent's turn too, for
  premoves), `grabbing` everywhere while holding one.
- Click-to-move hints: dots 38% of a square (was 31%) with a dark rim, capture rings thicker
  with a dark underlay.
- Board size: a grip in the board frame's bottom-right corner resizes every board (280–1100 px);
  remembered on this device; arrow keys on the grip resize by 16 px; double-click returns to the
  default (600 px). Hidden on stacked (phone/tablet) layouts. The layouts size their board column
  from `--wc-board-size`, and the page widens for big boards so the side panel keeps its room.
- Bug fixed on the way: pointer positions were mapped against the board's border box, but the
  squares fill the box inside its 2 px border, so hit-testing was off by up to 4 px toward the
  far edge. The renderer now measures the inner box.

**Board badges (Phase 5 spec addition):** the analysis board shows the current move's class icon
(the review's own icons and colours) on the top-right corner of its destination square, inside
the square so the board edge never clips it, with a short pop-in. None at the start position, on
unreviewed moves, or while the position editor is open. It follows navigation, a review finishing
and annotations being stripped.

**Deviations**
1. Lift on press (before the threshold) goes beyond "drags start immediately"; it's what makes a
   press feel like picking the piece up. The threshold still decides click vs drag.
2. The analysis board's step animation keeps its own off / fast / normal setting (Phase 4 spec,
   ~100 ms); "Animation speed" sets played moves elsewhere.
3. Board feel and board size are stored in `localStorage` (per-device preferences, read
   synchronously at start-up so the board never jumps size).
4. `phase3-premoves.spec.ts` asserted the old fixed lift scale (`scale(1.08)`); it now asserts
   the live lift scale from the feel store (same strictness, plus a check that it is > 1).
5. Phone fix (audit problem 14): the Play settings grid uses `minmax(0, 1fr)` columns and its
   selects truncate, so the Piece Set select no longer pushes the page 58 px sideways.

**Tests:** unit `board-feel.test.ts` (13): store clamping/persistence/reset/corrupt and blocked
storage, `resolveDropSquare` (exact, past an edge, diagonal corner, off the board, nearest of two,
flipped), board size. E2E `phase6b-board-feel.spec.ts` (10): live tuning, persistence and reset;
press lifts and a click selects/deselects; drag-target frame and a drop 0.15 squares past f3
landing and gliding; the same drop with tolerance 0 sliding back; touch drag above the finger and
a tap; grab cursor; corner resize, remembered, shared by Analysis, keyboard, double-click reset;
phone width; badges for all ten classes in both orientations (inside the top-right of the
destination square, not clipped); badges during a real review. `phase6b-screens.spec.ts` (4):
every screen at desktop and phone width, no sideways scroll.

**Checks:** typecheck, lint, **451 unit tests** (40 files; +13), `npm run build`, `npm run
build:ext`, **82/82 e2e** (one worker, 8.6 min): all pass. Main bundle 1,387.19 kB (247.94 kB
gzip), +11.8 kB.

**Not measured:** `npm run perf:drag` aborted twice on its own memory guard (2.80 GB free, it
needs 3.00 GB; other applications were using the memory). It has to be re-run before the phase
is done.

### Step 2 approved (2026-10-19)

You kept the default board feel values. Changes asked for:
- **Drop rule (confirmed, now pinned by a unit test):** if the square under the pointer is
  legal, the piece always lands there. Tolerance applies only when that square is illegal (or
  off the board) and a legal square is within reach; then the nearest one wins. For a touch
  drag, "the pointer" means where the piece is drawn, above the finger.
- **Board feel sliders move to the user-facing Settings** ("Board feel" section, with "Reset to
  defaults"); the dev overlay keeps only its metrics. This replaces the spec's "Board feel
  panel in the dev overlay" (your instruction). Part of the layout build below.
- Lift on press stays.

### Proposal — step 3: layout, navigation and shared components (waiting for approval)

Mockups (real board images from the app, layout mocked with the app's colours):
`test-results/phase6b-mockups/` — `desktop-play.png`, `desktop-play-setup.png`,
`desktop-review.png`, `desktop-puzzles.png`, `desktop-games.png`, `desktop-settings.png`,
`phone-play.png`, `phone-review.png`. Source: `test-results/phase6b-mockups/src/mockups.html`.

**Navigation.** One slim top bar: crest and name on the left, four destinations in the middle
(**Play · Puzzles · Review · Games**), a Settings button on the right. Original line icons
(crossed swords, star, chart line, card stack, gear) replace the emoji. On a phone the four
destinations move to a bottom tab bar and the top bar shows the screen name and Settings.
- **Review** = today's Analysis Board and its review panel, merged: one place to look at a
  game, with or without a review.
- **Today** folds into Puzzles: a "Today" strip at the top of Puzzles (each tile opens its
  session), and the number due shows as a count on the Puzzles tab. `#today` opens Puzzles.
- **Analyze Game →** goes: Play's ⋯ menu gets "Analyze this position", and the game-over
  panel's primary button is "Review this game".
- The five header badges and the eight-card diagnostics strip move into Settings › About &
  diagnostics (same text, kept for the tests), with the dev overlay switch.

**Settings** (a sheet from the right; full screen on a phone). Everything that isn't part of
starting or playing a game:
- Board: board theme, piece set, board size (shows the size, Reset).
- Board feel: the six sliders and "Reset to defaults".
- Moves: auto-queen, confirm move, max premoves, analysis move animation (off/fast/normal).
- Sound & effects: sound, volume, capture shards.
- About & diagnostics: engine and threading, offline status, storage version, dev overlay.
Settings are remembered on this device (today, theme, piece set, sound and the toggles reset
on every reload).

**Shared components** (in `src/ui/components/`; Phases 7 and 8 build on them):
1. `AppShell` — top bar, nav (top / bottom), content host, Settings sheet.
2. `BoardLayout` — board column (slots above and below the board, eval bar slot, transport)
   plus one side panel; stacked under 960 px; sized from the shared board size.
3. `SidePanel` + `Tabs` — tabbed panel with a fixed footer for the action bar; every tab
   keeps a reserved height (no layout shift when switching).
4. `ActionBar` — at most one primary button, secondary buttons, and a ⋯ `Menu`.
5. `Menu` (popover, keyboard and Escape), `Sheet` (side or full-screen dialog).
6. `Button` (46 px tall, 44 px minimum on touch), `SegmentedControl`, `ChipGroup`, `Slider`,
   `Toggle`, `SettingRow`, `StatTile`.
7. `PlayerStrip` (avatar, name, rating, captured pieces, clock).
8. `MoveList` (Play's two-column list; Review's tree reuses it), `CoachCard`, `Icon` set.

**Screens**
- **Play** (`desktop-play.png`, `desktop-play-setup.png`, `phone-play.png`): before a game the
  panel is a **New game** card: opponent level slider with tier names, style, time chips, play
  as White / Random / Black, "More options" (think time, takebacks, hints), and one primary
  **Play** button. Settings apply when you press Play (today, changing colour or time control
  restarts the game at once). In a game: Moves / Analysis tabs; the action bar has Hint,
  Takeback, Flip and ⋯ (Offer draw, Analyze this position, Game options, Resign). After the game:
  primary **Review this game**, secondary New game.
- **Review** (`desktop-review.png`, `phone-review.png`): opening line above the board, larger
  transport buttons under it. Panel tabs **Review · Analysis · Moves**.
  - Review tab: the two accuracy tiles, the win% chart, then the **coach card**: "Key moment
    1 of 5" with progress, the move and its badge, the eval change, the review's sentence, the
    best move and refutation, **Try it** (primary; today's Retry This Mistake), Show best line,
    previous / **Next moment**. Class counts become a row of chips (click to jump); the full
    table opens from "All moves by class". Review as White / Black / Both sits in the footer;
    Export PGN, Play vs bot here and the preset go in ⋯.
  - Before a review: a "Review this game" card (preset, primary Start review, sample game).
  - Analysis tab: engine on/off, lines, engine lines, best/threat arrow toggles.
  - Moves tab: the move tree, annotation glyphs and comment; ⋯ holds Import PGN, Export PGN,
    Copy FEN, Position editor.
- **Puzzles** (`desktop-puzzles.png`): Today strip, session control (Due reviews · My
  mistakes · Rated) with theme, status card with rating, Hint / Show solution / ⋯ (Retry,
  Analyze, Flip), rating and "from my games" tiles, and **Next puzzle** as the primary once a
  puzzle is solved or failed (while solving, the board is the action).
- **Games** (`desktop-games.png`): title with counts, **Import** menu (Paste PGN, Open file,
  drop files anywhere), a capture card (extension status in words, what it does, today's
  deliveries, capture settings), filter chips, taller rows with a Review button or the
  accuracy, and a floating selection bar ("2 selected · preset · Analyze 2 games"). Rows become
  cards on a phone.
- **Phone**: board edge to edge (8 px gutter, thinner frame: ~374 px wide instead of 290 px),
  compact player strips, move list as one scrolling line, four big action buttons, bottom nav.

**Every existing control has a home** (nothing is dropped): bot tier/rating/style, time
control, colour → New game card; min/max think, takebacks → More options; hints, takeback,
draw, resign, flip → action bar and ⋯; board theme, piece set, max premoves, auto-queen,
confirm move, shards, sound, volume, infinite analysis → Settings (infinite analysis →
Play's Analysis tab); analysis toggles, lines, editor, FEN, PGN, NAGs, comments, promote /
demote / delete → Review tabs and ⋯; review preset, perspective, retry, refutation, play vs
bot, export → coach card, footer, ⋯.

**Test impact.** The e2e tests reach some controls through the old layout (e.g.
`mode-tab-analysis` in 8 files, the theme select, the header badges). Test ids stay on the
moved controls where they still make sense; where a control moves into a menu, a tab or
Settings, the tests gain the click that opens it. No assertion is removed or loosened. New
tests: navigation, Settings (each section, persistence, both resets), coach card walk-through
and Try it, New game card, Games selection bar, Today strip, zero layout shift while switching
tabs and walking key moments, phone screenshots of every screen.

**Build order** (a commit after each, all earlier tests passing at every step):
1. Icons, `AppShell`, nav, Settings sheet (board feel moves out of the dev overlay; settings
   remembered).
2. `BoardLayout`, `SidePanel`/`Tabs`, `ActionBar`/`Menu`, `PlayerStrip`, `MoveList`; Play.
3. Review (merge, tabs, coach card).
4. Puzzles with the Today strip; Games.
5. Phone pass, screenshots, layout-shift and `perf:drag` (needs ≥ 3 GB free memory).

**Questions for you**
1. Merge Analysis into Review (one destination with Review / Analysis / Moves tabs)?
2. Fold Today into Puzzles (strip + count on the tab)? Phase 7's trainers would then also
   live under Puzzles, perhaps renamed "Train" then.
3. Move the technical badges and diagnostics into Settings › About?
4. New game settings apply on "Play" instead of restarting at once?
5. Remember all Settings on this device?

### Proposal approved (2026-10-19), with these decisions
1. Analysis merges into **Review**, but free analysis stays one click away inside Review: a
   new empty board (start position), the position editor, and Load FEN / PGN, with no game
   needed.
2. Today folds into the trainers and the destination is called **Train** now (Phase 7 adds its
   trainers there).
3. The badges and diagnostics move into Settings › About; the backtick overlay stays for
   performance numbers.
4. New-game choices apply only when Play is pressed; changing an option never ends a game in
   progress.
5. Every setting is remembered on this device and included in the JSON backup and restore.

Build stages, each with checks, desktop and phone screenshots looked at, and a commit:
app frame and navigation → Play → Review → Train → Games → Settings. `docs/SPEC.md` gets the
navigation and settings changes. `npm run perf:drag` runs at the end, once memory is freed.

### Stage 1 plan — app frame and navigation (written before code)
- `src/ui/components/icons.ts`: the original line icons (crossed swords, star, chart line, card
  stack, a generated 8-tooth gear, and the action icons).
- `src/ui/components/sheet.ts`: `Sheet`, a side dialog (full screen on phones): `role=dialog`,
  `aria-modal`, Escape / backdrop / close button, focus moves in and returns to the opener.
- `src/ui/settings-panel.ts`: the Settings sheet's sections; this stage has **About &
  diagnostics** (the five former header badges and the eight diagnostics cards, same test ids
  and text, plus the dev overlay switch `toggle-dev-overlay`). Later stages add their sections.
- `src/app.ts`: new shell: top bar (crest, title, nav, Settings), nav `mode-tab-play`,
  `mode-tab-train`, `mode-tab-review`, `mode-tab-games` with `aria-current`. Modes become
  `play | train | review | games` (`getMode()` returns them). Routes `#play #train #review #games`
  (and `?mode=`); old links still work: `#analysis → review`, `#today` and `#puzzles → train`.
  Train opens on its **hub** (the Today screen plus one primary "Start training", which picks
  the session with the most to do, as Puzzles did); a session shows the puzzle trainer with a
  "‹ Train" button back to the hub. The puzzle chunk and dataset worker still load only when a
  session starts. "Analyze Game →" leaves the header: until stage 2 it sits in Play's action row.
- Phone (≤ 760 px): the nav becomes a fixed bottom tab bar; the top bar shows the screen name.
- CSS for all of the above; the diagnostics strip and header badge row go.
- Tests: every e2e test that clicked an old tab clicks the new one (`mode-tab-analysis →
  mode-tab-review`, `mode-tab-today / mode-tab-puzzles → mode-tab-train`, plus "Start
  training" where a session was opened); `phase0` opens Settings before the dev overlay switch.
  No assertion removed. New `phase6b-shell.spec.ts`: nav and `aria-current`, every route and old
  alias, Settings open/close (button, Escape, backdrop) with focus return, About content, phone
  bottom nav, no sideways scroll.
- Risk: the review panel and puzzle tests reach screens through the tabs; all of them change
  in the same commit.

### Stage 1 result — app frame and navigation (2026-10-19)

Built as planned. Top bar with the crest, **Play · Train · Review · Games** (original line icons,
`aria-current="page"`, a count of what's waiting on Train) and a Settings button; on phones
(≤ 760 px) the destinations are a fixed bottom tab bar (each ≥ 44 px tall) and the top bar shows
the screen name. The Settings sheet (`Sheet`: dialog, Escape / backdrop / close, focus kept
inside and returned to the opener; full screen on phones) has **About & diagnostics**: the five
former header badges, the eight diagnostics cards (same test ids and text) and the performance
overlay switch. The backtick key still toggles the overlay.

Routes `#play #train #review #games` and `?mode=`; the old links `#analysis`, `#today`,
`#puzzles` still land in the right place. New: the address follows the destination (a reload or
a shared link reopens it) and a typed `#link` switches without a reload.

Train opens on its hub (Today plus **Start training**, which picks the session with the most to
do, as the old Puzzles tab did). A session shows the trainer with "‹ Train" back to the hub; the
Train tab while in a session also goes back to the hub, and from elsewhere it returns to the
session. The puzzle chunk and dataset worker still load only when a session starts.

**Found and fixed while checking:** `backdrop-filter` on the sticky top bar made it the
containing block of the phone tab bar (the bar sat at the top); the performance overlay
(z-index 1000) covered the sheet's switch (the sheet is now above it); the hidden Train count
put a "0" into the button's text; the phone padding under the tab bar lost to the base `.wc-main`
rule (moved to the end of the stylesheet).

**Tests:** e2e tests that clicked old tabs click the new ones (`mode-tab-analysis →
mode-tab-review` in 9 files; `mode-tab-today → mode-tab-train`; `mode-tab-puzzles →
mode-tab-train` + "Start training"; `aria-selected → aria-current`); `phase0` opens Settings
before the overlay switch. No assertion removed. New `phase6b-shell.spec.ts` (5): destinations,
routes and old links, Train hub/session, Settings (open/close three ways, focus, About content,
overlay switch, Tab trap), phone tab bar (bottom, touch-size, screen name, nothing hidden under
it, full-screen Settings, no sideways scroll).

**Checks:** typecheck, lint, 452 unit tests, build, build:ext, **87/87 e2e** (8.4 min). Screens
looked at: `desktop-today.png` (Train hub), `desktop-settings-about.png`, `phone-shell-play.png`,
`phone-today.png`, `phone-settings-about.png`, plus every screen in `phase6b-screens`.
"Analyze game" sits in Play's action row until stage 2.

### Stage 2 plan — Play (written before code)
- `src/ui/app-settings.ts`: `AppSettingsStore` (get / set / subscribe) holding board theme,
  piece set, auto-queen, confirm move, max premoves, capture shards, sound, volume, Play's live
  evaluation, and the **new-game choices** (colour, time control, bot rating, style, min/max
  think time, takebacks). Every board subscribes, so a theme chosen in Settings applies to Play,
  Review and Train at once. In memory for now; stage 6 adds remembering and backup.
- Shared components (`src/ui/components/`): `panel.ts` (a side panel whose height follows the
  board column, so its content never resizes the page, with tabs, a scrolling body and a fixed
  footer), `menu.ts` (⋯ popover: `role=menu`, arrow keys, Escape, click outside), `controls.ts`
  (segmented control, chips, switch row, select row, slider row).
- `src/ui/play-controller.ts` — the panel has three views:
  - **New game** (on load, and from ⋯ › New game): opponent slider with the five tier names
    (click one to jump), style (Solid / Aggressive / Gambiteer), ten time chips, play as White /
    Random / Black, "More options" (min/max think time, takebacks), primary **Play**. Choices are
    pending until Play (or any explicit new game, e.g. Review's Play vs bot here). With a game in
    progress (a move played, not over), Play first asks "End your current game?" (Keep playing /
    End it and play), and "Back to game" returns to it. Changing a choice never touches the game.
    The board stays playable on load, so a first move starts a game with the shown choices.
  - **In game**: status and evaluation, tabs Moves / Analysis (the live evaluation switch),
    action bar Hint (n), Takeback, Flip, ⋯ (Offer draw, Analyze this position, New game…, Resign).
  - **Game over**: the result, primary **Review this game** (opens it in Review), New game.
- Settings sections (wired to the store): Board (theme, piece set), Moves (auto-queen, confirm
  move, max premoves), Sound & effects (sound, volume, capture shards). Test ids kept.
- Player strips: original bot / person icons instead of ♚ ♔.
- Phone: board nearly edge to edge (smaller gutters and frame), the move list one scrolling
  line, four large action buttons.
- Tests: controls that moved gain the click that reaches them (Settings for theme / piece set /
  confirm move / max premoves; "More options" for think time; time chips instead of the time
  select; Play to apply new-game choices; the Analysis tab for the live evaluation, also in
  `scripts/perf-drag.mjs`). New `phase6b-play.spec.ts`: New game card (pending choices, Play
  applies, a game in progress never ends from a change, the confirm, Back to game), in-game
  menu and tabs, game over → Review this game, Settings applying to every board, phone layout.
- Risk: many Phase 3 tests play straight after load; the board stays live on load for that
  reason, and the first move switches the panel to the game view.

### Stage 2 result — Play (2026-10-19)

Built as planned.
- **Settings store** (`app-settings.ts`): one `AppSettingsStore` for board, input, sound, Play's
  live evaluation, Review's move animation and the new-game choices; every board follows it
  (Play itself, Review and Train boards through `app.ts`). Settings sheet sections Board,
  Moves, Sound & effects (`settings-sections.ts`), both ways in step with the store.
- **Shared components**: `panel` CSS (a side panel exactly as tall as the board column, its
  body scrolling inside, a fixed footer), `Tabs` (arrow keys, Home/End), `Menu` (⋯: arrow keys,
  Escape, click outside, focus back to the button), `controls.ts` (segmented control, chips,
  switch row on a real checkbox, select row, slider row).
- **New game card**: opponent slider with the five tier names, style, ten time chips, play as
  White / Random / Black, More options (think time, takebacks), one primary Play. Choices are
  pending; they apply on Play or any explicit new game. With a game in progress, Play asks
  ("This ends the game in progress": Keep playing / End it and play), and Review's Play vs bot
  here goes through the same question. "Back to game" when a game waits behind the card.
- **In game**: status and evaluation, Moves / Analysis tabs (live evaluation switch), action bar
  Hint (n) · Takeback · Flip · ⋯ (Offer draw, Analyze this position, New game…, Resign).
  **Game over**: Review this game (opens it in Review and starts the review) and New game.
- Player strips use the bot / person icons. Phone: board 374 px wide (was 290), the move list on
  one scrolling line, actions ≥ 44 px tall.

**Decisions**
- The board stays live on load (a first move starts a game with the card's choices), so a quick
  start needs no click; the card switches to the game on the first move.
- The game API setters (`setBotRating`, `setBotDelayRangeMs`, `setMaxPremoves`) change the
  current game as before *and* become the next game's choices (the tests set a bot delay and
  then start a game).
- A global `[hidden] { display: none !important }`: a component's `display` no longer beats the
  attribute (it did for "Back to game").

**Tests changed** (each gains the click that reaches a moved control; no assertion removed):
`phase3` (Settings for confirm move / theme / piece set; More options + Play for think time;
Play before the move-1 hint), `phase3-premoves` (time chip; Settings for max premoves),
`scripts/perf-drag.mjs` (Play, then the Analysis tab, for live evaluation),
`phase6b-shell` (visible elements measured with `checkVisibility()`: closed `<details>`
content has a layout box). New `phase6b-play.spec.ts` (7): pending choices and Play, a game in
progress never ending without the confirm (Back to game, Keep playing, End it and play), the
same from Review, tabs / action bar / menu (keyboard, outside click) / resign / Review this game,
Analyze this position, Settings applying to every board, phone.

**Checks:** typecheck, lint, 452 unit tests, build, **94/94 e2e** (93 in the full run, then the
one phone-layout test fixed as above and re-run). Screens looked at: `desktop-play-start.png`,
`desktop-play-new-game.png`, `desktop-play-confirm-end.png`, `desktop-play-menu.png`,
`desktop-play-game-over.png`, `desktop-settings-play.png`, `phone-play-start.png`,
`phone-play-new-game.png`, `phone-play-game.png`. Fixed after looking: "Back to game" showing
with no game (the `hidden` rule above), the small Play label (`.wc-btn-lg` lost to `.wc-btn`),
the current-move highlight spanning its whole column, a "Moves" heading repeating the tab.
