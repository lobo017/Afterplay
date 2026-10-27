import './styles/main.css';
import { installReadyHooks, mountAppShell } from './app';
import { registerServiceWorker } from './pwa';

const root = document.getElementById('app');
if (!root) {
  throw new Error('Missing #app root container');
}

installReadyHooks();

// Start-up in separate tasks, none over 50 ms: this one only loads the modules. The page's small shell (index.html) is
// laid out in the first frame, which is where the browser pays its one-time font start-up; the app is then built
// in a task of its own, and laid out in the frame after.
requestAnimationFrame(() => {
  setTimeout(() => {
    mountAppShell(root);
    registerServiceWorker();
  }, 0);
});
