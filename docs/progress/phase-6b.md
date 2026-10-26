<!-- Archive of docs/PROGRESS.md lines 2822-3489 (verbatim). Phase 6b -->

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

### Stage 3 result — Review (2026-10-19)

**Plan (written before code, condensed here as built):** the analysis board and the game review
become one screen. Board column: opening line, eval bar + board, large move-navigation buttons
(start, back, forward, end, flip). Side panel (the shared panel, as tall as the board column):
a **free-analysis toolbar** (New board · Edit position · Load FEN / PGN), the status and
evaluation, then tabs **Review · Analysis · Moves**. The review panel keeps every test id; its
parts are rearranged around a coach card.

Built:
- **Free analysis, one click away, no game needed:** *New board* (start position, nothing kept,
  switches to Analysis), *Edit position* (the editor takes the panel's place, "Done" returns),
  *Load FEN / PGN* (a sheet showing this game's PGN; Load accepts a FEN, which opens Analysis, or
  a PGN, which opens Review; a bad paste keeps the sheet open with the error; Copy). The review's
  annotated export opens the same sheet.
- **Tabs:** Review (default), Analysis (engine lines, best / threat arrow switches, clear my
  arrows, FEN with Copy), Moves (tree, variation actions, annotation glyphs, comment). Analyze
  this position (from Play) and a puzzle's Analyze open Analysis; Review this game and a saved
  review open Review.
- **Coach card** (the Review tab after a review): "Key moment k of N", the key moments as a row of
  chips (badge + move; the sentence kept for screen readers and tests), the move card, **Try it**
  (Phase 5's Retry This Mistake: "Stop trying" while on), Show refutation, Previous / Next moment
  (in game order, wrapping; "First moment" before the first). Below: the mistakes navigation, the
  win% chart, the two accuracy cards, and "All moves by class" (the counts table) as a disclosure.
  Footer: Review as White / Black / Both and ⋯ (Play vs bot from here, Export annotated PGN).
- **Before a review:** an intro ("Review this game"), depth, a large **Start review**, Sample game.
  Afterwards the same controls are one compact row (Start review reads "Review again").
- **Settings:** "Move animation in Review" moved to Settings › Moves; the Review board follows the
  board theme, piece set and capture shards from Settings (its two unlabeled selects are gone).
- **Keyboard:** board shortcuts (arrows, Home/End, F, Space) are ignored while a sheet is open;
  arrow keys on tabs and choice groups move between them, not through the game.

**Found and fixed while checking**
- Layout shift on switching perspective: "First moment" / "Next moment" changed the button's width
  (now fixed and unwrapped).
- The phone page scrolled sideways after resizing from desktop: each chip's visually hidden
  sentence was absolutely positioned with no positioned ancestor inside the scrolling chip row, so
  it escaped the row's clipping (chips are positioned now).
- A control scrolled into view could sit under the sticky top bar / phone tab bar / the Review
  footer: `scroll-padding` on the page and on the panel body.
- The Load sheet showed a lone `*` (an empty game's PGN) and a stale status.

**Tests changed** (the click that reaches a moved control; no assertion removed):
`phase4`, `phase4-navigation`, `phase2-engine-restart`, `scripts/perf-drag.mjs` (Analysis tab
before the engine lines; the Load sheet before the PGN box; Settings for the move animation);
`phase5-review` (the class table's disclosure before clicking counts; ⋯ before Export / Play vs
bot; Escape to close the PGN sheet the export opened; the chart scrolled into view and clicked
through its locator; the phone test's "outside" tap on the status banner, as the old panel title
is gone); `phase5b-games` (the Blunder badge looked for in the class table). Two Phase 5
assertions on the retry button's label follow the spec's new name: "Retry This Mistake" → "Try
it", "Stop Retrying" → "Stop trying". New `phase6b-review.spec.ts` (7): tabs (click, arrows),
New board / Edit position / Load FEN and PGN (and a bad paste), the coach walk-through (every
moment, wrap both ways, chip marked, board badge, zero layout shift, Try it, Next moment leaving
the retry), the ⋯ menu and export, Settings' move animation and quiet board keys under a sheet,
Analyze this position → Analysis, phone.

**Checks:** typecheck, lint, 452 unit tests, build, **101/101 e2e** (10.0 min). Screens looked at: `desktop-analysis-empty.png`, `desktop-review-done.png`, `desktop-review-key-moment.png`, `desktop-review-try-it.png`, `desktop-review-load.png`, `desktop-review-editor.png`, `phone-review-done.png`, `phone-review-key-moment.png`, `phone-review-coach.png`. Fixed after looking: the coach card was below the chart and cut off (now first), the phone coach buttons wrapped badly (2×2 grid), the phone card title was squeezed by the eval column, "Load FEN / PGN" was cut off on phones ("Load").

### Stage 4 plan — Train (written before code)
- Hub: the page heading, one primary **Start training** (the session with the most to do) with a
  line saying what it will start, and the Today cards as the other ways in (their buttons
  become secondary). The Train tab's count follows every puzzle attempt and review save.
- Session (`puzzle-trainer.ts`) in the shared panel: a compact Today strip (reviews due, new from
  my games, rated today), the session switch (Due reviews / My mistakes / Rated) and theme, a
  status card with the rating, the prompt, Hint and Show solution with ⋯ (Retry, Analyze, Flip),
  the solution line, my rating, and **Next puzzle** in the footer: the large primary once a
  puzzle is solved or failed, a plain button (skip) while solving. Board look from Settings.
- Phone: the board first, then the panel, nothing sideways.
- Tests: test ids kept (Retry / Analyze / Flip gain the ⋯ click; no test uses them today). New
  `phase6b-train.spec.ts`: hub (Start training's line, Today cards, count), session panel
  (strip numbers, the menu, Next puzzle's two states), phone.

### Stage 4 result — Train (2026-10-19)

Built as planned.
- **Hub:** the heading, one primary **Start training** with a line saying what it opens ("Your 3
  due reviews", "2 new puzzles from your games", or "Rated puzzles near 1500": the same choice
  it makes), and the Today cards as the other ways in (their buttons are secondary now). The
  Train tab's count follows every attempt and review save (`PuzzleStore.onChange`).
- **Session** in the shared panel: a Today strip (reviews due, new from my games with the total in
  its tooltip, rated today solved/played), the session switch in the segmented style, theme, the
  puzzle card (status, rating, prompt, source), Hint and Show solution with ⋯ (Retry this
  puzzle, Analyze the position, Flip board), the solution line, and the footer: my puzzle rating
  (with the last change) beside **Next puzzle**, which is the large primary once the puzzle is
  solved or its solution shown and a plain skip button while solving.
- The session's board takes the board look and capture shards from Settings.

**Found and fixed while checking:** the rating, "reviews due" and "from my games" were repeated
below the puzzle and clipped under the footer; the Today strip has the counts and the footer has
the rating now.

**Tests:** no existing test changed (Retry / Analyze / Flip moved into ⋯; no test used them).
New `phase6b-train.spec.ts` (4): the hub's single primary and its line, the live Train count and
"Your 1 due review" after a failed attempt comes due, the session panel (strip numbers, the ⋯
items, Flip, Next puzzle's two states, Retry enabled once the puzzle is over, Analyze → Review's
Analysis tab), phone.

**Checks:** typecheck, lint, 452 unit tests, build, **105/105 e2e** (9.3 min). Screens looked at: `desktop-today.png` (hub), `desktop-train-hub.png`, `desktop-train-session.png`, `phone-train-session.png`, `phone-puzzles.png`, `phase6-screens/puzzle-desktop-solved.png`.

### Stage 5 plan — Games (written before code)
- Header: the page heading with "N games · M analyzed" and one **Import** menu (Paste PGN…,
  Open PGN file…; dropping files anywhere still works).
- A capture card: the extension's status in words (not detected / connected · up to date / N
  received), what it does, my accounts as the extension sent them, and the auto-analyze switch.
- Filters stay labelled selects in one bar (they have many uses in tests; restyled, bigger).
- Rows taller and easier to hit. A floating selection bar appears while games are selected:
  "N selected · depth · **Analyze N** · ✕".
- Phone: the bar sits above the tab bar. Tests: the paste helpers open the Import menu first.

### Stage 5 result — Games (2026-10-19)

Built as planned: the page heading with "N games · M analyzed", one **Import** menu (Paste PGN…,
Open PGN file…; dropping files still works), a capture card (status in words, what it does or
how to install it, my accounts, the auto-analyze switch), the filters in one bar, taller rows,
and a floating selection bar ("N selected · depth · **Analyze N** · ✕") while games are
selected; on phones it sits above the tab bar.

**Found and fixed while checking:** the phone selection bar cut "2 selected" and wrapped "Analyze
2" (the label is visually hidden on phones; the button says the count).

**Tests:** the paste helpers (`phase5b-games`, `phase6b-screens`) open the Import menu first. New
`phase6b-games.spec.ts` (3): Import menu and file picker, summary, capture card without the
extension; the selection bar (appears, counts, clears, analyzes); phone.

**Checks:** typecheck, lint, unit tests, build, **108/108 e2e** (9.5 min). Screens looked at:
`desktop-games-selected.png`, `phone-games-selected.png`, `desktop-games-list.png`,
`phone-games-list.png`.

### Stage 6 plan — Settings (written before code)
- `settings-persistence.ts`: `Preferences` keeps the app settings in `localStorage`
  (`wc.settings.v1`, read synchronously so the first frame has them) and mirrors the app
  settings, board feel and board size into one IndexedDB settings record (`app.preferences`), so
  the existing JSON backup carries them. A device with no saved settings takes them from that
  record; a restore applies a backup's record everywhere.
- `settings-feel-section.ts`: Settings › Board feel (the six sliders, live, changed values in
  gold, "Reset to defaults") and the board size (shown, "Default"); the dev overlay keeps only
  its performance numbers (your decision; the overlay's JSON / "Copy values" line goes too).
- `settings-data-section.ts`: Settings › Your data: "Download a backup" (a dated JSON file) and
  "Restore a backup…" (checked, counted, confirmed, then applied: games, reviews, puzzles,
  cards, accounts, auto-analyze and every setting, with the screens refreshed).
- `docs/SPEC.md`: the navigation and settings decisions written into Phase 6b.
- Tests: unit `app-settings.test.ts` (9); e2e `phase6b-settings.spec.ts` (5): section order and
  the overlay without the panel, Board feel live + reset, everything remembered after a reload,
  backup download → change → restore (and a non-backup file refused), phone. The board-feel
  test that used the overlay panel uses Settings; the Play spec's section list grows.

### Stage 6 result — Settings (2026-10-19)

Built as planned.
- **Remembered on this device:** every setting (board, board feel, board size, moves, sound,
  Review's move animation, Play's live evaluation) and the new-game choices. App settings in
  `localStorage` `wc.settings.v1`, read before the first frame; board feel and size keep their
  own keys. All three are mirrored (300 ms after the last change) into the IndexedDB settings
  record `app.preferences`, so the existing JSON backup carries them. A device with no saved
  settings but a record in the database (site data partly cleared) takes the record.
- **Settings sheet**, in order: Board (theme, piece set, board size with Reset), **Board feel**
  (the six sliders, changed values in gold, "Reset to defaults"), Moves, Sound & effects,
  **Your data**, About & diagnostics. The dev overlay shows performance numbers only.
- **Your data:** "Download a backup" writes the preferences record first, then saves
  `wizards-chess-backup-YYYY-MM-DD.json`; "Restore a backup…" checks the file, says what it holds
  ("1 game, 1 review and 3 puzzles, and replaces your settings"), restores after Restore, applies
  the settings everywhere and refreshes the Games list (accounts, auto-analyze) and Train. A file
  that isn't a backup is refused with a message.
- `docs/SPEC.md` Phase 6b now records the four destinations, Review / Train, Play's choices, the
  Settings sheet, what's remembered and backed up, the drop rule and lift on press, and the
  Board feel defaults you approved.

**Found and fixed while checking:** Escape didn't close the Settings sheet after a restore (the
focused Restore button had just been hidden, so focus was outside the sheet): Escape now closes an
open sheet wherever focus is, and focus goes back to "Restore a backup…" after the confirmation
closes. The board size row said "Default" twice (now "Reset", disabled at the default; the hint
says the grip is on wide screens).

**Tests:** unit `app-settings.test.ts` (9): sanitizing, merging new-game choices, restore,
remembering, the database record both ways, backup parsing and naming. E2E
`phase6b-settings.spec.ts` (5): section order and the overlay without the panel; Board feel live
and Reset; everything remembered after a reload (new-game choices, theme, piece set, auto-queen,
max premoves, Review's animation, sound, volume, snap duration, board size); backup → change and
delete → refused non-backup → restore → all back; phone. Changed: the board-feel test that drove
the overlay's panel drives Settings' section (its check of the overlay's JSON / "Copy values" line
is gone with that line); the Play spec's list of sections includes the new two.

**Checks:** typecheck, lint, **461 unit tests** (41 files), build (main bundle 1,420.22 kB, 260.77 kB gzip: +33 kB over the board-feel commit for the shell, components and five redesigned screens), build:ext, **113/113 e2e** (10.3 min). Screens looked at: `desktop-settings-board-feel.png`, `desktop-settings-restore.png`, `phone-settings.png`.
