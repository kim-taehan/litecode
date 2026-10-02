import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App.tsx'
import './styles.css'
import { loadSettings } from './settingsStore.ts'
import { loadFeatures } from './featuresStore.ts'

// 설정(언어·글자 크기)·켜진 기능을 읽은 뒤 그린다 — 첫 그림이 다른 언어로 번쩍이거나 꺼진 기능이 잠깐 보이지 않게
void Promise.all([loadSettings(), loadFeatures()]).then(() =>
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  ),
)
