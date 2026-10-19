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

Slower measurement scripts, kept out of `npm test`:

```bash
npm run perf:drag        # Frame times while dragging during engine analysis (needs a build)
npm run perf:review      # Game review speed and review-engine threads (needs a build)
npm run calibrate:bots   # Bot strength calibration (ACPL and blunder rate per level)
npm run fixtures:review  # Re-record the engine results behind the classification fixtures
npm run review:compare   # Quick preset vs. depth-18 classifications (docs/classification.md)
node scripts/record-capture-fixtures.mjs  # Re-record the capture extension's page/API fixtures (network)
# Re-fetch the Lichess reference game (needs a Lichess API token, no scopes):
#   PowerShell: $env:LICHESS_TOKEN = "lip_..."; node scripts/fetch-lichess-game.mjs
```

How the game review classifies moves, and why: [docs/classification.md](docs/classification.md).

The end-to-end tests run against the built site and extension: run `npm run build` first
(the extension spec rebuilds `dist-ext/` itself).

## Games list and the capture extension

The **📚 Games** tab lists every game you capture or import: source, date, your color,
opponent and ratings, result, time control, opening, and whether it has been analyzed.
Filter by source, result and analysis; sort by date, opponent or accuracy. Select games and
press **Analyze** to review them in the background (the preset defaults to **Standard**);
**Auto-analyze new games** reviews each newly captured or imported game on **Quick** (history
imports are not reviewed automatically). Opening an analyzed game shows its saved review
without running the engine again. **Paste PGN**, **Open PGN file…** and dropping `.pgn`
files on the list import games directly; the same game is never stored twice.

The website itself stays offline. Games from Lichess and Chess.com come through a separate
Chrome extension, the only component that touches the network (lichess.org,
www.chess.com, api.chess.com).

### Loading the extension

```bash
npm run build:ext     # builds the unpacked extension into dist-ext/
```

1. Open `chrome://extensions`, switch on **Developer mode**.
2. **Load unpacked** → choose the `dist-ext/` folder.
3. Pin "Wizard's Chess capture" to the toolbar. The badge counts captured games the site
   hasn't collected yet.
4. In the extension's popup, open **Settings** and enter your Lichess and Chess.com
   usernames (they decide which games are yours, and the site uses them for "Review as").

### Setting the site URL

The extension delivers games to the analysis site through a small content script that it
registers on **one** URL: the **Analysis site URL** in Settings, `http://127.0.0.1:4173` by
default (`npm run serve`). If you serve the site elsewhere (another port, or `localhost`),
change it there; only `http://localhost:<port>` and `http://127.0.0.1:<port>` are accepted.
Games are handed over as soon as they are captured while the site is open in a tab (focused
or not), and whenever its tab opens or regains focus. The popup's "N games waiting" counts
games captured but not yet copied into the site's Games list. Without the extension the site
works as usual.

### How games are captured

- **Save button** on game pages, and **Save game to Wizard's Chess** in the right-click menu
  of game links.
- **Automatic capture** (Settings; on by default; your usernames tell the extension which
  games are yours):
  - when a game you play ends on the page (Lichess: its official game stream; Chess.com: the
    game's data, checked every 10 s while the game runs; the game-over markers on the page
    as a faster hint),
  - when you open a game of yours that ended in the last 6 hours (e.g. Chess.com moving from
    /play/online to the game's page after the end),
  - when you leave or close a game page (the extension fetches the game itself),
  - and as a safety net, your recent games from the official history endpoints, every 3
    minutes while a Lichess or Chess.com tab is open, right after you leave a game page and
    for 30 minutes after, and at browser start. The first check of an account goes 24 h back;
    use Import my history for older games.
- **Debug this tab** (popup) shows what the capture script sees on the current tab (URL, game
  ID and where it came from, game state, whether it's your game, what it watches, the last
  detection events) and the background's view (settings, the last check of your recent
  games, the last game page left). **Copy report** copies it as text. Tabs opened before the
  extension was loaded or updated get the script when it is installed or updated, or with
  **Start capture on this tab**.
- **Popup**: paste a game link (one per line) or a PGN. Chess.com links come from the
  monthly archive and stay *pending* until the game appears there (it can lag up to 12 h;
  retried every 15 minutes for 48 hours, or with **Retry now**).
- **Import my history** (popup): your Lichess history and Chess.com monthly archives, one
  request at a time, fetching only what's new on later imports.
- If extraction fails, a notification opens the popup, which offers the game's link for
  pasting.

| Method | Where | Official? |
|---|---|---|
| Lichess single-game export with your Lichess session | Lichess game page | Official API; now needs a login, so it only works where your session cookie goes along (the page itself) |
| Lichess export by IDs (`POST /api/games/export/_ids`) | links, popup | Official API |
| Lichess game history (`/api/games/user/{name}`) | Import my history | Official API |
| Lichess page data (`page-init-data` JSON in the game page) | game page, links (fallback) | **Unofficial** — may break when Lichess changes its pages |
| Chess.com game data (`/callback/live/game/{id}`, TCN-encoded moves) | Chess.com game page | **Unofficial** — may break when Chess.com changes it |
| Chess.com Share → PGN dialog | game page (fallback) | **Unofficial** — depends on Chess.com's page markup |
| Chess.com monthly archives (`api.chess.com/pub/...`) | links, Import my history, background check of recent games | Official Published-Data API |
| Lichess game stream (`/api/stream/game/{id}`) | end of a game on its page | Official API |
| Lichess games of a user since a time (`/api/games/user/{name}?since=…`) | background check of recent games | Official API |
| Chess.com game ID from the page's own requests (Resource Timing), on /play pages | auto-capture | **Unofficial** — depends on which URLs Chess.com's play page loads |
| Game-over markers on the page (Lichess `.result-wrap`, Chess.com game-over dialog) | auto-capture (fast hint) | **Unofficial** — the game data / stream above don't depend on them |

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
