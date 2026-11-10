/**
 * The frame cadence this machine gives a blank page right now (no app, no engine).
 *
 * Headless Chrome only locks to the display rate while the display is awake: with the session locked or
 * the screen off it falls back to a software timer (~56 Hz seen), and then no app could meet a 60 Hz
 * budget. Frame-time numbers are only meaningful when this floor is at the display rate (~16.7 ms).
 */

/** Above this blank-page median the frame numbers of a run are not valid evidence (60 Hz = 16.7 ms). */
export const FRAME_FLOOR_P50_MAX_MS = 17.0;

/**
 * What a failed floor means on this machine, for the abort message. A laptop's headless Chrome follows the
 * display, so a slow blank page means a locked or sleeping screen, battery or load. A cluster node has no
 * display: Chromium paces frames with its own 60 Hz timer, so only load on the node (or a throttled CPU) can
 * make the floor slow.
 */
export function floorFailureHint(headlessServer) {
  return headlessServer
    ? 'This machine has no display (headless server), so Chromium paces frames with its own 60 Hz timer and a ' +
        'slow blank page means the node is busy or throttled. Run perf jobs on an --exclusive node and check ' +
        'that nothing else of yours shares it.'
    : 'Typical causes: the session is locked or the display is off (headless Chrome then loses vsync), battery ' +
        'or power-saver mode, a busy machine. Unlock the screen, plug in, close other apps and run again.';
}

/** Samples 240 requestAnimationFrame intervals of a blank page in a new page of `context`. */
export async function measureFrameFloor(context) {
  const page = await context.newPage();
  try {
    await page.setContent('<!doctype html><title>blank</title>');
    const stats = await page.evaluate(
      () =>
        new Promise((resolve) => {
          const stamps = [];
          const tick = (now) => {
            stamps.push(now);
            if (stamps.length < 241) {
              requestAnimationFrame(tick);
              return;
            }
            const d = stamps
              .slice(1)
              .map((t, i) => t - stamps[i])
              .filter((v) => v < 250)
              .sort((a, b) => a - b);
            const at = (q) => d[Math.min(d.length - 1, Math.floor(d.length * q))];
            resolve({ p50: at(0.5), p95: at(0.95) });
          };
          requestAnimationFrame(tick);
        }),
    );
    return { p50FrameMs: Number(stats.p50.toFixed(2)), p95FrameMs: Number(stats.p95.toFixed(2)) };
  } finally {
    await page.close();
  }
}
