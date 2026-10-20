import { BOARD_THEMES, PIECE_SETS, type BoardThemeId, type PieceSetId } from '../render/themes';
import { MAX_PREMOVES_LIMIT, type AppSettings, type AppSettingsStore } from './app-settings';
import { selectRowHtml, sliderRowHtml, switchRowHtml } from './components/controls';
import type { SettingsPanel } from './settings-panel';

/** Section order in the Settings sheet (About & diagnostics is 1000). */
export const SETTINGS_ORDER = { board: 10, boardFeel: 20, moves: 30, sound: 40, data: 900 } as const;

/**
 * The Board, Moves and Sound & effects sections, bound both ways to the app settings: a change
 * here applies at once everywhere, and a change made elsewhere shows here.
 */
export function mountAppSettingsSections(panel: SettingsPanel, store: AppSettingsStore): () => void {
  const s = store.get();

  const board = panel.addSection('board', 'Board', SETTINGS_ORDER.board);
  board.innerHTML = `
    ${selectRowHtml(
      'select-board-theme',
      'Board theme',
      Object.values(BOARD_THEMES).map((t) => ({ value: t.id, label: t.label })),
      s.boardTheme,
    )}
    ${selectRowHtml(
      'select-piece-set',
      'Piece set',
      Object.values(PIECE_SETS).map((p) => ({ value: p.id, label: p.label })),
      s.pieceSet,
    )}`;

  const moves = panel.addSection('moves', 'Moves', SETTINGS_ORDER.moves);
  moves.innerHTML = `
    ${switchRowHtml('toggle-auto-queen', 'Auto-queen', s.autoQueen, 'Promote to a queen without asking')}
    ${switchRowHtml('toggle-confirm-move', 'Confirm each move', s.confirmMove, 'In Play: a move waits for Confirm')}
    <label class="wc-setting-row" title="How many premoves you can queue during the opponent's turn. 1 = Lichess-style single premove.">
      <span class="wc-setting-label">Max premoves<span class="wc-setting-hint">Moves you can queue during the opponent's turn</span></span>
      <input type="number" min="1" max="${MAX_PREMOVES_LIMIT}" step="1" value="${s.maxPremoves}" class="wc-select wc-setting-number" data-testid="input-max-premoves" />
    </label>`;

  const sound = panel.addSection('sound', 'Sound &amp; effects', SETTINGS_ORDER.sound);
  sound.innerHTML = `
    ${switchRowHtml('toggle-audio-mute', 'Sound', s.sound)}
    ${sliderRowHtml('slider-audio-volume', 'Volume', {
      min: 0,
      max: 100,
      step: 1,
      value: s.volume,
      valueText: `${s.volume}%`,
      valueTestId: 'audio-volume-label',
    })}
    ${switchRowHtml('toggle-capture-particles', 'Capture shards', s.captureEffects, 'Marble shards fly when a piece is taken')}`;

  const q = <T extends HTMLElement>(root: HTMLElement, id: string) =>
    root.querySelector(`[data-testid="${id}"]`) as T;
  const theme = q<HTMLSelectElement>(board, 'select-board-theme');
  const pieces = q<HTMLSelectElement>(board, 'select-piece-set');
  const autoQueen = q<HTMLInputElement>(moves, 'toggle-auto-queen');
  const confirm = q<HTMLInputElement>(moves, 'toggle-confirm-move');
  const premoves = q<HTMLInputElement>(moves, 'input-max-premoves');
  const soundOn = q<HTMLInputElement>(sound, 'toggle-audio-mute');
  const volume = q<HTMLInputElement>(sound, 'slider-audio-volume');
  const volumeLabel = q<HTMLElement>(sound, 'audio-volume-label');
  const shards = q<HTMLInputElement>(sound, 'toggle-capture-particles');

  theme.addEventListener('change', () => store.set({ boardTheme: theme.value as BoardThemeId }));
  pieces.addEventListener('change', () => store.set({ pieceSet: pieces.value as PieceSetId }));
  autoQueen.addEventListener('change', () => store.set({ autoQueen: autoQueen.checked }));
  confirm.addEventListener('change', () => store.set({ confirmMove: confirm.checked }));
  premoves.addEventListener('change', () => store.set({ maxPremoves: Number(premoves.value) }));
  soundOn.addEventListener('change', () => store.set({ sound: soundOn.checked }));
  volume.addEventListener('input', () => store.set({ volume: Number(volume.value) }));
  shards.addEventListener('change', () => store.set({ captureEffects: shards.checked }));

  const render = (v: AppSettings): void => {
    if (theme.value !== v.boardTheme) theme.value = v.boardTheme;
    if (pieces.value !== v.pieceSet) pieces.value = v.pieceSet;
    autoQueen.checked = v.autoQueen;
    confirm.checked = v.confirmMove;
    if (document.activeElement !== premoves) premoves.value = String(v.maxPremoves);
    soundOn.checked = v.sound;
    if (Number(volume.value) !== v.volume) volume.value = String(v.volume);
    volumeLabel.textContent = `${v.volume}%`;
    shards.checked = v.captureEffects;
  };
  return store.subscribe((v) => render(v));
}
