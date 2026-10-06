import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { HookCandidate, HookEvent } from '../shared/ipc.ts'
import { useFocusTrap } from './focusTrap.ts'
import { candidateFiles, toggled, usesMatcher } from './hooksView.ts'
import { reason } from './ipcError.ts'
import { useT } from './settingsStore.ts'
import './hooks.css'

// 프로젝트 훅 가져오기 확인 창 (이슈 #102 3단계, 시안 _workspace/mock-hooks/Import.dc.html). 프로젝트 폴더의 `.claude/settings.json`·
// `.claude/settings.local.json` 에서 찾은 훅을 **자동으로 실행하지 않고** 여기서 명령 전문을 보여 준다 — 사용자가 고른 것만 이 PC("이 프로젝트만")에
// 복사한다 (사용자 결정). 후보마다 체크박스 · 이벤트 배지 · 매처 · 기한 · 명령 전문, 바깥으로 내용을 보낼 법한 명령에는 경고 줄.
// **처음엔 아무것도 골라져 있지 않다** (시안은 둘이 체크돼 있지만 안전한 기본값으로 — 사용자가 직접 고른다).
// 훅 팝업 대신 뜬다 (판 하나만 떠 있다) — 닫으면 훅 팝업으로 돌아간다. 가림막·Esc·포커스 가두기는 다른 판과 같다.

/** 이벤트 배지 — 색은 이벤트마다 (hooks.css) */
export function HookBadge({ event }: { event: HookEvent }) {
  const t = useT()
  return (
    <span className="hook-badge" data-event={event}>
      {t(`hooks.event.${event}`)}
    </span>
  )
}

export function HooksImport({ directory, candidates, onClose }: { directory: string; candidates: readonly HookCandidate[]; onClose(imported: boolean): void }) {
  const t = useT()
  const titleId = useId()
  const panelRef = useRef<HTMLDivElement>(null)
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  useFocusTrap(panelRef)
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key !== 'Escape' || event.isComposing) return
      event.preventDefault() // 입력창의 Esc 두 번(답변 중지)은 이미 쓰인 Esc 를 세지 않는다
      event.stopPropagation() // 아래에 깔린 훅 팝업(PlusDialog)까지 같이 닫히지 않게 — 그래서 잡는 단계에서 먼저 받는다
      onClose(false)
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => document.removeEventListener('keydown', onKeyDown, true)
  }, [onClose])

  async function confirm(): Promise<void> {
    setBusy(true)
    setError(undefined)
    try {
      await window.litecode.importHooks([...selected], directory)
      onClose(true)
    } catch (failure) {
      setError(reason(failure))
      setBusy(false)
    }
  }

  return createPortal(
    <div className="settings-overlay" role="presentation">
      <div className="settings-mask" aria-hidden="true" onClick={() => onClose(false)} />
      <div className="hooks-import" ref={panelRef} role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className="hooks-import__head">
          <div className="hooks-import__title" id={titleId}>
            {t('hooks.import.title')}
          </div>
          <div className="hooks-import__intro">{t('hooks.import.intro', { files: candidateFiles(candidates) })}</div>
        </div>
        <div className="hooks-import__list">
          {candidates.length === 0 && <p className="plus-group__note">{t('hooks.import.none')}</p>}
          {candidates.map((candidate) => (
            <label key={candidate.key} className="hook-candidate" data-hook-key={candidate.key} data-selected={selected.has(candidate.key)} data-outbound={candidate.outbound || undefined}>
              <input type="checkbox" checked={selected.has(candidate.key)} disabled={busy} onChange={() => setSelected((now) => toggled(now, candidate.key))} />
              <div className="hook-candidate__body">
                <div className="hook-candidate__line">
                  <HookBadge event={candidate.event} />
                  <span className="hook-candidate__meta">
                    {usesMatcher(candidate.event)
                      ? t('hooks.import.meta', { matcher: candidate.matcher || t('hooks.import.noMatcher'), seconds: candidate.seconds })
                      : t('hooks.popup.seconds', { seconds: candidate.seconds })}
                    {' · '}
                    {candidate.file}
                  </span>
                </div>
                <pre className="hook-candidate__command">{candidate.command}</pre>
                {candidate.outbound && <div className="hook-candidate__warn">{t('hooks.import.outbound')}</div>}
              </div>
            </label>
          ))}
        </div>
        {error && (
          <p className="settings-error" role="alert">
            {error}
          </p>
        )}
        <div className="hooks-import__foot">
          <div className="hooks-import__note">{t('hooks.import.note')}</div>
          <div className="hooks-import__actions">
            <button type="button" className="settings-button" disabled={busy} onClick={() => onClose(false)}>
              {t('hooks.import.skip')}
            </button>
            <button type="button" className="settings-button settings-button--primary" data-hooks="import-confirm" disabled={busy || selected.size === 0} onClick={() => void confirm()}>
              {t('hooks.import.confirm', { count: selected.size })}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  )
}
