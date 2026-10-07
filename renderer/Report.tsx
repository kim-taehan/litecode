import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { useT } from './settingsStore.ts'
import { reason } from './ipcError.ts'
import { useFocusTrap } from './focusTrap.ts'
import './plus.css'
import './report.css'

// 대화 내보내기 · 문제 신고 묶음 (이슈 #177, 시안 _workspace/mock-report/{Main,Report}.dc.html). 파일 쓰기·대화상자는 메인(ctx.report)이 하고,
// 화면은 대화 id 와 "만들어 달라" 만 보낸다. 메뉴 동작(바깥 클릭·Esc 로 닫기, 열면 첫 항목에 포커스)과 잠깐 뜨는 결과 줄은
// 대화 머리의 "다른 앱에서 열기"(OpenInButton) 와 같게 — dsh session-log-export(세션 머리 더 보기 메뉴) 참조

/** ⋯ */
function MoreIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <circle cx="3.5" cy="8" r="1.3" />
      <circle cx="8" cy="8" r="1.3" />
      <circle cx="12.5" cy="8" r="1.3" />
    </svg>
  )
}

/** 아래 화살표 + 받침 — 내보내기 */
function ExportIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M8 2v8" />
      <path d="M5 7l3 3 3-3" />
      <path d="M3 12.5h10" />
    </svg>
  )
}

/** 느낌표 삼각형 — 문제 신고 */
function ReportIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M8 2L14.5 13.5h-13z" />
      <path d="M8 6.5v3.2" />
      <path d="M8 11.6v.1" />
    </svg>
  )
}

/** 대화 머리 오른쪽 끝 "더 보기" — 항목은 "대화 내보내기"와 "문제 신고 묶음"(별도 팝업 — 사용자 결정 2026-10-07, 설정이 아니다). 대화 복사는 아직 없는 기능이라 만들지 않았다 */
export function ConversationMenu({ conversationId }: { conversationId: string }) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [reporting, setReporting] = useState(false)
  const [notice, setNotice] = useState<{ ok: boolean; text: string }>()
  const root = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    root.current?.querySelector<HTMLButtonElement>('.chat-more__item')?.focus()
    const onMouseDown = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onMouseDown)
    return () => document.removeEventListener('mousedown', onMouseDown)
  }, [open])

  useEffect(() => {
    if (!notice) return
    const timer = setTimeout(() => setNotice(undefined), 4000)
    return () => clearTimeout(timer)
  }, [notice])

  async function exportChat(): Promise<void> {
    setOpen(false)
    setBusy(true)
    setNotice(undefined)
    try {
      const result = await window.litecode.exportConversation(conversationId)
      if ('saved' in result) setNotice({ ok: true, text: t('report.exported', { path: result.saved }) })
    } catch (failure) {
      setNotice({ ok: false, text: reason(failure) })
    } finally {
      setBusy(false)
    }
  }

  function onMenuKey(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key !== 'Escape') return
    event.preventDefault() // 메뉴만 닫는다 — 파일 미리보기 패널이 이 Esc 로 같이 닫히지 않게
    setOpen(false)
    root.current?.querySelector<HTMLButtonElement>('.chat-more')?.focus()
  }

  return (
    <div className="chat-more-wrap" ref={root}>
      <button
        type="button"
        className="chat-more"
        aria-label={t('report.more')}
        title={t('report.more')}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={busy}
        onClick={() => setOpen((now) => !now)}
      >
        <MoreIcon />
      </button>
      {open && (
        <div className="chat-more__menu" role="menu" aria-label={t('report.more')} onKeyDown={onMenuKey}>
          <button type="button" role="menuitem" className="chat-more__item" onClick={() => void exportChat()}>
            <ExportIcon />
            <span>{t('report.exportChat')}</span>
          </button>
          <button
            type="button"
            role="menuitem"
            className="chat-more__item"
            onClick={() => {
              setOpen(false)
              setReporting(true)
            }}
          >
            <ReportIcon />
            <span>{t('report.bundle.menu')}</span>
          </button>
        </div>
      )}
      {reporting && <ReportDialog onClose={() => setReporting(false)} />}
      {notice && (
        <p className={`chat-more__notice${notice.ok ? '' : ' chat-more__notice--error'}`} role={notice.ok ? 'status' : 'alert'}>
          {notice.text}
        </p>
      )}
    </div>
  )
}

/** 문제 신고 묶음 팝업 — 가림막·닫기 버튼·Esc 는 `+` 메뉴 팝업(PlusDialog)과 같다. 프로젝트 배지는 없다(앱 전체의 일) */
function ReportDialog({ onClose }: { onClose(): void }) {
  const t = useT()
  const titleId = useId()
  const dialogRef = useRef<HTMLDivElement>(null)
  useFocusTrap(dialogRef)
  useEffect(() => {
    function onKeyDown(event: globalThis.KeyboardEvent): void {
      if (event.key !== 'Escape' || event.isComposing) return
      event.preventDefault()
      onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  return createPortal(
    <div className="settings-overlay" role="presentation">
      <div className="settings-mask" aria-hidden="true" onClick={onClose} />
      <div className="plus-dialog report-dialog" ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className="plus-dialog__head">
          <div className="plus-dialog__titles">
            <span className="plus-dialog__title" id={titleId}>
              {t('report.bundle')}
            </span>
          </div>
          <button type="button" className="settings-close plus-dialog__close" aria-label={t('settings.close')} onClick={onClose}>
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" aria-hidden="true">
              <path d="M3 3L11 11M11 3L3 11" />
            </svg>
          </button>
        </div>
        <div className="plus-dialog__body">
          <ReportBundle />
        </div>
      </div>
    </div>,
    document.body,
  )
}

/** 문제 신고 묶음 카드 — 들어가는 것/들어가지 않는 것 두 칸, 저장 뒤 초록 안내 + [폴더 열기] */
export function ReportBundle() {
  const t = useT()
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState<string>()
  const [error, setError] = useState<string>()

  async function create(): Promise<void> {
    setBusy(true)
    setError(undefined)
    try {
      const result = await window.litecode.createReport()
      if ('saved' in result) setSaved(result.saved)
    } catch (failure) {
      setError(reason(failure))
    } finally {
      setBusy(false)
    }
  }

  function openFolder(dir: string): void {
    setError(undefined)
    window.litecode.openReport(dir).catch((failure: unknown) => setError(reason(failure)))
  }

  return (
    <div className="report-bundle">
      <div className="report-card">
        <div className="report-card__head">
          <div className="settings-row__text">
            <div className="settings-row__title">{t('report.bundle')}</div>
            <div className="settings-row__description">{t('report.bundle.description')}</div>
          </div>
          <button type="button" className="settings-button settings-button--primary" disabled={busy} onClick={() => void create()}>
            {t('report.bundle.create')}
          </button>
        </div>
        <div className="report-card__divider" />
        <div className="report-card__lists">
          <div className="report-card__list report-card__list--in">
            <span className="report-card__list-title">{t('report.bundle.included')}</span>
            <ul>
              {t('report.bundle.includedList').split('\n').map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </div>
          <div className="report-card__list report-card__list--out">
            <span className="report-card__list-title">{t('report.bundle.excluded')}</span>
            <ul>
              {t('report.bundle.excludedList').split('\n').map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </div>
        </div>
      </div>
      {error && (
        <p className="settings-error" role="alert">
          {error}
        </p>
      )}
      {saved && (
        <div className="report-saved" role="status">
          <span className="report-saved__title">{t('report.bundle.saved')}</span>
          <span className="report-saved__path">{saved}</span>
          <span>
            <button type="button" className="settings-button report-saved__open" onClick={() => openFolder(saved)}>
              {t('report.bundle.openFolder')}
            </button>
          </span>
        </div>
      )}
    </div>
  )
}
