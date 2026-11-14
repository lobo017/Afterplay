/**
 * Where the app opens: one localStorage value, read before the first frame (it must not wait for IndexedDB).
 *   absent or "new"        the account form (Games › Story)
 *   "importing", "ready"   the Story
 *   "skipped", "seen"      Play
 * "seen" is set the first time the Story is on screen with a finished import, so the Story shows once.
 */
export const STORY_LANDING_KEY = 'wc.story.v1';

export type StoryLanding = 'new' | 'importing' | 'ready' | 'skipped' | 'seen';
export type LandingScreen = 'form' | 'story' | 'play';

interface LandingStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function localStore(): LandingStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** The stored value; anything unknown counts as "new". */
export function readLanding(storage: LandingStorage | null = localStore()): StoryLanding {
  try {
    const v = storage?.getItem(STORY_LANDING_KEY);
    return v === 'importing' || v === 'ready' || v === 'skipped' || v === 'seen' ? v : 'new';
  } catch {
    return 'new';
  }
}

/** Returns false when the value could not be kept (storage blocked). */
export function writeLanding(value: StoryLanding, storage: LandingStorage | null = localStore()): boolean {
  try {
    if (!storage) return false;
    storage.setItem(STORY_LANDING_KEY, value);
    return true;
  } catch {
    return false;
  }
}

export function landingScreen(value: StoryLanding): LandingScreen {
  switch (value) {
    case 'new':
      return 'form';
    case 'importing':
    case 'ready':
      return 'story';
    default:
      return 'play';
  }
}
