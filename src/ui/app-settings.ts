import { BOT_STYLE_PRESETS, clampBotRating, type BotStyleId } from '../engine/bot';
import {
  BOARD_THEMES,
  DEFAULT_BOARD_THEME,
  DEFAULT_PIECE_SET,
  PIECE_SETS,
  type BoardThemeId,
  type PieceSetId,
} from '../render/themes';
import { TIME_CONTROL_PRESETS, type TimeControlPresetId } from './clock';

/** What a new game against the bot starts with; applied only when a new game starts. */
export interface NewGameOptions {
  color: 'w' | 'b' | 'random';
  timeControlId: TimeControlPresetId;
  botRating: number;
  botStyle: BotStyleId;
  minThinkMs: number;
  maxThinkMs: number;
  takebacks: boolean;
}

export type NavigationAnimation = 'off' | 'fast' | 'normal';

export interface AppSettings {
  boardTheme: BoardThemeId;
  pieceSet: PieceSetId;
  autoQueen: boolean;
  confirmMove: boolean;
  maxPremoves: number;
  captureEffects: boolean;
  sound: boolean;
  /** 0–100. */
  volume: number;
  /** Play's live engine evaluation during a game. */
  playLiveEval: boolean;
  /** Stepping through moves on the Review board. */
  navigationAnimation: NavigationAnimation;
  newGame: NewGameOptions;
}

export const MAX_PREMOVES_LIMIT = 20;

export const DEFAULT_NEW_GAME: Readonly<NewGameOptions> = Object.freeze({
  color: 'w',
  timeControlId: '5+3',
  botRating: 1400,
  botStyle: 'solid',
  minThinkMs: 500,
  maxThinkMs: 3000,
  takebacks: true,
});

export const DEFAULT_APP_SETTINGS: Readonly<AppSettings> = Object.freeze({
  boardTheme: DEFAULT_BOARD_THEME,
  pieceSet: DEFAULT_PIECE_SET,
  autoQueen: false,
  confirmMove: false,
  maxPremoves: 10,
  captureEffects: true,
  sound: true,
  volume: 75,
  playLiveEval: false,
  navigationAnimation: 'normal',
  newGame: DEFAULT_NEW_GAME,
});

const bool = (v: unknown, fallback: boolean): boolean => (typeof v === 'boolean' ? v : fallback);
const num = (v: unknown, fallback: number, min: number, max: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
const oneOf = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T =>
  typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;

/** Fills in and clamps every field; anything unknown or malformed falls back to the default. */
export function sanitizeAppSettings(input: unknown): AppSettings {
  const src = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const ng = (src.newGame && typeof src.newGame === 'object' ? src.newGame : {}) as Record<string, unknown>;
  const d = DEFAULT_APP_SETTINGS;
  const dn = DEFAULT_NEW_GAME;
  const minThinkMs = Math.round(num(ng.minThinkMs, dn.minThinkMs, 0, 10_000));
  return {
    boardTheme: oneOf(src.boardTheme, Object.keys(BOARD_THEMES) as BoardThemeId[], d.boardTheme),
    pieceSet: oneOf(src.pieceSet, Object.keys(PIECE_SETS) as PieceSetId[], d.pieceSet),
    autoQueen: bool(src.autoQueen, d.autoQueen),
    confirmMove: bool(src.confirmMove, d.confirmMove),
    maxPremoves: Math.floor(num(src.maxPremoves, d.maxPremoves, 1, MAX_PREMOVES_LIMIT)),
    captureEffects: bool(src.captureEffects, d.captureEffects),
    sound: bool(src.sound, d.sound),
    volume: Math.round(num(src.volume, d.volume, 0, 100)),
    playLiveEval: bool(src.playLiveEval, d.playLiveEval),
    navigationAnimation: oneOf(src.navigationAnimation, ['off', 'fast', 'normal'] as const, d.navigationAnimation),
    newGame: {
      color: oneOf(ng.color, ['w', 'b', 'random'] as const, dn.color),
      timeControlId: oneOf(
        ng.timeControlId,
        Object.keys(TIME_CONTROL_PRESETS) as TimeControlPresetId[],
        dn.timeControlId,
      ),
      botRating: clampBotRating(num(ng.botRating, dn.botRating, 0, 4000)),
      botStyle: oneOf(ng.botStyle, Object.keys(BOT_STYLE_PRESETS) as BotStyleId[], dn.botStyle),
      minThinkMs,
      maxThinkMs: Math.max(minThinkMs, Math.round(num(ng.maxThinkMs, dn.maxThinkMs, 0, 15_000))),
      takebacks: bool(ng.takebacks, dn.takebacks),
    },
  };
}

export type AppSettingsPatch = Partial<Omit<AppSettings, 'newGame'>> & {
  newGame?: Partial<NewGameOptions>;
};

/**
 * Every app setting in one place. Screens read it and subscribe; Settings and the New game
 * card write it.
 */
export class AppSettingsStore {
  private value: AppSettings;
  private readonly listeners = new Set<(settings: AppSettings, previous: AppSettings) => void>();

  constructor(initial?: unknown) {
    this.value = sanitizeAppSettings(initial);
  }

  public get(): Readonly<AppSettings> {
    return this.value;
  }

  public set(patch: AppSettingsPatch): void {
    const previous = this.value;
    this.value = sanitizeAppSettings({
      ...previous,
      ...patch,
      newGame: { ...previous.newGame, ...patch.newGame },
    });
    this.emit(previous);
  }

  /** Replaces everything (a restore); missing fields take their defaults. */
  public replace(next: unknown): void {
    const previous = this.value;
    this.value = sanitizeAppSettings(next);
    this.emit(previous);
  }

  public subscribe(listener: (settings: AppSettings, previous: AppSettings) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(previous: AppSettings): void {
    for (const listener of this.listeners) listener(this.value, previous);
  }
}
