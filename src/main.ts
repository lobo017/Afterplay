import './styles/main.css';
import { mountAppShell } from './app';

const root = document.getElementById('app');
if (!root) {
  throw new Error('Missing #app root container');
}

mountAppShell(root);

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    if (!window.crossOriginIsolated) {
      navigator.serviceWorker.register('/coi-serviceworker.js').catch(() => {
        // Fallback to single-threaded Stockfish when SW registration is unavailable
      });
    }
  });
}
