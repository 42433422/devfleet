import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tsconfigPaths from "vite-tsconfig-paths";
import { resolve } from 'node:path';

const apiProxyTarget = process.env.VITE_API_PROXY_TARGET || 'http://127.0.0.1:3001';
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig({
  // Tauri 生产包必须用相对路径，否则 WebView 加载 /assets/* 会白屏
  base: './',
  plugins: [
    react({
      babel: {
        plugins: process.env.NODE_ENV === 'development' ? ['react-dev-locator'] : [],
      },
    }),
    tsconfigPaths(),
  ],
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        backendError: resolve(__dirname, 'backend-error.html'),
      },
    },
  },
  server: {
    host: host || '127.0.0.1',
    port: 5173,
    strictPort: true,
    headers: process.env.NODE_ENV === 'development' ? {
      'Content-Security-Policy': "default-src 'self'; connect-src 'self' http://localhost:3001 http://127.0.0.1:3001 ws://localhost:3001 ws://127.0.0.1:3001 http://localhost:5173 ws://localhost:5173 https:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:",
    } : undefined,
    proxy: {
      '/api': {
        target: apiProxyTarget,
        changeOrigin: true,
        secure: false,
        configure: (proxy) => {
          proxy.on('error', (err) => {
            console.log('proxy error', err);
          });
          proxy.on('proxyReq', (_, req) => {
            console.log('Sending Request to the Target:', req.method, req.url);
          });
          proxy.on('proxyRes', (proxyRes, req) => {
            console.log('Received Response from the Target:', proxyRes.statusCode, req.url);
          });
        },
      },
      '/ws': {
        target: apiProxyTarget.replace(/^http/, 'ws'),
        ws: true,
        changeOrigin: true,
      }
    }
  }
})
