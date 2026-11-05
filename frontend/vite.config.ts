import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8765',
        changeOrigin: true,
        // SSE / streaming endpoints must not be buffered
        configure: (proxy) => {
          proxy.on('proxyRes', (proxyRes) => {
            if (
              (proxyRes.headers['content-type'] || '').includes('text/event-stream')
            ) {
              proxyRes.headers['cache-control'] = 'no-cache, no-transform';
            }
          });
        },
      },
    },
  },
  build: {
    outDir: 'dist',
    chunkSizeWarningLimit: 2000,
    // two versions of the same app: the classic reader (index.html) and the
    // desktop-pet reading assistant (pet.html). Both share one backend.
    rollupOptions: {
      input: {
        main: 'index.html',
        pet: 'pet.html',
      },
    },
  },
});
