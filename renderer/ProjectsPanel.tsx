import { useEffect, useState } from 'react'
import { DEFAULT_MODE } from '../shared/modes.ts'
import { reason } from './ipcError.ts'
import { useT } from './settingsStore.ts'
import type { ProjectTarget } from './delegationView.ts'
import './delegation.css'

// Projects 탭 (이슈 #341) — 다른 프로젝트의 마지막에 보던 대화에 지시를 **직접**(AI 없이) 보내기. 오른쪽 패널의 고정 탭(파일·Git·터미널·작업 탭과
// 같은 줄). 목록(targets)은 App 이 승인 카드·진행 줄과 같은 규칙(renderer/delegationView.ts)으로 계산해 준다 — 패널은
// DelegationContext 바깥이라 컨텍스트가 아니다. #351: targets 에 지금 프로젝트도 들어오니 이 탭은 **자기 프로젝트는 뺀다** — 지시를 직접
// 보내는 대상은 "다른 프로젝트" (자기 대화로 보내는 것은 그냥 여기에서 쓰는 것과 같으니까). 보내기는 IPC 로(ctx.delegation — 세션 도구의
// send_to_project 와 같은 자격: 대상·모델·대기열). 받은 대화가 지시라는 표시는 기존 딱지(OriginTag)가 그대로 한다.

export function ProjectsPanel({ directory, fromId, fromTitle, targets }: { directory: string; fromId?: string; fromTitle?: string; targets: readonly ProjectTarget[] }) {
  const t = useT()
  const [selected, setSelected] = useState<string>()
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [done, setDone] = useState<string>()

  const others = targets.filter((entry) => entry.path !== directory)
  const target = others.find((entry) => entry.id === selected && !entry.peer.unusable)

  useEffect(() => {
    if (target) return
    setSelected((now) => (now && others.some((entry) => entry.id === now) ? now : others[0]?.id))
  }, [others, target])

  function send(): void {
    if (!target || !message.trim() || busy) return
    setBusy(true)
    setError(undefined)
    setDone(undefined)
    window.litecode
      .sendDelegation({ directory, fromId: fromId ?? '', fromTitle, targetId: target.id, message: message.trim() })
      .then((sent) => {
        setMessage('')
        setDone(sent.state === 'sent' ? t('projects.sent', { project: sent.projectName }) : t('projects.queued', { project: sent.projectName, ahead: sent.ahead ?? 1 }))
      })
      .catch((failure: unknown) => setError(reason(failure)))
      .finally(() => setBusy(false))
  }

  return (
    <div className="file-view projects-panel">
      <div className="file-preview__bar">
        <span className="file-preview__path">
          <strong className="file-preview__path-name">{t('projects.tab')}</strong>
        </span>
      </div>
      <div className="file-preview__body projects-panel__body">
        {others.length === 0 ? (
          <p className="file-preview__empty projects-panel__empty">{t('projects.empty')}</p>
        ) : (
          <>
            <ul className="projects-panel__list" role="listbox" aria-label={t('projects.tab')}>
              {others.map((entry) => (
                <li key={entry.id}>
                  <button
                    type="button"
                    role="option"
                    className="projects-panel__row"
                    data-selected={target?.id === entry.id}
                    data-unusable={entry.peer.unusable || undefined}
                    aria-selected={target?.id === entry.id}
                    disabled={!!entry.peer.unusable}
                    onClick={() => setSelected(entry.id)}
                  >
                    <span className="projects-panel__name">
                      {entry.name}
                      {entry.peer.unusable && <em className="projects-panel__unusable"> · {t('projects.unusable')}</em>}
                    </span>
                    <span className="projects-panel__path">{entry.displayPath}</span>
                    <span className="projects-panel__conv">{entry.peer.title}</span>
                    <span className="projects-panel__meta">
                      {t(`mode.${entry.peer.mode ?? DEFAULT_MODE}`)} · {entry.peer.running ? t('delegate.card.targetBusy') : t('delegate.pick.idle')}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            {target && (
              <div className="projects-panel__composer">
                <label className="projects-panel__label" htmlFor="projects-panel-message">
                  {t('projects.to', { name: target.name, title: target.peer.title })}
                </label>
                <textarea
                  id="projects-panel-message"
                  className="projects-panel__input"
                  rows={4}
                  value={message}
                  placeholder={t('projects.placeholder')}
                  onChange={(event) => setMessage(event.target.value)}
                />
                {done && (
                  <p className="projects-panel__done" role="status">
                    {done}
                  </p>
                )}
                {error && (
                  <p className="projects-panel__error" role="alert">
                    {error}
                  </p>
                )}
                <button type="button" className="projects-panel__send" disabled={busy || !message.trim()} onClick={send}>
                  {t('projects.send')}
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
