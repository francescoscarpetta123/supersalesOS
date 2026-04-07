import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

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
