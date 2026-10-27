// Builds the capture extension (extension/) into dist-ext/, ready to load unpacked.
//   npm run build:ext
//
// Every script is bundled into one self-contained IIFE file (MV3 content scripts can't be
// modules, and the extension loads no remote code). The manifest gets the version from
// package.json; the toolbar icons are drawn here as PNGs.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const OUT = path.join(root, 'dist-ext');

const ENTRIES = [
  ['background', 'extension/src/background.ts'],
  ['bridge', 'extension/src/bridge.ts'],
  ['popup', 'extension/src/popup/popup.ts'],
  ['lichess', 'extension/src/content/lichess.ts'],
  ['chesscom', 'extension/src/content/chesscom.ts'],
];

// --- PNG icons (gold pawn on obsidian), drawn with 4× supersampling

function crc32(buf) {
  let c;
  const table = [];
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(size, rgba) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Coverage of the icon shapes at (x, y) in unit coordinates: 0 none, 1 background, 2 pawn. */
function shapeAt(x, y) {
  const r = 0.18;
  const inRounded = (() => {
    const dx = Math.max(Math.abs(x - 0.5) - (0.5 - r), 0);
    const dy = Math.max(Math.abs(y - 0.5) - (0.5 - r), 0);
    return dx * dx + dy * dy <= r * r;
  })();
  if (!inRounded) return 0;
  const head = (x - 0.5) ** 2 + (y - 0.3) ** 2 <= 0.12 ** 2;
  const neck = y >= 0.4 && y <= 0.47 && Math.abs(x - 0.5) <= 0.13;
  const body = y >= 0.44 && y <= 0.74 && Math.abs(x - 0.5) <= 0.07 + (y - 0.44) * 0.55;
  const base = y >= 0.72 && y <= 0.82 && Math.abs(x - 0.5) <= 0.27;
  return head || neck || body || base ? 2 : 1;
}

function drawIcon(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const SS = 4;
  const bg = [22, 25, 34];
  const gold = [212, 175, 55];
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let a = 0;
      const col = [0, 0, 0];
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const s = shapeAt((px + (sx + 0.5) / SS) / size, (py + (sy + 0.5) / SS) / size);
          if (s === 0) continue;
          a++;
          const c = s === 2 ? gold : bg;
          col[0] += c[0];
          col[1] += c[1];
          col[2] += c[2];
        }
      }
      const i = (py * size + px) * 4;
      if (a > 0) {
        rgba[i] = Math.round(col[0] / a);
        rgba[i + 1] = Math.round(col[1] / a);
        rgba[i + 2] = Math.round(col[2] / a);
      }
      rgba[i + 3] = Math.round((a / (SS * SS)) * 255);
    }
  }
  return encodePng(size, rgba);
}

// --- build

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(path.join(OUT, 'icons'), { recursive: true });

for (const [name, file] of ENTRIES) {
  await build({
    configFile: false,
    root,
    logLevel: 'warn',
    publicDir: false,
    build: {
      outDir: OUT,
      emptyOutDir: false,
      target: 'chrome127',
      minify: false,
      sourcemap: false,
      copyPublicDir: false,
      reportCompressedSize: false,
      lib: {
        entry: path.join(root, file),
        formats: ['iife'],
        name: `wizardChess_${name}`,
        fileName: () => `${name}.js`,
      },
      rollupOptions: { output: { inlineDynamicImports: true } },
    },
  });
}

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'extension', 'manifest.json'), 'utf8'));
manifest.version = pkg.version;
fs.writeFileSync(path.join(OUT, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
for (const f of ['popup.html', 'popup.css']) fs.copyFileSync(path.join(root, 'extension', f), path.join(OUT, f));
for (const size of [16, 32, 48, 128]) fs.writeFileSync(path.join(OUT, 'icons', `icon-${size}.png`), drawIcon(size));

// No remotely hosted code: nothing may load scripts from the network
for (const [name] of ENTRIES) {
  const code = fs.readFileSync(path.join(OUT, `${name}.js`), 'utf8');
  if (/\bimportScripts\s*\(|\bimport\s*\(\s*['"`]https?:/.test(code)) {
    throw new Error(`${name}.js loads remote code`);
  }
}
const sizes = ENTRIES.map(
  ([name]) => `${name}.js ${(fs.statSync(path.join(OUT, `${name}.js`)).size / 1024).toFixed(0)} kB`,
);
console.log(`Extension built into ${path.relative(root, OUT)}/ (v${pkg.version}): ${sizes.join(', ')}`);
