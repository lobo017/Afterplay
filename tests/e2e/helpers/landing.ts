import type { BrowserContext } from '@playwright/test';

/**
 * Where the app opens is one localStorage value (src/story/landing.ts). The Playwright config sets it to "skipped" for
 * the site's own origin; a test that makes its own context without that storage state, or opens a server on another
 * port (another origin), sets it here, so the app still opens on Play. Only an absent value is filled in.
 */
export async function skipStoryLanding(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    try {
      if (localStorage.getItem('wc.story.v1') === null) localStorage.setItem('wc.story.v1', 'skipped');
    } catch {
      // storage blocked: nothing to set
    }
  });
}
