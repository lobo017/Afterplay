import type { Color } from '../core/rules';
import type { PuzzleRatingState } from '../trainers/puzzle-store';
import type { GameFilter } from './game-rows';
import { toRow, type GameRow } from './game-rows';
import {
  MOTIF_LABEL,
  PHASE_LABEL,
  accuracyByPhase,
  blundersOverTime,
  commonMotifs,
  puzzleRatingSeries,
  resultsByOpening,
  type InsightPosition,
  type ReviewedGameInput,
} from './insights';
import type { GameLibrary } from './library';

export interface InsightsViewOptions {
  container: HTMLElement;
  library: GameLibrary;
  getPuzzleRating: () => Promise<Pick<PuzzleRatingState, 'history' | 'rating' | 'games'>>;
  /** Opens a game of the library on the board at a move. */
  onOpenPosition: (gameId: string, ply: number) => void;
  /** Shows the Games list with these filters. */
  onOpenGames: (filter: Partial<GameFilter>) => void;
  onOpenPuzzle: (puzzleId: string) => void;
}

const escapeHtml = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const GLYPH: Record<string, string> = {
  K: '♔',
  Q: '♕',
  R: '♖',
  B: '♗',
  N: '♘',
  P: '♙',
  k: '♚',
  q: '♛',
  r: '♜',
  b: '♝',
  n: '♞',
  p: '♟',
};

/** A small static board for a FEN, from `from`'s side. */
export function miniBoardHtml(fen: string, from: Color = 'w'): string {
  const rows = (fen.split(' ')[0] ?? '').split('/');
  const cells: string[] = [];
  rows.forEach((row, r) => {
    let f = 0;
    for (const ch of row) {
      if (/\d/.test(ch)) {
        f += Number(ch);
        continue;
      }
      cells.push(
        `<text x="${f * 10 + 5}" y="${r * 10 + 8}" class="wc-mini-piece wc-mini-${ch === ch.toUpperCase() ? 'w' : 'b'}">${GLYPH[ch] ?? ''}</text>`,
      );
      f++;
    }
  });
  const squares: string[] = [];
  for (let r = 0; r < 8; r++)
    for (let f = 0; f < 8; f++)
      squares.push(
        `<rect x="${f * 10}" y="${r * 10}" width="10" height="10" class="wc-mini-sq-${(r + f) % 2 === 0 ? 'l' : 'd'}"/>`,
      );
  const flip = from === 'b' ? ' transform="rotate(180 40 40)"' : '';
  // Pieces are drawn upright even when the board is turned round
  const pieces =
    from === 'b'
      ? cells
          .map((c) =>
            c.replace(
              /x="([\d.]+)" y="([\d.]+)"/,
              (_m, x: string, y: string) => `x="${80 - Number(x)}" y="${80 - Number(y) + 6}"`,
            ),
          )
          .join('')
      : cells.join('');
  return `<svg class="wc-mini-board" viewBox="0 0 80 80" aria-hidden="true" focusable="false"><g${flip}>${squares.join('')}</g>${pieces}</svg>`;
}

interface LinePoint {
  id: string;
  x: number;
  y: number;
  label: string;
}

/** A line chart with one clickable dot per point. x and y are in data units; the axes are drawn from the ranges given. */
function lineChartSvg(
  points: LinePoint[],
  opts: { yMin: number; yMax: number; yTicks: number[]; xLabels: [string, string]; testId: string; ariaLabel: string },
): string {
  const W = 640;
  const H = 220;
  const L = 44;
  const R = 12;
  const T = 12;
  const B = 28;
  const xs = points.map((p) => p.x);
  const x0 = Math.min(...xs);
  const x1 = Math.max(...xs);
  const sx = (x: number) => L + (x1 === x0 ? (W - L - R) / 2 : ((x - x0) / (x1 - x0)) * (W - L - R));
  const sy = (y: number) => T + (1 - (y - opts.yMin) / (opts.yMax - opts.yMin || 1)) * (H - T - B);
  const grid = opts.yTicks
    .map(
      (t) =>
        `<line x1="${L}" x2="${W - R}" y1="${sy(t)}" y2="${sy(t)}" class="wc-chart-grid"/><text x="${L - 6}" y="${sy(t) + 4}" text-anchor="end" class="wc-chart-axis">${t}</text>`,
    )
    .join('');
  const path = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${sx(p.x).toFixed(1)} ${sy(p.y).toFixed(1)}`).join(' ');
  const dots = points
    .map(
      (p) =>
        `<g class="wc-chart-point" role="button" tabindex="0" data-point="${escapeHtml(p.id)}" aria-label="${escapeHtml(p.label)}"><circle cx="${sx(p.x).toFixed(1)}" cy="${sy(p.y).toFixed(1)}" r="14" class="wc-chart-hit"/><circle cx="${sx(p.x).toFixed(1)}" cy="${sy(p.y).toFixed(1)}" r="4" class="wc-chart-dot"/><title>${escapeHtml(p.label)}</title></g>`,
    )
    .join('');
  return `<svg class="wc-chart" viewBox="0 0 ${W} ${H}" role="group" aria-label="${escapeHtml(opts.ariaLabel)}" data-testid="${opts.testId}">${grid}<path d="${path}" class="wc-chart-line"/>${dots}<text x="${L}" y="${H - 6}" class="wc-chart-axis">${escapeHtml(opts.xLabels[0])}</text><text x="${W - R}" y="${H - 6}" text-anchor="end" class="wc-chart-axis">${escapeHtml(opts.xLabels[1])}</text></svg>`;
}

const day = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/**
 * Insights: accuracy by game phase, blunders per 10 moves over time, the motifs behind my
 * mistakes, results by opening and my puzzle rating over time. Every data point is a button
 * that shows the positions (or games, or the puzzle) behind it.
 */
export class InsightsView {
  private readonly root: HTMLElement;
  private detail!: HTMLElement;
  private readonly positions = new Map<string, InsightPosition[]>();
  private refreshing = false;
  private again = false;

  constructor(private readonly options: InsightsViewOptions) {
    this.root = document.createElement('section');
    this.root.className = 'wc-insights';
    this.root.setAttribute('data-testid', 'insights');
    this.root.setAttribute('aria-label', 'Insights');
    options.container.appendChild(this.root);
    this.root.innerHTML = '<p class="wc-games-loading">Counting your games…</p>';
    this.root.addEventListener('click', (e) => this.onActivate(e.target as HTMLElement));
    this.root.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const el = (e.target as HTMLElement).closest('[role="button"]');
      if (el && el.tagName !== 'BUTTON') {
        e.preventDefault();
        this.onActivate(el as HTMLElement);
      }
    });
  }

  /** Reads the library again and redraws. */
  public async refresh(): Promise<void> {
    if (this.refreshing) {
      this.again = true;
      return;
    }
    this.refreshing = true;
    try {
      do {
        this.again = false;
        await this.render();
      } while (this.again);
    } finally {
      this.refreshing = false;
    }
  }

  private async render(): Promise<void> {
    const accounts = this.options.library.getUserAccounts();
    const rows: GameRow[] = (await this.options.library.list()).map((r) => toRow(r, accounts));
    const mine = rows.filter((r) => r.color !== null);
    const reviewed: ReviewedGameInput[] = [];
    for (const row of mine) {
      if (!row.record.analysis) continue;
      const review = await this.options.library.getReview(row.record.id);
      if (review) reviewed.push({ row, review });
    }
    const rating = await this.options.getPuzzleRating();
    this.positions.clear();

    const phases = accuracyByPhase(reviewed);
    const blunders = blundersOverTime(reviewed);
    const motifs = commonMotifs(reviewed);
    const openings = resultsByOpening(mine).slice(0, 8);
    const series = puzzleRatingSeries(rating.history);

    const empty = (text: string) => `<p class="wc-insight-empty" data-empty="true">${text}</p>`;
    const needReviews = `Review some of your games (Games › Analyze) to see this. ${
      mine.length === 0 && rows.length > 0
        ? 'None of your games are marked yours yet: set your usernames in Settings › Your games.'
        : ''
    }`.trim();

    const phaseChart = phases.every((p) => p.moves === 0)
      ? empty(needReviews)
      : `<div class="wc-insight-bars" data-testid="chart-phase">${phases
          .map((p) => {
            this.positions.set(`phase:${p.phase}`, p.positions);
            const pct = p.accuracy === null ? 0 : p.accuracy;
            return `<button type="button" class="wc-insight-bar" role="button" data-point="phase:${p.phase}" data-testid="phase-${p.phase}" aria-label="${PHASE_LABEL[p.phase]}: ${p.accuracy === null ? 'no moves' : `${pct.toFixed(1)}% accuracy over ${p.moves} moves`}" ${p.moves === 0 ? 'disabled' : ''}>
              <span class="wc-insight-bar-value">${p.accuracy === null ? '–' : `${pct.toFixed(1)}%`}</span>
              <span class="wc-insight-bar-track"><span class="wc-insight-bar-fill" style="height:${pct}%"></span></span>
              <span class="wc-insight-bar-label">${PHASE_LABEL[p.phase]}</span>
              <span class="wc-insight-bar-sub">${p.moves} moves</span></button>`;
          })
          .join('')}</div>`;

    let blunderChart: string;
    if (blunders.length === 0) blunderChart = empty(needReviews);
    else {
      for (const b of blunders) this.positions.set(`game:${b.gameId}`, b.positions);
      const max = Math.max(2, Math.ceil(Math.max(...blunders.map((b) => b.per10))));
      blunderChart = lineChartSvg(
        blunders.map((b) => ({
          id: `game:${b.gameId}`,
          x: b.at,
          y: b.per10,
          label: `${b.gameLabel}: ${b.blunders} blunder${b.blunders === 1 ? '' : 's'} in ${b.moves} moves (${b.per10.toFixed(1)} per 10)`,
        })),
        {
          yMin: 0,
          yMax: max,
          yTicks: [0, Math.round(max / 2), max],
          xLabels: [day(blunders[0]!.at), day(blunders[blunders.length - 1]!.at)],
          testId: 'chart-blunders',
          ariaLabel: 'Blunders per 10 moves, game by game',
        },
      );
    }

    const motifList =
      motifs.length === 0
        ? empty(reviewed.length === 0 ? needReviews : 'No named motifs behind your mistakes yet.')
        : `<div class="wc-insight-rows" data-testid="chart-motifs">${motifs
            .slice(0, 8)
            .map((m) => {
              this.positions.set(`motif:${m.kind}`, m.positions);
              const top = motifs[0]!.count;
              return `<button type="button" class="wc-insight-row" role="button" data-point="motif:${m.kind}" data-testid="motif-${m.kind}"><span class="wc-insight-row-label">${MOTIF_LABEL[m.kind]}</span><span class="wc-insight-row-track"><span class="wc-insight-row-fill" style="width:${(m.count / top) * 100}%"></span></span><span class="wc-insight-row-value">${m.count}</span></button>`;
            })
            .join('')}</div>`;

    const openingList =
      openings.length === 0
        ? empty('Games with a known opening that are yours will show here.')
        : `<div class="wc-insight-rows" data-testid="chart-openings">${openings
            .map((o, i) => {
              const seg = (kind: 'win' | 'draw' | 'loss', n: number, word: string) =>
                n === 0
                  ? ''
                  : `<button type="button" class="wc-insight-seg wc-insight-seg-${kind}" role="button" style="flex:${n}" data-point="opening:${i}:${kind}" data-testid="opening-${i}-${kind}" aria-label="${escapeHtml(o.name)}: ${n} ${word}"><span>${n}</span></button>`;
              return `<div class="wc-insight-opening" data-testid="opening-${i}"><span class="wc-insight-row-label" title="${escapeHtml(o.name)}">${escapeHtml(o.name)}</span><span class="wc-insight-stack">${seg('win', o.wins, 'wins')}${seg('draw', o.draws, 'draws')}${seg('loss', o.losses, 'losses')}</span><span class="wc-insight-row-value">${o.games}</span><span class="wc-insight-opening-text">W ${o.wins} · D ${o.draws} · L ${o.losses}</span></div>`;
            })
            .join('')}</div>`;
    this.openings = openings;

    let ratingChart: string;
    if (series.length === 0) ratingChart = empty('Solve some rated puzzles (Train) to see your rating here.');
    else {
      const lo = Math.floor(Math.min(...series.map((s) => s.rating)) / 100) * 100;
      const hi = Math.max(lo + 100, Math.ceil(Math.max(...series.map((s) => s.rating)) / 100) * 100);
      ratingChart = lineChartSvg(
        series.map((s, i) => ({
          id: `puzzle:${s.puzzleId}`,
          x: i,
          y: s.rating,
          label: `${day(s.at)}: ${Math.round(s.rating)} after ${s.solved ? 'solving' : 'missing'} puzzle ${s.puzzleId}`,
        })),
        {
          yMin: lo,
          yMax: hi,
          yTicks: [lo, (lo + hi) / 2, hi],
          xLabels: [day(series[0]!.at), day(series[series.length - 1]!.at)],
          testId: 'chart-rating',
          ariaLabel: 'Puzzle rating over time',
        },
      );
    }

    this.root.innerHTML = `
      <div class="wc-insights-head"><h2 class="wc-page-title">Insights</h2><span class="wc-games-summary" data-testid="insights-summary">${reviewed.length} reviewed game${reviewed.length === 1 ? '' : 's'} of yours · ${mine.length} of yours in all</span></div>
      <div class="wc-insights-grid">
        <section class="wc-insight-card" aria-labelledby="ins-phase"><h3 id="ins-phase">Accuracy by game phase</h3><p class="wc-insight-hint">Mean accuracy of your moves. Opening: the first 10 moves; endgame: 6 pieces or fewer left. Click a bar for its moves, worst first.</p>${phaseChart}</section>
        <section class="wc-insight-card" aria-labelledby="ins-blunders"><h3 id="ins-blunders">Blunders per 10 moves</h3><p class="wc-insight-hint">One point per reviewed game, oldest to newest. Click a point for its blunders.</p>${blunderChart}</section>
        <section class="wc-insight-card" aria-labelledby="ins-motifs"><h3 id="ins-motifs">Most common motifs</h3><p class="wc-insight-hint">What was going on in your mistakes, blunders and misses. Click a row for the positions.</p>${motifList}</section>
        <section class="wc-insight-card" aria-labelledby="ins-openings"><h3 id="ins-openings">Results by opening</h3><p class="wc-insight-hint">Your games by opening family. Click a segment for those games.</p>${openingList}</section>
        <section class="wc-insight-card wc-insight-wide" aria-labelledby="ins-rating"><h3 id="ins-rating">Puzzle rating over time</h3><p class="wc-insight-hint">Your Glicko-2 rating after each rated puzzle${rating.games > 0 ? ` (${Math.round(rating.rating)} now, ${rating.games} played)` : ''}. Click a point to open that puzzle.</p>${ratingChart}</section>
      </div>
      <section class="wc-insight-detail" data-testid="insights-detail" aria-live="polite" hidden></section>`;
    this.detail = this.root.querySelector('[data-testid="insights-detail"]') as HTMLElement;
  }

  private openings: ReturnType<typeof resultsByOpening> = [];

  private onActivate(target: HTMLElement): void {
    const el = target.closest<HTMLElement>('[data-point]');
    const id = el?.getAttribute('data-point');
    if (!el || !id) return;
    if (id.startsWith('puzzle:')) {
      this.options.onOpenPuzzle(id.slice('puzzle:'.length));
      return;
    }
    if (id.startsWith('opening:')) {
      const [, index, kind] = id.split(':');
      const o = this.openings[Number(index)];
      if (o) this.options.onOpenGames({ opening: o.name, color: 'all', result: kind as GameFilter['result'] });
      return;
    }
    this.showPositions(id, el);
  }

  private titleOf(id: string): string {
    const [kind, key = ''] = id.split(':');
    if (kind === 'phase') return `${PHASE_LABEL[key as keyof typeof PHASE_LABEL]}: your moves, worst first`;
    if (kind === 'motif') return `${MOTIF_LABEL[key as keyof typeof MOTIF_LABEL]}: your mistakes`;
    return 'Blunders in this game';
  }

  private showPositions(id: string, source: HTMLElement): void {
    const list = this.positions.get(id) ?? [];
    const shown = list.slice(0, 30);
    this.detail.hidden = false;
    this.detail.setAttribute('data-point', id);
    this.detail.innerHTML = `
      <div class="wc-insight-detail-head"><h3>${escapeHtml(this.titleOf(id))}</h3><span data-testid="insights-detail-count">${list.length} position${list.length === 1 ? '' : 's'}${list.length > shown.length ? ` (the first ${shown.length} shown)` : ''}</span>
      <button type="button" class="wc-btn wc-btn-ghost wc-btn-sm" data-testid="btn-insights-detail-close">Close</button></div>
      ${shown.length === 0 ? '<p class="wc-insight-empty">No positions behind this point.</p>' : ''}
      <ul class="wc-insight-positions">${shown
        .map(
          (
            p,
            i,
          ) => `<li class="wc-insight-position" data-testid="insight-position"><button type="button" class="wc-insight-position-btn" data-open="${i}" aria-label="Open ${escapeHtml(p.moveLabel)} in ${escapeHtml(p.gameLabel)}">
            ${miniBoardHtml(p.fen, p.color)}
            <span class="wc-insight-position-text"><strong>${escapeHtml(p.moveLabel)}</strong> <span class="wc-insight-class">${escapeHtml(p.classification)}</span>
            <span class="wc-insight-position-game">${escapeHtml(p.gameLabel)}</span>${p.note ? `<span class="wc-insight-position-note">${escapeHtml(p.note)}</span>` : ''}</span></button></li>`,
        )
        .join('')}</ul>`;
    this.detail.querySelector('[data-testid="btn-insights-detail-close"]')!.addEventListener('click', () => {
      this.detail.hidden = true;
      source.focus();
    });
    for (const btn of this.detail.querySelectorAll<HTMLElement>('[data-open]')) {
      btn.addEventListener('click', () => {
        const p = shown[Number(btn.dataset.open)];
        if (p) this.options.onOpenPosition(p.gameId, p.ply);
      });
    }
    this.detail.scrollIntoView({ block: 'nearest' });
  }
}
