# Third-Party Licenses & Dataset Attributions

Wizard's Chess is licensed under **GPL-3.0-or-later** (see root `LICENSE`).
Every runtime dependency, development tool, and bundled dataset used by this project is listed below along with its license.

## Runtime Dependencies

| Package | Version | SPDX License | Source / Copyright |
|---------|---------|--------------|--------------------|
| `stockfish` | `^17.1.0` | `GPL-3.0-or-later` | Stockfish Authors & NMrugg (`stockfish.js`) — see `LICENSES/GPL-3.0-or-later.txt` |
| `chess.js` | `^1.0.0` | `BSD-2-Clause` | Copyright (c) 2025 Jeff Hlywa (`jhlywa@gmail.com`) — see `LICENSES/BSD-2-Clause-chess.js.txt` |
| `idb` | `^8.0.2` | `ISC` | Copyright (c) Jake Archibald — see `LICENSES/ISC-idb.txt` |

## Build, Testing & Linting Dependencies

| Package | Version | SPDX License | Source / Copyright |
|---------|---------|--------------|--------------------|
| `vite` | `^6.2.0` | `MIT` | Copyright (c) 2019-present VoidZero Inc. and Vite contributors |
| `vite-plugin-pwa` | `^0.21.1` | `MIT` | Copyright (c) 2021-present Anthony Fu & contributors |
| `typescript` | `^5.8.2` | `Apache-2.0` | Copyright (c) Microsoft Corporation |
| `vitest` | `^3.0.7` | `MIT` | Copyright (c) 2021-present Anthony Fu, Matias Capeletto |
| `@playwright/test` | `^1.51.0` | `Apache-2.0` | Copyright (c) Microsoft Corporation |
| `eslint` / `@eslint/js` | `^9.21.0` | `MIT` | Copyright OpenJS Foundation and other contributors |
| `typescript-eslint` | `^8.26.0` | `MIT` | Copyright (c) 2019-present TypeScript ESLint and contributors |
| `prettier` | `^3.5.3` | `MIT` | Copyright (c) James Long and contributors |
| `@types/node` | `^22.13.9` | `MIT` | Copyright (c) Microsoft Corporation and DefinitelyTyped contributors (type declarations only, not shipped) |
| `wrangler` | `^4.160.0` | `MIT OR Apache-2.0` | Copyright (c) Cloudflare, Inc. (deploy tool for `npm run deploy:*` only, not shipped) |

## Bundled Datasets (`data/`)

| Dataset File | Source | SPDX License | Description |
|--------------|--------|--------------|-------------|
| `data/openings.json` | [`lichess-org/chess-openings`](https://github.com/lichess-org/chess-openings) | `CC0-1.0` | Public domain ECO opening classifications (`a.tsv`–`e.tsv`) keyed by normalized EPD — see `LICENSES/CC0-1.0.txt` |
| `data/puzzles.json` | [Lichess Open Puzzle Database](https://database.lichess.org/#puzzles) | `CC0-1.0` | Public domain tactical puzzles (`lichess_db_puzzle.csv.zst`), stratified 20k subset — see `LICENSES/CC0-1.0.txt` |
| `data/endgames.json` | Wizard's Chess Contributors | `GPL-3.0-or-later` | Hand-curated fundamental endgame training positions (K+Q v K, K+R v K, K+P opposition, Lucena, Philidor, R+P v R) |

## Bundled artwork

| Files | Source | SPDX License | Description |
|-------|--------|--------------|-------------|
| `src/render/classic-pieces.ts` (the "Classic" piece set) | SVG chess pieces by [Colin M.L. Burnett](https://en.wikipedia.org/wiki/User:Cburnett), taken from [`lichess-org/lila`](https://github.com/lichess-org/lila/tree/master/public/piece/cburnett) at commit `5b44d719ec59` by `scripts/build-piece-set.mjs` | `GPL-2.0-or-later` (the author also offers them under GFDL and BSD) | The twelve piece drawings, unchanged except that each file's outer `<svg>` element is replaced by the app's own; used here under the terms of GPL version 3 — see `LICENSES/GPL-3.0-or-later.txt` |

## Original to this project (GPL-3.0-or-later)

Not taken from any other work, so nothing further to attribute:

- the piece sets Cathedral, Staunton and High contrast, and every board theme (Tournament Green included: its colour values are this project's own): generated in code (`src/render/piece-sets.ts`, `src/render/themes.ts`);
- the app icons (`public/`, rendered from `public/favicon.svg` by `scripts/build-icons.mjs`) and the capture extension's toolbar icons (drawn by `scripts/build-extension.mjs`);
- the Web Audio synthesizer (`src/render/audio.ts`, ported from this project's earlier `legacy/index.html`);
- the endgame positions (`data/endgames.json`, listed above).

The built-in sample game is the Opera Game (Paul Morphy, Paris 1858), a historical game record.
