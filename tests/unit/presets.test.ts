import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  PRESET_LIMITS,
  START_SLUG_PATTERN,
  cleanText,
  parsePreset,
  presetUrl,
  startManifestUrl,
  startPath,
  startSlugFromPath,
} from '../../src/preset/preset';
import {
  FIRST_RUN_STORAGE_KEY,
  loadFirstRunPreset,
  loadFirstRunState,
  saveFirstRunState,
} from '../../src/preset/first-run';
import {
  PROFILE_STORAGE_KEY,
  ProfileStore,
  customBotFor,
  sanitizeProfile,
  welcomeWithAppName,
} from '../../src/preset/profile';
import { AppSettingsStore, DEFAULT_APP_SETTINGS } from '../../src/ui/app-settings';
import { PREFERENCES_SETTING_KEY, Preferences, parsePreferences } from '../../src/ui/settings-persistence';
import { BoardFeelStore, type FeelStorage } from '../../src/render/board-feel';
import {
  START_SLUG_PATTERN as SCRIPT_SLUG_PATTERN,
  presetAppName,
  startIndexHtml,
  startManifest,
} from '../../scripts/lib/start-pages.mjs';

class MemoryStorage implements FeelStorage {
  readonly map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
}

class MemoryBackend {
  readonly settings = new Map<string, unknown>();
  async getSetting<T>(key: string): Promise<T | undefined> {
    return this.settings.get(key) as T | undefined;
  }
  async setSetting<T>(key: string, value: T): Promise<void> {
    this.settings.set(key, JSON.parse(JSON.stringify(value)));
  }
}

const SAMPLE_PATH = path.join('public', 'start', 'sample', 'preset.json');
const sampleText = fs.readFileSync(SAMPLE_PATH, 'utf8');

describe('Phase 11 — preset files', () => {
  it('reads the committed sample preset without a single problem', () => {
    const { preset, problems } = parsePreset(JSON.parse(sampleText));
    expect(problems).toEqual([]);
    expect(preset).toMatchObject({
      version: 1,
      appName: "Ada's Chess",
      displayName: 'Ada',
      title: 'Countess',
      settings: {
        boardTheme: 'green',
        pieceSet: 'classic',
        newGame: { botRating: 800, botStyle: 'solid', timeControlId: '10+0' },
      },
      usernames: { lichess: '', chesscom: 'ada-sample' },
    });
    expect(preset!.bots.map((b) => b.name)).toEqual(['Professor Rook', 'The Gambit Goblin', 'Lady Zugzwang']);
    expect(preset!.welcome!.message.split('\n\n')).toHaveLength(2);
  });

  it('puts the preset app name in the welcome sentence, and falls back to Afterplay without one', () => {
    const { preset } = parsePreset(JSON.parse(sampleText));
    const shown = welcomeWithAppName(preset!.welcome!, preset!.appName);
    expect(shown.message.split('\n\n')[0]).toBe(
      "This copy of Ada's Chess was set up for you: a green board, the classic pieces and three opponents with names of their own.",
    );
    expect(shown.message).not.toContain('{appName}');
    expect(welcomeWithAppName(preset!.welcome!, '').message).toContain('This copy of Afterplay was set up');
    expect(welcomeWithAppName({ title: 'Hi', message: 'Hello', from: '' }, 'X')).toEqual({
      title: 'Hi',
      message: 'Hello',
      from: '',
    });
  });

  it('names only the settings the file names, so applying it leaves the others alone', () => {
    const { preset } = parsePreset({ version: 1, settings: { boardTheme: 'green', newGame: { botRating: 900 } } });
    expect(preset!.settings).toEqual({ boardTheme: 'green', newGame: { botRating: 900 } });
    const store = new AppSettingsStore({ volume: 20, pieceSet: 'staunton', newGame: { color: 'b', botRating: 2000 } });
    store.set(preset!.settings);
    expect(store.get()).toMatchObject({
      boardTheme: 'green',
      pieceSet: 'staunton',
      volume: 20,
      newGame: { color: 'b', botRating: 900, timeControlId: DEFAULT_APP_SETTINGS.newGame.timeControlId },
    });
  });

  it('is not a preset when it is not an object or has another version', () => {
    for (const bad of [null, 'x', 3, [], { version: 2 }, { appName: 'No version' }]) {
      const { preset, problems } = parsePreset(bad);
      expect(preset).toBeNull();
      expect(problems).toHaveLength(1);
    }
  });

  it('an empty preset is valid and changes nothing', () => {
    const { preset, problems } = parsePreset({ version: 1 });
    expect(problems).toEqual([]);
    expect(preset).toEqual({
      version: 1,
      appName: '',
      displayName: '',
      title: '',
      welcome: null,
      settings: {},
      usernames: null,
      bots: [],
    });
  });

  it('reports and drops what it does not understand, and keeps the rest', () => {
    const { preset, problems } = parsePreset({
      version: 1,
      appNmae: 'typo',
      appName: 42,
      profile: { displayName: 'x'.repeat(40), nickname: 'no' },
      welcome: { title: 'Hi' },
      settings: {
        boardTheme: 'neon',
        pieceSet: 'classic',
        volume: 500,
        sound: 'yes',
        zoom: 2,
        newGame: { botRating: 99, botStyle: 'wild', color: 'b', speed: 1 },
      },
      usernames: { lichess: 7, chesscom: '' },
      bots: [
        { name: 'A', rating: 1000, style: 'solid' },
        { name: 'Same as A', rating: 1000, style: 'solid' },
        { name: '', rating: 1200 },
        { name: 'No style', rating: 1300 },
        { name: 'Bad rating', rating: 3000 },
        { name: 'Bad style', rating: 1400, style: 'wild' },
        'not a bot',
      ],
    });
    expect(preset).not.toBeNull();
    expect(preset!.appName).toBe('');
    expect(preset!.displayName).toBe('x'.repeat(PRESET_LIMITS.displayName));
    expect(preset!.welcome).toBeNull();
    expect(preset!.settings).toEqual({ pieceSet: 'classic', newGame: { color: 'b' } });
    expect(preset!.usernames).toBeNull();
    expect(preset!.bots).toEqual([
      { name: 'A', rating: 1000, style: 'solid' },
      { name: 'No style', rating: 1300, style: 'solid' },
    ]);
    const text = problems.join('\n');
    for (const expected of [
      'appNmae: not a known field',
      'appName: must be text',
      'profile.displayName: longer than 30 characters',
      'profile.nickname: not a known field',
      'welcome.message: missing',
      'settings.boardTheme: "neon" is not a valid value',
      'settings.volume: 500 is not a valid value',
      'settings.sound: "yes" is not a valid value',
      'settings.zoom: not a known field',
      'settings.newGame.botRating: 99 is not a valid value',
      'settings.newGame.botStyle: "wild" is not a valid value',
      'settings.newGame.speed: not a known field',
      'usernames.lichess: must be text',
      'bots[1]: the same rating and style as an earlier bot',
      'bots[2].name: missing',
      'bots[4].rating: must be a whole number from 400 to 2400',
      'bots[5].style: must be one of',
      'bots[6]: must be an object',
    ]) {
      expect(text, expected).toContain(expected);
    }
  });

  it('keeps at most eight bots', () => {
    const bots = Array.from({ length: 10 }, (_, i) => ({ name: `Bot ${i}`, rating: 400 + i * 100 }));
    const { preset, problems } = parsePreset({ version: 1, bots });
    expect(preset!.bots).toHaveLength(PRESET_LIMITS.bots);
    expect(problems.filter((p) => p.includes('more than 8 bots'))).toHaveLength(2);
  });

  it('cleans text: one line, no control characters, paragraphs kept only where asked', () => {
    expect(cleanText('  two\twords\n here ', 30)).toBe('two words here');
    expect(cleanText('a\u0000b\u0007c', 30)).toBe('a b c');
    expect(cleanText('line one\r\nline two\n\n\n\npara two  ', 100, true)).toBe('line one\nline two\n\npara two');
    expect(cleanText('😀😀😀😀', 2)).toBe('😀😀');
    expect(cleanText(12, 30)).toBe('');
    // Markup stays text: nothing here is ever written as HTML
    expect(cleanText('<b>Hi</b>', 30)).toBe('<b>Hi</b>');
  });
});

describe('Phase 11 — first-run links', () => {
  it('reads the slug from the link path only', () => {
    expect(startSlugFromPath('/start/sample/')).toBe('sample');
    expect(startSlugFromPath('/start/sample')).toBe('sample');
    expect(startSlugFromPath('/start/sample/index.html')).toBe('sample');
    expect(startSlugFromPath('/start/k3v9-2xq7hd0m4p8z/')).toBe('k3v9-2xq7hd0m4p8z');
    for (const not of [
      '/',
      '/index.html',
      '/start/',
      '/start',
      '/start/ab/',
      '/start/Sample/',
      '/start/a_b/',
      '/start/-abc/',
      '/start/sample/preset.json',
      '/start/sample/more/',
      '/starts/sample/',
      `/start/${'a'.repeat(65)}/`,
    ]) {
      expect(startSlugFromPath(not), not).toBeNull();
    }
    expect(startPath('sample')).toBe('/start/sample/');
    expect(presetUrl('sample')).toBe('/start/sample/preset.json');
    expect(startManifestUrl('sample')).toBe('/start/sample/manifest.webmanifest');
    // The build script checks link names with the same rule
    expect(SCRIPT_SLUG_PATTERN.source).toBe(START_SLUG_PATTERN.source);
  });

  const respond = (body: string, status = 200) => {
    const calls: string[] = [];
    const fetchPreset = async (url: string): Promise<Response> => {
      calls.push(url);
      return new Response(body, { status });
    };
    return { calls, fetchPreset };
  };

  it('fetches nothing without a link, or for a link already applied on this device', async () => {
    const { calls, fetchPreset } = respond(sampleText);
    expect(await loadFirstRunPreset({ pathname: '/', appliedSlug: '', fetchPreset })).toEqual({ kind: 'none' });
    expect(await loadFirstRunPreset({ pathname: '/start/sample/', appliedSlug: 'sample', fetchPreset })).toEqual({
      kind: 'already',
      slug: 'sample',
    });
    expect(calls).toEqual([]);
  });

  it('loads the preset beside the link, once', async () => {
    const { calls, fetchPreset } = respond(sampleText);
    const result = await loadFirstRunPreset({ pathname: '/start/sample/', appliedSlug: '', fetchPreset });
    expect(calls).toEqual(['/start/sample/preset.json']);
    expect(result.kind).toBe('loaded');
    if (result.kind !== 'loaded') return;
    expect(result.slug).toBe('sample');
    expect(result.preset.displayName).toBe('Ada');
    expect(result.problems).toEqual([]);
  });

  it('another link than the one applied before is applied too', async () => {
    const { calls, fetchPreset } = respond(sampleText);
    const result = await loadFirstRunPreset({ pathname: '/start/sample/', appliedSlug: 'other-link', fetchPreset });
    expect(result.kind).toBe('loaded');
    expect(calls).toHaveLength(1);
  });

  it('fails in words, never by throwing: unknown link, a page instead of JSON, another version, no network', async () => {
    const unknown = await loadFirstRunPreset({ pathname: '/start/nope/', appliedSlug: '', ...respond('', 404) });
    expect(unknown).toMatchObject({ kind: 'failed', slug: 'nope' });
    // A host that answers unknown paths with the app page (Cloudflare Pages does)
    const page = await loadFirstRunPreset({
      pathname: '/start/nope/',
      appliedSlug: '',
      ...respond('<!doctype html><html></html>'),
    });
    expect(page).toMatchObject({ kind: 'failed', slug: 'nope' });
    if (unknown.kind === 'failed' && page.kind === 'failed') {
      expect(unknown.message).toContain('not known here');
      expect(page.message).toBe(unknown.message);
    }
    const version = await loadFirstRunPreset({
      pathname: '/start/nope/',
      appliedSlug: '',
      ...respond('{"version":2}'),
    });
    expect(version).toMatchObject({ kind: 'failed' });
    if (version.kind === 'failed') expect(version.message).toContain('this version of the app');
    const offline = await loadFirstRunPreset({
      pathname: '/start/nope/',
      appliedSlug: '',
      fetchPreset: () => Promise.reject(new TypeError('Failed to fetch')),
    });
    expect(offline).toMatchObject({ kind: 'failed' });
    if (offline.kind === 'failed') expect(offline.message).toContain('when you are online');
  });

  it('gives up on a preset that never arrives', async () => {
    const result = await loadFirstRunPreset({
      pathname: '/start/slow/',
      appliedSlug: '',
      timeoutMs: 20,
      fetchPreset: (_url, signal) =>
        new Promise<Response>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }),
    });
    expect(result).toMatchObject({ kind: 'failed', slug: 'slow' });
  });

  it('remembers on the device which link was applied and whether its welcome was seen', () => {
    const storage = new MemoryStorage();
    expect(loadFirstRunState(storage)).toEqual({ slug: '', welcomeSeen: false });
    saveFirstRunState({ slug: 'sample', welcomeSeen: false }, storage);
    expect(loadFirstRunState(storage)).toEqual({ slug: 'sample', welcomeSeen: false });
    saveFirstRunState({ slug: 'sample', welcomeSeen: true }, storage);
    expect(loadFirstRunState(storage)).toEqual({ slug: 'sample', welcomeSeen: true });
    storage.setItem(FIRST_RUN_STORAGE_KEY, 'not json');
    expect(loadFirstRunState(storage)).toEqual({ slug: '', welcomeSeen: false });
    storage.setItem(FIRST_RUN_STORAGE_KEY, '{"slug":5,"welcomeSeen":"yes"}');
    expect(loadFirstRunState(storage)).toEqual({ slug: '', welcomeSeen: false });
    expect(loadFirstRunState(null)).toEqual({ slug: '', welcomeSeen: false });
  });
});

describe('Phase 11 — profile', () => {
  it('is empty by default, keeps itself on the device and tells its listeners', () => {
    const storage = new MemoryStorage();
    const store = new ProfileStore(storage);
    expect(store.get()).toEqual({ displayName: '', title: '', appName: '', bots: [], welcome: null });
    const seen: string[] = [];
    store.subscribe((p, prev) => seen.push(`${prev.displayName}>${p.displayName}`));
    store.set({ displayName: '  Ada  ', title: 'Countess' });
    expect(seen).toEqual(['>Ada']);
    expect(new ProfileStore(storage).get()).toMatchObject({ displayName: 'Ada', title: 'Countess' });
    expect(JSON.parse(storage.getItem(PROFILE_STORAGE_KEY)!)).toMatchObject({ displayName: 'Ada' });
    // No storage at all (a private controller): still works, just not kept
    const loose = new ProfileStore(null);
    loose.set({ displayName: 'Temp' });
    expect(loose.get().displayName).toBe('Temp');
  });

  it('cleans whatever is stored or restored', () => {
    const p = sanitizeProfile({
      displayName: 'x'.repeat(99),
      title: 5,
      appName: 'My\nChess',
      bots: [{ name: 'Rook', rating: 900, style: 'solid' }, { name: 'Bad' }],
      welcome: { title: 'Hi', message: '' },
    });
    expect(p.displayName).toHaveLength(PRESET_LIMITS.displayName);
    expect(p.title).toBe('');
    expect(p.appName).toBe('My Chess');
    expect(p.bots).toEqual([{ name: 'Rook', rating: 900, style: 'solid' }]);
    expect(p.welcome).toBeNull();
    expect(sanitizeProfile('nonsense')).toEqual(sanitizeProfile(null));
    const storage = new MemoryStorage();
    storage.setItem(PROFILE_STORAGE_KEY, '{broken');
    expect(new ProfileStore(storage).get().displayName).toBe('');
  });

  it('a bot has a name when its rating and style are a named bot', () => {
    const profile = sanitizeProfile({
      bots: [
        { name: 'Rook', rating: 900, style: 'solid' },
        { name: 'Goblin', rating: 900, style: 'gambiteer' },
      ],
    });
    expect(customBotFor(profile, 900, 'solid')?.name).toBe('Rook');
    expect(customBotFor(profile, 900, 'gambiteer')?.name).toBe('Goblin');
    expect(customBotFor(profile, 900, 'aggressive')).toBeNull();
    expect(customBotFor(profile, 950, 'solid')).toBeNull();
  });

  it('travels in the preferences record, so a backup carries it and a restore brings it back', async () => {
    const storage = new MemoryStorage();
    const app = new AppSettingsStore();
    const profile = new ProfileStore(storage);
    const prefs = new Preferences({
      appSettings: app,
      boardFeel: new BoardFeelStore(storage),
      profile,
      storage,
      mirrorDelayMs: 0,
    });
    const backend = new MemoryBackend();
    await prefs.attach(backend);
    profile.set({ displayName: 'Ada', bots: [{ name: 'Rook', rating: 900, style: 'solid' }] });
    await prefs.mirrorNow();
    const record = parsePreferences(backend.settings.get(PREFERENCES_SETTING_KEY))!;
    expect(record.profile).toMatchObject({ displayName: 'Ada', bots: [{ name: 'Rook', rating: 900, style: 'solid' }] });

    // Restored on another device
    const otherStorage = new MemoryStorage();
    const otherProfile = new ProfileStore(otherStorage);
    otherProfile.set({ displayName: 'Before', title: 'Old' });
    const other = new Preferences({
      appSettings: new AppSettingsStore(),
      boardFeel: new BoardFeelStore(otherStorage),
      profile: otherProfile,
      storage: otherStorage,
      mirrorDelayMs: 0,
    });
    other.apply(record);
    expect(otherProfile.get()).toMatchObject({ displayName: 'Ada', title: '' });
    expect(new ProfileStore(otherStorage).get().displayName).toBe('Ada');

    // A record from before profiles existed leaves the profile as it is
    const old = parsePreferences({ app: {}, boardFeel: {}, boardSize: null })!;
    expect('profile' in old).toBe(false);
    other.apply(old);
    expect(otherProfile.get().displayName).toBe('Ada');
  });

  it('a device whose own storage was cleared takes the profile back from the database record', async () => {
    const backend = new MemoryBackend();
    backend.settings.set(PREFERENCES_SETTING_KEY, {
      version: 1,
      app: {},
      boardFeel: {},
      boardSize: null,
      profile: { displayName: 'Ada', title: 'Countess' },
    });
    const storage = new MemoryStorage();
    const profile = new ProfileStore(storage);
    const prefs = new Preferences({
      appSettings: new AppSettingsStore(),
      boardFeel: new BoardFeelStore(storage),
      profile,
      storage,
      mirrorDelayMs: 0,
    });
    await prefs.attach(backend);
    expect(profile.get()).toMatchObject({ displayName: 'Ada', title: 'Countess' });
  });
});

describe('Phase 11 — first-run link pages (scripts/lib/start-pages.mjs)', () => {
  const INDEX = `<!doctype html>
<html lang="en">
  <head>
    <meta name="apple-mobile-web-app-title" content="Afterplay" />
    <title>Afterplay</title>
    <script type="module" crossorigin src="/assets/index-abc.js"></script>
  <link rel="manifest" href="/manifest.webmanifest"></head>
  <body><div id="app"></div></body>
</html>`;
  const MANIFEST = JSON.stringify({
    name: 'Afterplay',
    short_name: 'Afterplay',
    start_url: '/',
    scope: '/',
    id: '/',
    display: 'standalone',
    icons: [{ src: '/icon-192.png' }],
  });

  it("the link's manifest starts the installed app at the link, under the preset's name", () => {
    const manifest = JSON.parse(startManifest(MANIFEST, 'sample', "Ada's Chess")) as Record<string, unknown>;
    expect(manifest).toEqual({
      name: "Ada's Chess",
      short_name: "Ada's Chess",
      start_url: '/start/sample/',
      scope: '/',
      id: '/',
      display: 'standalone',
      icons: [{ src: '/icon-192.png' }],
    });
    const unnamed = JSON.parse(startManifest(MANIFEST, 'sample', '')) as Record<string, unknown>;
    expect(unnamed).toMatchObject({ name: 'Afterplay', short_name: 'Afterplay', start_url: '/start/sample/' });
    expect(() => startManifest(MANIFEST, '../etc', 'x')).toThrow(/not a valid link name/);
  });

  it("the link's page points at that manifest, carries the name, and is kept out of search results", () => {
    const html = startIndexHtml(INDEX, 'sample', 'Tom & "Jerry" <3');
    expect(html).toContain('<link rel="manifest" href="/start/sample/manifest.webmanifest">');
    expect(html).toContain('<title>Tom &amp; &quot;Jerry&quot; &lt;3</title>');
    expect(html).toContain('<meta name="apple-mobile-web-app-title" content="Tom &amp; &quot;Jerry&quot; &lt;3" />');
    expect(html).toContain('<meta name="robots" content="noindex" />');
    expect(html).toContain('/assets/index-abc.js');
    expect(html).not.toContain('href="/manifest.webmanifest"');
    // Without a name only the manifest and the robots tag change
    const unnamed = startIndexHtml(INDEX, 'sample', '');
    expect(unnamed).toContain('<title>Afterplay</title>');
    expect(unnamed).toContain('/start/sample/manifest.webmanifest');
  });

  it('refuses a page whose shape changed, rather than writing a link that installs the wrong thing', () => {
    expect(() =>
      startIndexHtml(INDEX.replace('<link rel="manifest" href="/manifest.webmanifest">', ''), 's-1', 'A'),
    ).toThrow(/manifest link/);
    expect(() => startIndexHtml(INDEX.replace('<title>Afterplay</title>', ''), 's-1', 'A')).toThrow(/title/);
    expect(() => startIndexHtml(INDEX, 'Bad Slug', 'A')).toThrow(/not a valid link name/);
  });

  it("reads a preset's app name, and refuses what is not a preset", () => {
    expect(presetAppName(sampleText)).toBe("Ada's Chess");
    expect(presetAppName('{"version":1}')).toBe('');
    expect(presetAppName(`{"version":1,"appName":"  ${'n'.repeat(50)} "}`)).toHaveLength(PRESET_LIMITS.appName);
    expect(() => presetAppName('<html>')).toThrow(/not JSON/);
    expect(() => presetAppName('{"version":3}')).toThrow(/version 1/);
    expect(() => presetAppName('[]')).toThrow(/version 1/);
  });

  it('the build runs the step, and the real page still has what the step replaces', () => {
    const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8')) as { scripts: Record<string, string> };
    expect(pkg.scripts.build).toMatch(/vite build && node scripts\/build-start-pages\.mjs$/);
    expect(pkg.scripts['build:local']).toMatch(/build-start-pages\.mjs --local$/);
    const index = fs.readFileSync('index.html', 'utf8');
    expect(index).toMatch(/<title>[^<]*<\/title>/);
    expect(index).toMatch(/<meta name="apple-mobile-web-app-title" content="[^"]*"\s*\/?>/);
    // A first-run link's files are fetched online, once: never part of the offline cache
    expect(fs.readFileSync('vite.config.ts', 'utf8')).toContain("'start/**'");
  });
});

describe('Phase 11 — personal presets (gift.local/start/, never committed)', () => {
  const LOCAL = path.join('gift.local', 'start');
  const slugs = fs.existsSync(LOCAL)
    ? fs.readdirSync(LOCAL).filter((name) => fs.existsSync(path.join(LOCAL, name, 'preset.json')))
    : [];

  it('git ignores the folder', () => {
    expect(fs.readFileSync('.gitignore', 'utf8')).toMatch(/^gift\.local\/$/m);
  });

  // A problem names a field (and, for a setting, its value), never a name or a message, so it is safe to print
  it.skipIf(slugs.length === 0)('every personal preset on this machine is valid and has a usable link name', () => {
    slugs.forEach((slug, i) => {
      expect(START_SLUG_PATTERN.test(slug), `preset ${i + 1}: link name`).toBe(true);
      const { preset, problems } = parsePreset(
        JSON.parse(fs.readFileSync(path.join(LOCAL, slug, 'preset.json'), 'utf8')),
      );
      expect(preset, `preset ${i + 1}`).not.toBeNull();
      expect(problems, `preset ${i + 1}`).toEqual([]);
    });
  });
});
