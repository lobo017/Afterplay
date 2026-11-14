// Which browser the perf scripts drive. The Windows laptop has branded Chrome installed; the Playwright
// image on Linux (Juno) has only its bundled Chromium, so no channel there. WC_BROWSER_CHANNEL overrides both.
import process from 'node:process';

export function browserChannel() {
  return process.env.WC_BROWSER_CHANNEL || (process.platform === 'win32' ? 'chrome' : undefined);
}

/** `chromium.launch()` options for a headless run, without the signal handling each script sets itself. */
export function browserLaunchOptions() {
  const channel = browserChannel();
  return { ...(channel ? { channel } : {}), headless: true };
}

/**
 * True on a machine with no display server (a cluster node): headless Chromium then paces requestAnimationFrame
 * with its own 60 Hz timer instead of a monitor's vsync, so a "blank page" check measures the machine's load,
 * not a screen. Windows and macOS always count as having a display.
 */
export function isHeadlessServer() {
  return process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY;
}

/**
 * The app opens on the Chess Story's form in a browser that has never seen it (src/story/landing.ts). Measuring and
 * checking scripts want Play, so they store the landing value "skipped" first (only when none is stored).
 */
export async function skipStoryLanding(context) {
  await context.addInitScript(() => {
    try {
      if (window.localStorage.getItem('wc.story.v1') === null) window.localStorage.setItem('wc.story.v1', 'skipped');
    } catch {
      // storage blocked: nothing to set
    }
  });
}
