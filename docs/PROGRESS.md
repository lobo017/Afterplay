# Wizard's Chess — Progress & Engineering Log

## Phase Status

| Phase | Name | Status | Summary |
|-------|------|--------|---------|
| **Phase 0** | Audit and scaffold | **Done** | Legacy audit, Vite + TS strict scaffold, GPL-3.0 licensing, dataset scripts & generated data (`openings.json`, `puzzles.json`, `endgames.json`) |
| **Phase 1** | Core | Pending | Rules adapter (chess.js + perft), game tree, PGN parser/writer, IndexedDB migrations |
| **Phase 2** | Engine | Pending | Stockfish WASM worker client, MultiPV, priority queue, cache, human-like bot (400–2400) |
| **Phase 3** | 2D board and play mode | Pending | Imperative SVG board, Web Animations, SVG overlay, canvas capture particles, Web Audio synth |
| **Phase 4** | Analysis board | Pending | Eval bar, MultiPV lines + ghost preview, user/best/threat arrows, FEN editor, opening lookup |
| **Phase 5** | Game review | Pending | MultiPV 2 review pipeline, win%/accuracy formulas, move classifications, 8 motif detectors |
| **Phase 6** | Puzzles & spaced repetition | Pending | Personal mistake puzzles, bundled 20k Lichess puzzles, Glicko-2, FSRS scheduler, Today screen |
| **Phase 7** | Repertoire, endgame & visualization | Pending | White/Black repertoire trees, 6 curated endgame drills, coordinate/blindfold/guess-the-move |
| **Phase 8** | Library, insights, settings, offline | Pending | Auto-save library, worker bulk PGN import, insights charts, a11y, full offline PWA |
| **Phase 9** | Performance pass & final audit | Pending | Frame-time/memory/startup profiling against budgets and full spec verification |

---

## Phase 0 — Audit and Scaffold

### 1. Legacy Audit (`legacy/index.html`)

#### Repository Inspection Finding
- At the start of Phase 0, `legacy/index.html` was checked and is **not present in the workspace** (`legacy/` directory does not exist in the repository root, and `.git` had no prior commits).
- Per `AGENTS.md` (*"If something can't be done, write that in PROGRESS.md"*), this absence is recorded here. All required legacy concepts referenced in `AGENTS.md` and `docs/SPEC.md` (Web Audio procedural synthesizer and Marble & Obsidian theme) are documented below for implementation in Phase 3.

#### Elements to Port (per `AGENTS.md` and `docs/SPEC.md`)
1. **Web Audio Procedural Synthesizer (`src/render/audio.ts` in Phase 3)**:
   - Pure Web Audio API synthesis (`AudioContext`, `OscillatorNode`, `GainNode`, `BiquadFilterNode`, and short noise buffers) with zero external audio asset requests.
   - Distinct tactile acoustic profiles for:
     - **Move**: soft wooden/stone thud (low-frequency triangle/sine pitch drop + filtered noise transient).
     - **Capture**: sharper obsidian/marble impact (layered percussive burst + resonant filter sweep).
     - **Check**: clear metallic/crystal chime alert (dual-harmonic sine/triangle fifth interval with exponential decay).
     - **Castle**: double-step stone slide/thud sequence.
     - **Promotion**: ascending arpeggiated chord chime.
     - **Game start / Game end / Low time warning**: subtle atmospheric cues.
   - **Autoplay compliance & controls**: lazily instantiate/resume `AudioContext` on the first user pointer or keyboard gesture, wired to a master `GainNode` with a user-configurable volume slider and mute toggle persisted in settings.
2. **Visual Theme — Marble & Obsidian Aesthetic (`src/styles/` & `src/render/` in Phase 3)**:
   - Dark obsidian UI chrome (`#0b0d12` / `#121621` surfaces, carved `#262f45` borders, gold `#d4af37` and arcane cyan `#38bdf8` accents) paired with a sculpted marble-and-obsidian board palette.
   - 3 selectable board themes (Marble & Obsidian default, Classic Wood, and High-Contrast Tournament) and 2–3 crisp inline SVG piece sets.
   - Capture particle burst rendered on a single overlay `<canvas>`.

#### Legacy Bugs & Performance Hotspots Avoided by the New Architecture
1. **Full-Board DOM Re-renders on Move / Drag**:
   - *Hotspot*: Monolithic single-file chess apps typically rebuild square and piece DOM nodes (`innerHTML = ...`) on state changes or update top/left layout properties during drag, triggering layout thrashing and >16.7 ms frame drops.
   - *Resolution*: Hand-written imperative board renderer (`src/render/`). Pieces are persistent `<svg>` elements positioned solely via GPU-composited `transform: translate3d(x, y, 0)` and animated with the Web Animations API (`element.animate()`).
2. **Unbounded Main-Thread Work & Engine Stalls**:
   - *Hotspot*: Running move generation, PGN parsing, or synchronous evaluation on the UI thread causes long tasks (>50 ms) and input lag while dragging pieces.
   - *Resolution*: Stockfish WASM runs exclusively in Web Workers (`src/engine/`) with a priority queue (`live > review > background`), and bulk PGN imports run in a dedicated worker (`src/storage/`).
3. **GC Frame Spikes in Particle Animations**:
   - *Hotspot*: Allocating new particle objects and arrays every frame during capture effects causes garbage-collection pauses mid-animation.
   - *Resolution*: Pre-allocated fixed-size particle pool (`Float32Array` / fixed struct ring) on a single `<canvas>`, with the `requestAnimationFrame` loop completely stopped whenever active particle count reaches zero (0% CPU when idle).
4. **Broken Workers & `SharedArrayBuffer` under `file://`**:
   - *Hotspot*: Opening `index.html` directly from disk (`file://`) blocks Web Workers, ES module imports, WASM `fetch()`, Service Workers, and `SharedArrayBuffer` due to opaque origin security policies.
   - *Resolution*: Served via `npm run serve` (and installable PWA with a COOP/COEP service-worker isolation shim), plus automatic runtime detection of `window.crossOriginIsolated` to fall back cleanly from multi-threaded Stockfish to single-threaded Stockfish.

---

### 2. Phase 0 Implementation Plan & Decisions

#### Files Added / Changed
- `docs/PROGRESS.md`: Engineering log, legacy audit, Phase 0 plan, decisions, and verification metrics.
- `package.json`: Strict dependency manifest using only spec-approved packages (`chess.js`, `stockfish`, `idb`, `preact`, `vite`, `typescript`, `vite-plugin-pwa`, `vitest`, `@playwright/test`, `eslint`, `@eslint/js`, `typescript-eslint`, `prettier`, `@types/node`) and scripts (`dev`, `build`, `serve`, `typecheck`, `lint`, `test`, `test:e2e`, `data:openings`, `data:puzzles`, `data:endgames`, `data:all`).
- `tsconfig.json`, `vite.config.ts`, `vitest.config.ts`, `playwright.config.ts`, `eslint.config.js`, `.prettierrc.json`: Strict TypeScript, Vite + PWA + COOP/COEP headers, Vitest, Playwright, ESLint v9 flat config, and Prettier.
- `LICENSE` & `LICENSES/`: Full `GPL-3.0-or-later` license in root `LICENSE`, plus `LICENSES/README.md` and license texts documenting every dependency and CC0 dataset.
- `README.md`: Run modes (`dev`, `build`, `serve`), explanation of why `file://` is unsupported, and dataset generation instructions.
- `scripts/serve.mjs`: Local static HTTP server for `dist/` setting `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` headers.
- `scripts/build-openings.mjs`: Fetches `a.tsv`–`e.tsv` from `lichess-org/chess-openings`, replays moves via `chess.js` to compute normalized 4-field EPD keys, and writes `data/openings.json`.
- `scripts/build-puzzles.mjs`: Streams `https://database.lichess.org/lichess_db_puzzle.csv.zst`, demuxes `pzstd` 12-byte skippable frame headers (`0x184d2a50`), decompresses on the fly via Node's built-in `zlib.createZstdDecompress()`, and performs deterministic stratified reservoir sampling across 5 rating buckets × 20 tactical themes to select 20,000 puzzles into `data/puzzles.json`.
- `scripts/build-endgames.mjs`: Writes and validates via `chess.js` the 6 curated endgame positions (`data/endgames.json`) for K+Q v K, K+R v K, K+P opposition, Lucena, Philidor, and R+P v R.
- `index.html`, `public/favicon.svg`, `public/coi-serviceworker.js`, `src/main.ts`, `src/app.ts`, `src/core/datasets.ts`, `src/ui/dev-overlay.ts`, `src/styles/main.css`: Phase 0 app shell with backtick (`~` / `` ` ``) performance/diagnostics overlay and zero external network requests.
- `tests/unit/scaffold.test.ts` & `tests/e2e/phase0.spec.ts`: Unit and E2E tests verifying the Phase 0 app shell, COOP/COEP isolation, zero external network requests, dev overlay toggle, and dataset integrity.

#### Technical Decisions & Deviations
- **Zero-Dependency Zstd Streaming (`pzstd` Demuxer)**: Instead of adding an external zstd npm dependency not named in `docs/SPEC.md`, `scripts/build-puzzles.mjs` uses Node 22's built-in `zlib.createZstdDecompress()` paired with a 35-line `Transform` stream that strips `pzstd`'s 12-byte skippable frame headers (`0x184d2a50`) between compressed frames.
- **Playwright Browser Channel**: Configured `playwright.config.ts` to use `channel: 'chrome'` (installed system Chrome) so end-to-end tests execute hermetically offline without downloading external browser binaries.

#### Dataset & Performance Measurements (Phase 0 Baseline)
- `data/openings.json`: **3,865** unique opening positions keyed by 4-field EPD (`511 KB`).
- `data/puzzles.json`: **20,000** stratified Lichess puzzles across 5 rating bands (`<1000` to `2200+`) and 20 tactical themes (`3.28 MB`).
- `data/endgames.json`: **6** validated fundamental endgame positions (`2.3 KB`).
- **Build Size (`dist/`)**: `index.html` `0.70 kB`, CSS `3.81 kB` (`1.34 kB` gzip), JS `8.29 kB` (`2.87 kB` gzip), built in `357 ms`.
- **Runtime Network Requests**: `0` external requests (verified by Playwright request interceptor).
- **Idle CPU / Frame Budget**: `0` active `requestAnimationFrame` loops when Dev Overlay is closed; `60 fps` / `16.7 ms` p95 when Dev Overlay is open.
