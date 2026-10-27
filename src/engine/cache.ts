import { DEFAULT_POSITION } from '../core/rules';
import type { UciScore } from './uci-parser';

export interface EngineLine {
  multipv: number;
  depth: number;
  seldepth: number;
  score: UciScore;
  scoreWhite: UciScore;
  evalCp: number;
  nodes: number;
  nps: number;
  timeMs: number;
  pv: string[];
  wdl?: [number, number, number];
}

export interface EngineAnalysisResult {
  fen: string;
  normalizedFen: string;
  depth: number;
  multipv: number;
  bestMove: string | null;
  ponder: string | null;
  lines: EngineLine[];
  nodes: number;
  nps: number;
  timeMs: number;
  cached: boolean;
}

export interface CacheStats {
  size: number;
  maxEntries: number;
  hits: number;
  misses: number;
  totalLookups: number;
  hitRate: number;
}

/**
 * Normalizes a FEN string (or 'startpos') to its 4-field EPD key (board, turn, castling, ep).
 */
export function normalizeFenForCache(fen: string): string {
  const trimmed = fen.trim();
  const resolved = trimmed === '' || trimmed.toLowerCase() === 'startpos' ? DEFAULT_POSITION : trimmed;
  const parts = resolved.split(/\s+/);
  if (parts.length >= 4) {
    return `${parts[0]} ${parts[1]} ${parts[2]} ${parts[3]}`;
  }
  return resolved;
}

/**
 * Builds the canonical cache key for (normalized FEN, depth, multipv).
 */
export function buildAnalysisCacheKey(fen: string, depth: number, multipv: number): string {
  const normFen = normalizeFenForCache(fen);
  return `${normFen}|d:${depth}|mpv:${multipv}`;
}

function cloneResult(res: EngineAnalysisResult, cached: boolean): EngineAnalysisResult {
  return {
    ...res,
    cached,
    lines: res.lines.map((line) => ({
      ...line,
      score: { ...line.score },
      scoreWhite: { ...line.scoreWhite },
      pv: [...line.pv],
      ...(line.wdl ? { wdl: [...line.wdl] as [number, number, number] } : {}),
    })),
  };
}

/**
 * Bounded LRU cache for Stockfish analysis results keyed by (normalized FEN, depth, multipv).
 */
export class AnalysisCache {
  private readonly store = new Map<string, EngineAnalysisResult>();
  private readonly maxEntries: number;
  private hits = 0;
  private misses = 0;
  private readonly onLookup?: (hit: boolean) => void;

  constructor(options?: { maxEntries?: number; onLookup?: (hit: boolean) => void }) {
    this.maxEntries = Math.max(16, options?.maxEntries ?? 2000);
    this.onLookup = options?.onLookup;
  }

  public get(fen: string, depth: number, multipv: number): EngineAnalysisResult | null {
    const key = buildAnalysisCacheKey(fen, depth, multipv);
    const existing = this.store.get(key);
    if (existing) {
      // Refresh LRU order
      this.store.delete(key);
      this.store.set(key, existing);
      this.hits++;
      this.onLookup?.(true);
      return cloneResult(existing, true);
    }

    this.misses++;
    this.onLookup?.(false);
    return null;
  }

  public has(fen: string, depth: number, multipv: number): boolean {
    const key = buildAnalysisCacheKey(fen, depth, multipv);
    return this.store.has(key);
  }

  public set(fen: string, depth: number, multipv: number, result: EngineAnalysisResult): void {
    const key = buildAnalysisCacheKey(fen, depth, multipv);
    if (this.store.has(key)) {
      this.store.delete(key);
    } else if (this.store.size >= this.maxEntries) {
      const oldestKey = this.store.keys().next().value;
      if (oldestKey !== undefined) {
        this.store.delete(oldestKey);
      }
    }
    this.store.set(key, cloneResult(result, false));
  }

  public clear(): void {
    this.store.clear();
  }

  public resetStats(): void {
    this.hits = 0;
    this.misses = 0;
  }

  public getStats(): CacheStats {
    const totalLookups = this.hits + this.misses;
    const hitRate = totalLookups > 0 ? Number(((this.hits / totalLookups) * 100).toFixed(1)) : 0;
    return {
      size: this.store.size,
      maxEntries: this.maxEntries,
      hits: this.hits,
      misses: this.misses,
      totalLookups,
      hitRate,
    };
  }
}
