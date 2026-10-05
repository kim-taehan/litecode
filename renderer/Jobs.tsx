import { useEffect, useRef, useState } from 'react'
import type { Subtask, TurnItem } from '../shared/ipc.ts'
import { useNow } from './useNow.ts'
import { compactTokens, elapsed, jobList, lastLine, recentLines } from './jobsView.ts'
import { useT } from './settingsStore.ts'
import './jobs.css'

// 도는 작업 목록 (이슈 #32) — 대화 머리의 "작업 N" 버튼과 그 아래 펼침 목록. 시안 B(_workspace/mock-32/Header.dc.html)가 구조의 정본이고,
// 역할은 dsh ui-jobs(머리 버튼 하나에 도는 것·끝난 것 묶음, 줄 앞에 오르는 시간, 줄마다 중지)·ui-subagent 참조 — 코드는 새로 썼다.
// 데이터는 도는 턴의 진행 줄(chat:progress)뿐이다: 메인 한 줄 + 하위 작업(#31 Subtask) 줄. 하위 작업이 없는 턴엔 버튼이 없다.
// ■ 는 그 하위 작업만 멈춘다(ctx.llm.stopSubtask) — 턴은 남은 결과로 이어 간다.

interface JobsButtonProps {
  /** 도는 턴의 진행 줄 */
  items: readonly TurnItem[]
  /** 턴을 보낸 시각 — 메인 줄의 경과 시간 */
  startedAt?: number
}

export function JobsButton({ items, startedAt }: JobsButtonProps) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const { running, finished } = jobList(items)

  // 바깥을 누르거나 Esc 면 닫는다. Esc 는 여기서 쓴 것으로 표시한다 — 답변 중지의 "Esc 두 번" 에 세지 않게 (stopTurn.tsx)
  useEffect(() => {
    if (!open) return
    const onMouseDown = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      event.preventDefault()
      setOpen(false)
      root.current?.querySelector<HTMLButtonElement>('.jobs__button')?.focus()
    }
    document.addEventListener('mousedown', onMouseDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onMouseDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  if (running.length + finished.length === 0) return null
  const count = 1 + running.length
  return (
    <div className="jobs" ref={root}>
      <button type="button" className="jobs__button" aria-label={t('jobs.buttonLabel', { count })} aria-expanded={open} onClick={() => setOpen((now) => !now)}>
        <Spinner />
        {t('jobs.button', { count })}
      </button>
      {open && <JobsPanel items={items} running={running} finished={finished} startedAt={startedAt} />}
    </div>
  )
}

function JobsPanel({ items, running, finished, startedAt }: { items: readonly TurnItem[]; running: Subtask[]; finished: Subtask[]; startedAt?: number }) {
  const t = useT()
  const now = useNow(true)
  const [expanded, setExpanded] = useState<string>()
  const [showFinished, setShowFinished] = useState(false)
  const toggle = (id: string) => setExpanded((was) => (was === id ? undefined : id))
  // 메인이 지금 하는 일 — 하위 작업이 돌면 그것을 기다리는 중, 아니면 메인의 마지막 생각·도구 줄
  const mainLine = running.length > 0 ? undefined : lastLine(items.filter((item) => item.kind !== 'subtask'))
  return (
    <section className="jobs__panel" aria-label={t('jobs.title')}>
      <div className="jobs__heading">{t('jobs.running', { count: 1 + running.length })}</div>
      <div className="jobs__row" data-job="main">
        <div className="jobs__cells">
          <span className="jobs__time">{startedAt === undefined ? '…' : elapsed(now - startedAt)}</span>
          <span className="jobs__kind jobs__kind--main">{t('jobs.main')}</span>
          <span className="jobs__doing">
            <span className="jobs__activity">
              {running.length > 0 ? t('jobs.waiting') : mainLine ? <span className={mainLine.mono ? 'jobs__mono' : undefined}>{mainLine.text}</span> : t('chat.working')}
            </span>
          </span>
        </div>
      </div>
      {running.map((item) => (
        <JobRow key={item.id} item={item} now={now} open={expanded === item.id} onToggle={() => toggle(item.id)} />
      ))}
      {finished.length > 0 && (
        <>
          <div className="jobs__finished-head">
            <span>{t('jobs.finished', { count: finished.length })}</span>
            <button
              type="button"
              className="jobs__fold"
              aria-label={showFinished ? t('jobs.hideFinished') : t('jobs.showFinished')}
              aria-expanded={showFinished}
              onClick={() => setShowFinished((was) => !was)}
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M4 6L8 10L12 6" />
              </svg>
            </button>
          </div>
          {showFinished && finished.map((item) => <JobRow key={item.id} item={item} now={now} open={expanded === item.id} onToggle={() => toggle(item.id)} />)}
        </>
      )}
    </section>
  )
}

/** 하위 작업 한 줄 — 경과 시간 · 종류 · 설명 + 지금 하는 일 · 토큰, 도는 것은 ■. 누르면 아래에 그 작업의 최근 생각·도구 줄 */
function JobRow({ item, now, open, onToggle }: { item: Subtask; now: number; open: boolean; onToggle(): void }) {
  const t = useT()
  const [stopping, setStopping] = useState(false)
  const live = item.status === 'running' || item.status === 'preparing'
  const time = item.startedAt === undefined ? '…' : elapsed((live ? now : (item.endedAt ?? item.startedAt)) - item.startedAt)
  const last = live ? lastLine(item.items) : undefined
  const state = item.status === 'done' ? t('chat.completed') : item.status === 'error' ? t('chat.subtaskFailed') : item.status === 'stopped' ? t('chat.subtaskStopped') : undefined
  const lines = recentLines(item.items)
  return (
    <>
      <div className="jobs__row" data-job="subtask" data-status={item.status} data-open={open || undefined}>
        <button type="button" className="jobs__cells" aria-expanded={open} onClick={onToggle}>
          <span className="jobs__time">{time}</span>
          <span className="jobs__kind" title={item.agent}>{item.agent || t('chat.subtask')}</span>
          <span className="jobs__doing">
            <span className="jobs__activity">
              {item.description}
              {item.description && (last || state || item.status === 'preparing') && ' · '}
              {last ? <span className={last.mono ? 'jobs__mono' : undefined}>{last.text}</span> : (state ?? (item.status === 'preparing' ? t('chat.toolPreparing') : ''))}
            </span>
            {item.tokens !== undefined && <span className="jobs__tokens">· ↓ {compactTokens(item.tokens)}</span>}
          </span>
        </button>
        {item.status === 'running' && (
          <button
            type="button"
            className="jobs__stop"
            aria-label={t('jobs.stop')}
            title={t('jobs.stop')}
            disabled={stopping}
            onClick={() => {
              setStopping(true)
              // 멈추면 그 줄이 "중단됨" 으로 끝난 것에 들어간다. 못 멈췄으면(이미 끝남 등) 버튼을 되살린다
              void window.litecode.stopSubtask(item.id).then((stopped) => stopped || setStopping(false), () => setStopping(false))
            }}
          >
            ■
          </button>
        )}
      </div>
      {open && (
        <div className="jobs__detail">
          {lines.map((line) => (
            <div key={line.id} className={line.mono ? 'jobs__mono' : undefined} data-state={line.state}>
              {line.mono ? `${line.text} ${line.state === 'done' ? '✓' : line.state === 'error' ? '✕' : '…'}` : `${t('chat.think')} · ${line.text}`}
            </div>
          ))}
          {lines.length === 0 && !item.error && <div className="jobs__empty">{t('chat.subtaskEmpty')}</div>}
          {item.error && <div data-state="error">{item.error}</div>}
        </div>
      )}
    </>
  )
}

/** 도는 표시 — 시안의 12px 고리 */
function Spinner() {
  return (
    <svg className="jobs__spinner" width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <circle cx="6" cy="6" r="4.5" stroke="currentColor" strokeOpacity="0.25" strokeWidth="1.5" />
      <path d="M6 1.5a4.5 4.5 0 0 1 4.5 4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}
