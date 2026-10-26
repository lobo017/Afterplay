import './styles/main.css';
import { mountAppShell } from './app';
import { registerServiceWorker } from './pwa';

const root = document.getElementById('app');
if (!root) {
  throw new Error('Missing #app root container');
}

mountAppShell(root);
registerServiceWorker();
