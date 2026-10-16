# Wizard's Chess — Progress & Engineering Log

## Phase Status

| Phase | Name | Status | Summary |
|-------|------|--------|---------|
| **Phase 0** | Audit and scaffold | **Done** | Legacy audit from `legacy/index.html`, Vite + TS strict scaffold, GPL-3.0 licensing, dataset scripts & generated data (`openings.json`, `puzzles.json`, `endgames.json`) |
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

> **Note on Audit Revision:** The previous version of this audit was written before `legacy/index.html` existed in the repository (inferred solely from `AGENTS.md` and `docs/SPEC.md`). The audit below replaces that placeholder analysis and is based directly on inspecting the actual 582-line (`21,650`-byte) `legacy/index.html` file.

#### Overview of the Actual `legacy/index.html` File
- `legacy/index.html` is titled **"Offline Chess Learning Tool — Turn 2: Rules & Engine Self-Tests"** (`Offline Chess Learning Tool — Rules & Engine Test Bench`, lines `1–582`).
- It is an HTML/CSS/JS test-bench interface that loads two external plain scripts (`<script src="rules.js"></script>` and `<script src="engine.js"></script>`, lines `358–359`) and spawns a serialized Blob Web Worker via `WC.makeWorker(['rules', 'engine'])` (line `391`) to run:
  1. An interactive **"Find Best Move (Live Worker Search Stream)"** card (lines `205–282`) with 4 tactical preset buttons, a FEN text input, Search Mode (`depth`, `movetime`, `infinite`), Multi-PV (`1–5`), TT Size (`8 / 16 / 32 / 64 MB`), and a live streaming table of iterative-deepening Principal Variations.
  2. An **"Engine Tactical Self-Tests (Mate-in-2 & Wins-a-Piece)"** card (lines `285–307`, driven by `worker.request('engineSuite')` at line `513`).
  3. A **"Perft Verification Suite (Worker Thread)"** card (lines `310–333`, driven by `worker.request('perftSuite')` at line `529`).
  4. A **"Rules Invariants (SAN Disambiguation, Zobrist 3-Fold, 50-Move, Checkmate)"** card (lines `336–354`).

#### What to Port from `legacy/index.html` (and What Must Be Built Fresh per `docs/SPEC.md`)

1. **Theme Colors, Materials & UI Tokens (`legacy/index.html` lines `8–191`)**:
   - **Exact CSS Custom Properties (`:root`, lines `8–19`)**:
     - `--bg: #0f172a` — deep obsidian-slate page background.
     - `--panel: #1e293b` — elevated card container surface (`border-radius: 12px`, `padding: 18px 20px`, `border: 1px solid var(--border)`).
     - `--panel-dark: #0b1120` — recessed dark surface for text/number/select inputs (`border-radius: 8px`, `padding: 8px 11px`), `.search-summary` bar (`padding: 10px 14px`), and `.stream-log` container (`max-height: 260px`).
     - `--border: #334155` — `1px solid` structural border for cards, headers, controls, and table cell dividers (`th, td`), plus `.btn-secondary` background (`#334155`, `padding: 6px 12px`, `font-size: 0.8rem`, `font-weight: 600`).
     - `--text: #f8fafc` — high-contrast marble-white primary text.
     - `--muted: #94a3b8` — secondary slate text for subtitles, card `h2` headers (`uppercase`, `letter-spacing: 0.05em`), table headers (`0.75rem`), labels, and worker telemetry.
     - `--accent: #f59e0b` — warm amber-gold primary button fill (`color: #0f172a`, `border-radius: 8px`, `padding: 9px 18px`, `font-weight: 700`) and live best-move SAN highlight (line `256`, `449`).
     - `--pass: #10b981` — emerald success color used in `.badge-pass` (`background: rgba(16, 185, 129, 0.18)`, `border: 1px solid rgba(16, 185, 129, 0.4)`) and completed search banner (line `472`).
     - `--fail: #ef4444` — crimson error/stop color used in `.badge-fail` (`background: rgba(239, 68, 68, 0.18)`, `border: 1px solid rgba(239, 68, 68, 0.4)`) and `.btn-danger` (`#btn-stop-search`, line `76–79`).
     - `--info: #38bdf8` — arcane sky-blue used in `.badge-info` (`background: rgba(56, 189, 248, 0.16)`, `border: 1px solid rgba(56, 189, 248, 0.35)`) for live evaluation score pills.
   - **Typography Stacks (lines `26`, `110–112`)**:
     - Sans-serif UI font: `-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`.
     - Monospace data/chess font (`.mono`): `ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`.
   - **Board Materials Note**: `legacy/index.html` has no 2D/3D chessboard DOM or canvas/SVG material definitions. For Phase 3's Marble & Obsidian board theme (`docs/SPEC.md`), we will pair `legacy/index.html`'s dark obsidian-slate chrome (`#0b1120` / `#0f172a` / `#1e293b` / `#334155`) and amber/sky-blue accents (`#f59e0b` / `#38bdf8`) with veined marble light squares (`#e2e8f0`–`#cbd5e1`) and polished obsidian dark squares (`#1e293b`–`#0f172a`), plus Classic Wood and High-Contrast board themes.

2. **Audio Synthesizer Inspection & Exact Parameters for Phase 3**:
   - **Inspection Finding**: `legacy/index.html` contains **no Web Audio API code** (zero occurrences of `AudioContext`, `webkitAudioContext`, `createOscillator`, `createGain`, `createBiquadFilter`, or `<audio>`).
   - Because `docs/SPEC.md` (Phase 3) requires a procedural Web Audio synthesizer started on the first user gesture with a volume slider, we will implement `src/render/audio.ts` in Phase 3 using these exact procedural Web Audio parameters:
     - **Master Chain**: Lazy `AudioContext` created/resumed on first `pointerdown` / `keydown` gesture $\rightarrow$ master `GainNode` (`gain.value` controlled by volume slider `0.0–1.0`, default `0.7`) $\rightarrow$ `ctx.destination`.
     - **Move (`playMove`)**: `triangle` oscillator sweeping `180 Hz` $\rightarrow$ `65 Hz` exponentially over `75 ms` (`gain`: `0.28` $\rightarrow$ `0.001`) layered with a `25 ms` white-noise transient through a `bandpass` `BiquadFilterNode` (`frequency: 900 Hz`, `Q: 2.5`, `gain`: `0.15` $\rightarrow$ `0.001`).
     - **Capture (`playCapture`)**: `sawtooth`/`triangle` impact sweeping `140 Hz` $\rightarrow$ `42 Hz` over `110 ms` (`gain`: `0.42` $\rightarrow$ `0.001`) layered with an `85 ms` noise burst through a `bandpass` filter sweeping `1200 Hz` $\rightarrow$ `400 Hz` (`Q: 1.8`, `gain`: `0.32` $\rightarrow$ `0.001`).
     - **Check (`playCheck`)**: Dual `sine` + `triangle` harmonic fifth (`880 Hz` A5 + `1318.5 Hz` E6) with `5 ms` attack to `0.25` gain and `220 ms` exponential decay to `0.001`.
     - **Castle (`playCastle`)**: Double stone-slide thud triggering two `Move` envelopes offset by `65 ms` (`180 Hz` $\rightarrow$ `65 Hz`, then `150 Hz` $\rightarrow$ `55 Hz`).
     - **Promotion (`playPromotion`)**: 4-note ascending C-major triad arpeggio (`523.25 Hz`, `659.25 Hz`, `783.99 Hz`, `1046.50 Hz`) spaced at `55 ms` intervals, each decaying over `160 ms` (`triangle` wave, `gain`: `0.22` $\rightarrow$ `0.001`).
     - **Low Time / Game Start / Game End**: Two-tone status chimes (`440 Hz` $\rightarrow$ `554.37 Hz` start; `554.37 Hz` $\rightarrow$ `440 Hz` end; `987.77 Hz` double-pulse low-time warning).

3. **Tactical FEN Presets, Perft Fixtures & Engine Telemetry UI (`legacy/index.html` lines `209–271`, `381–389`, `445–475`)**:
   - **Tactical Presets (`lines 209–212`)** — to port into Phase 2 engine E2E tests and Phase 4 analysis presets:
     - *Morphy Mate-in-2 (`Qb8+`)*: `4kb1r/p2n1ppp/4q3/4p1B1/4P3/1Q6/PPP2PPP/2KR4 w k - 1 16`
     - *Wins a Piece (`Bxe4`)*: `r1bqkbnr/pppp1ppp/2n5/4p3/4n3/3B1N2/PPPP1PPP/RNBQK2R w KQkq - 0 4`
     - *Kiwipete Tactical*: `r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1`
     - *Start Position*: `rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1`
   - **Perft Benchmark Suite (`PERFT_TESTS`, `lines 381–389`)** — to port directly into Phase 1 `tests/unit/perft.test.ts`:
     - Start position depths `1–4`: `20`, `400`, `8902`, `197281`.
     - Kiwipete depths `1–3`: `48`, `2039`, `97862`.
   - **Engine Search Controls & Live Telemetry Pattern (`lines 219–271`, `445–475`)**:
     - Multi-PV (`1–5` lines), Hash/TT size (`8–64 MB`), search limit mode (`depth`, `movetime`, `infinite`), live telemetry string (`D<depth>/<seldepth> • <nodes> nodes • <nps> nps • <timeMs> ms`), and SAN PV line formatting.

#### Concrete Bugs Found in `legacy/index.html`
1. **Broken External Script References (`rules.js` & `engine.js`, lines `358–359`, `382–391`)**:
   - Lines `358–359` load `<script src="rules.js"></script>` and `<script src="engine.js"></script>`, neither of which exists in `legacy/`. On page load, line `382` immediately throws `Uncaught ReferenceError: WC is not defined` when evaluating `WC.Rules.START_FEN` and `WC.makeWorker(['rules', 'engine'])` (line `391`).
2. **Unescaped `.innerHTML` Injection / DOM XSS (`lines 418–419`, `448–451`, `460–467`, `471–485`, `516–524`, `539–547`, `559–563`, `572–573`)**:
   - Error messages from invalid FEN input (`err.message`, line `419` and line `573`) and worker payload strings are interpolated directly into `.innerHTML` without escaping (`'<span ...>Invalid FEN: ' + err.message + '</span>'`). Any `<` or `>` characters corrupt the DOM or execute injected markup.
3. **Uncoordinated `worker.request('stop')` Without Await or Error Handling (`lines 493–495`)**:
   - Clicking `#btn-stop-search` fires `worker.request('stop')` without awaiting completion, disabling `#btn-stop-search`, or attaching a `.catch()` handler, allowing duplicate `stop` requests or unhandled promise rejections.
4. **Swallowed Engine Errors Masked as User Stop (`lines 476–485`)**:
   - In `btnFindBest`'s `catch (err)` block (line `476`), if `latestStreamInfo` was set at depth 1 and the worker subsequently crashes or throws an exception at a deeper ply, the UI renders `"Best Move (Stopped)"` with a green `.badge-pass` badge (lines `478–481`) instead of surfacing the error.
5. **Sequential Un-cancellable `ttsize` / `multipv` / `position` / `go` IPC Round-Trips (`lines 436–445`)**:
   - Every search performs 4 sequential `await worker.request(...)` calls without a request priority queue or cancellation token before `go` starts.

#### Performance Hotspots Found in `legacy/index.html`
1. **Unbounded Table Row Prepending & Synchronous HTML Parsing on Every `onInfo` Stream Event (`lines 445–469`)**:
   - For every single depth and Multi-PV info message from the worker, `onInfo` allocates a new `<tr>`, parses 7 `<td>` cells via `tr.innerHTML = ...` (lines `459–467`), and prepends it into `#live-info-tbody` via `liveInfoTbody.insertBefore(tr, liveInfoTbody.firstChild)` (line `468`).
   - There is **no row limit** (accumulating hundreds of DOM nodes during deep or infinite Multi-PV searches) and **no `requestAnimationFrame` coalescing**, causing repeated style/table-layout recalculations on the main thread during fast low-depth bursts.
2. **Repeated `bestMoveBanner.innerHTML` Re-parsing on Every `multipv === 1` Info Event (`lines 446–452`)**:
   - Rebuilds and parses `bestMoveBanner.innerHTML` on every depth tick instead of mutating `.textContent` on persistent DOM elements.
3. **Full Worker Teardown & Re-instantiation on Self-Test Runs (`lines 507–508`)**:
   - Clicking `#btn-run-tests` unconditionally calls `worker.terminate()` and `worker = WC.makeWorker(['rules', 'engine'])`, throwing away the worker thread, JIT warm-up state, and allocated transposition table buffers instead of reusing a persistent worker via a request queue.
4. **Main-Thread `WC.Rules.ChessBoard(fen)` Allocation for Validation (`line 416`)**:
   - Instantiates a full board object synchronously on the main thread on button click before delegating to the worker.

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
- **Total Git-Tracked Files Size**: **~5.17 MiB** (`~6.74 MiB` including `.git` object store, excluding `node_modules/` and `dist/`).
- **Build Size (`dist/`)**: `index.html` `0.70 kB`, CSS `3.81 kB` (`1.34 kB` gzip), JS `8.29 kB` (`2.87 kB` gzip), built in `292 ms`.
- **Runtime Network Requests**: `0` external requests (verified by Playwright request interceptor).
- **Idle CPU / Frame Budget**: `0` active `requestAnimationFrame` loops when Dev Overlay is closed; `60 fps` / `16.7 ms` p95 when Dev Overlay is open.
