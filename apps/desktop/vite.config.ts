import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const devServer = process.env.VITE_HUDDLE_DEV_SERVER ?? 'http://localhost:3000'
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    host: '127.0.0.1',
    port: Number(process.env.HUDDLE_DESKTOP_PORT ?? 1420),
    strictPort: true,
    proxy: { '/api': { target: devServer, changeOrigin: true } },
  },
})
