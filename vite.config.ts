import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const stockfishSrcDir = path.resolve(__dirname, 'node_modules', 'stockfish', 'src');

const STOCKFISH_LITE_FILES = [
  'stockfish-17.1-lite-51f59da.js',
  'stockfish-17.1-lite-51f59da.wasm',
  'stockfish-17.1-lite-single-03e3232.js',
  'stockfish-17.1-lite-single-03e3232.wasm',
] as const;

const isolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

function stockfishAssetsPlugin(): Plugin {
  return {
    name: 'wizards-chess-stockfish-assets',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!req.url || !req.url.startsWith('/stockfish/')) {
          next();
          return;
        }
        const rawPath = req.url.split('?')[0]?.split('#')[0] ?? '';
        const filename = path.basename(rawPath);
        if (!STOCKFISH_LITE_FILES.includes(filename as (typeof STOCKFISH_LITE_FILES)[number])) {
          next();
          return;
        }
        const fullPath = path.join(stockfishSrcDir, filename);
        if (!fs.existsSync(fullPath)) {
          next();
          return;
        }
        res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
        res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
        res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
        res.setHeader(
          'Content-Type',
          filename.endsWith('.wasm') ? 'application/wasm' : 'text/javascript; charset=utf-8',
        );
        fs.createReadStream(fullPath).pipe(res);
      });
    },
    generateBundle() {
      for (const filename of STOCKFISH_LITE_FILES) {
        const fullPath = path.join(stockfishSrcDir, filename);
        if (fs.existsSync(fullPath)) {
          this.emitFile({
            type: 'asset',
            fileName: `stockfish/${filename}`,
            source: fs.readFileSync(fullPath),
          });
        }
      }
    },
  };
}

export default defineConfig({
  server: {
    port: 5173,
    strictPort: false,
    headers: isolationHeaders,
  },
  preview: {
    port: 4173,
    strictPort: false,
    headers: isolationHeaders,
  },
  build: {
    target: 'es2022',
    sourcemap: true,
  },
  plugins: [
    stockfishAssetsPlugin(),
    VitePWA({
      // One service worker of our own (src/sw.ts): precache + the isolation headers; see there
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      registerType: 'prompt',
      injectRegister: false,
      manifest: {
        id: '/',
        name: 'Afterplay',
        short_name: 'Afterplay',
        description: 'Fully offline chess learning and Stockfish analysis tool',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        orientation: 'any',
        categories: ['games', 'education'],
        theme_color: '#0b0d12',
        background_color: '#0b0d12',
        icons: [
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          { src: '/favicon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
        ],
      },
      injectManifest: {
        globPatterns: ['**/*.{js,css,html,svg,json,wasm,nnue,webmanifest,png}'],
        // Source maps are not part of the offline app; a first-run link's preset is fetched once, online
        globIgnores: ['**/*.map', 'start/**'],
        maximumFileSizeToCacheInBytes: 30 * 1024 * 1024,
        rollupFormat: 'iife',
      },
    }),
  ],
});
