/**
 * The Story's sentences: fixed templates filled only from `StoryStats`. No model, no network, no name: the stats
 * hold none, and the only other text that can reach a card is the optional personal intro and closing, which is
 * shown as one plain paragraph and never read for numbers.
 */
import {
  MIN_GAMES_FOR_STORY,
  MIN_GAMES_FOR_STREAKS,
  MIN_MOVES_FOR_BEST_GAME,
  MIN_REVIEWED_GAMES,
  type BestWin,
  type ClassStats,
  type OpeningStats,
  type ReviewedGameRef,
  type ReviewStats,
  type ScopeStats,
  type StoryScope,
  type StoryStats,
  type TimeClass,
  type TrendSeries,
} from './stats';

export type StoryCardId =
  | 'intro'
  | 'totals'
  | 'chesscom'
  | 'lichess'
  | 'accuracy'
  | 'mistakes'
  | 'swing'
  | 'bestGame'
  | 'openings'
  | 'bestWin'
  | 'trend'
  | 'closing';

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

// ---------------------------------------------------------------------------- engine review sentences

const PRESET_NAME: Record<NonNullable<ReviewedGameRef['preset']>, string> = {
  quick: 'Quick',
  standard: 'Standard',
  deep: 'Deep',
};

const oneDecimal = (value: number): string => value.toFixed(1);
const percent = (value: number): string => `${oneDecimal(value)}%`;
/** " in March 2024", or '' for a game with no date. */
const inMonth = (playedAt: number | null): string =>
  playedAt === null ? '' : ` in ${monthLabel(new Date(playedAt).toISOString().slice(0, 7))}`;
/** " blitz", or '' for a game with no time class. */
const classWord = (timeClass: TimeClass | null): string =>
  timeClass === null ? '' : ` ${CLASS_LABEL[timeClass].toLowerCase()}`;

/** "Not enough reviewed games yet (12 of 20)." */
export function notEnoughReviewed(reviewed: number): string {
  return `Not enough reviewed games yet (${n(reviewed)} of ${n(MIN_REVIEWED_GAMES)}).`;
}

/**
 * The fixed footnote of the Accuracy card. The device clause and the last sentence (a game reviewed here replaces its
 * earlier numbers) are left out when no counted game was reviewed on this device: the sentence has nothing to say then.
 */
export function reviewFootnote(r: ReviewStats): string {
  const sources = [
    r.inAdvance > 0 ? `${n(r.inAdvance)} reviewed in advance` : '',
    r.onDevice > 0 ? `${n(r.onDevice)} on this device with its timed review` : '',
  ].filter((part) => part !== '');
  const have = r.counted === 1 ? 'counted game has' : 'counted games have';
  const counts =
    `Accuracy is the engine's measure (Lichess's formula, Stockfish 17.1 at depth 18); Chess.com's own accuracy can differ. ` +
    `${n(r.reviewed)} of ${n(r.counted)} ${have} an engine review: ${sources.join(' and ')}.`;
  return r.onDevice > 0
    ? `${counts} A game you review here replaces its earlier numbers, and a timed review can give a slightly different number for the same game.`
    : counts;
}

/** The note under the swing and best-game cards: how that one game was reviewed. */
export function gameReviewNote(game: ReviewedGameRef): string {
  if (game.source === 'advance') {
    return game.depth === null
      ? 'This game was reviewed in advance.'
      : `This game was reviewed in advance at depth ${game.depth}.`;
  }
  return game.preset === null
    ? 'This game was reviewed on this device.'
    : `This game was reviewed on this device (${PRESET_NAME[game.preset]}).`;
}

export function accuracySentence(accuracy: number, reviewed: number): string {
  return `Your average accuracy is ${percent(accuracy)} over ${plural(reviewed, 'reviewed game')}.`;
}

export function blunderSentence(perGame: number, reviewed: number): string {
  return `You blundered ${oneDecimal(perGame)} times a game over ${plural(reviewed, 'reviewed game')}.`;
}

export function halvesSentence(h: NonNullable<ReviewStats['halves']>): string {
  return (
    `In the first half of your reviewed games (to ${monthLabel(h.first.endMonth)}) your accuracy was ${percent(h.first.accuracy)} ` +
    `and you blundered ${oneDecimal(h.first.blundersPerGame)} times a game; in the second half, ` +
    `${percent(h.second.accuracy)} and ${oneDecimal(h.second.blundersPerGame)}.`
  );
}

/** "3%", or "under 1%" below 1. */
export function chanceText(low: number): string {
  return low < 1 ? 'under 1%' : `${Math.round(low)}%`;
}

/** The clause follows what the game has: class and date, date only, class only, or neither (no clause). */
export function swingSentence(s: NonNullable<ReviewStats['swing']>): string {
  const g = s.game;
  const clause =
    g.timeClass === null && g.playedAt === null ? '' : `, a${classWord(g.timeClass)} game${inMonth(g.playedAt)}`;
  return `You won a game the engine had at ${chanceText(g.low)} for you${clause}.`;
}

export function swingPoolNote(s: NonNullable<ReviewStats['swing']>): string {
  return `Chosen from ${plural(s.reviewedWins, 'reviewed win')}.`;
}

export function bestGameSentence(b: NonNullable<ReviewStats['bestGame']>): string {
  const g = b.game;
  const against = g.opponentRating === null ? '' : ` against a player rated ${n(g.opponentRating)}`;
  const when = g.playedAt === null ? '' : `, in ${monthLabel(new Date(g.playedAt).toISOString().slice(0, 7))}`;
  return `Your most accurate game was ${percent(g.accuracy)}: a${classWord(g.timeClass)} ${g.outcome}${against}${when}, over ${n(g.moves)} of your moves.`;
}

export function bestGamePoolNote(b: NonNullable<ReviewStats['bestGame']>): string {
  return `Chosen from ${plural(b.eligible, 'reviewed game')} of ${MIN_MOVES_FOR_BEST_GAME} moves or more.`;
}

function reviewClassRow(c: ReviewStats['byClass'][number]): StoryTableRow {
  return {
    label: `${CLASS_LABEL[c.timeClass]} · ${plural(c.games, 'game')}`,
    detail: `${percent(c.accuracy)} average accuracy`,
  };
}

/**
 * The Mistakes card lists this many of the newest years. More rows make the card taller than the Story's scroller on a
 * phone; the overall numbers and the first-half/second-half note still cover every year.
 */
export const YEAR_ROWS_SHOWN = 3;

/** "The 3 earlier years are not listed." / "The earliest year is not listed." */
export function earlierYearsNote(hidden: number): string {
  return hidden === 1 ? 'The earliest year is not listed.' : `The ${n(hidden)} earlier years are not listed.`;
}

function reviewYearRow(y: ReviewStats['byYear'][number]): StoryTableRow {
  return {
    label: `${y.year} · ${plural(y.games, 'game')}`,
    detail: `${percent(y.accuracy)} accuracy · ${oneDecimal(y.blundersPerGame)} blunders a game`,
  };
}

function accuracyCard(r: ReviewStats): StoryCard {
  const footnote = reviewFootnote(r);
  if (!r.enough) return card('accuracy', 'Accuracy', { sentence: notEnoughReviewed(r.reviewed), notes: [footnote] });
  const notes: string[] = [];
  if (r.white && r.black) {
    notes.push(
      `As White ${percent(r.white.accuracy)} over ${plural(r.white.games, 'game')}; ` +
        `as Black ${percent(r.black.accuracy)} over ${plural(r.black.games, 'game')}.`,
    );
  }
  if (r.wins && r.losses) {
    notes.push(
      `Your accuracy averaged ${percent(r.wins.accuracy)} in the ${n(r.wins.games)} games you won ` +
        `and ${percent(r.losses.accuracy)} in the ${n(r.losses.games)} games you lost.`,
    );
  }
  notes.push(footnote);
  return card('accuracy', 'Accuracy', {
    value: percent(r.accuracy!),
    sentence: accuracySentence(r.accuracy!, r.reviewed),
    rows: r.byClass.map(reviewClassRow),
    notes,
  });
}

function mistakesCard(r: ReviewStats): StoryCard {
  const per = r.perGame!;
  const hiddenYears = r.byYear.length - YEAR_ROWS_SHOWN;
  return card('mistakes', 'Mistakes', {
    value: oneDecimal(per.blunder),
    sentence: blunderSentence(per.blunder, r.reviewed),
    rows: r.byYear.slice(-YEAR_ROWS_SHOWN).map(reviewYearRow),
    notes: [
      ...(hiddenYears > 0 ? [earlierYearsNote(hiddenYears)] : []),
      `Mistakes: ${oneDecimal(per.mistake)} a game. Inaccuracies: ${oneDecimal(per.inaccuracy)} a game. ` +
        `Your reviewed games average ${n(Math.round(per.moves))} of your moves.`,
      // Left out when the engine marked none of either
      ...(r.brilliant > 0 || r.great > 0
        ? [`The engine marked ${n(r.brilliant)} of your moves Brilliant and ${n(r.great)} Great.`]
        : []),
      ...(r.halves ? [halvesSentence(r.halves)] : []),
    ],
  });
}

function swingCard(r: ReviewStats): StoryCard {
  const s = r.swing;
  if (s === null) return card('swing', 'Biggest swing', { sentence: 'No reviewed win yet.' });
  return card('swing', 'Biggest swing', {
    value: chanceText(s.game.low),
    sentence: swingSentence(s),
    notes: [
      swingPoolNote(s),
      ...(s.alsoLow > 0 ? [`${plural(s.alsoLow, 'other win')} also fell that low.`] : []),
      gameReviewNote(s.game),
    ],
  });
}

/** Left out (null) when no reviewed game has MIN_MOVES_FOR_BEST_GAME moves. */
function bestGameCard(r: ReviewStats): StoryCard | null {
  const b = r.bestGame;
  if (b === null) return null;
  return card('bestGame', 'Most accurate game', {
    value: percent(b.game.accuracy),
    sentence: bestGameSentence(b),
    notes: [bestGamePoolNote(b), gameReviewNote(b.game)],
  });
}

/** The review cards: none with no reviewed game, one "not enough" card below MIN_REVIEWED_GAMES, else all four. */
export function reviewCards(r: ReviewStats): StoryCard[] {
  if (r.reviewed === 0) return [];
  if (!r.enough) return [accuracyCard(r)];
  return [accuracyCard(r), mistakesCard(r), swingCard(r), bestGameCard(r)].filter((c): c is StoryCard => c !== null);
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

/**
 * The cards in their fixed order: intro, totals, Chess.com, Lichess, the review cards (none without reviewed games),
 * openings, best win, trend, closing.
 */
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

  cards.push(...reviewCards(all.review));

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
