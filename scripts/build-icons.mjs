// Renders public/favicon.svg to the PNG icons the web app manifest lists (Chrome wants 192 and
// 512 px PNGs before it offers to install an app). Dev-time script, run by hand:
//   npm run build:icons
// It uses the Playwright Chromium that the end-to-end tests already use; nothing leaves this machine.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const svg = fs
  .readFileSync(path.join(root, 'public', 'favicon.svg'), 'utf8')
  .replace(/ width="64" height="64"/, ' width="100%" height="100%"');

const icons = [
  // The icon as drawn, on a transparent background
  { file: 'icon-192.png', size: 192, inset: 0, background: 'transparent' },
  { file: 'icon-512.png', size: 512, inset: 0, background: 'transparent' },
  // Maskable: full-bleed background with the mark inside the central safe zone
  { file: 'icon-maskable-512.png', size: 512, inset: 0.14, background: '#0b0d12' },
];

const browser = await chromium.launch({ channel: 'chrome' });
try {
  const page = await browser.newPage();
  for (const { file, size, inset, background } of icons) {
    await page.setViewportSize({ width: size, height: size });
    const pad = Math.round(size * inset);
    await page.setContent(
      `<!doctype html><html><body style="margin:0;background:${background};width:${size}px;height:${size}px">
        <div style="position:absolute;inset:${pad}px">${svg}</div></body></html>`,
    );
    await page.screenshot({ path: path.join(root, 'public', file), omitBackground: background === 'transparent' });
    console.log(`wrote public/${file} (${size}x${size})`);
  }
} finally {
  await browser.close();
}
