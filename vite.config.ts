import basicSsl from '@vitejs/plugin-basic-ssl';
import { VitePWA } from 'vite-plugin-pwa';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    // The microphone needs a secure context; this serves the dev/preview server over https on the LAN.
    basicSsl(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['apple-touch-icon.png'],
      workbox: { globPatterns: ['**/*.{js,css,html,png,woff2}'] },
      manifest: {
        name: 'Whoosh',
        short_name: 'Whoosh',
        description: 'Send short messages between nearby devices as sound.',
        display: 'standalone',
        orientation: 'portrait',
        background_color: '#4b4a4a',
        theme_color: '#4b4a4a',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
    }),
  ],
  build: {
    rollupOptions: {
      // design-system.html is the live reference for the UI kit.
      input: { main: 'index.html', designSystem: 'design-system.html' },
    },
  },
  test: { include: ['tests/**/*.test.ts'], environment: 'node' },
});
