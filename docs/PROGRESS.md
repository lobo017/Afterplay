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
| **Phase 5b** | Capture extension + Games list | **Done** | Chrome MV3 capture extension (Lichess, Chess.com, queue, popup, backfill), localhost bridge, Games list with background review queue, IndexedDB v4 |
| **Phase 6** | Puzzles & spaced repetition | Pending | Personal mistake puzzles, bundled 20k Lichess puzzles, Glicko-2, FSRS scheduler, Today screen |
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
(11: pasted PGN round trip + focus sync; Lichess without login → page data, Games list,
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
`npm run build:ext`, **46/46 e2e** (30 earlier + 15 Phase 5b + Phase 1's extended migration
test; 5.8 min, one worker): all pass.
- A first full run was stopped by the environment (the machine ran low on memory) after 31
  tests, all passing.
- The user's full run then had 45/46: the extraction-failure test read the notifications
  right after the Save button turned "failed", but the content script set the button before
  telling the background, which creates the notification. The content script now reports
  the failure first, and the test polls; the failure-path tests passed 3 times in a row, then
  the full run above.
