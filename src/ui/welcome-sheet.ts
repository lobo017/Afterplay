import type { WelcomeMessage } from '../preset/preset';
import { Sheet } from './components/sheet';

/**
 * The welcome message a preset carries: shown once after a first-run link has set the app up, and again from
 * Settings › Profile. The text is the preset's, shown as plain text (a blank line starts a new paragraph).
 */
export class WelcomeSheet {
  private readonly sheet: Sheet;

  constructor(parent: HTMLElement, onClosed: () => void) {
    this.sheet = new Sheet(parent, {
      title: 'Welcome',
      testId: 'welcome-sheet',
      onToggle: (open) => {
        if (!open) onClosed();
      },
    });
  }

  public show(welcome: WelcomeMessage): void {
    const body = this.sheet.body;
    body.replaceChildren();
    const card = document.createElement('div');
    card.className = 'wc-welcome';
    if (welcome.title) {
      const title = document.createElement('h3');
      title.className = 'wc-welcome-title';
      title.setAttribute('data-testid', 'welcome-title');
      title.textContent = welcome.title;
      card.appendChild(title);
    }
    const message = document.createElement('div');
    message.className = 'wc-welcome-message';
    message.setAttribute('data-testid', 'welcome-message');
    for (const paragraph of welcome.message.split(/\n{2,}/)) {
      const p = document.createElement('p');
      p.textContent = paragraph;
      message.appendChild(p);
    }
    card.appendChild(message);
    if (welcome.from) {
      const from = document.createElement('p');
      from.className = 'wc-welcome-from';
      from.setAttribute('data-testid', 'welcome-from');
      from.textContent = welcome.from;
      card.appendChild(from);
    }
    const actions = document.createElement('div');
    actions.className = 'wc-welcome-actions';
    const done = document.createElement('button');
    done.type = 'button';
    done.className = 'wc-btn wc-btn-primary wc-btn-lg';
    done.setAttribute('data-testid', 'welcome-done');
    done.textContent = 'Start playing';
    done.addEventListener('click', () => this.sheet.close());
    actions.appendChild(done);
    card.appendChild(actions);
    body.appendChild(card);
    this.sheet.open();
  }

  public isOpen(): boolean {
    return this.sheet.isOpen();
  }
}
