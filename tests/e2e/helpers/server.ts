import { spawn, type ChildProcess } from 'node:child_process';
import net from 'node:net';
import { expect, type Page } from '@playwright/test';

// A copy of the built app on a port (and so an origin) of its own, for tests that need the service worker or
// have to take the server away: scripts/serve.mjs as a process the test holds a handle to.

export interface Server {
  url: string;
  stop(): Promise<void>;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as net.AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

/** The built app on its own port (scripts/serve.mjs): a process this test holds a handle to. */
export async function startServer(distDir?: string): Promise<Server> {
  const port = await freePort();
  const child: ChildProcess = spawn(process.execPath, ['scripts/serve.mjs', '--port', String(port)], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, WC_EXIT_WITH_PARENT_PID: String(process.pid), ...(distDir ? { WC_DIST_DIR: distDir } : {}) },
    windowsHide: true,
  });
  let exited = false;
  child.once('exit', () => {
    exited = true;
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('the test server did not start')), 15_000);
    child.stdout!.on('data', (chunk: Buffer) => {
      if (chunk.toString().includes('http://')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.once('exit', (code) => reject(new Error(`the test server exited early (${code})`)));
  });
  return {
    url: `http://127.0.0.1:${port}`,
    stop: () =>
      new Promise<void>((resolve) => {
        if (exited) {
          resolve();
          return;
        }
        child.once('exit', () => resolve());
        child.kill();
      }),
  };
}

/** Waits until the service worker has cached the whole build (Settings › About says so). */
export async function waitForOfflineReady(page: Page): Promise<string> {
  await expect
    .poll(() => page.getByTestId('stat-offline').textContent(), {
      timeout: 60_000,
      message: 'the service worker should cache the build',
    })
    .toMatch(/^Ready: all \d+ files are cached$/);
  return (await page.getByTestId('stat-offline').textContent())!;
}
