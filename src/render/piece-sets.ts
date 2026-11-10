import type { Color, PieceSymbol } from '../core/rules';
import { CLASSIC_PIECES, CLASSIC_PIECE_VIEWBOX } from './classic-pieces';
import type { PieceSetId } from './themes';

interface PiecePalette {
  bodyFill: string;
  bodyShade: string;
  stroke: string;
  strokeWidth: number;
  trimFill: string;
  gemFill: string;
  highlightStroke: string;
  outerHalo: string;
}

function getPalette(setId: PieceSetId, color: Color): PiecePalette {
  if (setId === 'high-contrast') {
    return color === 'w'
      ? {
          bodyFill: '#ffffff',
          bodyShade: '#e2e8f0',
          stroke: '#000000',
          strokeWidth: 4.5,
          trimFill: '#000000',
          gemFill: '#000000',
          highlightStroke: '#000000',
          outerHalo: '#000000',
        }
      : {
          bodyFill: '#090d16',
          bodyShade: '#000000',
          stroke: '#ffffff',
          strokeWidth: 4.2,
          trimFill: '#facc15',
          gemFill: '#facc15',
          highlightStroke: '#ffffff',
          outerHalo: '#ffffff',
        };
  }

  if (setId === 'staunton') {
    return color === 'w'
      ? {
          bodyFill: '#f8fafc',
          bodyShade: '#cbd5e1',
          stroke: '#1e293b',
          strokeWidth: 3.0,
          trimFill: '#94a3b8',
          gemFill: '#475569',
          highlightStroke: '#ffffff',
          outerHalo: 'rgba(15, 23, 42, 0.4)',
        }
      : {
          bodyFill: '#1e293b',
          bodyShade: '#0f172a',
          stroke: '#e2e8f0',
          strokeWidth: 2.8,
          trimFill: '#64748b',
          gemFill: '#cbd5e1',
          highlightStroke: '#94a3b8',
          outerHalo: 'rgba(248, 250, 252, 0.3)',
        };
  }

  // Default: 'cathedral' (Marble & Gold for White; Obsidian & Arcane Amethyst for Black)
  return color === 'w'
    ? {
        bodyFill: '#f8f5f0',
        bodyShade: '#dfd7c8',
        stroke: '#2b2418',
        strokeWidth: 2.8,
        trimFill: '#d4af37',
        gemFill: '#38bdf8',
        highlightStroke: '#ffffff',
        outerHalo: 'rgba(212, 175, 55, 0.35)',
      }
    : {
        bodyFill: '#161925',
        bodyShade: '#0b0d14',
        stroke: '#a855f7',
        strokeWidth: 2.7,
        trimFill: '#9333ea',
        gemFill: '#c084fc',
        highlightStroke: '#c084fc',
        outerHalo: 'rgba(168, 85, 247, 0.4)',
      };
}

function renderPedestalBase(p: PiecePalette, setId: PieceSetId): string {
  const ornate = setId === 'cathedral';
  return `
    <ellipse cx="50" cy="88" rx="33" ry="6" fill="rgba(0,0,0,0.34)" />
    <path d="M 20 85 L 80 85 L 76 78 L 24 78 Z" fill="${p.bodyShade}" stroke="${p.stroke}" stroke-width="${p.strokeWidth}" stroke-linejoin="round" />
    <rect x="23" y="83" width="54" height="5" rx="2.5" fill="${ornate ? p.trimFill : p.bodyFill}" stroke="${p.stroke}" stroke-width="${p.strokeWidth * 0.85}" />
    ${
      ornate
        ? `<line x1="27" y1="78" x2="73" y2="78" stroke="${p.trimFill}" stroke-width="2.4" stroke-linecap="round" />`
        : ''
    }
  `;
}

function renderPawnBody(p: PiecePalette, setId: PieceSetId): string {
  const ornate = setId === 'cathedral';
  return `
    ${renderPedestalBase(p, setId)}
    <path d="M 30 78 C 31 64, 38 56, 41 46 L 59 46 C 62 56, 69 64, 70 78 Z"
      fill="${p.bodyFill}" stroke="${p.stroke}" stroke-width="${p.strokeWidth}" stroke-linejoin="round" />
    <rect x="36" y="43" width="28" height="5.5" rx="2.5"
      fill="${ornate ? p.trimFill : p.bodyShade}" stroke="${p.stroke}" stroke-width="${p.strokeWidth * 0.85}" />
    <circle cx="50" cy="29" r="13.5"
      fill="${p.bodyFill}" stroke="${p.stroke}" stroke-width="${p.strokeWidth}" />
    ${
      ornate
        ? `<circle cx="50" cy="29" r="4" fill="${p.gemFill}" opacity="0.85" />
           <path d="M 43 22 A 9 9 0 0 1 55 20" fill="none" stroke="${p.highlightStroke}" stroke-width="2" stroke-linecap="round" opacity="0.7" />`
        : `<path d="M 43 22 A 9 9 0 0 1 54 20" fill="none" stroke="${p.highlightStroke}" stroke-width="2.2" stroke-linecap="round" opacity="0.6" />`
    }
  `;
}

function renderRookBody(p: PiecePalette, setId: PieceSetId): string {
  const ornate = setId === 'cathedral';
  return `
    ${renderPedestalBase(p, setId)}
    <path d="M 28 78 L 33 38 L 67 38 L 72 78 Z"
      fill="${p.bodyFill}" stroke="${p.stroke}" stroke-width="${p.strokeWidth}" stroke-linejoin="round" />
    <path d="M 25 38 L 25 22 L 35 22 L 35 28 L 44 28 L 44 22 L 56 22 L 56 28 L 65 28 L 65 22 L 75 22 L 75 38 Z"
      fill="${p.bodyFill}" stroke="${p.stroke}" stroke-width="${p.strokeWidth}" stroke-linejoin="round" />
    <rect x="30" y="37" width="40" height="5" rx="2"
      fill="${ornate ? p.trimFill : p.bodyShade}" stroke="${p.stroke}" stroke-width="${p.strokeWidth * 0.8}" />
    ${
      ornate
        ? `<path d="M 45 64 L 45 50 A 5 5 0 0 1 55 50 L 55 64 Z" fill="${p.trimFill}" opacity="0.75" stroke="${p.stroke}" stroke-width="1.6" />
           <circle cx="50" cy="31" r="2.8" fill="${p.gemFill}" />`
        : `<line x1="39" y1="46" x2="37" y2="72" stroke="${p.highlightStroke}" stroke-width="2" stroke-linecap="round" opacity="0.55" />`
    }
  `;
}

function renderKnightBody(p: PiecePalette, setId: PieceSetId): string {
  const ornate = setId === 'cathedral';
  return `
    ${renderPedestalBase(p, setId)}
    <path d="M 27 78
             C 27 60, 34 51, 39 43
             C 33 44, 27 43, 24 38
             C 22 35, 25 29, 31 25
             L 33 16
             L 41 21
             C 48 18, 58 20, 64 27
             C 71 36, 72 54, 71 78 Z"
      fill="${p.bodyFill}" stroke="${p.stroke}" stroke-width="${p.strokeWidth}" stroke-linejoin="round" />
    <path d="M 55 24 C 63 32, 65 49, 63 73"
      fill="none" stroke="${ornate ? p.trimFill : p.bodyShade}" stroke-width="4" stroke-linecap="round" />
    <circle cx="36" cy="29" r="3" fill="${ornate ? p.gemFill : p.stroke}" />
    <path d="M 29 36 L 38 35" stroke="${p.stroke}" stroke-width="2.2" stroke-linecap="round" />
  `;
}

function renderBishopBody(p: PiecePalette, setId: PieceSetId): string {
  const ornate = setId === 'cathedral';
  return `
    ${renderPedestalBase(p, setId)}
    <path d="M 28 78
             C 30 64, 34 56, 36 49
             C 29 39, 32 23, 50 17
             C 68 23, 71 39, 64 49
             C 66 56, 70 64, 72 78 Z"
      fill="${p.bodyFill}" stroke="${p.stroke}" stroke-width="${p.strokeWidth}" stroke-linejoin="round" />
    <circle cx="50" cy="13" r="4.5"
      fill="${ornate ? p.trimFill : p.bodyFill}" stroke="${p.stroke}" stroke-width="${p.strokeWidth * 0.85}" />
    <rect x="33" y="48" width="34" height="5" rx="2.5"
      fill="${ornate ? p.trimFill : p.bodyShade}" stroke="${p.stroke}" stroke-width="${p.strokeWidth * 0.8}" />
    <path d="M 44 33 L 56 33 M 50 27 L 50 39"
      stroke="${ornate ? p.trimFill : p.stroke}" stroke-width="3" stroke-linecap="round" />
    ${ornate ? `<circle cx="50" cy="33" r="2.6" fill="${p.gemFill}" />` : ''}
  `;
}

function renderQueenBody(p: PiecePalette, setId: PieceSetId): string {
  const ornate = setId === 'cathedral';
  return `
    ${renderPedestalBase(p, setId)}
    <path d="M 26 78
             L 20 31
             L 35 46
             L 43 24
             L 50 45
             L 57 24
             L 65 46
             L 80 31
             L 74 78 Z"
      fill="${p.bodyFill}" stroke="${p.stroke}" stroke-width="${p.strokeWidth}" stroke-linejoin="round" />
    <rect x="27" y="69" width="46" height="5" rx="2.5"
      fill="${ornate ? p.trimFill : p.bodyShade}" stroke="${p.stroke}" stroke-width="${p.strokeWidth * 0.8}" />
    <circle cx="20" cy="27" r="3.8" fill="${ornate ? p.trimFill : p.bodyFill}" stroke="${p.stroke}" stroke-width="2" />
    <circle cx="43" cy="20" r="3.8" fill="${ornate ? p.trimFill : p.bodyFill}" stroke="${p.stroke}" stroke-width="2" />
    <circle cx="57" cy="20" r="3.8" fill="${ornate ? p.trimFill : p.bodyFill}" stroke="${p.stroke}" stroke-width="2" />
    <circle cx="80" cy="27" r="3.8" fill="${ornate ? p.trimFill : p.bodyFill}" stroke="${p.stroke}" stroke-width="2" />
    ${
      ornate
        ? `<polygon points="50,51 55,58 50,65 45,58" fill="${p.gemFill}" stroke="${p.stroke}" stroke-width="1.6" />`
        : `<circle cx="50" cy="58" r="4" fill="${p.trimFill}" />`
    }
  `;
}

function renderKingBody(p: PiecePalette, setId: PieceSetId): string {
  const ornate = setId === 'cathedral';
  return `
    ${renderPedestalBase(p, setId)}
    <path d="M 47 22 L 47 8 L 53 8 L 53 22 Z M 42 13 L 58 13 L 58 18 L 42 18 Z"
      fill="${ornate ? p.trimFill : p.bodyFill}" stroke="${p.stroke}" stroke-width="${p.strokeWidth * 0.85}" stroke-linejoin="round" />
    <path d="M 27 78
             C 26 57, 24 37, 36 28
             C 42 24, 58 24, 64 28
             C 76 37, 74 57, 73 78 Z"
      fill="${p.bodyFill}" stroke="${p.stroke}" stroke-width="${p.strokeWidth}" stroke-linejoin="round" />
    <path d="M 33 44 Q 50 36 67 44"
      fill="none" stroke="${ornate ? p.trimFill : p.stroke}" stroke-width="3.2" stroke-linecap="round" />
    <rect x="28" y="68" width="44" height="5.5" rx="2.5"
      fill="${ornate ? p.trimFill : p.bodyShade}" stroke="${p.stroke}" stroke-width="${p.strokeWidth * 0.8}" />
    ${
      ornate
        ? `<polygon points="50,48 56,56 50,64 44,56" fill="${p.gemFill}" stroke="${p.stroke}" stroke-width="1.8" />`
        : `<line x1="50" y1="30" x2="50" y2="64" stroke="${p.stroke}" stroke-width="2.6" stroke-linecap="round" />`
    }
  `;
}

const SVG_CACHE = new Map<string, string>();

/**
 * Returns the complete SVG markup for a chess piece in the specified piece set.
 * Cached by (pieceSet, color, pieceSymbol) so repeated renders never re-concatenate strings.
 */
export function getPieceSvgMarkup(setId: PieceSetId, color: Color, piece: PieceSymbol): string {
  const cacheKey = `${setId}:${color}:${piece}`;
  const cached = SVG_CACHE.get(cacheKey);
  if (cached) return cached;

  if (setId === 'classic') {
    // Ready-made drawings (classic-pieces.ts), not built from the shared shapes below
    const classic = `<svg class="wc-piece-svg" viewBox="${CLASSIC_PIECE_VIEWBOX}" aria-hidden="true" focusable="false">${CLASSIC_PIECES[color][piece]}</svg>`;
    SVG_CACHE.set(cacheKey, classic);
    return classic;
  }

  const palette = getPalette(setId, color);
  let body = '';
  switch (piece) {
    case 'p':
      body = renderPawnBody(palette, setId);
      break;
    case 'r':
      body = renderRookBody(palette, setId);
      break;
    case 'n':
      body = renderKnightBody(palette, setId);
      break;
    case 'b':
      body = renderBishopBody(palette, setId);
      break;
    case 'q':
      body = renderQueenBody(palette, setId);
      break;
    case 'k':
      body = renderKingBody(palette, setId);
      break;
  }

  const svg = `<svg class="wc-piece-svg" viewBox="0 0 100 100" aria-hidden="true" focusable="false">${body}</svg>`;
  SVG_CACHE.set(cacheKey, svg);
  return svg;
}
