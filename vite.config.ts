import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

// base './' so the build works at https://<user>.github.io/listenshelf/ and locally.
export default defineConfig({
  base: './',
  worker: { format: 'es' },
  // Cross-origin isolation enables multi-threaded WASM for the Pocket voice model.
  // In production the service worker adds these headers (GitHub Pages can't).
  server: { headers: { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'credentialless' } },
  // `vite preview` deliberately sends no COOP/COEP so it mimics GitHub Pages and
  // proves the service worker adds them.
  build: { target: 'es2022', chunkSizeWarningLimit: 4000 },
  optimizeDeps: { exclude: ['kokoro-js'] },
  plugins: [
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icon.svg'],
      manifest: {
        name: 'ListenShelf',
        short_name: 'ListenShelf',
        description: 'Listen to your PDF books and Wikipedia articles',
        theme_color: '#14161c',
        background_color: '#14161c',
        display: 'standalone',
        orientation: 'portrait',
        start_url: './',
        scope: './',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      // Custom service worker (src/sw.ts): precache + COOP/COEP headers + Pocket runtime cache.
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      injectManifest: {
        // App shell only (incl. the pdf.js worker, needed offline). The Pocket-mode
        // worker + onnxruntime wasm (~24 MB) are fetched on first use and runtime-cached;
        // the voice model itself is cached by transformers.js (Cache API).
        globPatterns: ['**/*.{js,css,html,svg,png,mjs}'],
        globIgnores: ['**/ort-wasm*', '**/worker-*.js'],
        maximumFileSizeToCacheInBytes: 10 * 1024 * 1024,
      },
    }),
  ],
});
