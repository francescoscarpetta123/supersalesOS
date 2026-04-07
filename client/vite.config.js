import path from 'path';
import { fileURLToPath } from 'url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function forwardBrowserHost() {
  return (proxyReq, req) => {
    const host = req.headers.host;
    if (host) {
      proxyReq.setHeader('X-Forwarded-Host', host);
      proxyReq.setHeader('X-Forwarded-Proto', 'http');
    }
  };
}

export default defineConfig({
  // Keep Vite’s cache outside node_modules so npm ci / workspace installs never fight rmdir on .../node_modules/.vite (EBUSY on Railway/Linux).
  cacheDir: path.resolve(__dirname, '.vite'),
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
        configure: (proxy) => proxy.on('proxyReq', forwardBrowserHost()),
      },
      '/auth': {
        target: 'http://localhost:3001',
        changeOrigin: true,
        configure: (proxy) => proxy.on('proxyReq', forwardBrowserHost()),
      },
    },
  },
});
