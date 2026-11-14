import type { BotStyleId } from '../engine/bot';
import type { FeelStorage } from '../render/board-feel';
import { PRESET_LIMITS, cleanText, parseBots, parseWelcome, type CustomBot, type WelcomeMessage } from './preset';

/**
 * Who uses this copy of the app and what it is called: a display name and title (shown in Play and written into the
 * PGN of games played here), the app's name (page title, Home Screen), bots with names of their own, and a welcome
 * message. Empty by default; a preset fills it (first-run.ts) and Settings › Profile edits the name and title.
 */
export interface Profile {
  displayName: string;
  title: string;
  appName: string;
  bots: CustomBot[];
  welcome: WelcomeMessage | null;
}

export const EMPTY_PROFILE: Readonly<Profile> = Object.freeze({
  displayName: '',
  title: '',
  appName: '',
  bots: [],
  welcome: null,
});

/** The app's own name, used wherever the profile names none. */
export const DEFAULT_APP_NAME = 'Afterplay';

/** A welcome text names the app with {appName}: the preset's app name, or the app's own when the preset has none. */
export function welcomeWithAppName(welcome: WelcomeMessage, appName: string): WelcomeMessage {
  const name = appName || DEFAULT_APP_NAME;
  const fill = (text: string): string => text.split('{appName}').join(name);
  return { ...welcome, title: fill(welcome.title), message: fill(welcome.message) };
}

/** Where the profile lives on this device (read synchronously at start-up, so the first frame has the names). */
export const PROFILE_STORAGE_KEY = 'wc.profile.v1';

/** Fills in and cleans every field; anything malformed falls back to empty. */
export function sanitizeProfile(input: unknown): Profile {
  const src = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  return {
    displayName: cleanText(src.displayName, PRESET_LIMITS.displayName),
    title: cleanText(src.title, PRESET_LIMITS.title),
    appName: cleanText(src.appName, PRESET_LIMITS.appName),
    bots: parseBots(src.bots ?? []),
    welcome: parseWelcome(src.welcome ?? null),
  };
}

/** The custom bot that a rating and style are, if any. */
export function customBotFor(profile: Profile, rating: number, style: BotStyleId): CustomBot | null {
  return profile.bots.find((bot) => bot.rating === rating && bot.style === style) ?? null;
}

function localStore(): FeelStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export class ProfileStore {
  private value: Profile;
  private readonly listeners = new Set<(profile: Profile, previous: Profile) => void>();

  constructor(private readonly storage: FeelStorage | null = localStore()) {
    this.value = this.load();
  }

  private load(): Profile {
    try {
      const raw = this.storage?.getItem(PROFILE_STORAGE_KEY);
      return raw ? sanitizeProfile(JSON.parse(raw)) : sanitizeProfile(null);
    } catch {
      return sanitizeProfile(null);
    }
  }

  public get(): Readonly<Profile> {
    return this.value;
  }

  public set(patch: Partial<Profile>): void {
    this.replace({ ...this.value, ...patch });
  }

  /** Replaces everything (a preset, a restore); missing fields become empty. */
  public replace(next: unknown): void {
    const previous = this.value;
    this.value = sanitizeProfile(next);
    try {
      this.storage?.setItem(PROFILE_STORAGE_KEY, JSON.stringify(this.value));
    } catch {
      // Storage full or blocked: the profile still applies until the page closes
    }
    for (const listener of this.listeners) listener(this.value, previous);
  }

  public subscribe(listener: (profile: Profile, previous: Profile) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
