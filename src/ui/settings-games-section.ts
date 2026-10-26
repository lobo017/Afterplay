import type { GamesList } from '../library/games-list';
import type { GameLibrary } from '../library/library';
import { switchRowHtml } from './components/controls';
import type { SettingsPanel } from './settings-panel';

/** Where "Your games" sits in the Settings sheet (after Sound & effects, before Your data). */
export const GAMES_SECTION_ORDER = 50;

/**
 * Your games: my usernames (so the library knows which side is mine, with or without the
 * capture extension) and whether each new game is reviewed on its own.
 */
export function mountGamesSettings(panel: SettingsPanel, library: GameLibrary, list: GamesList): void {
  const body = panel.addSection('games', 'Your games', GAMES_SECTION_ORDER);
  const accounts = library.getMyAccounts();
  body.innerHTML = `
    <label class="wc-setting-row">
      <span class="wc-setting-label">Lichess username<span class="wc-setting-hint">Marks your side in Lichess games</span></span>
      <input type="text" class="wc-select wc-setting-text" autocomplete="off" spellcheck="false" maxlength="40" value="" data-testid="input-lichess-username" />
    </label>
    <label class="wc-setting-row">
      <span class="wc-setting-label">Chess.com username<span class="wc-setting-hint">Marks your side in Chess.com games</span></span>
      <input type="text" class="wc-select wc-setting-text" autocomplete="off" spellcheck="false" maxlength="40" value="" data-testid="input-chesscom-username" />
    </label>
    ${switchRowHtml('toggle-auto-analyze', 'Auto-analyze new games', false, 'A Quick review of each new captured or imported game')}`;
  const q = <T extends HTMLElement>(id: string) => body.querySelector(`[data-testid="${id}"]`) as T;
  const lichess = q<HTMLInputElement>('input-lichess-username');
  const chesscom = q<HTMLInputElement>('input-chesscom-username');
  const auto = q<HTMLInputElement>('toggle-auto-analyze');
  const show = (): void => {
    const a = library.getMyAccounts();
    if (document.activeElement !== lichess) lichess.value = a?.lichess ?? '';
    if (document.activeElement !== chesscom) chesscom.value = a?.chesscom ?? '';
  };
  lichess.value = accounts?.lichess ?? '';
  chesscom.value = accounts?.chesscom ?? '';
  const save = (): void => {
    void library.setMyAccounts({ lichess: lichess.value.trim(), chesscom: chesscom.value.trim() }).then(() => list.refresh());
  };
  lichess.addEventListener('change', save);
  chesscom.addEventListener('change', save);
  library.onAccountsChange(show);
  void library.getAutoAnalyze().then((on) => {
    auto.checked = on;
  });
  auto.addEventListener('change', () => {
    void library.setAutoAnalyze(auto.checked).then(() => list.syncAutoAnalyze());
  });
  list.onAutoAnalyzeChange((on) => {
    auto.checked = on;
  });
}
