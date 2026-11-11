import { Sheet } from './components/sheet';

/**
 * "Add to Home Screen" for iPhone and iPad. Safari has no install prompt, and it clears the saved data of a website
 * that has not been opened for a while; a Home Screen web app keeps its data, opens full screen and works offline.
 * The sheet opens by itself once, on the first visit in iOS or iPadOS when the app is not installed; Settings can
 * open it again anywhere. The pictures are drawn here (no Apple artwork).
 */
export const INSTALL_GUIDE_SEEN_KEY = 'wc-install-guide-seen';

export interface InstallEnvironment {
  userAgent: string;
  maxTouchPoints: number;
  /** `navigator.standalone` (iOS) or `(display-mode: standalone)`. */
  standalone: boolean;
}

export function readInstallEnvironment(): InstallEnvironment {
  const nav = typeof navigator !== 'undefined' ? (navigator as Navigator & { standalone?: boolean }) : null;
  const displayStandalone =
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(display-mode: standalone)').matches
      : false;
  return {
    userAgent: nav?.userAgent ?? '',
    maxTouchPoints: nav?.maxTouchPoints ?? 0,
    standalone: nav?.standalone === true || displayStandalone,
  };
}

/** iPhone, iPod or iPad (iPadOS Safari reports a Mac user agent, but a Mac has no touch screen). */
export function isAppleTouchDevice(env: InstallEnvironment): boolean {
  if (/iPhone|iPad|iPod/.test(env.userAgent)) return true;
  return /Macintosh/.test(env.userAgent) && env.maxTouchPoints > 1;
}

export function shouldAutoOpenInstallGuide(env: InstallEnvironment, seen: boolean): boolean {
  return !seen && !env.standalone && isAppleTouchDevice(env);
}

function readSeen(): boolean {
  try {
    return localStorage.getItem(INSTALL_GUIDE_SEEN_KEY) === '1';
  } catch {
    return false;
  }
}

function writeSeen(): void {
  try {
    localStorage.setItem(INSTALL_GUIDE_SEEN_KEY, '1');
  } catch {
    // Private mode or storage off: the guide may show again next time
  }
}

const HIGHLIGHT = 'var(--accent-gold)';
/** How much of the app's name fits under an icon in the pictures. */
const PICTURE_NAME_CHARS = 16;

/** How much of the page's host fits in the pictured address bar. */
const PICTURE_HOST_CHARS = 18;

/** The host as the pictured address bar shows it: cut with an ellipsis when it is long. */
export function shortHost(host: string): string {
  const chars = [...host];
  return chars.length > PICTURE_HOST_CHARS ? `${chars.slice(0, PICTURE_HOST_CHARS - 1).join('')}…` : host;
}

/** Safari's bottom bar with the ⋯ menu open, "Share" highlighted (and the older toolbar's Share button). */
const PICTURE_SHARE = `
<svg viewBox="0 0 240 150" role="img" aria-labelledby="ig-p1" class="wc-install-pic" data-testid="install-picture-share">
  <title id="ig-p1">Safari's menu open above the address bar, with Share highlighted</title>
  <rect x="8" y="6" width="224" height="138" rx="14" class="wc-ig-screen"/>
  <rect x="112" y="16" width="110" height="78" rx="10" class="wc-ig-card"/>
  <text x="124" y="34" class="wc-ig-text-dim">Copy</text>
  <rect x="116" y="42" width="102" height="22" rx="6" fill="none" stroke="${HIGHLIGHT}" stroke-width="2.5"/>
  <g transform="translate(124 46)" class="wc-ig-stroke"><path d="M5 7v8h10V7M10 1v10M6.5 4.5 10 1l3.5 3.5"/></g>
  <text x="148" y="58" class="wc-ig-text">Share</text>
  <text x="124" y="84" class="wc-ig-text-dim">Bookmarks</text>
  <rect x="18" y="106" width="204" height="28" rx="14" class="wc-ig-card"/>
  <path d="M34 114l-6 6 6 6" class="wc-ig-stroke"/>
  <text x="64" y="124" class="wc-ig-text-dim" data-page-host></text>
  <circle cx="204" cy="120" r="10" fill="none" stroke="${HIGHLIGHT}" stroke-width="2.5"/>
  <text x="204" y="124" text-anchor="middle" class="wc-ig-text">⋯</text>
</svg>`;

/** The share sheet's list with "Add to Home Screen" highlighted. */
const PICTURE_ADD = `
<svg viewBox="0 0 240 150" role="img" aria-labelledby="ig-p2" class="wc-install-pic" data-testid="install-picture-add">
  <title id="ig-p2">The share sheet's list, with Add to Home Screen highlighted</title>
  <rect x="8" y="6" width="224" height="138" rx="14" class="wc-ig-screen"/>
  <rect x="20" y="16" width="200" height="118" rx="10" class="wc-ig-card"/>
  <text x="34" y="38" class="wc-ig-text-dim">Copy</text>
  <text x="34" y="62" class="wc-ig-text-dim">Add to Reading List</text>
  <text x="34" y="86" class="wc-ig-text-dim">Add Bookmark</text>
  <rect x="26" y="96" width="188" height="28" rx="6" fill="none" stroke="${HIGHLIGHT}" stroke-width="2.5"/>
  <text x="34" y="115" class="wc-ig-text">Add to Home Screen</text>
  <g transform="translate(190 102)" class="wc-ig-stroke"><rect x="0" y="0" width="16" height="16" rx="4"/><path d="M8 4v8M4 8h8"/></g>
</svg>`;

/** The "Add to Home Screen" screen: Open as Web App on, Add highlighted. */
const PICTURE_CONFIRM = `
<svg viewBox="0 0 240 150" role="img" aria-labelledby="ig-p3" class="wc-install-pic" data-testid="install-picture-confirm">
  <title id="ig-p3">The Add to Home Screen screen, with Open as Web App switched on and Add highlighted</title>
  <rect x="8" y="6" width="224" height="138" rx="14" class="wc-ig-screen"/>
  <text x="22" y="30" class="wc-ig-text-dim">Cancel</text>
  <text x="120" y="30" text-anchor="middle" class="wc-ig-text">Add to Home Screen</text>
  <rect x="190" y="16" width="34" height="22" rx="6" fill="none" stroke="${HIGHLIGHT}" stroke-width="2.5"/>
  <text x="207" y="31" text-anchor="middle" class="wc-ig-text">Add</text>
  <rect x="20" y="46" width="200" height="40" rx="10" class="wc-ig-card"/>
  <image href="/icon-192.png" x="28" y="52" width="28" height="28"/>
  <text x="66" y="71" class="wc-ig-text" data-app-name="short">Afterplay</text>
  <rect x="20" y="94" width="200" height="36" rx="10" class="wc-ig-card"/>
  <text x="32" y="116" class="wc-ig-text">Open as Web App</text>
  <rect x="176" y="102" width="34" height="20" rx="10" fill="${HIGHLIGHT}"/>
  <circle cx="200" cy="112" r="8" class="wc-ig-knob"/>
</svg>`;

/** A Home Screen with the app's icon highlighted. */
const PICTURE_HOME = `
<svg viewBox="0 0 240 150" role="img" aria-labelledby="ig-p4" class="wc-install-pic" data-testid="install-picture-home">
  <title id="ig-p4">The Home Screen with the app's icon</title>
  <rect x="8" y="6" width="224" height="138" rx="14" class="wc-ig-screen"/>
  ${[0, 1, 2, 3]
    .map(
      (c) =>
        `<rect x="${30 + c * 48}" y="20" width="36" height="36" rx="9" class="wc-ig-card"/>` +
        (c < 3 ? `<rect x="${30 + c * 48}" y="76" width="36" height="36" rx="9" class="wc-ig-card"/>` : ''),
    )
    .join('')}
  <image href="/icon-192.png" x="174" y="76" width="36" height="36"/>
  <rect x="170" y="72" width="44" height="44" rx="12" fill="none" stroke="${HIGHLIGHT}" stroke-width="2.5"/>
  <text x="192" y="132" text-anchor="middle" class="wc-ig-text-small" data-app-name="short">Afterplay</text>
</svg>`;

const STEPS: ReadonlyArray<{ title: string; text: string; picture: string }> = [
  {
    title: 'Open the Share menu',
    text: 'In Safari, tap <strong>⋯</strong> next to the address bar, then <strong>Share</strong>. (In older Safari, tap the Share button, a square with an arrow, in the toolbar.)',
    picture: PICTURE_SHARE,
  },
  {
    title: 'Tap “Add to Home Screen”',
    text: 'Scroll down the list if you don’t see it at first.',
    picture: PICTURE_ADD,
  },
  {
    title: 'Tap “Add”',
    text: 'Leave <strong>Open as Web App</strong> on, if your iPhone shows it.',
    picture: PICTURE_CONFIRM,
  },
  {
    title: 'Open it from the Home Screen',
    text: 'From now on, start <span data-app-name>Afterplay</span> from its icon. It opens full screen, works offline and keeps your games.',
    picture: PICTURE_HOME,
  },
];

export class InstallGuide {
  private readonly sheet: Sheet;
  private readonly continueButton: HTMLButtonElement;
  /** Set while the guide is open for a first-run link: what "Continue in Safari" goes on to. */
  private onContinue: (() => void) | null = null;

  constructor(parent: HTMLElement) {
    this.sheet = new Sheet(parent, {
      title: 'Add to Home Screen',
      testId: 'install-guide',
      // Closed in any way (Done, ×, backdrop, Escape): it does not open by itself again
      onToggle: (open) => {
        if (open) return;
        writeSeen();
        this.onContinue = null;
        this.continueButton.hidden = true;
      },
    });
    this.sheet.body.innerHTML = `
      <p class="wc-install-intro" data-testid="install-guide-intro">
        Safari can clear the saved games, puzzles and progress of a website you haven’t opened for a while.
        Added to your Home Screen, <span data-app-name>Afterplay</span> runs as an app and keeps them.
      </p>
      <ol class="wc-install-steps">
        ${STEPS.map(
          (step, i) => `
          <li class="wc-install-step" data-testid="install-step-${i + 1}">
            ${step.picture}
            <div class="wc-install-step-text"><h3>${i + 1}. ${step.title}</h3><p>${step.text}</p></div>
          </li>`,
        ).join('')}
      </ol>
      <div class="wc-install-actions">
        <button type="button" class="wc-btn wc-btn-secondary" data-testid="install-guide-continue" hidden>Continue in Safari</button>
        <button type="button" class="wc-btn wc-btn-primary" data-testid="install-guide-done">Done</button>
      </div>`;
    // The address bar in the first picture shows this page's own host, as Safari does
    const host = this.sheet.body.querySelector('[data-page-host]');
    if (host) host.textContent = shortHost(typeof location === 'undefined' ? '' : location.host);
    this.sheet.body
      .querySelector('[data-testid="install-guide-done"]')
      ?.addEventListener('click', () => this.sheet.close());
    this.continueButton = this.sheet.body.querySelector('[data-testid="install-guide-continue"]') as HTMLButtonElement;
    this.continueButton.addEventListener('click', () => {
      const next = this.onContinue;
      this.sheet.close();
      next?.();
    });
  }

  /** The name the guide uses for the app (a preset can give it one); long names are cut in the pictures. */
  public setAppName(name: string): void {
    const chars = [...name];
    const short = chars.length > PICTURE_NAME_CHARS ? `${chars.slice(0, PICTURE_NAME_CHARS - 1).join('')}…` : name;
    for (const el of this.sheet.body.querySelectorAll<HTMLElement | SVGElement>('[data-app-name]')) {
      el.textContent = el.getAttribute('data-app-name') === 'short' ? short : name;
    }
  }

  public open(): void {
    this.sheet.open();
  }

  public close(): void {
    this.sheet.close();
  }

  public isOpen(): boolean {
    return this.sheet.isOpen();
  }

  /**
   * A first-run link opened in Safari on an iPhone or iPad (first visit, not installed): the guide comes first and
   * offers "Continue in Safari", which closes it and calls `onContinue`. Closed any other way, nothing follows: the
   * link's welcome then waits for the Home Screen app (or the next visit in Safari). Returns false, opening nothing,
   * when the guide's own first-visit rule does not apply.
   */
  public openForFirstRunLink(onContinue: () => void, env: InstallEnvironment = readInstallEnvironment()): boolean {
    if (!shouldAutoOpenInstallGuide(env, readSeen())) return false;
    this.onContinue = onContinue;
    this.continueButton.hidden = false;
    this.open();
    return true;
  }

  /** Opens the guide if this is the first visit in iOS/iPadOS and the app isn't installed. */
  public openIfFirstRun(env: InstallEnvironment = readInstallEnvironment()): boolean {
    if (!shouldAutoOpenInstallGuide(env, readSeen())) return false;
    this.open();
    return true;
  }
}

/**
 * iOS Safari zooms the page in when a field with text under 16 px gets focus (the app's selects and inputs are
 * smaller) and does not zoom back out. `maximum-scale=1` stops that; on iOS the user can still pinch to zoom (Safari
 * ignores the limit for pinching since iOS 10). Elsewhere it would block pinch zoom, so it is set only on iOS.
 */
export function preventIosFocusZoom(env: InstallEnvironment = readInstallEnvironment()): boolean {
  if (!isAppleTouchDevice(env) || typeof document === 'undefined') return false;
  const meta = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
  if (!meta || /maximum-scale/.test(meta.content)) return false;
  meta.content = `${meta.content}, maximum-scale=1`;
  return true;
}
