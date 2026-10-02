import { useEffect, useRef, useState } from 'react'
import type { ConversationStatus, NoticeState, OpenTarget, Toast } from '../shared/ipc.ts'
import { useT } from './settingsStore.ts'
import './notices.css'

// 앱 알림 — 상태의 정본은 메인(ctx.notifications)이고 화면은 받아서 그린다: 대화 행·프로젝트 점(StatusDot), 앞일 때의 토스트(Toasts).
// 화면은 지금 보는 대화를 메인에 알린다(viewConversation) — 앱이 앞이면 그 대화가 읽음이 되고, 그 대화의 사건은 알리지 않는다.
// 모양은 dsh 를 따른다: 점은 ui-primitives StateDot(초록 끝남·주황 답 필요·회색 실행 중·빨강 실패), 토스트는 ui-primitives Toast
// (위 가운데, 어두운 바탕, 잠깐 머물다 사라짐). dsh 토스트는 클릭을 통과시키지만 우리 것은 누르면 그 대화로 간다(사용자 결정 2).

/** 화면에 떠 있는 토스트 하나 — 알림이거나(누르면 이동) 짧은 안내 글 */
export interface ToastItem {
  key: number
  toast?: Toast
  message?: string
}

/** 토스트가 머무는 시간 — 문구가 두 줄이라 dsh 기본(3초)보다 길게. notices.css 의 사라짐(5초 뒤 1초)과 맞춘다 */
const HOLD_MS = 6000
const MAX_TOASTS = 3

let nextKey = 0

export function useNotices(viewing: string | undefined) {
  const [state, setState] = useState<NoticeState>({})
  const [toasts, setToasts] = useState<ToastItem[]>([])
  const viewingRef = useRef(viewing)
  viewingRef.current = viewing

  function push(item: Omit<ToastItem, 'key'>): void {
    const key = nextKey++
    setToasts((now) => [...now, { ...item, key }].slice(-MAX_TOASTS))
    setTimeout(() => setToasts((now) => now.filter((entry) => entry.key !== key)), HOLD_MS)
  }

  useEffect(() => {
    // 알림 플러그인이 빠졌으면(채널 없음) 점·토스트 없이 그대로 돈다
    void window.litecode.getNotifications().then(setState, () => {})
    const offChanged = window.litecode.onNotificationsChanged(setState)
    const offToast = window.litecode.onNotificationToast((toast) => {
      if (toast.conversationId !== viewingRef.current) push({ toast })
    })
    return () => {
      offChanged()
      offToast()
    }
  }, [])

  useEffect(() => {
    void window.litecode.viewConversation(viewing).catch(() => {})
  }, [viewing])

  return {
    state,
    toasts,
    /** 짧은 안내 (예: 누른 알림의 대화가 지워졌다) */
    say: (message: string) => push({ message }),
    dismiss: (key: number) => setToasts((now) => now.filter((entry) => entry.key !== key)),
  }
}

/** 상태 점 — 실행 중은 회색, 답 필요는 주황, 끝남은 초록, 실패·중단은 빨강. 읽는 이에겐 이름표로 */
export function StatusDot({ status, className }: { status: ConversationStatus; className?: string }) {
  const t = useT()
  const label = statusLabel(t, status)
  return <span className={`notice-dot${className ? ` ${className}` : ''}`} data-status={status} role="img" aria-label={label} title={label} />
}

function statusLabel(t: ReturnType<typeof useT>, status: ConversationStatus): string {
  if (status === 'running') return t('notify.running')
  if (status === 'attention') return t('notify.attention')
  return t(`notify.${status}`)
}

export function Toasts({ items, onOpen, onDismiss }: { items: ToastItem[]; onOpen(target: OpenTarget): void; onDismiss(key: number): void }) {
  const t = useT()
  if (items.length === 0) return null
  return (
    <div className="toasts" role="region" aria-label={t('notify.toasts')}>
      {items.map(({ key, toast, message }) =>
        toast ? (
          <button
            key={key}
            type="button"
            className="toast"
            onClick={() => {
              onDismiss(key)
              onOpen({ conversationId: toast.conversationId, project: toast.project })
            }}
          >
            <StatusDot status={toast.kind === 'question' || toast.kind === 'permission' ? 'attention' : toast.kind} />
            <span className="toast__text">
              <span className="toast__title">{toast.title || t('sidebar.untitled')}</span>
              <span className="toast__detail">{t('notify.body', { project: toast.projectName, status: t(`notify.${toast.kind}`) })}</span>
            </span>
          </button>
        ) : (
          <div key={key} className="toast toast--message" role="status">
            <span className="toast__text">{message}</span>
          </div>
        ),
      )}
    </div>
  )
}
