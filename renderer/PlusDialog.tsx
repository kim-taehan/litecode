import { useEffect, useId, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { Project } from '../shared/ipc.ts'
import { badgeColor, badgeLetters } from './badge.ts'
import { useT } from './settingsStore.ts'
import { useFocusTrap } from './focusTrap.ts'
import './plus.css'

// 입력창 `+` 메뉴가 여는 팝업의 틀 (이슈 #43, 시안 _workspace/mock-plus/Mcp.dc.html·Skills.dc.html): 720 폭·24 모서리 판, 머리(프로젝트 배지 + 제목 +
// "<프로젝트> 에서 …" + 닫기) · 구분선 · 스크롤되는 내용. 가림막·닫기 버튼·Esc 동작은 설정 모달(dsh ui-settings-general SettingsRoot)과 같다.
// 입력 카드 안에서 열리므로 body 에 붙인다(포털) — 입력 카드의 겹침 맥락·넘침에 갇히지 않게.

interface PlusDialogProps {
  project: Project
  title: string
  subtitle: string
  onClose(): void
  children: ReactNode
}

/** 팝업의 묶음 하나 — 머리(이름 + 설명 + 오른쪽 버튼)와 그 아래 줄들 */
export function PlusGroup({ label, hint, action, children }: { label: string; hint: ReactNode; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="plus-group" aria-label={label}>
      <div className="plus-group__head">
        <span className="plus-group__label">{label}</span>
        <span className="plus-group__hint">{hint}</span>
        {action}
      </div>
      {children}
    </section>
  )
}

export function PlusDialog({ project, title, subtitle, onClose, children }: PlusDialogProps) {
  const t = useT()
  const titleId = useId()
  const dialogRef = useRef<HTMLDivElement>(null)
  useFocusTrap(dialogRef)
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key !== 'Escape' || event.isComposing) return // 한글 조합 중의 Esc 는 조합 취소다 — 쓰던 폼을 날리지 않는다
      event.preventDefault() // 입력창의 Esc 두 번(답변 중지)은 이미 쓰인 Esc 를 세지 않는다 (stopTurn.tsx)
      onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  return createPortal(
    <div className="settings-overlay" role="presentation">
      <div className="settings-mask" aria-hidden="true" onClick={onClose} />
      <div className="plus-dialog" ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className="plus-dialog__head">
          <span className="plus-dialog__badge" style={{ background: badgeColor(project.path) }} aria-hidden="true">
            {badgeLetters(project.name)}
          </span>
          <div className="plus-dialog__titles">
            <span className="plus-dialog__title" id={titleId}>
              {title}
            </span>
            <span className="plus-dialog__subtitle">{subtitle}</span>
          </div>
          <button type="button" className="settings-close plus-dialog__close" aria-label={t('settings.close')} onClick={onClose}>
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" aria-hidden="true">
              <path d="M3 3L11 11M11 3L3 11" />
            </svg>
          </button>
        </div>
        <div className="plus-dialog__body">{children}</div>
      </div>
    </div>,
    document.body,
  )
}
