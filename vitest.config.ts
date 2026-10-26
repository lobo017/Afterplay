import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
    globals: false,
    // Several files do real work (the engine, 20,000 puzzles, solving endgames) and run side by
    // side; on a busy machine the 5 s default timed two of them out though each passes alone in seconds
    testTimeout: 30_000,
    // Fewer test processes at once: with every core busy a starved worker missed vitest's own
    // 60 s report-back and the run ended with an error although every test passed
    poolOptions: { forks: { maxForks: 4, minForks: 1 } },
  },
});
