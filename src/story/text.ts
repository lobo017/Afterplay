/**
 * The Story's sentences: fixed templates filled only from `StoryStats`. No model, no network, no name: the stats
 * hold none, and the only other text that can reach a card is the optional personal intro and closing, which is
 * shown as one plain paragraph and never read for numbers.
 */
import {
  COMEBACK_BELOW,
  MIN_GAMES_FOR_STORY,
  MIN_MOVES_FOR_BEST_GAME,
  MIN_REVIEWED_GAMES,
  type Activity,
  type BestWin,
  type ClassStats,
  type ControlStats,
  type EndKind,
  type JourneySeries,
  type LongGame,
  type OpeningStats,
  type PhaseStat,
  type ReviewedGameRef,
  type ReviewStats,
  type ScopeStats,
  type StoryScope,
  type StoryStats,
  type TimeClass,
} from './stats';

export type StoryCardId =
  | 'intro'
  | 'totals'
  | 'chesscom'
  | 'lichess'
  | 'time'
  | 'ends'
  | 'openings'
  | 'accuracy'
  | 'mistakes'
  | 'phases'
  | 'marks'
  | 'bestGame'
  | 'comebacks'
  | 'bestWin'
  | 'records'
  | 'hours'
  | 'journey'
  | 'closing';

export interface StoryTableRow {
  label: string;
  /** "12 W · 3 L · 2 D" */
  detail: string;
}

/** A short list of bars: one row per way a game ended, `share` is 0–1 of the whole list's title. */
export interface StoryMeter {
  title: string;
  rows: { label: string; count: number; share: number }[];
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
  /** Bars under the rows (the "How your games end" card only). */
  meters: StoryMeter[];
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

const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export const TIME_CLASS_NOTE =
  'Time classes follow one rule for both sites, so a few games may be labeled differently on Chess.com or Lichess.';

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

/** "2025-09" → "Sep 2025". */
export function monthShort(month: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  const name = m ? MONTHS_SHORT[Number(m[2]) - 1] : undefined;
  return m && name ? `${name} ${m[1]}` : month;
}

/** "2023-08-18" → "August 18, 2023". */
export function dayLabel(day: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  const name = m ? MONTHS[Number(m[2]) - 1] : undefined;
  return m && name ? `${name} ${Number(m[3])}, ${m[1]}` : day;
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
  return { id, label, value: '', sentence: '', notes: [], rows: [], meters: [], personal: null, ...extra };
}

// ---------------------------------------------------------------------------- sentences

export function favouriteSentence(scope: ScopeStats): string {
  if (scope.favouriteClasses.length === 0) return 'No game has a time control, so there is no favorite yet.';
  const names = scope.favouriteClasses.map((c) => CLASS_LABEL[c].toLowerCase());
  const games = scope.byClass.find((c) => c.timeClass === scope.favouriteClasses[0])!.games;
  const each = scope.favouriteClasses.length > 1 ? ' each' : '';
  return `Your favorite is ${names.join(' and ')}: ${plural(games, 'game')}${each}.`;
}

export function colourSentence(scope: ScopeStats): string {
  return `You played ${plural(scope.white.games, 'game')} as White and ${plural(scope.black.games, 'game')} as Black.`;
}

/** "Longest winning streak ..." sentence is gone: the Records card shows the numbers as rows. */

/** Most played exact controls: "Most played: 10 min (1,604 games), then 15+10 (1,576 games)." */
export function controlsSentence(controls: readonly ControlStats[]): string {
  if (controls.length === 0) return '';
  const one = (c: ControlStats): string => `${c.label} (${plural(c.games, 'game')})`;
  return controls.length === 1
    ? `Most played: ${one(controls[0]!)}.`
    : `Most played: ${one(controls[0]!)}, then ${one(controls[1]!)}.`;
}

/** The share of games won, whole percent. */
const wonPercent = (w: { games: number; wins: number }): number => Math.round((w.wins / w.games) * 100);

/** One opening row: the family and its games above, the win rate and the most-played variation below. */
export function openingRow(color: 'White' | 'Black', o: OpeningStats): StoryTableRow {
  const rate = o.games >= MIN_OPENING_ROW_GAMES ? `${wonPercent(o)}% won` : wld(o);
  const top = o.topVariation ? ` · mostly ${o.topVariation.name}` : '';
  return { label: `${color} · ${o.name} · ${plural(o.games, 'game')}`, detail: `${rate}${top}` };
}
/** A win rate is a percentage from this many games of the opening. */
const MIN_OPENING_ROW_GAMES = 10;

/** How many openings of each colour the Openings card lists. */
export const OPENING_ROWS_PER_COLOUR = 2;

export function bestWinSentence(best: BestWin | null): string {
  if (best === null) return 'No rated win yet.';
  const cls = best.timeClass ? ` ${CLASS_LABEL[best.timeClass].toLowerCase()}` : '';
  const when = best.playedAt === null ? '' : ` in ${monthLabel(new Date(best.playedAt).toISOString().slice(0, 7))}`;
  const mine = best.myRating === null ? '' : ` You were rated ${n(best.myRating)}.`;
  return `Your best win was against a player rated ${n(best.opponentRating)}, in a${cls} game${when}.${mine}`;
}

/** "Biggest upset: a win against a player rated 503 points above you (1,790 against your 1,287), ..." */
export function upsetSentence(u: NonNullable<ScopeStats['upset']>): string {
  const cls = u.timeClass ? ` ${CLASS_LABEL[u.timeClass].toLowerCase()}` : '';
  const when = u.playedAt === null ? '' : ` in ${monthLabel(new Date(u.playedAt).toISOString().slice(0, 7))}`;
  return `Biggest upset: a${cls} win${when} against a player ${plural(u.points, 'point')} above you (${n(u.opponentRating)} against your ${n(u.myRating)}).`;
}

export function higherRatedSentence(wins: number): string {
  return `You have beaten a higher-rated player ${plural(wins, 'time')}.`;
}

// ---------------------------------------------------------------------------- how games end

const WIN_END: Partial<Record<EndKind, string>> = {
  checkmate: 'You checkmated them',
  resignation: 'They resigned',
  time: 'They ran out of time',
  left: 'They left',
  other: 'Other',
};
const LOSS_END: Partial<Record<EndKind, string>> = {
  checkmate: 'You were checkmated',
  resignation: 'You resigned or left',
  time: 'You ran out of time',
  other: 'Other',
};
const DRAW_END: Partial<Record<EndKind, string>> = {
  repetition: 'by repetition',
  agreement: 'by agreement',
  insufficient: 'with too few pieces',
  stalemate: 'by stalemate',
  other: 'another way',
};

function meterOf(
  title: string,
  total: number,
  counts: Record<EndKind, number>,
  labels: Partial<Record<EndKind, string>>,
): StoryMeter {
  const rows = (Object.keys(labels) as EndKind[])
    // A loss by leaving is a loss by resigning in all but name: the two are one row
    .map((kind) => ({ kind, count: counts[kind] + (labels === LOSS_END && kind === 'resignation' ? counts.left : 0) }))
    .filter((r) => r.count > 0)
    .sort((a, b) => b.count - a.count)
    .map((r) => ({ label: labels[r.kind]!, count: r.count, share: r.count / total }));
  return { title, rows };
}

/** "72 by repetition, 22 by agreement and 1 another way" for the drawn games. */
export function drawsSentence(draw: Record<EndKind, number>, draws: number): string {
  const parts = (Object.keys(DRAW_END) as EndKind[])
    .filter((k) => draw[k] > 0)
    .sort((a, b) => draw[b] - draw[a])
    .map((k) => `${n(draw[k])} ${DRAW_END[k]}`);
  const list = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : parts[0]!;
  return `You drew ${plural(draws, 'game')}: ${list}.`;
}

/** How many of the losses were by leaving (the row "Resigned or left" holds them with the resignations). */
export function leftSentence(left: number, resignedOrLeft: number): string {
  return `${n(left)} of the ${n(resignedOrLeft)} "resigned or left" ${resignedOrLeft === 1 ? 'game was' : 'games were'} by leaving.`;
}

function endsCard(s: ScopeStats): StoryCard | null {
  const e = s.endings;
  const meters: StoryMeter[] = [];
  if (s.wins > 0) meters.push(meterOf(`You won ${n(s.wins)}`, s.wins, e.win, WIN_END));
  if (s.losses > 0) meters.push(meterOf(`You lost ${n(s.losses)}`, s.losses, e.loss, LOSS_END));
  if (meters.length === 0 && s.draws === 0) return null;
  const notes: string[] = [];
  if (e.loss.left > 0) notes.push(leftSentence(e.loss.left, e.loss.resignation + e.loss.left));
  if (s.draws > 0) notes.push(drawsSentence(e.draw, s.draws));
  return card('ends', 'How your games end', { meters, notes });
}

// ---------------------------------------------------------------------------- records, time at the board, rating journey

/** "a rapid win by checkmate in March 2024". */
export function longGameSentence(kind: 'game' | 'win', g: LongGame): string {
  const cls = g.timeClass === null ? '' : ` ${CLASS_LABEL[g.timeClass].toLowerCase()}`;
  const how: Record<EndKind, string> = {
    checkmate: 'by checkmate',
    resignation: 'by resignation',
    time: 'on time',
    left: 'by leaving',
    repetition: 'by repetition',
    insufficient: 'with too few pieces',
    agreement: 'by agreement',
    stalemate: 'by stalemate',
    other: '',
  };
  const outcome = g.outcome === 'win' ? 'win' : g.outcome === 'loss' ? 'loss' : 'draw';
  const ending = how[g.ending] === '' ? '' : ` ${how[g.ending]}`;
  return `Your longest ${kind} lasted ${plural(g.moves, 'move')}: a${cls} ${outcome}${ending}${inMonth(g.playedAt)}.`;
}

function recordsCard(s: ScopeStats): StoryCard | null {
  const st = s.streaks;
  const rows: StoryTableRow[] = [];
  if (st.enough) {
    rows.push({ label: 'Losses in a row', detail: n(st.longestLoss) });
    rows.push({ label: 'Games without a loss', detail: n(st.longestUnbeaten) });
  }
  if (s.records) {
    rows.push({ label: 'Longest game', detail: plural(s.records.longest.moves, 'move') });
    if (s.records.longestWin) rows.push({ label: 'Longest win', detail: plural(s.records.longestWin.moves, 'move') });
  }
  if (rows.length === 0) return null;
  return card('records', 'Records', {
    value: st.enough ? n(st.longestWin) : '',
    sentence: st.enough
      ? `${st.longestWin === 1 ? 'win' : 'wins'} in a row: your longest streak.`
      : 'Your longest games.',
    rows,
    notes: s.records ? [longGameSentence('game', s.records.longest)] : [],
  });
}

/** "Not enough time info": hours need clocks; without them the card tells the days. */
export function hoursSentence(a: Activity): string {
  const hours = Math.max(1, Math.round(a.liveSeconds / 3600));
  return a.timedGames > 0
    ? `${hours === 1 ? 'hour' : 'hours'} at the board in live games, over ${plural(a.days, 'day')}.`
    : `${a.days === 1 ? 'day' : 'days'} with a game.`;
}

function hoursCard(a: Activity): StoryCard | null {
  if (a.datedGames === 0) return null;
  const hours = Math.max(1, Math.round(a.liveSeconds / 3600));
  const notes: string[] = [];
  if (a.longestRun > 1) notes.push(`Your longest run: ${plural(a.longestRun, 'day')} in a row.`);
  if (a.busiestMonth)
    notes.push(`Busiest month: ${monthLabel(a.busiestMonth.month)}, ${plural(a.busiestMonth.games, 'game')}.`);
  if (a.busiestYear) notes.push(`Busiest year: ${a.busiestYear.year}, ${plural(a.busiestYear.games, 'game')}.`);
  if (a.busiestDay && a.busiestDay.games > 1) {
    notes.push(`Busiest day: ${plural(a.busiestDay.games, 'game')}, on ${dayLabel(a.busiestDay.day)}.`);
  }
  return card('hours', 'Time at the board', {
    value: n(a.timedGames > 0 ? hours : a.days),
    sentence: hoursSentence(a),
    notes,
  });
}

/** The rating of one site and class: "Started 533 · peak 1,708, Sep 2025 · latest 1,500, Dec 2025". */
export function journeyDetail(j: JourneySeries): string {
  const same = j.peak.rating === j.latest.rating && j.peak.month === j.latest.month;
  const peak = same
    ? `peak and latest ${n(j.peak.rating)}, ${monthShort(j.peak.month)}`
    : `peak ${n(j.peak.rating)}, ${monthShort(j.peak.month)}`;
  return `Started ${n(j.first.rating)} · ${peak}${same ? '' : ` · latest ${n(j.latest.rating)}, ${monthShort(j.latest.month)}`}`;
}

/** At most this many classes are listed (the most played): a fifth row would not fit a short phone. */
export const JOURNEY_ROWS = 4;

function journeyCard(s: ScopeStats): StoryCard | null {
  if (s.journeys.length === 0) return null;
  const sites = new Set(s.journeys.map((j) => j.site));
  const shown = [...s.journeys]
    .sort((a, b) => b.ratedGames - a.ratedGames)
    .slice(0, JOURNEY_ROWS)
    .sort((a, b) => s.journeys.indexOf(a) - s.journeys.indexOf(b));
  const main = [...shown].sort((a, b) => b.ratedGames - a.ratedGames)[0]!;
  return card('journey', 'Rating journey', {
    value: n(main.peak.rating),
    sentence: `is your ${CLASS_LABEL[main.timeClass].toLowerCase()} peak, in ${monthLabel(main.peak.month)}.`,
    rows: shown.map((j) => ({
      label: sites.size > 1 ? `${CLASS_LABEL[j.timeClass]} · ${SITE_LABEL[j.site]}` : CLASS_LABEL[j.timeClass],
      detail: journeyDetail(j),
    })),
    notes: sites.size > 1 ? ['Ratings are never combined across sites.'] : [],
  });
}

// ---------------------------------------------------------------------------- engine review sentences

const PRESET_NAME: Record<NonNullable<ReviewedGameRef['preset']>, string> = {
  quick: 'Quick',
  standard: 'Standard',
  deep: 'Deep',
};

const oneDecimal = (value: number): string => value.toFixed(1);
const percent = (value: number): string => `${oneDecimal(value)}%`;
const twoDecimals = (value: number): string => value.toFixed(2);
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
  const counts =
    `Accuracy here is measured by the app, so it can differ a little from Chess.com's number. ` +
    `Based on ${n(r.reviewed)} of your ${plural(r.counted, 'game')}.`;
  return r.onDevice > 0
    ? `${counts} A game you review here replaces its earlier numbers, and a timed review can give a slightly different number for the same game.`
    : counts;
}

/** The note under the swing and best-game cards, only for a game reviewed on this device; none for one reviewed in advance. */
export function gameReviewNote(game: ReviewedGameRef): string[] {
  if (game.source === 'advance') return [];
  return [
    game.preset === null
      ? 'This game was reviewed on this device.'
      : `This game was reviewed on this device (${PRESET_NAME[game.preset]}).`,
  ];
}

export function accuracySentence(accuracy: number, reviewed: number): string {
  return `Your average accuracy is ${percent(accuracy)} over ${plural(reviewed, 'reviewed game')}.`;
}

export function blunderSentence(perGame: number, reviewed: number): string {
  return `You blundered ${oneDecimal(perGame)} times a game over ${plural(reviewed, 'reviewed game')}.`;
}

export function halvesSentence(h: NonNullable<ReviewStats['halves']>): string {
  return (
    `Early on: ${percent(h.first.accuracy)} accuracy and ${oneDecimal(h.first.blundersPerGame)} blunders a game. ` +
    `Lately: ${percent(h.second.accuracy)} and ${oneDecimal(h.second.blundersPerGame)}.`
  );
}

/** "3%", or "under 1%" below 1. */

/** "only a 3% chance", "only an 8% chance", "less than a 1% chance". */
function chanceClause(low: number): string {
  if (low < 1) return 'less than a 1% chance';
  const pct = Math.round(low);
  return `only ${/^(8|11|18)/.test(String(pct)) ? 'an' : 'a'} ${pct}% chance`;
}

/** The clause follows what the game has: class and date, date only, class only, or neither (no clause). */
export function unlikeliestSentence(s: NonNullable<ReviewStats['comebacks']>): string {
  const g = s.game;
  const clause =
    g.timeClass === null && g.playedAt === null ? '' : `, a${classWord(g.timeClass)} game${inMonth(g.playedAt)}`;
  return `Your most unlikely win: you had ${chanceClause(g.low)}${clause}.`;
}

export function bestGameSentence(b: NonNullable<ReviewStats['bestGame']>): string {
  const g = b.game;
  const against = g.opponentRating === null ? '' : ` against a player rated ${n(g.opponentRating)}`;
  const when = g.playedAt === null ? '' : `, in ${monthLabel(new Date(g.playedAt).toISOString().slice(0, 7))}`;
  return `Your most accurate game was ${percent(g.accuracy)}: a${classWord(g.timeClass)} ${g.outcome}${against}${when}, over ${n(g.moves)} of your moves.`;
}

export function bestGamePoolNote(b: NonNullable<ReviewStats['bestGame']>): string {
  return `Out of ${plural(b.eligible, 'game')} of ${MIN_MOVES_FOR_BEST_GAME} moves or more.`;
}

/**
 * The Accuracy card lists this many classes (the most reviewed, in class order): more rows make it taller than the
 * Story's scroller on a short phone. The Time controls card lists every class.
 */
export const CLASS_ROWS_SHOWN = 3;

function mostReviewedClasses(rows: ReviewStats['byClass']): ReviewStats['byClass'] {
  const keep = new Set([...rows].sort((a, b) => b.games - a.games).slice(0, CLASS_ROWS_SHOWN));
  return rows.filter((row) => keep.has(row));
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
    rows: mostReviewedClasses(r.byClass).map(reviewClassRow),
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
      `Mistakes: ${oneDecimal(per.mistake)} a game. Inaccuracies: ${oneDecimal(per.inaccuracy)} a game.`,
      ...(r.halves ? [halvesSentence(r.halves)] : []),
    ],
  });
}

const PHASE_WORD: Record<PhaseStat['phase'], string> = {
  opening: 'opening',
  middlegame: 'middlegame',
  endgame: 'endgame',
};

function phaseRow(p: PhaseStat): StoryTableRow {
  return {
    label: PHASE_WORD[p.phase][0]!.toUpperCase() + PHASE_WORD[p.phase].slice(1),
    detail:
      p.accuracy === null || p.blundersPer10 === null
        ? 'no moves'
        : `${percent(p.accuracy)} accuracy · ${twoDecimals(p.blundersPer10)} blunders per 10 moves`,
  };
}

/** Where you play best and worst, by accuracy; '' when fewer than two phases differ. */
export function phaseStrengthSentence(items: readonly PhaseStat[]): string {
  const played = items.filter((p) => p.accuracy !== null);
  if (played.length < 2) return '';
  const best = played.reduce((a, b) => (b.accuracy! > a.accuracy! ? b : a));
  const worst = played.reduce((a, b) => (b.accuracy! < a.accuracy! ? b : a));
  if (best.accuracy === worst.accuracy) return '';
  return `You play best in the ${PHASE_WORD[best.phase]} (${percent(best.accuracy!)}) and worst in the ${PHASE_WORD[worst.phase]} (${percent(worst.accuracy!)}).`;
}

/** Where you blunder most, per 10 moves, against where you blunder least; '' when fewer than two phases differ. */
export function phaseSlipSentence(items: readonly PhaseStat[]): string {
  const played = items.filter((p) => p.blundersPer10 !== null);
  if (played.length < 2) return '';
  const most = played.reduce((a, b) => (b.blundersPer10! > a.blundersPer10! ? b : a));
  const least = played.reduce((a, b) => (b.blundersPer10! < a.blundersPer10! ? b : a));
  if (most.blundersPer10 === least.blundersPer10) return '';
  return `You blunder most in the ${PHASE_WORD[most.phase]}: ${twoDecimals(most.blundersPer10!)} per 10 moves, against ${twoDecimals(least.blundersPer10!)} in the ${PHASE_WORD[least.phase]}.`;
}

/** "2,084 of 4,535 games reached an endgame." */
export function endgameReachedSentence(endgameGames: number, games: number): string {
  return `${n(endgameGames)} of ${plural(games, 'game')} reached an endgame.`;
}

/** The three phases of a game; left out (null) when no counted game has phase numbers. */
function phasesCard(r: ReviewStats): StoryCard | null {
  const ph = r.phases;
  if (ph === null) return null;
  const endgame = ph.items.find((p) => p.phase === 'endgame')!;
  const strength = phaseStrengthSentence(ph.items);
  return card('phases', 'Game phases', {
    sentence: strength === '' ? 'How you play the opening, the middlegame and the endgame.' : strength,
    rows: ph.items.map(phaseRow),
    notes: [
      ...(phaseSlipSentence(ph.items) === '' ? [] : [phaseSlipSentence(ph.items)]),
      endgameReachedSentence(endgame.games, ph.games),
      ...(ph.games < r.reviewed ? [`Based on ${n(ph.games)} of your ${plural(r.reviewed, 'reviewed game')}.`] : []),
    ],
  });
}

/** Brilliant and Great moves; left out (null) when there are none of either. */
function marksCard(r: ReviewStats): StoryCard | null {
  if (r.brilliant === 0 && r.great === 0) return null;
  const row = (label: string, moves: number, games: number): StoryTableRow => ({
    label,
    detail: moves === 0 ? 'none' : `${plural(moves, 'move')} in ${plural(games, 'game')}`,
  });
  return card('marks', 'Brilliant and Great', {
    sentence: `${n(r.brilliant)} Brilliant ${r.brilliant === 1 ? 'move' : 'moves'} and ${n(r.great)} Great ${r.great === 1 ? 'move' : 'moves'}.`,
    rows: [row('Brilliant', r.brilliant, r.brilliantGames), row('Great', r.great, r.greatGames)],
  });
}

/** Wins from under COMEBACK_BELOW%; left out (null) when there is none. */
function comebacksCard(r: ReviewStats): StoryCard | null {
  const c = r.comebacks;
  if (c === null || c.count === 0) return null;
  return card('comebacks', 'Comebacks', {
    value: n(c.count),
    sentence: `${c.count === 1 ? 'win' : 'wins'} from a position where you had under a ${COMEBACK_BELOW}% chance.`,
    notes: [
      unlikeliestSentence(c),
      ...(c.alsoLow > 0 ? [`${plural(c.alsoLow, 'other win')} fell that low.`] : []),
      ...gameReviewNote(c.game),
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
    notes: [bestGamePoolNote(b), ...gameReviewNote(b.game)],
  });
}

/**
 * The review cards: none with no reviewed game, one "not enough" card below MIN_REVIEWED_GAMES, else accuracy, mistakes,
 * the game phases (when any game has them), Brilliant and Great (when there are any), the most accurate game and the comebacks (when there are any).
 */
export function reviewCards(r: ReviewStats): StoryCard[] {
  if (r.reviewed === 0) return [];
  if (!r.enough) return [accuracyCard(r)];
  return [accuracyCard(r), mistakesCard(r), phasesCard(r), marksCard(r), bestGameCard(r), comebacksCard(r)].filter(
    (c): c is StoryCard => c !== null,
  );
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

function timeCard(s: ScopeStats): StoryCard | null {
  if (s.byClass.length === 0) return null;
  const favourite = s.byClass.find((c) => c.timeClass === s.favouriteClasses[0])!;
  return card('time', 'Time controls', {
    value: s.favouriteClasses.map((c) => CLASS_LABEL[c]).join(' and '),
    sentence: `is your favorite: ${plural(favourite.games, 'game')}${s.favouriteClasses.length > 1 ? ' each' : ''}.`,
    rows: s.byClass.map(classRow),
    notes: s.controls.length > 0 ? [controlsSentence(s.controls)] : [],
  });
}

function openingsCard(s: ScopeStats): StoryCard | null {
  const rows = [
    ...s.openings.white.slice(0, OPENING_ROWS_PER_COLOUR).map((o) => openingRow('White', o)),
    ...s.openings.black.slice(0, OPENING_ROWS_PER_COLOUR).map((o) => openingRow('Black', o)),
  ];
  if (rows.length === 0) return null;
  return card('openings', 'Openings', {
    sentence: 'The openings that come up most in your games',
    rows,
    notes: s.openings.withoutOpening > 0 ? [`${plural(s.openings.withoutOpening, 'game')} had no named opening.`] : [],
  });
}

function bestWinCard(s: ScopeStats): StoryCard | null {
  if (s.bestWin === null) return null;
  return card('bestWin', 'Best win', {
    value: n(s.bestWin.opponentRating),
    sentence: bestWinSentence(s.bestWin),
    notes: [
      ...(s.upset ? [upsetSentence(s.upset)] : []),
      ...(s.higherRatedWins > 0 ? [higherRatedSentence(s.higherRatedWins)] : []),
    ],
  });
}

/**
 * The cards in their fixed order, as a story: who you are (intro, totals, the sites when both have games), your time
 * at the board and rating journey, how you play (time controls, how games end, openings), how well (accuracy, mistakes,
 * Brilliant and Great, the most accurate game), the highlights (best win, comebacks, records) and the closing. A card
 * with nothing to say is left out.
 */
export function storyCards(stats: StoryStats, personal: PersonalText = {}): StoryCard[] {
  const all = stats.all;
  const thin = !all.enough;
  const cards: StoryCard[] = [];
  const add = (c: StoryCard | null): void => {
    if (c !== null) cards.push(c);
  };

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
      e.pastedOrBot > 0 ? `${plural(e.pastedOrBot, 'pasted or bot game')}` : '',
      e.notMine > 0 ? `${n(e.notMine)} not yours` : '',
      e.nonStandard > 0 ? `${plural(e.nonStandard, 'Chess960 or odds game')}` : '',
      e.unfinished > 0 ? `${plural(e.unfinished, 'unfinished game')}` : '',
    ].filter((p) => p !== '');
    const list = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : parts[0]!;
    totalNotes.push(`${list} ${e.total === 1 ? 'is' : 'are'} left out.`);
  }
  // Both notes about how the sites differ say nothing with one site
  const bothSites = stats.chesscom.games > 0 && stats.lichess.games > 0;
  cards.push(
    all.games === 0
      ? card('totals', 'Total', {
          sentence: 'No games yet. Add your username and import.',
          notes: bothSites ? [TIME_CLASS_NOTE] : [],
        })
      : card('totals', 'Total', {
          value: n(all.games),
          sentence: `${plural(all.games, 'game')} in all: ${wld(all)}.`,
          notes: [
            ...(thin ? [notEnoughGames(all.games)] : [colourSentence(all)]),
            ...totalNotes,
            ...(bothSites ? [TIME_CLASS_NOTE] : []),
          ],
        }),
  );

  // With games from one site only, the site card would repeat the Total card
  if (bothSites) {
    cards.push(scopeCard('chesscom', stats.chesscom));
    cards.push(scopeCard('lichess', stats.lichess));
  }

  if (thin) {
    if (all.games > 0) cards.push(card('openings', 'Openings', { sentence: notEnoughGames(all.games) }));
  } else {
    add(hoursCard(all.activity));
    add(journeyCard(all));
    add(timeCard(all));
    add(endsCard(all));
    add(openingsCard(all));
  }

  // The comebacks come after the best win, the other review cards before it
  const review = reviewCards(all.review);
  cards.push(...review.filter((c) => c.id !== 'comebacks'));
  if (!thin) add(bestWinCard(all));
  add(review.find((c) => c.id === 'comebacks') ?? null);
  if (!thin) add(recordsCard(all));

  cards.push(
    card('closing', 'And on', { sentence: 'That is the story so far.', personal: personalOf(personal.closing) }),
  );
  return cards;
}
