import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App.tsx'
import './styles.css'
import { loadSettings } from './settingsStore.ts'
import { loadFeatures } from './featuresStore.ts'
import { ErrorBoundary, ErrorPanel, errorText } from './ErrorBoundary.tsx'
import { translate } from '../shared/i18n/index.ts'

const root = createRoot(document.getElementById('root')!)

// 설정(언어·글자 크기)·켜진 기능을 읽은 뒤 그린다 — 첫 그림이 다른 언어로 번쩍이거나 꺼진 기능이 잠깐 보이지 않게.
// 그리기 오류는 맨 바깥 경계가 잡는다(흰 화면 대신 "다시 불러오기"). 설정을 못 읽으면 그릴 것이 없어 창이 비므로 그 사유를 보인다 —
// 그때는 언어를 모르니 기본 언어(en) 사전으로
void Promise.all([loadSettings(), loadFeatures()]).then(
  () =>
    root.render(
      <StrictMode>
        <ErrorBoundary scope="app">
          <App />
        </ErrorBoundary>
      </StrictMode>,
    ),
  (error: unknown) => root.render(<ErrorPanel scope="app" detail={errorText(error)} onRetry={() => {}} t={(key, vars) => translate('en', key, vars)} />),
)
