/**
 * The Story's sentences: fixed templates filled only from `StoryStats`. No model, no network, no name: the stats
 * hold none, and the only other text that can reach a card is the optional personal intro and closing, which is
 * shown as one plain paragraph and never read for numbers.
 */
import {
  MIN_GAMES_FOR_STORY,
  MIN_GAMES_FOR_STREAKS,
  type BestWin,
  type ClassStats,
  type OpeningStats,
  type ScopeStats,
  type StoryScope,
  type StoryStats,
  type TimeClass,
  type TrendSeries,
} from './stats';

export type StoryCardId = 'intro' | 'totals' | 'chesscom' | 'lichess' | 'openings' | 'bestWin' | 'trend' | 'closing';

export interface StoryTableRow {
  label: string;
  /** "12 W · 3 L · 2 D" */
  detail: string;
}

export interface StoryCard {
  id: StoryCardId;
  label: string;
  /** The one large number or word; '' when the card has none. */
  value: string;
  /** One sentence (at most three lines on a phone). */
  sentence: string;
  /** Further plain lines under the sentence (notes), possibly none. */
  notes: string[];
  rows: StoryTableRow[];
  /** The optional personal paragraph (intro and closing only); plain text. */
  personal: string | null;
}

export interface PersonalText {
  intro?: string | null;
  closing?: string | null;
}

export const CLASS_LABEL: Record<TimeClass, string> = {
  bullet: 'Bullet',
  blitz: 'Blitz',
  rapid: 'Rapid',
  classical: 'Classical',
  daily: 'Daily',
};

const SITE_LABEL: Record<StoryScope, string> = { all: 'both sites', chesscom: 'Chess.com', lichess: 'Lichess' };
const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

export const TIME_CLASS_NOTE =
  'Time classes follow one rule for both sites, so a few games may be labelled differently on Chess.com or Lichess.';

const n = (value: number): string => value.toLocaleString('en-US');
const plural = (count: number, one: string, many = `${one}s`): string => `${n(count)} ${count === 1 ? one : many}`;
const wld = (w: { wins: number; losses: number; draws: number }): string =>
  `${n(w.wins)} W · ${n(w.losses)} L · ${n(w.draws)} D`;

/** "2024-03" → "March 2024". */
export function monthLabel(month: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  const name = m ? MONTHS[Number(m[2]) - 1] : undefined;
  return m && name ? `${name} ${m[1]}` : month;
}

/** "Not enough games yet (12 of 20)." */
export function notEnoughGames(games: number, needed = MIN_GAMES_FOR_STORY): string {
  return `Not enough games yet (${n(games)} of ${n(needed)}).`;
}

function classRow(c: ClassStats): { label: string; detail: string } {
  const percent = c.showPercent ? ` · ${Math.round((c.wins / c.games) * 100)}% won` : '';
  return { label: `${CLASS_LABEL[c.timeClass]} · ${plural(c.games, 'game')}`, detail: `${wld(c)}${percent}` };
}

function personalOf(text: string | null | undefined): string | null {
  const t = (text ?? '').trim();
  return t === '' ? null : t;
}

function card(id: StoryCardId, label: string, extra: Partial<StoryCard> = {}): StoryCard {
  return { id, label, value: '', sentence: '', notes: [], rows: [], personal: null, ...extra };
}

// ---------------------------------------------------------------------------- sentences

export function favouriteSentence(scope: ScopeStats): string {
  if (scope.favouriteClasses.length === 0) return 'No game has a time control, so there is no favourite yet.';
  const names = scope.favouriteClasses.map((c) => CLASS_LABEL[c].toLowerCase());
  const games = scope.byClass.find((c) => c.timeClass === scope.favouriteClasses[0])!.games;
  const each = scope.favouriteClasses.length > 1 ? ' each' : '';
  return `Your favourite is ${names.join(' and ')}: ${plural(games, 'game')}${each}.`;
}

export function colourSentence(scope: ScopeStats): string {
  return `You played ${plural(scope.white.games, 'game')} as White and ${plural(scope.black.games, 'game')} as Black.`;
}

export function streakSentence(scope: ScopeStats): string {
  const s = scope.streaks;
  if (!s.enough) return notEnoughGames(s.datedGames, MIN_GAMES_FOR_STREAKS);
  return `Your longest winning streak is ${plural(s.longestWin, 'game')} and your longest losing streak ${plural(s.longestLoss, 'game')}.`;
}

export function openingSentence(color: 'White' | 'Black', list: readonly OpeningStats[]): string {
  if (list.length === 0) return `As ${color}, no opening has enough games yet.`;
  return `As ${color}: ${list.map((o) => `${o.name} (${plural(o.games, 'game')}, ${wld(o)})`).join('; ')}.`;
}

export function bestWinSentence(best: BestWin | null): string {
  if (best === null) return 'No rated win yet.';
  const cls = best.timeClass ? ` ${CLASS_LABEL[best.timeClass].toLowerCase()}` : '';
  const when = best.playedAt === null ? '' : ` in ${monthLabel(new Date(best.playedAt).toISOString().slice(0, 7))}`;
  return `Your best win was against a player rated ${n(best.opponentRating)}, in a${cls} game${when}.`;
}

export function trendSentence(t: TrendSeries): string {
  const cls = CLASS_LABEL[t.timeClass].toLowerCase();
  const site = SITE_LABEL[t.site];
  if (!t.anyInWindow) {
    return t.lastGameMonth === null
      ? `No ${cls} games on ${site} yet.`
      : `No games since ${monthLabel(t.lastGameMonth)}.`;
  }
  if (!t.enough) return `Not enough rated ${cls} games on ${site} in the last 12 months to draw a trend.`;
  const first = t.points[0]!;
  const last = t.points[t.points.length - 1]!;
  const change = last.rating - first.rating;
  const how = change === 0 ? 'unchanged' : `${change > 0 ? 'up' : 'down'} ${n(Math.abs(change))}`;
  return `Your ${site} ${cls} rating went from ${n(first.rating)} in ${monthLabel(first.month)} to ${n(last.rating)} in ${monthLabel(last.month)}: ${how}.`;
}

// ---------------------------------------------------------------------------- cards

function scopeCard(id: 'chesscom' | 'lichess', s: ScopeStats): StoryCard {
  const label = SITE_LABEL[id];
  if (s.games === 0) {
    return card(id, label, { sentence: `No ${label} games are stored yet.` });
  }
  return card(id, label, {
    value: n(s.games),
    sentence: `${plural(s.games, 'game')} on ${label}: ${wld(s)}.`,
    rows: s.byClass.map(classRow),
    notes: s.enough ? [favouriteSentence(s), colourSentence(s)] : [notEnoughGames(s.games)],
  });
}

/** The cards in their fixed order: intro, totals, Chess.com, Lichess, openings, best win, trend, closing. */
export function storyCards(stats: StoryStats, personal: PersonalText = {}): StoryCard[] {
  const all = stats.all;
  const thin = !all.enough;
  const cards: StoryCard[] = [];

  cards.push(
    card('intro', 'Your story', {
      sentence:
        all.games === 0
          ? 'No games yet. Add your username and import.'
          : `Here is what ${plural(all.games, 'game')} of yours add up to.`,
      personal: personalOf(personal.intro),
    }),
  );

  const totalNotes: string[] = [];
  if (stats.onBothSites > 0) {
    totalNotes.push(
      `${plural(stats.onBothSites, 'game is', 'games are')} on both sites and ${stats.onBothSites === 1 ? 'is' : 'are'} counted once.`,
    );
  }
  if (stats.excluded.total > 0) {
    const e = stats.excluded;
    const parts = [
      e.pastedOrBot > 0 ? `${n(e.pastedOrBot)} pasted or played against the bot` : '',
      e.notMine > 0 ? `${n(e.notMine)} not yours` : '',
      e.nonStandard > 0 ? `${n(e.nonStandard)} Chess960 or set-up` : '',
      e.unfinished > 0 ? `${n(e.unfinished)} unfinished` : '',
    ].filter((p) => p !== '');
    totalNotes.push(`${plural(e.total, 'stored game was', 'stored games were')} not counted (${parts.join(', ')}).`);
  }
  totalNotes.push(TIME_CLASS_NOTE);
  cards.push(
    all.games === 0
      ? card('totals', 'Total', {
          sentence: 'No games yet. Add your username and import.',
          notes: totalNotes.slice(-1),
        })
      : card('totals', 'Total', {
          value: n(all.games),
          sentence: `${plural(all.games, 'game')} in all: ${wld(all)}.`,
          rows: all.byClass.map(classRow),
          notes: [
            ...(thin ? [notEnoughGames(all.games)] : [favouriteSentence(all), colourSentence(all)]),
            ...totalNotes,
          ],
        }),
  );

  cards.push(scopeCard('chesscom', stats.chesscom));
  // The Lichess section appears only when Lichess games are stored
  if (stats.lichess.games > 0) cards.push(scopeCard('lichess', stats.lichess));

  cards.push(
    thin
      ? card('openings', 'Openings', { sentence: notEnoughGames(all.games) })
      : card('openings', 'Openings', {
          sentence: openingSentence('White', all.openings.white),
          notes: [
            openingSentence('Black', all.openings.black),
            ...(all.openings.withoutOpening > 0
              ? [`${plural(all.openings.withoutOpening, 'game')} had no opening in the book and are not listed.`]
              : []),
            streakSentence(all),
          ],
        }),
  );

  cards.push(
    card('bestWin', 'Best win', {
      value: all.bestWin ? n(all.bestWin.opponentRating) : '',
      sentence: bestWinSentence(all.bestWin),
    }),
  );

  cards.push(
    thin
      ? card('trend', 'Rating', { sentence: notEnoughGames(all.games) })
      : all.trends.length === 0
        ? card('trend', 'Rating', { sentence: 'No games with a time control yet.' })
        : card('trend', 'Rating', {
            sentence: trendSentence(all.trends[0]!),
            notes: [
              ...all.trends.slice(1).map(trendSentence),
              'Ratings are never combined across sites, and unrated games cannot be told apart on Chess.com.',
            ],
          }),
  );

  cards.push(
    card('closing', 'And on', { sentence: 'That is the story so far.', personal: personalOf(personal.closing) }),
  );
  return cards;
}
