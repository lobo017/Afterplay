// The settings of the engine review batch: the one place they are written. review-games.mjs records them in every part
// file's first line, and merge-reviews.mjs refuses any part whose first line holds different ones. The values give a
// fixed depth on one thread, so the review repeats from run to run.
// A change here is a different review: the parts of an earlier run no longer match and must not be merged with new ones.
export const SETTINGS = {
  depth: 18,
  multipv: 2,
  hashMb: 32,
  threads: 1,
  ucinewgame: true,
  variant: 'single-threaded',
  engineFile: 'stockfish-17.1-lite-single-03e3232.js',
};

// The number of chunks the engine review is split into: part files are engine/part-<k>-of-<HISTORY_CHUNKS>.jsonl, game i
// of the sorted ids belongs to chunk i mod HISTORY_CHUNKS. The job (history-engine.sbatch) and the merge read it from
// here; the job refuses to start when its array size times its CPUs per task is not this number. A change is a different
// split: part files of an earlier run no longer match and must not be merged with new ones.
export const HISTORY_CHUNKS = 64;
