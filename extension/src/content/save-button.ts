/**
 * The "Save game" button injected on game pages. It lives in a shadow root on <html>, so
 * the site's styles don't reach it and a site re-rendering <body> doesn't remove it.
 */
export type SaveButtonState =
  | 'ready'
  | 'in-progress'
  | 'saving'
  | 'saved'
  | 'already-queued'
  | 'already-delivered'
  | 'failed';

const LABELS: Record<SaveButtonState, string> = {
  ready: "Save to Wizard's Chess",
  'in-progress': 'Game in progress',
  saving: 'Saving…',
  saved: 'Saved ✓',
  'already-queued': 'Already saved ✓',
  'already-delivered': 'On the analysis site ✓',
  failed: "Couldn't save",
};

const STYLE = `
  :host { all: initial; }
  .wc {
    position: fixed; right: 16px; bottom: 16px; z-index: 2147483000;
    display: flex; flex-direction: column; align-items: flex-end; gap: 4px;
    font: 600 13px/1.3 system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
  }
  button {
    display: inline-flex; align-items: center; gap: 6px;
    padding: 8px 12px; border-radius: 8px; cursor: pointer;
    border: 1px solid rgba(212, 175, 55, 0.7);
    background: #161922; color: #fcd34d;
    box-shadow: 0 6px 18px rgba(0, 0, 0, 0.45);
    font: inherit;
  }
  button:hover:not(:disabled) { background: #232838; }
  button:disabled { cursor: default; opacity: 0.85; }
  button[data-state='saved'], button[data-state='already-queued'], button[data-state='already-delivered'] {
    color: #86efac; border-color: rgba(52, 211, 153, 0.6);
  }
  button[data-state='failed'] { color: #fca5a5; border-color: rgba(248, 113, 113, 0.6); }
  button[data-state='in-progress'] { color: #cbd5e1; border-color: rgba(148, 163, 184, 0.5); }
  .mark { font-size: 15px; }
  .note {
    max-width: 280px; padding: 4px 8px; border-radius: 6px;
    background: rgba(22, 25, 34, 0.95); color: #cbd5e1; font-weight: 500; font-size: 12px;
  }
  .note:empty { display: none; }
`;

export class SaveButton {
  private readonly host: HTMLElement;
  private readonly button: HTMLButtonElement;
  private readonly label: HTMLElement;
  private readonly note: HTMLElement;
  private state: SaveButtonState = 'ready';

  constructor(onClick: () => void) {
    document.getElementById('wizard-chess-capture')?.remove();
    this.host = document.createElement('div');
    this.host.id = 'wizard-chess-capture';
    const root = this.host.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>${STYLE}</style>
      <div class="wc">
        <span class="note" data-testid="wc-save-note" role="status"></span>
        <button type="button" data-testid="wc-save-button" title="Wizard's Chess capture"><span class="mark" aria-hidden="true">♛</span><span class="label"></span></button>
      </div>`;
    this.button = root.querySelector('button')!;
    this.label = root.querySelector('.label')!;
    this.note = root.querySelector('.note')!;
    this.button.addEventListener('click', () => {
      if (this.state === 'ready' || this.state === 'failed' || this.state === 'in-progress') onClick();
    });
    document.documentElement.appendChild(this.host);
    this.set('ready');
  }

  public set(state: SaveButtonState, note = ''): void {
    this.state = state;
    this.label.textContent = LABELS[state];
    this.button.setAttribute('data-state', state);
    this.host.setAttribute('data-state', state);
    this.button.disabled = state === 'saving' || state === 'saved' || state === 'already-queued' || state === 'already-delivered';
    this.note.textContent = note;
  }

  public getState(): SaveButtonState {
    return this.state;
  }

  public remove(): void {
    this.host.remove();
  }
}
