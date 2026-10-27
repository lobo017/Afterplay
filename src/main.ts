import './styles/main.css';
import { mountAppShell } from './app';
import { registerServiceWorker } from './pwa';

const root = document.getElementById('app');
if (!root) {
  throw new Error('Missing #app root container');
}

// Start-up in separate tasks, none over 50 ms: this one only loads the modules; the page is then
// parsed and styled (a forced layout), and the app is built in a task of its own.
setTimeout(() => {
  mountAppShell(root);
  registerServiceWorker();
}, 0);
