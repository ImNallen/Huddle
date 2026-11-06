import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const devServer = process.env.VITE_HUDDLE_DEV_SERVER ?? 'http://localhost:3000'
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  // Below the light-dark() floor Lightning CSS swaps it for a polyfill, and an inline color-scheme
  // on a swatch can't reach the polyfill's variables.
  build: { cssTarget: ['chrome123', 'edge123', 'firefox120', 'safari17.5'] },
  publicDir: fileURLToPath(new URL('../../packages/ui/public', import.meta.url)),
  server: {
    host: '127.0.0.1',
    port: Number(process.env.HUDDLE_DESKTOP_PORT ?? 1420),
    strictPort: true,
    proxy: { '/api': { target: devServer, changeOrigin: true } },
  },
})
