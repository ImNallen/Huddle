import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
export default defineConfig({
  plugins: [tanstackStart(), react()],
  // Below the light-dark() floor Lightning CSS swaps it for a polyfill, and an inline color-scheme
  // on a swatch can't reach the polyfill's variables.
  build: { cssTarget: ['chrome123', 'edge123', 'firefox120', 'safari17.5'] },
  server: { host: '127.0.0.1', port: Number(process.env.PORT ?? 3000), strictPort: true },
})
