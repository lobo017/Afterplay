import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

const isolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

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
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: false,
      manifest: {
        name: "Wizard's Chess",
        short_name: 'WizardChess',
        description: 'Fully offline chess learning and Stockfish analysis tool',
        theme_color: '#0b0d12',
        background_color: '#0b0d12',
        display: 'standalone',
        icons: [
          {
            src: '/favicon.svg',
            sizes: 'any',
            type: 'image/svg+xml',
            purpose: 'any maskable',
          },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,json,wasm,nnue,webmanifest}'],
        maximumFileSizeToCacheInBytes: 30 * 1024 * 1024,
      },
    }),
  ],
});
