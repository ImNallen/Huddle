import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
export default defineConfig({
  plugins: [tanstackStart(), react()],
  server: { host: '0.0.0.0', port: 3000, strictPort: true },
})
