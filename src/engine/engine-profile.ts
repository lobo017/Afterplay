import { detectEngineCapabilities, type EngineCapabilities } from './engine-client';

/**
 * How many Stockfish workers the app runs, and how big they are.
 *
 * - **desktop:** three engines, as measured in Phases 5 and 9: live analysis (up to 4 threads, 32–64 MB hash), the bot and
 *   the threat search (1 thread, 16 MB) and the review (1 thread, 32 MB), so a review never slows live analysis.
 * - **phone:** one engine for everything (at most 2 threads, 16 MB hash). Three engines cost ~600 MB on a laptop (+294,
 *   +153, +149 MB), which is about what iOS gives a Safari tab before it reloads it; one small engine is ~150 MB, runs
 *   cooler, and drains the battery less. The engine's priority queue orders the work (live > review > background), and a
 *   review started on the board pauses live analysis (app.ts).
 */
export type DeviceProfile = 'desktop' | 'phone';

export interface EngineSlot {
  threads: number;
  hashMb: number;
}

export interface EngineProfile {
  device: DeviceProfile;
  /** One engine serves live analysis, the bot, threats, trainers and reviews. */
  singleEngine: boolean;
  /** Live analysis (and on a phone, everything else). `threads` undefined: the engine's own choice. */
  live: { threads?: number; hashMb?: number };
  /** Desktop only: the bot and threat engine and the review engine. */
  bot: EngineSlot;
  review: EngineSlot;
}

export interface DeviceEnvironment {
  userAgent: string;
  /** `navigator.maxTouchPoints` (iPadOS Safari reports a Mac user agent with touch points). */
  maxTouchPoints: number;
  /** `(pointer: coarse)` matches. */
  coarsePointer: boolean;
  screenWidth: number;
  screenHeight: number;
}

/** A screen whose short side is below this (CSS px) with a coarse pointer counts as a phone. */
export const PHONE_SHORT_SIDE_PX = 600;
export const PHONE_MAX_THREADS = 2;
export const PHONE_HASH_MB = 16;
export const BOT_ENGINE_HASH_MB = 16;
/**
 * Threads for the desktop review engine. A review searches each position for a fixed time, so threads could only buy
 * depth, and measured they don't: 2 and 4 threads search 1.9× and 2.7× the nodes but reach no greater depth at 0.2 s
 * or 0.6 s, while 4 threads next to live analysis caused long tasks and slowed it by 15%. One thread leaves live
 * analysis untouched. See PROGRESS.md (Phase 5, review engine threads).
 */
export const DESKTOP_REVIEW_THREADS = 1;
export const DESKTOP_REVIEW_HASH_MB = 32;

export function readDeviceEnvironment(): DeviceEnvironment {
  const nav = typeof navigator !== 'undefined' ? navigator : null;
  const coarse =
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(pointer: coarse)').matches
      : false;
  const screenObj = typeof screen !== 'undefined' ? screen : null;
  return {
    userAgent: nav?.userAgent ?? '',
    maxTouchPoints: nav?.maxTouchPoints ?? 0,
    coarsePointer: coarse,
    screenWidth: screenObj?.width ?? 0,
    screenHeight: screenObj?.height ?? 0,
  };
}

export function detectDeviceProfile(env: DeviceEnvironment = readDeviceEnvironment()): DeviceProfile {
  const ua = env.userAgent;
  if (/iPhone|iPod/.test(ua)) return 'phone';
  if (/Android/.test(ua) && /Mobile/.test(ua)) return 'phone';
  const shortSide = Math.min(env.screenWidth, env.screenHeight);
  if (env.coarsePointer && shortSide > 0 && shortSide < PHONE_SHORT_SIDE_PX) return 'phone';
  return 'desktop';
}

export function engineProfileFor(
  device: DeviceProfile,
  caps: Pick<EngineCapabilities, 'recommendedThreads'> = detectEngineCapabilities(),
): EngineProfile {
  const bot = { threads: 1, hashMb: BOT_ENGINE_HASH_MB };
  const review = { threads: DESKTOP_REVIEW_THREADS, hashMb: DESKTOP_REVIEW_HASH_MB };
  if (device === 'phone') {
    return {
      device,
      singleEngine: true,
      live: { threads: Math.max(1, Math.min(PHONE_MAX_THREADS, caps.recommendedThreads)), hashMb: PHONE_HASH_MB },
      bot,
      review,
    };
  }
  return { device, singleEngine: false, live: {}, bot, review };
}

/** One line for Settings › About, e.g. "Phone: one engine, 2 threads, 16 MB hash". */
export function describeEngineProfile(profile: EngineProfile, liveThreads: number, liveHashMb: number): string {
  if (profile.singleEngine) {
    return `Phone: one engine, ${liveThreads} ${liveThreads === 1 ? 'thread' : 'threads'}, ${liveHashMb} MB hash`;
  }
  return (
    `Desktop: analysis ${liveThreads} ${liveThreads === 1 ? 'thread' : 'threads'} and ${liveHashMb} MB, ` +
    `bot ${profile.bot.hashMb} MB, review ${profile.review.threads} thread and ${profile.review.hashMb} MB`
  );
}
