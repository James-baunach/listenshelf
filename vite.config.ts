import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

// base './' so the build works at https://<user>.github.io/listenshelf/ and locally.
export default defineConfig({
  base: './',
  worker: { format: 'es' },
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
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // App shell only. The pdf.js worker is big but needed offline; the
        // neural voice model is cached separately by transformers.js (Cache API).
        globPatterns: ['**/*.{js,css,html,svg,png,mjs,wasm}'],
        maximumFileSizeToCacheInBytes: 30 * 1024 * 1024,
        navigateFallback: 'index.html',
      },
    }),
  ],
});
