export type BoardThemeId =
  | 'marble-obsidian'
  | 'imperial-walnut'
  | 'high-contrast';

export type PieceSetId = 'cathedral' | 'staunton' | 'high-contrast';

export interface BoardThemeConfig {
  id: BoardThemeId;
  label: string;
  description: string;
  lightSquareBase: string;
  lightSquareVein: string;
  lightSquareChamfer: string;
  darkSquareBase: string;
  darkSquareVein: string;
  darkSquareChamfer: string;
  frameOuter: string;
  frameInner: string;
  groutColor: string;
  inlayTrim: string;
  coordLight: string;
  coordDark: string;
}

export interface PieceSetConfig {
  id: PieceSetId;
  label: string;
  description: string;
}

export const DEFAULT_BOARD_THEME: BoardThemeId = 'marble-obsidian';
export const DEFAULT_PIECE_SET: PieceSetId = 'cathedral';

/**
 * Board themes ported from the legacy audit in docs/PROGRESS.md plus Imperial Walnut and WCAG High Contrast.
 */
export const BOARD_THEMES: Record<BoardThemeId, BoardThemeConfig> = {
  'marble-obsidian': {
    id: 'marble-obsidian',
    label: 'Cathedral Marble & Obsidian',
    description:
      'Veined ivory marble (#f2ede4) and volcanic obsidian (#121620) with arcane violet veins and inlaid brass dividers.',
    lightSquareBase: '#f2ede4',
    lightSquareVein: 'rgba(110, 102, 90, 0.16)',
    lightSquareChamfer: 'rgba(255, 255, 255, 0.65)',
    darkSquareBase: '#121620',
    darkSquareVein: 'rgba(139, 92, 246, 0.16)',
    darkSquareChamfer: 'rgba(212, 175, 55, 0.22)',
    frameOuter: '#926c2c',
    frameInner: '#161922',
    groutColor: '#090b10',
    inlayTrim: '#c59b27',
    coordLight: '#5c4d35',
    coordDark: '#d4af37',
  },
  'imperial-walnut': {
    id: 'imperial-walnut',
    label: 'Imperial Walnut & Ivory',
    description:
      'Warm antique parchment ivory (#ede0c8) paired with burled walnut (#5c3a21) and burnished bronze trim.',
    lightSquareBase: '#ede0c8',
    lightSquareVein: 'rgba(120, 90, 60, 0.12)',
    lightSquareChamfer: 'rgba(255, 248, 231, 0.55)',
    darkSquareBase: '#5c3a21',
    darkSquareVein: 'rgba(32, 18, 9, 0.28)',
    darkSquareChamfer: 'rgba(212, 175, 55, 0.20)',
    frameOuter: '#8a6226',
    frameInner: '#24160e',
    groutColor: '#170e09',
    inlayTrim: '#b8860b',
    coordLight: '#5c3a21',
    coordDark: '#ede0c8',
  },
  'high-contrast': {
    id: 'high-contrast',
    label: 'High Contrast Tournament',
    description:
      'Maximum WCAG AAA luminance contrast (#ffffff / #0f172a) with bold borders and zero decorative texture.',
    lightSquareBase: '#ffffff',
    lightSquareVein: 'transparent',
    lightSquareChamfer: '#cbd5e1',
    darkSquareBase: '#0f172a',
    darkSquareVein: 'transparent',
    darkSquareChamfer: '#334155',
    frameOuter: '#facc15',
    frameInner: '#020617',
    groutColor: '#000000',
    inlayTrim: '#facc15',
    coordLight: '#0f172a',
    coordDark: '#facc15',
  },
};

export const PIECE_SETS: Record<PieceSetId, PieceSetConfig> = {
  cathedral: {
    id: 'cathedral',
    label: 'Cathedral Marble & Amethyst',
    description:
      'Carved ivory marble with metallic gold trim for White; volcanic obsidian with arcane amethyst trim for Black.',
  },
  staunton: {
    id: 'staunton',
    label: 'Championship Staunton',
    description:
      'Classic tournament Staunton silhouettes with balanced collars and clean bevel shading.',
  },
  'high-contrast': {
    id: 'high-contrast',
    label: 'High Contrast Vector',
    description:
      'Ultra-crisp high-contrast monochrome silhouettes with thick dual outlines for maximum legibility.',
  },
};
