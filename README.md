# Wizard's Chess

An offline-first chess learning, playing, and Stockfish analysis suite built for locked 60/120 fps performance and zero runtime network requests.

## Run Modes

```bash
# 1. Development server (with COOP/COEP headers)
npm run dev

# 2. Production build (outputs to dist/)
npm run build

# 3. Offline local server (serves dist/ on localhost with COOP/COEP headers)
npm run serve
```

### Why Opening `index.html` Directly from Disk (`file://`) Is Not Supported

Opening `dist/index.html` directly via the `file://` protocol is **not supported** because modern browser security policies treat `file://` URLs as opaque origins:
1. **Web Workers & ES Modules:** Browsers block `new Worker(...)` and `<script type="module">` imports across `file://` paths under CORS rules.
2. **WebAssembly & NNUE Fetching:** Stockfish's `.wasm` binary and NNUE evaluation weights cannot be loaded via `fetch()` from a `file://` origin.
3. **Multi-Threaded Stockfish (`SharedArrayBuffer`):** Multi-threaded WebAssembly requires a cross-origin isolated secure context (`window.crossOriginIsolated === true`), which is only enabled when an HTTP server sends the headers:
   - `Cross-Origin-Opener-Policy: same-origin`
   - `Cross-Origin-Embedder-Policy: require-corp`
4. **Service Worker & PWA Offline Caching:** Service Workers and IndexedDB origin storage require `http://localhost` (or `https://`).

Always run `npm run serve` (or install the app as a PWA from `localhost`, which includes a service-worker COOP/COEP isolation shim and falls back cleanly to single-threaded Stockfish if cross-origin isolation is unavailable).

## Verification & Testing Scripts

```bash
npm run typecheck   # TypeScript strict type checking
npm run lint        # ESLint zero-warning check
npm test            # Vitest unit tests
npm run build       # Production build to dist/
npm run test:e2e    # Playwright end-to-end tests
```

## Dataset Generation (`scripts/` -> `data/`)

Runtime code makes **zero network requests**. All datasets live in `data/` and are generated via dev-time scripts under `scripts/`:

```bash
npm run data:openings   # Fetch lichess-org/chess-openings TSVs -> data/openings.json
npm run data:puzzles    # Stream & stratify 20k Lichess puzzles -> data/puzzles.json
npm run data:endgames   # Build & validate curated endgame drills -> data/endgames.json
npm run data:all        # Run all dataset scripts
```

## License

Licensed under **GPL-3.0-or-later** (see [`LICENSE`](./LICENSE) and [`LICENSES/README.md`](./LICENSES/README.md)).
