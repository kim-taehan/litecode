import { Component, useEffect, useState, type ErrorInfo, type ReactNode } from 'react'
import { useT, type Translate } from './settingsStore.ts'

// 흰 화면 방어 (closed-code ErrorPage 의 동작) — 그리기 오류가 나면 React 는 트리를 통째로 내려 빈 창이 된다. 경계가 잡아
// "문제가 생겼습니다 — 다시 불러오기" 와 오류 글(복사 가능)을 보인다. 턴·대기열은 메인(ctx.chat)이 쥐고 있어 다시 불러와도 이어진다.
// 경계는 넷: 앱 전체(main.tsx) · 대화 본문 · 설정 페이지 · 오른쪽 패널 — 한 구역의 오류가 나머지를 내리지 않는다.
// 구역 경계는 그 자리에서 "다시 시도"(같은 오류면 다시 이 화면)도 준다. resetKey(대화·탭·설정 페이지)가 바뀌면 저절로 풀린다

type Scope = 'app' | 'section'

/** 복사할 오류 글 — 스택(이름·사유가 첫 줄에 있다), 없으면 `이름: 사유`. 컴포넌트 스택이 있으면 뒤에 */
export function errorText(error: unknown, componentStack?: string): string {
  const head = error instanceof Error ? error.stack || `${error.name}: ${error.message}` : String(error)
  return componentStack ? `${head}\n\nComponent stack:${componentStack}` : head
}

interface PanelProps {
  scope: Scope
  detail: string
  /** 구역: 다시 그려 본다 */
  onRetry(): void
  className?: string
}

/** 번역 함수를 받는 판 — 설정을 못 읽어 번역 저장소가 빈 때(main.tsx)에도 그릴 수 있게 훅을 쓰지 않는 쪽을 따로 둔다 */
export function ErrorPanel({ scope, detail, onRetry, className, t }: PanelProps & { t: Translate }) {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1_500)
    return () => clearTimeout(timer)
  }, [copied])
  return (
    <div className={`crash crash--${scope}${className ? ` ${className}` : ''}`} role="alert">
      <div className="crash__title">{scope === 'app' ? t('crash.title') : t('crash.sectionTitle')}</div>
      <div className="crash__hint">{t('crash.hint')}</div>
      <div className="crash__actions">
        {scope === 'section' && (
          <button type="button" className="crash__button" onClick={onRetry}>
            {t('crash.retry')}
          </button>
        )}
        <button type="button" className="crash__button crash__button--primary" onClick={() => location.reload()}>
          {t('crash.reload')}
        </button>
        <button type="button" className="crash__button" onClick={() => void navigator.clipboard.writeText(detail).then(() => setCopied(true), () => {})}>
          {copied ? t('chat.messageCopied') : t('crash.copy')}
        </button>
      </div>
      <pre className="crash__detail">{detail}</pre>
    </div>
  )
}

export function ErrorFallback(props: PanelProps) {
  return <ErrorPanel {...props} t={useT()} />
}

interface BoundaryProps {
  scope: Scope
  /** 구역이 놓인 자리에 맞추는 클래스 (오른쪽 패널의 폭 등) */
  className?: string
  /** 이 값이 바뀌면 잡아 둔 오류를 푼다 — 다른 대화·다른 설정 페이지로 가면 다시 그려 본다 */
  resetKey?: string
  children?: ReactNode
}

interface BoundaryState {
  error?: unknown
  componentStack?: string
}

export class ErrorBoundary extends Component<BoundaryProps, BoundaryState> {
  override state: BoundaryState = {}

  static getDerivedStateFromError(error: unknown): BoundaryState {
    return { error: error ?? new Error('unknown render error') }
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error('[litecode] render error', error, info.componentStack)
    this.setState({ componentStack: info.componentStack ?? undefined })
  }

  override componentDidUpdate(previous: BoundaryProps): void {
    if (previous.resetKey !== this.props.resetKey && this.state.error !== undefined) this.setState({ error: undefined, componentStack: undefined })
  }

  override render(): ReactNode {
    if (this.state.error === undefined) return this.props.children
    return (
      <ErrorFallback
        scope={this.props.scope}
        className={this.props.className}
        detail={errorText(this.state.error, this.state.componentStack)}
        onRetry={() => this.setState({ error: undefined, componentStack: undefined })}
      />
    )
  }
}
