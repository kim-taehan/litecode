import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App.tsx'
import './styles.css'
import { loadSettings } from './settingsStore.ts'

// 설정(언어·글자 크기)을 읽은 뒤 그린다 — 첫 그림이 다른 언어로 번쩍이지 않게
void loadSettings().then(() =>
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  ),
)
