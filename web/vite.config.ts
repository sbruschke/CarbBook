import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      // New builds activate on the next load; the server sends index.html with Cache-Control: no-cache.
      registerType: 'autoUpdate',
      injectRegister: 'script',
      manifest: {
        name: 'CarbBook',
        short_name: 'CarbBook',
        description: 'Carb counter and insulin dose estimator',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        orientation: 'portrait',
        background_color: '#f6f7f4',
        theme_color: '#1b5e20',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // Precache the app shell; the API is never cached (data lives in IndexedDB).
        globPatterns: ['**/*.{js,css,html,svg,png,webmanifest}'],
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api\//],
        cleanupOutdatedCaches: true,
        runtimeCaching: [
          {
            // Hash URLs are immutable, so CacheFirst never needs revalidation and images stay
            // available offline. navigateFallbackDenylist already excludes /api/ from the SPA shell.
            urlPattern: /\/api\/images\/[0-9a-f]{64}$/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'carbbook-images',
              expiration: { maxEntries: 500 },
              cacheableResponse: { statuses: [200] },
            },
          },
        ],
      },
    }),
  ],
  server: {
    proxy: { '/api': 'http://127.0.0.1:3000' },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./test/setup.ts'],
    include: ['test/**/*.test.{ts,tsx}'],
  },
});
