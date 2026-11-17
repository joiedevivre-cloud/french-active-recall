import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

// GitHub Pages serves this app at https://joiedevivre-cloud.github.io/french-active-recall/
// so every asset URL must be prefixed with this base path.
const BASE_PATH = '/french-active-recall/';

export default defineConfig({
  base: BASE_PATH,
  plugins: [
    react(),
    VitePWA({
      // Manual update prompt instead of silent auto-reload, so a user mid-review
      // isn't yanked onto a new version. See src/pwa/useUpdatePrompt.ts.
      registerType: 'prompt',
      injectRegister: 'auto',
      workbox: {
        // index.html: network-first (always try to get the latest shell first).
        // Hashed JS/CSS/assets: cache-first, since their filename changes on
        // every build -- stale content can never be served under a new hash.
        globPatterns: ['**/*.{js,css,html,svg,png,ico,webmanifest}'],
        navigateFallback: `${BASE_PATH}index.html`,
        runtimeCaching: [
          {
            urlPattern: ({ request }) => request.mode === 'navigate',
            handler: 'NetworkFirst',
            options: { cacheName: 'html-shell' },
          },
        ],
      },
      manifest: {
        id: BASE_PATH,
        name: 'French Active Recall',
        short_name: 'FR Recall',
        description: '프랑스어 실시간 표현 수집 · AI 인출 학습 앱',
        start_url: BASE_PATH,
        scope: BASE_PATH,
        display: 'standalone',
        background_color: '#0f172a',
        theme_color: '#0f172a',
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
    }),
  ],
  resolve: {
    alias: {
      '@': '/src',
    },
  },
  server: {
    port: 5173,
  },
});
