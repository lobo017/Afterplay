import { describe, expect, it } from 'vitest';
import {
  PHONE_HASH_MB,
  PHONE_MAX_THREADS,
  describeEngineProfile,
  detectDeviceProfile,
  engineProfileFor,
  type DeviceEnvironment,
} from '../../src/engine/engine-profile';
import { describePersistence, requestPersistentStorage } from '../../src/storage/persistence';
import { isAppleTouchDevice, shouldAutoOpenInstallGuide } from '../../src/ui/install-guide';

const IPHONE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1';
const IPAD_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15';
const ANDROID_PHONE_UA =
  'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Mobile Safari/537.36';
const ANDROID_TABLET_UA =
  'Mozilla/5.0 (Linux; Android 15; SM-X910) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36';
const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36';

const env = (over: Partial<DeviceEnvironment>): DeviceEnvironment => ({
  userAgent: DESKTOP_UA,
  maxTouchPoints: 0,
  coarsePointer: false,
  screenWidth: 1920,
  screenHeight: 1080,
  ...over,
});

describe('Phase 11 — phone engine profile', () => {
  it('detects phones by user agent, or by a coarse pointer on a short screen', () => {
    expect(
      detectDeviceProfile(env({ userAgent: IPHONE_UA, coarsePointer: true, screenWidth: 390, screenHeight: 844 })),
    ).toBe('phone');
    expect(detectDeviceProfile(env({ userAgent: ANDROID_PHONE_UA }))).toBe('phone');
    // A small touch screen without a phone user agent (e.g. a browser asking for the desktop site)
    expect(detectDeviceProfile(env({ coarsePointer: true, screenWidth: 412, screenHeight: 915 }))).toBe('phone');
    // Tablets, laptops with touch screens and desktops keep the desktop profile
    expect(
      detectDeviceProfile(
        env({ userAgent: IPAD_UA, maxTouchPoints: 5, coarsePointer: true, screenWidth: 820, screenHeight: 1180 }),
      ),
    ).toBe('desktop');
    expect(
      detectDeviceProfile(
        env({ userAgent: ANDROID_TABLET_UA, coarsePointer: true, screenWidth: 800, screenHeight: 1280 }),
      ),
    ).toBe('desktop');
    expect(
      detectDeviceProfile(env({ maxTouchPoints: 10, coarsePointer: false, screenWidth: 1366, screenHeight: 768 })),
    ).toBe('desktop');
    expect(detectDeviceProfile(env({}))).toBe('desktop');
  });

  it('a phone gets one small engine; a desktop keeps three', () => {
    const phone = engineProfileFor('phone', { recommendedThreads: 4 });
    expect(phone.singleEngine).toBe(true);
    expect(phone.live).toEqual({ threads: PHONE_MAX_THREADS, hashMb: PHONE_HASH_MB });
    expect(engineProfileFor('phone', { recommendedThreads: 1 }).live.threads).toBe(1);

    const desktop = engineProfileFor('desktop', { recommendedThreads: 4 });
    expect(desktop.singleEngine).toBe(false);
    // Live analysis keeps the engine's own choice (up to 4 threads, 32–64 MB)
    expect(desktop.live).toEqual({});
    expect(desktop.bot).toEqual({ threads: 1, hashMb: 16 });
    expect(desktop.review).toEqual({ threads: 1, hashMb: 32 });

    expect(describeEngineProfile(phone, 2, 16)).toBe('Phone: one engine, 2 threads, 16 MB hash');
    expect(describeEngineProfile(desktop, 4, 64)).toContain('Desktop: analysis 4 threads and 64 MB');
  });
});

describe('Phase 11 — persistent storage', () => {
  it('asks only when not yet persistent, and never throws', async () => {
    let asked = 0;
    const granted = { persisted: async () => false, persist: async () => (++asked, true) };
    expect(await requestPersistentStorage(granted)).toBe('persistent');
    expect(asked).toBe(1);

    const already = { persisted: async () => true, persist: async () => (++asked, true) };
    expect(await requestPersistentStorage(already)).toBe('persistent');
    expect(asked).toBe(1);

    expect(await requestPersistentStorage({ persisted: async () => false, persist: async () => false })).toBe(
      'best-effort',
    );
    expect(
      await requestPersistentStorage({
        persist: async () => {
          throw new Error('denied');
        },
      }),
    ).toBe('best-effort');
    expect(await requestPersistentStorage(undefined)).toBe('unsupported');
    expect(await requestPersistentStorage({})).toBe('unsupported');
  });

  it('says what each state means, and points a website to the Home Screen', () => {
    expect(describePersistence('persistent', false)).toMatch(/^Kept/);
    expect(describePersistence('best-effort', false)).toContain('Home Screen');
    expect(describePersistence('best-effort', true)).not.toContain('Home Screen');
    expect(describePersistence('unsupported', false)).toContain('backup');
  });
});

describe('Phase 11 — Add to Home Screen guide', () => {
  it('opens by itself only on a first visit in iOS or iPadOS, not installed', () => {
    const iphone = { userAgent: IPHONE_UA, maxTouchPoints: 5, standalone: false };
    const ipad = { userAgent: IPAD_UA, maxTouchPoints: 5, standalone: false };
    const mac = { userAgent: IPAD_UA, maxTouchPoints: 0, standalone: false };
    expect(isAppleTouchDevice(iphone)).toBe(true);
    expect(isAppleTouchDevice(ipad)).toBe(true);
    expect(isAppleTouchDevice(mac)).toBe(false);
    expect(isAppleTouchDevice({ userAgent: ANDROID_PHONE_UA, maxTouchPoints: 5, standalone: false })).toBe(false);

    expect(shouldAutoOpenInstallGuide(iphone, false)).toBe(true);
    expect(shouldAutoOpenInstallGuide(ipad, false)).toBe(true);
    expect(shouldAutoOpenInstallGuide(iphone, true)).toBe(false);
    expect(shouldAutoOpenInstallGuide({ ...iphone, standalone: true }, false)).toBe(false);
    expect(shouldAutoOpenInstallGuide(mac, false)).toBe(false);
  });
});
