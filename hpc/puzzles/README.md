# Mistake puzzles for the gift copy

An offline search, outside `hpc/history/`: for each game in the player's history file, the engine's best move at the
player's stored worst move. The output feeds "puzzles from my mistakes" without a full review of every game. Nothing here
is app code, and nothing here has run on Juno yet.

## What it does

Input: `gift.local/history/restore-phased.json` (read only). A game is chosen when it is a standard game from a site, finished,
at least 10 plies, with a stored worst move of the player's side at ply 2 or later that lost at least 20 win%.

Per chosen game (`mine-positions.mjs`):

1. Replay the stored PGN to the player's move at the stored ply. The puzzle starts at the position before the opponent's
   last move (`fen`), `moves` are the opponent's move and the engine's best move.
2. Search the position before the player's move: depth 18, 2 lines, one thread (the settings of the history review,
   `hpc/history/lib/settings.mjs`). Scores are turned into win% with the app's formula (`src/review/formulas.ts`).
3. Filters, each counted (`lib/positions.mjs`, `DROP_REASONS`, in this order): played move is the best move; win% before
   outside 25 to 90 (a forced mate up to mate in 5 may be above 90); mate longer than 5; only one legal move; best move
   not at least 10 win% better than the second best; trivial recapture (the opponent's last move took on a square and the
   best move takes on that square); then a second search of the position after the played move (1 line, depth 18) and the
   measured loss, which must reach the review's Mistake threshold (10). The class (Mistake or Blunder) comes from
   `classFromWinDrop` in `src/review/classification.ts`.
4. A short best line in SAN (up to 6 plies), the played move in SAN, win% before and after, the mate distance if any.

Games left out before any search (`SELECTION_REASONS`) are counted too.

## Files

| File | |
|---|---|
| `mine-positions.mjs` | one shard: `--input <file> --dir <work folder> --shard <k> --shards 8 --commit <hash> [--stop-after-minutes <m>] [--limit <n>]`. Appends to `<dir>/parts/part-<k>-of-8.jsonl` game by game; the same line again resumes. |
| `merge-positions.mjs` | the shards into `puzzles.json` (schema version, a short hash of the input, entries by game id) and `puzzles.counts.json` (counts only). |
| `lib/positions.mjs` | the pure parts (choosing, replay, filters, part files, resume, merge); tested by `tests/unit/mistake-puzzle-script.test.ts` with invented games. |
| `job.sbatch`, `merge.sbatch`, `container.sh` | the Juno job (array of 8 tasks, at most 4 at once) and its merge, following `hpc/jobs/history-engine.sbatch`. |

Output entry (one line of `puzzles.json`, about 300 bytes): `id, ply, fen, moves, bestLineSan, playedSan, class, loss, before, after, mateIn`.

## On Juno

Everything lives in `~/work/wizard-chess-hpc/` and `~/scratch/wizard-chess-hpc/mistake-puzzles/` (a new folder; the history
folder is never touched; a job refuses the name `history`). The exact commands are in the round's report; the order is:
upload `restore-phased.json` to the work folder, `job.sbatch` (its array of 8 tasks is in the file), `merge.sbatch`, copy
`puzzles.json` and `puzzles.counts.json` to `gift.local/history/`, compare the sha-256 the merge log prints.

## Locally

```
node hpc/puzzles/mine-positions.mjs --input gift.local/history/restore-phased.json --dir <folder> --shard 0 --shards 1 --commit <40 hex> --limit 20
node hpc/puzzles/merge-positions.mjs --input gift.local/history/restore-phased.json --dir <folder> --shards 1 --allow-partial
```

The engine is the Node build of Stockfish 17.1 lite (`scripts/lib/node-stockfish.mjs`), the same file the history job
runs. Choosing the games reads about 2,400 PGNs and takes a few minutes before the first search.
