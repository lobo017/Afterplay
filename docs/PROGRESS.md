# Wizard's Chess — Progress & Engineering Log

## Phase Status

| Phase | Name | Status | Summary |
|-------|------|--------|---------|
| **Phase 0** | Audit and scaffold | **Done** | Legacy audit from `legacy/index.html` (3D Gothic Cathedral Edition), Vite + TS strict scaffold, GPL-3.0 licensing, dataset scripts & generated data (`openings.json`, `puzzles.json`, `endgames.json`) |
| **Phase 1** | Core | **Done** | Rules adapter (`chess.js` + Chess960 + perft), game tree, adversarial PGN parser/writer (`[%eval]`, `[%cal]`, `[%csl]`), IndexedDB v1$\rightarrow$v2$\rightarrow$v3 migrations |
| **Phase 2** | Engine | **Done** | Stockfish 17.1 WASM worker client (MT + ST), MultiPV 1–5, priority queue, LRU cache, human-like bot (400–2400), Stockfish `go perft` cross-check suite |
| **Phase 3** | 2D board and play mode | Pending | Imperative SVG board, Web Animations, SVG overlay, canvas capture particles, Web Audio synth |
| **Phase 4** | Analysis board | Pending | Eval bar, MultiPV lines + ghost preview, user/best/threat arrows, FEN editor, opening lookup |
| **Phase 5** | Game review | Pending | MultiPV 2 review pipeline, win%/accuracy formulas, move classifications, 8 motif detectors |
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



