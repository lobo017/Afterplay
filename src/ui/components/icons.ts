/**
 * The app's line icons, drawn for Wizard's Chess (24 × 24, stroked with currentColor).
 * Inline SVG strings, so they cost no requests and follow the text colour.
 */

const svg = (body: string, opts: { fill?: boolean; width?: number } = {}): string =>
  `<svg class="wc-icon" width="20" height="20" viewBox="0 0 24 24" aria-hidden="true" focusable="false" ${
    opts.fill
      ? 'fill="currentColor" stroke="none"'
      : `fill="none" stroke="currentColor" stroke-width="${opts.width ?? 1.8}" stroke-linecap="round" stroke-linejoin="round"`
  }>${body}</svg>`;

/** An 8-tooth gear outline: teeth at radius 9.2, roots at 6.9. */
function gearPath(): string {
  const pts: string[] = [];
  for (let i = 0; i < 16; i++) {
    const r = i % 2 === 0 ? 9.2 : 6.9;
    const mid = (i * Math.PI) / 8 - Math.PI / 16;
    for (const da of [-0.17, 0.17]) {
      const a = mid + da;
      pts.push(`${(12 + r * Math.cos(a)).toFixed(2)},${(12 + r * Math.sin(a)).toFixed(2)}`);
    }
  }
  return `M${pts.join(' L')}Z`;
}

export const ICONS = {
  /** The crown crest beside the app name. */
  crest: svg('<path d="M5 19h14M6 16h12l1-9-4 3-3-6-3 6-4-3z"/>'),
  /** Play: crossed swords. */
  play: svg('<path d="M4 4l10 10M10.5 16.5l6-6M15 15l4 4M20 4L10 14M7.5 10.5l6 6M9 15l-4 4"/>'),
  /** Train: a five-point star. */
  train: svg('<path d="M12 3l2.3 5.2 5.7.5-4.3 3.8 1.3 5.6L12 15.2 7 18.1l1.3-5.6L4 8.7l5.7-.5z"/>'),
  /** Review: a rising line over a baseline. */
  review: svg('<path d="M4 18l4-5 3 3 5-7 4 4"/><path d="M4 21h16"/>'),
  /** Games: a card with lines, and one behind it. */
  games: svg('<rect x="4" y="6" width="16" height="14" rx="2"/><path d="M7 3h10M8 11h8M8 15h5"/>'),
  settings: svg(`<path d="${gearPath()}"/><circle cx="12" cy="12" r="3"/>`, { width: 1.7 }),
  close: svg('<path d="M6 6l12 12M18 6L6 18"/>', { width: 2 }),
  back: svg('<path d="M15 6l-6 6 6 6"/>', { width: 2 }),
  next: svg('<path d="M9 6l6 6-6 6"/>', { width: 2 }),
  first: svg('<path d="M6 5v14M18 6l-7 6 7 6"/>', { width: 2 }),
  last: svg('<path d="M18 5v14M6 6l7 6-7 6"/>', { width: 2 }),
  caret: svg('<path d="M6 9l6 6 6-6"/>', { width: 2.2 }),
  more: svg('<circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/>', {
    fill: true,
  }),
  hint: svg('<path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2.1h5c0-.9.4-1.6 1-2.1A6 6 0 0 0 12 3z"/>'),
  undo: svg('<path d="M9 14L4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/>'),
  flip: svg('<path d="M7 4v16M4 7l3-3 3 3M17 20V4M14 17l3 3 3-3"/>'),
  flag: svg('<path d="M5 21V4M5 4h11l-2 4 2 4H5"/>'),
  handshake: svg(
    '<path d="M8 12V6a1.5 1.5 0 0 1 3 0v5M11 11V4.5a1.5 1.5 0 0 1 3 0V11M14 11V6a1.5 1.5 0 0 1 3 0v8a6 6 0 0 1-6 6h-1a5 5 0 0 1-4.2-2.3L4 14.5a1.5 1.5 0 0 1 2.4-1.8L8 14"/>',
  ),
  plus: svg('<path d="M12 5v14M5 12h14"/>', { width: 2.2 }),
  board: svg(
    '<rect x="4" y="4" width="16" height="16" rx="1.5"/><path d="M4 12h16M12 4v16M8 4v4M4 8h4M16 12v4M12 16h4M8 12v4M4 16h4M16 4v4M12 8h4M16 16v4M20 8h-4"/>',
    { width: 1.4 },
  ),
  edit: svg('<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13 7l4 4"/>'),
  upload: svg('<path d="M12 16V4M7 9l5-5 5 5"/><path d="M5 20h14"/>'),
  download: svg('<path d="M12 4v12M7 11l5 5 5-5"/><path d="M5 20h14"/>'),
  bot: svg('<rect x="5" y="8" width="14" height="11" rx="3"/><path d="M12 4v4M9 13h.01M15 13h.01"/>'),
  person: svg('<circle cx="12" cy="8" r="4"/><path d="M4 20c1.5-4 4.5-6 8-6s6.5 2 8 6"/>'),
  /** Repertoire: an open book. */
  book: svg(
    '<path d="M12 6.5C10.5 5 8 4.5 4 4.5V18c4 0 6.5.5 8 2 1.5-1.5 4-2 8-2V4.5c-4 0-6.5.5-8 2z"/><path d="M12 6.5V20"/>',
  ),
  /** Visualization: an eye. */
  eye: svg('<path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12z"/><circle cx="12" cy="12" r="2.8"/>'),
  copy: svg(
    '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/>',
  ),
} as const;

export type IconName = keyof typeof ICONS;

export function icon(name: IconName): string {
  return ICONS[name];
}
