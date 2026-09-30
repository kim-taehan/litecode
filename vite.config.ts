import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  root: 'renderer',
  // 설치본은 file:// 로 index.html 을 연다 — 기본값 '/' 면 /assets/… 가 디스크 루트를 가리켜 빈 화면이 된다 (test:dist 로 잡음)
  base: './',
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
