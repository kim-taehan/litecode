import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  root: 'renderer',
  plugins: [react()],
  server: {
    port: 5174,
    strictPort: true,
  },
  build: {
    outDir: '../dist/renderer',
    emptyOutDir: true,
  },
})
