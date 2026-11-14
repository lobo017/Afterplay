/**
 * Games › Story: the account form, then the cards. One column in a vertical scroll with CSS scroll-snap (no gesture
 * code). The numbers come from `computeStoryStats` and the sentences from `storyCards`; nothing here reads a preset.
 * This version shows the gift's cards (intro, totals, Chess.com, Lichess, closing). "Start import" is a placeholder
 * until the sync runner is shared: it is disabled and says so.
 */
import type { GameLibrary } from '../library/library';
import { computeStoryStats, type ScopeStats, type StoryStats } from './stats';
import { storyCards, type StoryCard, type StoryCardId } from './text';
import type { StoryLanding } from './landing';

/** The cards this version shows, in order (the others are built after the gift). */
export const SHOWN_CARDS: readonly StoryCardId[] = ['intro', 'totals', 'chesscom', 'lichess', 'closing'];
/** The numbers are recounted at most this often while games arrive. */
export const RECOUNT_INTERVAL_MS = 2000;

export type LoadStatus =
  | { kind: 'idle' }
  | { kind: 'loading'; loaded: number; total: number }
  | { kind: 'paused'; loaded: number; total: number; message: string };

export interface StoryViewOptions {
  container: HTMLElement;
  library: GameLibrary;
  getLanding(): StoryLanding;
  /** "Skip for now": the app remembers it and opens Play. */
  onSkip(): void;
  /** "Continue" after a paused load. */
  onContinue(): void;
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

export class StoryView {
  private readonly root: HTMLElement;
  private stats: StoryStats | null = null;
  private load: LoadStatus = { kind: 'idle' };
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
        this.stats = computeStoryStats(await lib.list(), lib.getUserAccounts(), Date.now());
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
      case 'top':
        this.root.querySelector('.wc-story-scroll')?.scrollTo({ top: 0, behavior: 'smooth' });
        break;
    }
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
    const field = (site: 'chesscom' | 'lichess', label: string): string =>
      `<label class="wc-story-field"><span>${label}</span><input class="wc-input" type="text" autocomplete="off" autocapitalize="off" spellcheck="false" data-account="${site}" data-testid="story-account-${site}" value="${escapeHtml(this.drafts[site])}"></label>`;
    return `<section class="wc-story-card wc-story-form" data-testid="story-form" aria-label="Your accounts">
      <p class="wc-story-label">Your accounts</p>
      <p class="wc-story-sentence">Add your usernames so the Story can tell which games, and which side, are yours.</p>
      ${field('chesscom', 'Chess.com username')}
      ${field('lichess', 'Lichess username')}
      <p class="wc-story-note">Lichess import is not available yet. The name is saved and marks your side in Lichess games you open here.</p>
      <div class="wc-story-actions">
        <button type="button" class="wc-btn wc-btn-secondary wc-story-btn" data-story-action="save" data-testid="story-save">Save usernames</button>
        <button type="button" class="wc-btn wc-btn-primary wc-story-btn" data-testid="story-start-import" disabled aria-describedby="story-import-note">Start import</button>
        <button type="button" class="wc-btn wc-btn-ghost wc-story-btn" data-story-action="skip" data-testid="story-skip">Skip for now</button>
      </div>
      <p class="wc-story-note" id="story-import-note">Importing with a button comes in a later update. Games that came with your link load by themselves.</p>
      <p class="wc-story-note" data-testid="story-form-saved"${this.saved ? '' : ' hidden'}>Saved.</p>
    </section>`;
  }

  private bannerHtml(): string {
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

  private cardHtml(card: StoryCard, stats: StoryStats): string {
    const scope: ScopeStats | null =
      card.id === 'totals'
        ? stats.all
        : card.id === 'chesscom'
          ? stats.chesscom
          : card.id === 'lichess'
            ? stats.lichess
            : null;
    const rows = card.rows.length
      ? `<table class="wc-story-table"><tbody>${card.rows
          .map((r) => `<tr><th scope="row">${escapeHtml(r.label)}</th><td>${escapeHtml(r.detail)}</td></tr>`)
          .join('')}</tbody></table>`
      : '';
    const personal = card.personal ? `<p class="wc-story-personal">${escapeHtml(card.personal)}</p>` : '';
    const top =
      card.id === 'closing'
        ? '<button type="button" class="wc-btn wc-btn-secondary wc-story-btn" data-story-action="top" data-testid="story-top">Start from the top</button>'
        : '';
    return `<section class="wc-story-card" data-testid="story-card-${card.id}" data-card="${card.id}" aria-label="${escapeHtml(card.label)}">
      <p class="wc-story-label">${escapeHtml(card.label)}</p>
      ${card.value ? `<p class="wc-story-value" data-testid="story-value-${card.id}">${escapeHtml(card.value)}</p>` : ''}
      <p class="wc-story-sentence">${escapeHtml(card.sentence)}</p>
      ${scope && scope.games > 0 ? wldBar(scope) : ''}
      ${rows}
      ${card.notes.map((t) => `<p class="wc-story-note">${escapeHtml(t)}</p>`).join('')}
      ${personal}${top}
    </section>`;
  }

  private render(): void {
    const stats = this.stats;
    if (!stats) return;
    // A field being typed in is not rebuilt by a recount
    if (this.root.querySelector('input[data-account]:focus')) {
      this.updateBanner();
      return;
    }
    const landing = this.options.getLanding();
    const empty = stats.all.games === 0;
    // A new user sees the form first; with no counted games it stays above the empty cards
    const formOnly = landing === 'new' && this.load.kind === 'idle';
    const keepTop = this.root.querySelector('.wc-story-scroll')?.scrollTop ?? 0;
    const cards = storyCards(stats).filter((c) => SHOWN_CARDS.includes(c.id));
    const body = formOnly
      ? this.formHtml()
      : `${empty ? this.formHtml() : ''}${cards.map((c) => this.cardHtml(c, stats)).join('')}`;
    const html = `${this.bannerHtml()}<div class="wc-story-scroll" data-testid="story-scroll" tabindex="0" role="region" aria-label="Your Chess Story">${body}</div>`;
    if (html !== this.lastHtml || !this.root.querySelector('.wc-story-scroll')) {
      this.lastHtml = html;
      this.root.innerHTML = html;
      const next = this.root.querySelector('.wc-story-scroll');
      if (next && keepTop > 0) next.scrollTop = keepTop;
    }
    this.options.onRendered?.(!formOnly && this.load.kind === 'idle');
  }

  private updateBanner(): void {
    this.lastHtml = '';
    const old = this.root.querySelector('.wc-story-banner');
    const holder = document.createElement('div');
    holder.innerHTML = this.bannerHtml();
    const fresh = holder.firstElementChild;
    if (old && fresh) old.replaceWith(fresh);
    else if (old) old.remove();
    else if (fresh) this.root.prepend(fresh);
  }
}
