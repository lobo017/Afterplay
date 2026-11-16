import { closeButton } from './components/popup';

/**
 * A short message the user has to see once (a set-up link that could not be loaded): a bar that stays until OK.
 * Returns the function that shows a message.
 */
export function mountNotice(parent: HTMLElement): (text: string) => void {
  const el = document.createElement('div');
  el.className = 'wc-update-banner wc-notice';
  el.setAttribute('data-testid', 'app-notice');
  el.setAttribute('role', 'status');
  el.hidden = true;
  const text = document.createElement('span');
  text.setAttribute('data-testid', 'app-notice-text');
  const ok = document.createElement('button');
  ok.type = 'button';
  ok.className = 'wc-btn wc-btn-ghost wc-btn-sm';
  ok.setAttribute('data-testid', 'btn-notice-ok');
  ok.textContent = 'OK';
  ok.addEventListener('click', () => {
    el.hidden = true;
  });
  // The X does what OK does
  el.append(text, ok, closeButton({ testId: 'app-notice-close', onClose: () => (el.hidden = true) }));
  parent.appendChild(el);
  return (message: string) => {
    text.textContent = message;
    el.hidden = false;
  };
}
