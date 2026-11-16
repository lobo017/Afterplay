/**
 * Games › Story: the account form, then the cards. One column in a vertical scroll with CSS scroll-snap (no gesture
 * code). The numbers come from `computeStoryStats` and the sentences from `storyCards`; nothing here reads a preset.
 * The cards are `storyCards`' (the sites' cards only when both have games). "Start import" and "Continue" ask
 * the app's shared sync runner (app.ts) for the Chess.com games; the view only shows how far it is and what went
 * wrong, in plain words.
 */
import type { GameLibrary } from '../library/library';
import { tapWordLower } from '../ui/pointer-words';
import { computeStoryStats, type ScopeStats, type StoryStats } from './stats';
import { storyCards, type PersonalText, type StoryCard, type StoryCardId, type StoryMeter } from './text';
import type { StoryLanding } from './landing';
import {
  SITE_NAME,
  addMoreAccount,
  moreAccountsHtml,
  removeMoreAccount,
  type AccountSite,
} from '../library/more-accounts';

/** Cards whose rows are two parts that do not fit side by side on a phone: the label above, the detail under it. */
const STACKED_CARDS: readonly StoryCardId[] = ['mistakes', 'phases', 'openings', 'journey'];
/**
 * The sections of the wide layout. The DOM stays flat (a heading, then its cards, all children of the scroll box), so the
 * phone's single column and the order of its cards are exactly the same; the phone hides the headings.
 */
const SECTIONS: readonly { key: string; title: string; ids: readonly StoryCardId[] }[] = [
  { key: 'hero', title: 'Your story', ids: ['intro'] },
  { key: 'years', title: 'Your years', ids: ['totals', 'chesscom', 'lichess', 'hours', 'journey'] },
  { key: 'play', title: 'How you play', ids: ['time', 'ends', 'openings'] },
  { key: 'skill', title: 'How well you play', ids: ['accuracy', 'mistakes', 'phases', 'marks'] },
  { key: 'best', title: 'Your best', ids: ['bestGame', 'bestWin', 'comebacks', 'records'] },
  { key: 'closing', title: '', ids: ['closing'] },
];
/** Cards with long table rows or bars want more room on a wide screen; the others weigh 4 of 12 columns. */
const WIDE_CARDS: readonly StoryCardId[] = [
  'journey',
  'time',
  'ends',
  'openings',
  'accuracy',
  'mistakes',
  'phases',
  'marks',
];
const sectionOf = (id: StoryCardId) => SECTIONS.find((s) => s.ids.includes(id)) ?? SECTIONS[SECTIONS.length - 1]!;

/**
 * How many of the 12 columns each card of one section takes. Cards are packed into the fewest rows their weights need,
 * every row is filled, and a row's columns are shared by weight.
 */
export function packSpans(weights: readonly number[]): number[] {
  const total = weights.reduce((a, b) => a + b, 0);
  const rowCount = Math.max(1, Math.ceil(total / 12));
  const target = total / rowCount;
  const rows: number[][] = [];
  let row: number[] = [];
  let sum = 0;
  weights.forEach((w, i) => {
    if (row.length > 0 && (sum + w > 12 || sum + w / 2 > target)) {
      rows.push(row);
      row = [];
      sum = 0;
    }
    row.push(i);
    sum += w;
  });
  if (row.length > 0) rows.push(row);
  const spans = weights.map(() => 12);
  for (const r of rows) {
    const rowTotal = r.reduce((a, i) => a + weights[i]!, 0);
    let left = 12;
    r.forEach((i, k) => {
      const share = k === r.length - 1 ? left : Math.max(3, Math.round((weights[i]! / rowTotal) * 12));
      spans[i] = share;
      left -= share;
    });
  }
  return spans;
}

const MONTH_THEN_NUMBER =
  /\b(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (?=\d)/g;
/**
 * A number stays with the word after it ("119 D.", "51% won", "1,790 against"), and a month with its year or day
 * ("Nov 2026"), so a line never ends on a number and starts on its unit. The stored text is not changed; only what is shown.
 */
export function glue(text: string): string {
  return text.replace(/(\d(?:[\d,.]*\d)?%?) (?=[A-Za-z])/g, '$1 ').replace(MONTH_THEN_NUMBER, '$1 ');
}
const gl = (text: string): string => escapeHtml(glue(text));

/** The four headline tiles of the wide layout: numbers the cards below already show. */
const TILES: readonly { id: StoryCardId; key: string; label: string }[] = [
  { id: 'totals', key: 'games', label: 'Games counted' },
  { id: 'journey', key: 'peak', label: 'Peak rating' },
  { id: 'accuracy', key: 'accuracy', label: 'Accuracy' },
  { id: 'records', key: 'streak', label: 'Longest winning streak' },
];

/** The numbers are recounted at most this often while games arrive. */
export const RECOUNT_INTERVAL_MS = 2000;

export type LoadStatus =
  | { kind: 'idle' }
  | { kind: 'loading'; loaded: number; total: number }
  | { kind: 'paused'; loaded: number; total: number; message: string };

/** Where the Chess.com import is. The file load has its own status (LoadStatus). */
export type SyncStatus =
  | { kind: 'idle' }
  | { kind: 'running'; line: string }
  | { kind: 'paused'; line: string; message: string }
  /** The username is wrong: the message sits on the field of the account with that name. */
  | { kind: 'field-error'; username: string; message: string }
  /** Something to say that is neither progress nor a failure (another sync is running; the import finished). */
  | { kind: 'notice'; message: string };

export interface StoryViewOptions {
  container: HTMLElement;
  library: GameLibrary;
  getLanding(): StoryLanding;
  /** "Skip for now": the app remembers it and opens Play. */
  onSkip(): void;
  /** "Continue" after a paused load of the link's history file. */
  onContinue(): void;
  /**
   * "Start import" and "Continue" on a paused import: the app runs the shared sync runner for every Chess.com
   * account. Called from the click handler only, once per press.
   */
  onStartImport(): Promise<void>;
  /** The preset's optional intro and closing paragraphs (never read for numbers). */
  getPersonal?(): PersonalText;
  /** Called after each render; `finished` is true when cards (not the form) are showing and no load is running. */
  onRendered?(finished: boolean): void;
}

const escapeHtml = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const n = (value: number): string => value.toLocaleString('en-US');

function wldBar(s: ScopeStats): string {
  const decided = s.wins + s.losses + s.draws;
  if (decided === 0) return '';
  const pct = (v: number): string => `${((v / decided) * 100).toFixed(2)}%`;
  return `<div class="wc-story-bar" role="img" aria-label="${n(s.wins)} won, ${n(s.draws)} drawn, ${n(s.losses)} lost">
      <span class="wc-story-bar-w" style="width:${pct(s.wins)}"></span><span class="wc-story-bar-d" style="width:${pct(s.draws)}"></span><span class="wc-story-bar-l" style="width:${pct(s.losses)}"></span>
    </div>
    <div class="wc-story-bar-key"><span>${n(s.wins)} won</span><span>${n(s.draws)} drawn</span><span>${n(s.losses)} lost</span></div>`;
}

/** One list of bars ("You won 2,405"): a label, a bar as wide as its share, and the count. */
function meterHtml(m: StoryMeter): string {
  return `<div class="wc-story-meter" role="group" aria-label="${escapeHtml(m.title)}">
      <p class="wc-story-meter-title">${escapeHtml(m.title)}</p>
      ${m.rows
        .map(
          (r) =>
            `<div class="wc-story-meter-row"><span>${escapeHtml(r.label)}</span><span class="wc-story-meter-track" aria-hidden="true"><i style="width:${(r.share * 100).toFixed(1)}%"></i></span><b>${n(r.count)}</b></div>`,
        )
        .join('')}
    </div>`;
}

export class StoryView {
  private readonly root: HTMLElement;
  private stats: StoryStats | null = null;
  private load: LoadStatus = { kind: 'idle' };
  private sync: SyncStatus = { kind: 'idle' };
  private readonly moreDrafts: Record<AccountSite, string> = { chesscom: '', lichess: '' };
  private readonly moreErrors: Record<AccountSite, string> = { chesscom: '', lichess: '' };
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastCount = 0;
  private counting = false;
  private again = false;
  private readonly drafts = { chesscom: '', lichess: '' };
  private draftsDirty = false;
  private saved = false;
  /** The markup on the page: an unchanged recount leaves the DOM (and the reader's scroll and taps) alone. */
  private lastHtml = '';

  constructor(private readonly options: StoryViewOptions) {
    this.root = options.container;
    this.root.classList.add('wc-story-root');
    this.root.innerHTML = '<p class="wc-games-loading" data-testid="story-loading">Counting your games…</p>';
    options.library.onAccountsChange(() => {
      if (!this.draftsDirty) this.syncDrafts();
      void this.recount();
    });
    this.root.addEventListener('click', (e) => this.onClick(e));
    this.root.addEventListener('input', (e) => {
      const input = e.target as HTMLInputElement | null;
      if (input?.matches('input[data-more-input]')) {
        this.moreDrafts[input.dataset.site as AccountSite] = input.value;
        return;
      }
      if (input?.matches('input[data-account]')) {
        this.drafts[input.dataset.account as 'chesscom' | 'lichess'] = input.value;
        this.draftsDirty = true;
        this.saved = false;
      }
    });
  }

  public getStats(): StoryStats | null {
    return this.stats;
  }

  public setLoad(status: LoadStatus): void {
    this.load = status;
    this.render();
  }

  public setSync(status: SyncStatus): void {
    this.sync = status;
    this.render();
  }

  public getSync(): SyncStatus {
    return this.sync;
  }

  /** Recounts now (a count already running is asked to run once more). */
  public async recount(): Promise<void> {
    if (this.counting) {
      this.again = true;
      return;
    }
    this.counting = true;
    try {
      do {
        this.again = false;
        this.lastCount = Date.now();
        const lib = this.options.library;
        this.stats = computeStoryStats(await lib.list(), lib.getUserAccounts());
      } while (this.again);
    } finally {
      this.counting = false;
    }
    this.render();
  }

  /** Recounts soon, at most once per RECOUNT_INTERVAL_MS (games arrive in batches). */
  public scheduleRecount(): void {
    if (this.timer !== null) return;
    const wait = Math.max(0, RECOUNT_INTERVAL_MS - (Date.now() - this.lastCount));
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.recount();
    }, wait);
  }

  /** Called when the Story's pane is shown. */
  public shown(): void {
    void this.recount();
  }

  private syncDrafts(): void {
    const mine = this.options.library.getMyAccounts();
    this.drafts.chesscom = mine?.chesscom ?? '';
    this.drafts.lichess = mine?.lichess ?? '';
  }

  private onClick(e: Event): void {
    const more = (e.target as HTMLElement).closest<HTMLElement>('[data-more-action]');
    if (more) {
      const site = more.dataset.site as AccountSite;
      // Safari does not focus a button it was tapped on: the typed-in field would keep a recount from redrawing
      this.root.querySelectorAll<HTMLElement>('input[data-more-input]').forEach((i) => i.blur());
      if (more.dataset.moreAction === 'add') void this.addAccount(site);
      else void removeMoreAccount(this.options.library, site, more.dataset.username ?? '');
      return;
    }
    const button = (e.target as HTMLElement).closest<HTMLElement>('[data-story-action]');
    if (!button) return;
    switch (button.dataset.storyAction) {
      case 'skip':
        this.options.onSkip();
        break;
      case 'save':
        void this.saveAccounts();
        break;
      case 'continue':
        this.options.onContinue();
        break;
      case 'start-import':
      case 'import-continue':
        void this.runImport();
        break;

      case 'top': {
        // The phone scrolls inside the box; the wide layout scrolls the page
        const box = this.root.querySelector<HTMLElement>('.wc-story-scroll');
        if (box && getComputedStyle(box).overflowY === 'auto') box.scrollTo({ top: 0, behavior: 'smooth' });
        else window.scrollTo({ top: 0, behavior: 'smooth' });
        break;
      }
    }
  }

  /** "Start import" and "Continue": what was typed is saved first, then the app's sync runner starts. */
  private async runImport(): Promise<void> {
    if (this.draftsDirty) await this.saveAccounts();
    await this.options.onStartImport();
  }

  private async addAccount(site: AccountSite): Promise<void> {
    const result = await addMoreAccount(this.options.library, site, this.moreDrafts[site]);
    if (result.ok) {
      this.moreDrafts[site] = '';
      this.moreErrors[site] = '';
    } else {
      this.moreErrors[site] = result.message;
    }
    this.lastHtml = '';
    this.render();
  }

  private async saveAccounts(): Promise<void> {
    await this.options.library.setMyAccounts({
      chesscom: this.drafts.chesscom.trim(),
      lichess: this.drafts.lichess.trim(),
    });
    this.draftsDirty = false;
    this.saved = true;
    await this.recount();
  }

  // ------------------------------------------------------------------------ rendering

  private formHtml(): string {
    if (!this.draftsDirty) this.syncDrafts();
    const accounts = this.options.library.getMoreAccounts();
    const sync = this.sync;
    const primary = this.options.library.getMyAccounts()?.chesscom.trim().toLowerCase() ?? '';
    // A wrong username is told on its own field: the first one, or the added one the sync was in
    const fieldError = sync.kind === 'field-error' ? sync : null;
    const onPrimary = fieldError !== null && (fieldError.username.toLowerCase() === primary || primary === '');
    const field = (site: AccountSite, label: string): string => {
      const error = site === 'chesscom' && fieldError && onPrimary ? fieldError.message : '';
      const added =
        site === 'chesscom' && fieldError && !onPrimary
          ? `${SITE_NAME.chesscom} account ${fieldError.username}: ${fieldError.message}`
          : '';
      return `<label class="wc-story-field"><span>${label}</span><input class="wc-input" type="text" autocomplete="off" autocapitalize="off" spellcheck="false" data-account="${site}" data-testid="story-account-${site}" value="${escapeHtml(this.drafts[site])}"${error ? ' aria-invalid="true"' : ''}></label>
      <p class="wc-story-error" role="alert" data-testid="story-account-${site}-error"${error ? '' : ' hidden'}>${escapeHtml(error)}</p>
      ${moreAccountsHtml(site, accounts, { idPrefix: 'story-more', draft: this.moreDrafts[site], error: this.moreErrors[site] || added })}`;
    };
    const busy = sync.kind === 'running';
    return `<section class="wc-story-card wc-story-form" data-testid="story-form" aria-label="Your accounts">
      <p class="wc-story-label">Your accounts</p>
      <p class="wc-story-sentence">Add your usernames so the Story can tell which games, and which side, are yours.</p>
      ${field('chesscom', 'Chess.com username')}
      ${field('lichess', 'Lichess username')}
      <p class="wc-story-note">Start import gets your games from Chess.com, for every account above, newest month first. Nothing is requested until you ${tapWordLower()} it.</p>
      <p class="wc-story-note">Lichess import is not available yet. The name is saved and marks your side in Lichess games you open here.</p>
      <div class="wc-story-actions">
        <button type="button" class="wc-btn wc-btn-secondary wc-story-btn" data-story-action="save" data-testid="story-save">Save usernames</button>
        <button type="button" class="wc-btn wc-btn-primary wc-story-btn" data-story-action="start-import" data-testid="story-start-import"${busy ? ' disabled' : ''}>Start import</button>
        <button type="button" class="wc-btn wc-btn-ghost wc-story-btn" data-story-action="skip" data-testid="story-skip">Skip for now</button>
      </div>
      <p class="wc-story-note" data-testid="story-import-note"${sync.kind === 'notice' ? '' : ' hidden'}>${sync.kind === 'notice' ? escapeHtml(sync.message) : ''}</p>
      <p class="wc-story-note" data-testid="story-form-saved"${this.saved ? '' : ' hidden'}>Saved.</p>
    </section>`;
  }

  private syncBannerHtml(): string {
    const s = this.sync;
    if (s.kind === 'running') {
      return `<div class="wc-story-banner" data-testid="story-sync-status" data-state="running" role="status">
        <strong>${escapeHtml(s.line)}</strong>
        <span>The numbers grow as games arrive.</span></div>`;
    }
    if (s.kind === 'paused') {
      return `<div class="wc-story-banner" data-testid="story-sync-status" data-state="paused" role="status">
        <strong>${escapeHtml(s.line)}</strong>
        <span>${escapeHtml(s.message)}</span>
        <button type="button" class="wc-btn wc-btn-primary wc-story-btn" data-story-action="import-continue" data-testid="story-sync-continue">Continue</button></div>`;
    }
    if (s.kind === 'notice' && this.stats && this.stats.all.games > 0) {
      return `<div class="wc-story-banner" data-testid="story-sync-status" data-state="notice" role="status"><span>${escapeHtml(s.message)}</span></div>`;
    }
    return '';
  }

  private bannerHtml(): string {
    return this.syncBannerHtml() + this.loadBannerHtml();
  }

  private loadBannerHtml(): string {
    const l = this.load;
    if (l.kind === 'loading') {
      return `<div class="wc-story-banner" data-testid="story-load-status" data-state="loading" role="status">
        <strong>Loading your games: ${n(l.loaded)} of ${n(l.total)}</strong>
        <span>The numbers grow as games arrive.</span></div>`;
    }
    if (l.kind === 'paused') {
      return `<div class="wc-story-banner" data-testid="story-load-status" data-state="paused" role="status">
        <strong>${l.total > 0 ? `Paused: ${n(l.loaded)} of ${n(l.total)} games loaded` : 'Paused: your games have not loaded yet'}</strong>
        <span>${escapeHtml(l.message)}</span>
        <button type="button" class="wc-btn wc-btn-primary wc-story-btn" data-story-action="continue" data-testid="story-continue">Continue</button></div>`;
    }
    return '';
  }

  private cardHtml(card: StoryCard, stats: StoryStats, extraClass = ''): string {
    const scope: ScopeStats | null =
      card.id === 'totals'
        ? stats.all
        : card.id === 'chesscom'
          ? stats.chesscom
          : card.id === 'lichess'
            ? stats.lichess
            : null;
    // Year rows are two parts that do not fit side by side on a phone: the label above, the detail under it. The block
    // layout can drop the table's semantics for a screen reader, so the stacked table says what it is.
    const stacked = STACKED_CARDS.includes(card.id);
    const rows = card.rows.length
      ? `<table class="wc-story-table${stacked ? ' wc-story-table-stack' : ''}"${stacked ? ' role="table"' : ''}><tbody${stacked ? ' role="rowgroup"' : ''}>${card.rows
          .map((r) =>
            stacked
              ? `<tr role="row"><th scope="row" role="rowheader">${gl(r.label)}</th><td role="cell">${gl(r.detail)}</td></tr>`
              : `<tr><th scope="row">${gl(r.label)}</th><td>${gl(r.detail)}</td></tr>`,
          )
          .join('')}</tbody></table>`
      : '';
    const personal = card.personal ? `<p class="wc-story-personal">${gl(card.personal)}</p>` : '';
    const top =
      card.id === 'closing'
        ? '<button type="button" class="wc-btn wc-btn-secondary wc-story-btn" data-story-action="top" data-testid="story-top">Start from the top</button>'
        : '';
    return `<section class="wc-story-card${extraClass}" data-testid="story-card-${card.id}" data-card="${card.id}" aria-label="${escapeHtml(card.label)}">
      <p class="wc-story-label">${escapeHtml(card.label)}</p>
      ${card.value ? `<p class="wc-story-value" data-testid="story-value-${card.id}">${escapeHtml(card.value)}</p>` : ''}
      ${card.sentence ? `<p class="wc-story-sentence">${gl(card.sentence)}</p>` : ''}
      ${scope && scope.games > 0 ? wldBar(scope) : ''}
      ${card.meters.map(meterHtml).join('')}
      ${rows}
      ${card.notes.map((t) => `<p class="wc-story-note">${gl(t)}</p>`).join('')}
      ${personal}${top}
    </section>`;
  }

  /**
   * The cards in their order, each section's heading in front of its first card (the phone hides the headings) and the
   * four headline tiles after the intro (the phone hides them too). Every card also carries how many of the wide layout's
   * 12 columns it takes. A section with no cards gets no heading.
   */
  private sectionsHtml(cards: readonly StoryCard[], stats: StoryStats): string {
    const byId = new Map(cards.map((c) => [c.id, c]));
    const tiles = TILES.flatMap((t) => {
      const value = byId.get(t.id)?.value ?? '';
      return value === ''
        ? []
        : [
            `<div class="wc-story-tile" data-testid="story-tile-${t.key}"><span class="wc-story-tile-value">${escapeHtml(value)}</span><span class="wc-story-tile-label">${t.label}</span></div>`,
          ];
    });
    const out: string[] = [];
    let at = 0;
    while (at < cards.length) {
      const section = sectionOf(cards[at]!.id);
      let end = at;
      while (end < cards.length && sectionOf(cards[end]!.id) === section) end++;
      const group = cards.slice(at, end);
      at = end;
      if (section.key === 'hero') {
        out.push(`<h2 class="wc-story-heading wc-story-heading-hero">${section.title}</h2>`);
        for (const c of group)
          out.push(this.cardHtml(c, stats, tiles.length > 0 ? ' wc-story-hero-card' : ' wc-story-span-12'));
        if (tiles.length > 0) out.push(`<div class="wc-story-tiles" data-testid="story-tiles">${tiles.join('')}</div>`);
        continue;
      }
      if (section.title !== '') out.push(`<h2 class="wc-story-heading">${section.title}</h2>`);
      const spans = section.key === 'closing' ? [12] : packSpans(group.map((c) => (WIDE_CARDS.includes(c.id) ? 6 : 4)));
      group.forEach((c, i) => {
        // On two columns an odd card at the end of a section takes the whole row
        const lone = i === group.length - 1 && group.length % 2 === 1 ? ' wc-story-lone' : '';
        out.push(this.cardHtml(c, stats, ` wc-story-span-${spans[i]}${lone}`));
      });
    }
    return out.join('');
  }

  private render(): void {
    const stats = this.stats;
    if (!stats) return;
    // A field being typed in is not rebuilt by a recount
    if (this.root.querySelector('input[data-account]:focus, input[data-more-input]:focus')) {
      this.updateBanner();
      return;
    }
    const landing = this.options.getLanding();
    const empty = stats.all.games === 0;
    // A new user sees the form first; with no counted games it stays above the empty cards
    const formOnly = landing === 'new' && this.load.kind === 'idle';
    const keepTop = this.root.querySelector('.wc-story-scroll')?.scrollTop ?? 0;
    const keepPage = window.scrollY;
    const cards = storyCards(stats, this.options.getPersonal?.() ?? {});
    const body = formOnly
      ? this.formHtml()
      : `${empty || this.sync.kind === 'field-error' ? this.formHtml() : ''}${this.sectionsHtml(cards, stats)}`;
    const html = `${this.bannerHtml()}<div class="wc-story-scroll" data-testid="story-scroll" tabindex="0" role="region" aria-label="Your Chess Story">${body}</div>`;
    if (html !== this.lastHtml || !this.root.querySelector('.wc-story-scroll')) {
      this.lastHtml = html;
      this.root.innerHTML = html;
      const next = this.root.querySelector('.wc-story-scroll');
      if (next && keepTop > 0) next.scrollTop = keepTop;
      // The wide layout scrolls the page: a rebuilt list must not send the reader back up
      if (keepPage > 0 && window.scrollY !== keepPage) window.scrollTo({ top: keepPage });
    }
    this.options.onRendered?.(
      !formOnly && this.load.kind === 'idle' && (this.sync.kind === 'idle' || this.sync.kind === 'notice'),
    );
  }

  private updateBanner(): void {
    this.lastHtml = '';
    this.root.querySelectorAll('.wc-story-banner').forEach((b) => b.remove());
    const holder = document.createElement('div');
    holder.innerHTML = this.bannerHtml();
    this.root.prepend(...Array.from(holder.children));
  }
}
