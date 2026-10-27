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

`npm run serve` serves the site at **http://127.0.0.1:4173**. Opening
`http://localhost:4173` redirects there (a `307` that keeps the path, query and `#…`). The
browser treats `localhost` and `127.0.0.1` as two different sites, each with its own storage,
so without the redirect the same app could hold two separate game libraries (and puzzle
progress) depending on which name you typed. Bookmark or install the `127.0.0.1` address.

### Why Opening `index.html` Directly from Disk (`file://`) Is Not Supported

Opening `dist/index.html` directly via the `file://` protocol is **not supported** because modern browser security policies treat `file://` URLs as opaque origins:
1. **Web Workers & ES Modules:** Browsers block `new Worker(...)` and `<script type="module">` imports across `file://` paths under CORS rules.
2. **WebAssembly & NNUE Fetching:** Stockfish's `.wasm` binary and NNUE evaluation weights cannot be loaded via `fetch()` from a `file://` origin.
3. **Multi-Threaded Stockfish (`SharedArrayBuffer`):** Multi-threaded WebAssembly requires a cross-origin isolated secure context (`window.crossOriginIsolated === true`), which is only enabled when an HTTP server sends the headers:
   - `Cross-Origin-Opener-Policy: same-origin`
   - `Cross-Origin-Embedder-Policy: require-corp`
4. **Service Worker & PWA Offline Caching:** Service Workers and IndexedDB origin storage require `http://localhost` (or `https://`).

Always run `npm run serve` (or install the app as a PWA from `localhost`).

### Offline and installing

The production build registers one service worker (`src/sw.ts`). On the first load it caches every
file of the build (about 20 MB: the app, both Stockfish builds, the puzzle set); after that the
app starts and works with no network and no server: play, analysis, review, all four trainers and
the Games list. It also serves the pages with the COOP/COEP headers, so the multi-threaded engine
still works offline and in the installed app, and the page falls back to single-threaded Stockfish
only if isolation is unavailable. Settings › About & diagnostics shows whether the cache is
complete. A newer build is downloaded in the background and waits behind an "A new version is
ready" banner, so a game in progress is never reloaded; **Reload** takes it. Chrome offers to
install the app (the manifest has PNG icons; `npm run build:icons` redraws them from
`public/favicon.svg`). `tests/e2e/phase8-offline.spec.ts` stops the server, switches the browser
offline and checks all of this.

## Performance and spec status

Measured on a 60 Hz laptop display, plugged in, in headless Chrome (headless numbers are indicative; see "Measure on a quiet
machine" below). Details and every run: [docs/progress/phase-9.md](docs/progress/phase-9.md).

| Budget (docs/SPEC.md) | Measured |
|---|---|
| Frame time p95 ≤ 16.7 ms while dragging and animating with the engine on `go infinite` | 16.7–17.0 ms, 0 long tasks (`npm run perf:drag`) |
| 120 fps on high-refresh screens | not testable here (60 Hz display); main-thread work is 1.4–3.1 ms per frame, so a 8.3 ms frame has at least 2.6× headroom |
| Input latency ≤ 1 frame | 0.6–1.4 ms in the pointer handlers, painted in the next frame |
| Idle | no render work: 0 animation-frame callbacks in 500 ms |
| Cold start to an interactive board ≤ 1.5 s | 0.1–0.5 s |
| Memory: no growth across 50 games | +0.2–0.3 MB over 40 games (JIT code), DOM nodes and listeners flat (`npm run perf:memory`) |
| Review of a 40-move game on Quick, one thread, ≲ 30 s | 17.4–17.9 s, UI responsive (`npm run perf:review`) |
| No main-thread task over 50 ms | none in a tour of 16 flows (`npm run perf:tasks`). Exception: on page load the browser's one-time audio start (60–340 ms, once, only with sound on) and its first text layout in a cold process (35–89 ms) |

The requirement-by-requirement audit of the spec is in [docs/progress/phase-9.md](docs/progress/phase-9.md): everything is
**Done** except two **Partial** items (the 50 ms rule on page load as above, and 120 fps on a real high-refresh display) and the
optional Phase 10 (native engine mode), which is **Missing**.

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
npm run perf:drag        # Frame times, input latency and main-thread cost per frame while dragging during analysis (needs a build)
npm run perf:review      # Game review speed and review-engine threads (needs a build)
npm run perf:memory      # 50 games in a row: heap, DOM, listeners and workers after forced GC, plus a heap-snapshot diff
npm run perf:tasks       # A tour of 16 flows (play, review, import, Insights, trainers, backup…): no main-thread task over 50 ms
npm run calibrate:bots   # Bot strength calibration (ACPL and blunder rate per level)
npm run fixtures:review  # Re-record the engine results behind the classification fixtures
npm run review:compare   # Quick preset vs. depth-18 classifications (docs/classification.md)
node scripts/record-capture-fixtures.mjs  # Re-record the capture extension's page/API fixtures (network)
# Re-fetch the Lichess reference game (needs a Lichess API token, no scopes):
#   PowerShell: $env:LICHESS_TOKEN = "lip_..."; node scripts/fetch-lichess-game.mjs
```

How the game review classifies moves, and why: [docs/classification.md](docs/classification.md).

**Measure on a quiet machine.** Frame times are only meaningful while the display is awake, the laptop is plugged in and
other apps are closed. A locked session or a screen that is off makes headless Chrome lose vsync (a blank page then runs
at ~56 Hz), so `perf:drag` first times a blank page and stops with exit code 4 if it is not at the display rate
(`PERF_RELATIVE=1` compares against that floor instead; such a run says nothing about the 60 fps budget).
`perf:drag`, `perf:review` and `perf:tasks` also stop below 3 GB (2.5 GB) of free memory.

The end-to-end tests run against the built site and extension: run `npm run build` first
(the extension spec rebuilds `dist-ext/` itself).

## Games list and the capture extension

The **📚 Games** tab is the library: every game you play here (a finished game against the bot
is saved by itself), capture or import: source, date, your color, opponent and ratings, result,
time control, opening, and whether it has been analyzed. Filter by source, result, colour,
analysis, opening, date and accuracy; sort by date, opponent or accuracy. Your usernames (Settings ›
Your games) tell the library which side is yours. Selected games can be deleted (it asks first).
Bulk imports of any size are read in a worker. The **Insights** tab beside **Library** charts your
reviewed games: accuracy by game phase, blunders per 10 moves over time, the motifs behind your
mistakes, results by opening and your puzzle rating; clicking any point shows the positions (or
games, or the puzzle) behind it. Select games and
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
default (`npm run serve`, which also redirects `localhost` there). If you serve the site
elsewhere (another port, or `npm run dev` on `localhost`), change it there; only `http://localhost:<port>` and `http://127.0.0.1:<port>` are accepted.
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

## Puzzles and the Today screen

**🧩 Puzzles** has three sessions:

- **Due reviews**: puzzles you missed (and every puzzle from your games) come back on a
  spaced-repetition schedule (FSRS-5). A wrong move brings a puzzle back in 10 minutes; a
  solve schedules it days ahead (sooner after a hint, later when solved quickly).
- **My mistakes**: every Mistake, Blunder and Miss **of yours** in a reviewed game becomes a
  puzzle: the position before your move, set up by your opponent's previous move, with the
  engine's best move as the answer. "Yours" means a player name equals one of your usernames
  for that game's site (the capture extension's settings; `Lobo017` on Lichess until it has
  sent them), so captured, pasted and imported games all count once analyzed. A position is
  skipped when the second-best move is nearly as good as the best (within 10 win% points).
  They are made when a review is saved, and checked again when your usernames change.
- **Rated**: the bundled 20,000 Lichess puzzles near your rating, mixed or by theme, with a
  Glicko-2 puzzle rating (a puzzle's first try counts; a hint makes it unrated). The puzzle
  set is loaded in a worker the first time Puzzles opens, so it never slows the app's start.

The opponent's move is played first, as on Lichess. A move other than the expected one is
checked by the engine and accepted when it mates, keeps a forced mate, or (in puzzles that
aren't about mate) keeps a decisive advantage or is as good as the solution.

**☀ Today** shows what's due: puzzle reviews, new puzzles from your games, rated puzzles
played today, repertoire positions, endgame and visualization drills, and games not
analyzed yet, each with a button to start. The trainers below keep their cards in the same
FSRS schedule as the puzzles, so "Start training" opens whichever has the most due.

## Repertoire, endgames and visualization

All three live in the Train hub, beside the puzzles.

- **Repertoire**: a White and a Black repertoire, each a tree of moves. *Build* it by playing
  your moves and the replies you expect on the board, or by importing a PGN (every game and
  variation goes in; a game that starts from another position is left out). *Drill* it: the
  opponent's moves are played for you, and in each position that is due you play a move of
  your repertoire. Each position is one spaced-repetition card, shared by every move order
  that reaches it. When a reviewed game of yours (matched to your side by your usernames)
  leaves your repertoire, the review says where, and whether it was you or your opponent.
- **Endgames**: K+Q v K, K+R v K, K+P (opposition), Lucena, Philidor and R+P v R, each played
  out from the side to move. In the three mate drills the opponent plays the exact best defence
  from solved tables (`src/trainers/endgame-tables.ts`), so your moves are counted against the
  true best possible; the others are played against the engine; Lucena
  and R+P v R end when you promote (or win the rook) and the engine agrees it is decided;
  Philidor ends in a draw by the rules, or by agreement after ten moves of holding it.
- **Visualization**: a 30-second *coordinate* round (click the named square), *blindfold*
  drills (the moves are read out on an empty board, then you find pieces; the length grows
  as you answer everything right) and *guess the move* through your own games (a match with
  the move played, or with the review's best move, counts).

Everything stays on this device and is included in the JSON backup.

## Playing against the bot

Press Play on the New game card; the bot's strength (400–2400), style and thinking time, the time control, your colour and
takebacks are all chosen there. **Hint** (three per game) shows the engine's best move. The move you then play carries the
comment `Hint used: <suggested move>` in the saved game, its PGN and the Moves tree, and the review says how many of your
moves followed a hint.

## Keyboard and screen readers

Every board can be played from the keyboard: Tab to the board, arrow keys move the cursor,
Enter or Space picks a piece up and puts it down, Escape cancels, and in the promotion picker the
piece's letter (Q, R, B, N) chooses. Moves, results and the cursor's square are announced through
one live region. On the analysis board the arrow keys still step through the game after a click.
Move classifications are an icon plus a name, never colour alone.

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
