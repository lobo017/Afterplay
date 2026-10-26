<!-- Archive of docs/PROGRESS.md lines 1871-2647 (verbatim). Phase 5b and npm run serve -->

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

