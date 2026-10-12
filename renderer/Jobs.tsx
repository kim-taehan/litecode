import { useEffect, useRef, useState, type RefObject } from 'react'
import type { Subtask, TurnItem } from '../shared/ipc.ts'
import { useNow } from './useNow.ts'
import { capRows, compactTokens, elapsed, jobList, lastLine, leadJob, quietMinutes, recentLines, VISIBLE_ROWS } from './jobsView.ts'
import { useT } from './settingsStore.ts'
import './jobs.css'

// 작업 목록 — 입력 카드 위 한 줄(JobsDock). 누르면 그 자리에서 목록이 펼쳐진다 (이슈 #295, 시안 _workspace/mock-jobs2 0번).
// 처음(#32)엔 대화 머리의 "작업 N" 버튼 + 팝오버였다 — 위아래 둘 다 뜨면 헷갈린다(사용자 2026-10-12)고 해서 머리 버튼을 걷고 이 줄 하나만 둔다.
// 줄 모양은 시안 G(_workspace/mock-jobs4) — 한 작업 = 한 줄 "● 종류 · 제목 · 시간·토큰", 올리면(포커스) 중지·⌄.
// 역할은 dsh ui-jobs(도는 것·끝난 것 묶음, 오르는 시간, 줄마다 중지)·ui-subagent 참조 — 코드는 새로 썼다.
// 데이터는 도는 턴의 진행 줄(chat:progress)뿐이다: 메인 한 줄 + 하위 작업(#31 Subtask) 줄. 하위 작업이 없는 턴엔 줄이 없다.
// 중지는 그 하위 작업만 멈춘다(ctx.llm.stopSubtask) — 턴은 남은 결과로 이어 간다.
// 백그라운드 하위 작업(#319, litecode_task_start)은 메인 턴이 끝난 뒤에도 돈다 — 메인이 쥔 대화별 목록(chat:tasks)을 같은 줄에 더한다.
// 그 작업이 도는 동안 메인은 기다리지 않으므로 "메인" 줄은 메인 턴이 내장 하위 작업을 기다릴 때만 보인다. 중지는 같은 버튼(그 작업만, 결과 턴으로 "중단됨")

/** 그 대화의 백그라운드 하위 작업 (이슈 #319) — 처음 한 번 받고 그 뒤는 알림으로. 대화를 바꾸면 그 대화 것으로 */
export function useBackgroundTasks(conversationId: string | undefined): Subtask[] {
  const [all, setAll] = useState<Record<string, Subtask[]>>({})
  useEffect(() => {
    let heard = false
    const off = window.litecode.onTasksChanged((cid, tasks) => {
      heard = true
      setAll((was) => ({ ...was, [cid]: tasks }))
    })
    void window.litecode.taskSnapshot().then(
      (snapshot) => !heard && setAll(snapshot),
      () => {},
    )
    return off
  }, [])
  return (conversationId && all[conversationId]) || NO_TASKS
}
const NO_TASKS: Subtask[] = []

/** 바깥을 누르거나 Esc 면 닫는다. Esc 는 여기서 쓴 것으로 표시한다 — 답변 중지의 "Esc 두 번" 에 세지 않게 (stopTurn.tsx) */
function useDismiss(open: boolean, root: RefObject<HTMLElement | null>, setOpen: (open: boolean) => void, focusSelector: string) {
  useEffect(() => {
    if (!open) return
    const onMouseDown = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      event.preventDefault()
      setOpen(false)
      root.current?.querySelector<HTMLButtonElement>(focusSelector)?.focus()
    }
    document.addEventListener('mousedown', onMouseDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onMouseDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open, root, setOpen, focusSelector])
}

interface JobsDockProps {
  /** 도는 턴의 진행 줄 (턴이 안 돌면 undefined) */
  items: readonly TurnItem[] | undefined
  /** 그 대화의 턴이 도는 중 */
  pending: boolean
  /** 턴을 보낸 시각 — 메인 줄의 경과 시간 */
  startedAt?: number
  /** 그 대화의 백그라운드 하위 작업 (#319) — 턴과 상관없이 돈다 */
  background?: readonly Subtask[]
}

/** 입력 카드 위 접힌 한 줄 — 도는 하위 작업이 있으면 "작업 N · 종류 · 제목 · 경과 ⌄"(대표 = 가장 먼저 시작한 것),
 *  다 끝났으면 "끝난 작업 N ⌄". 턴이 끝난 뒤에도 그 턴의 끝난 작업을 새 턴을 보낼 때까지 보인다 — 진행 줄은 턴이 끝나면 비므로
 *  돌던 동안의 진행 줄을 잡아 둔다(새 턴이 시작되면 빈 진행 줄로 바뀐다). 대화를 바꾸면 key 로 새로 그려 잊는다 */
export function JobsDock({ items, pending, startedAt, background = [] }: JobsDockProps) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const [kept, setKept] = useState<readonly TurnItem[]>()
  const root = useRef<HTMLElement>(null)
  useEffect(() => {
    if (pending) setKept(items)
  }, [pending, items])
  const turn = jobList((pending ? items : kept) ?? [], !pending)
  const tasks = jobList(background)
  const running = [...turn.running, ...tasks.running]
  const finished = [...turn.finished, ...tasks.finished]
  /** 메인 턴이 내장 하위 작업을 기다리는 중 — 백그라운드 작업만 돌면 메인은 쉬거나 제 일을 한다 */
  const waiting = turn.running.length > 0
  const lead = leadJob(running)
  /** 접힌 줄의 경과 — 턴의 하위 작업이면 턴 전체, 백그라운드 작업이면 그 작업의 시작부터 */
  const since = lead && turn.running.includes(lead) ? startedAt : lead?.startedAt
  const now = useNow(!!lead)
  useDismiss(open, root, setOpen, '.jobs-dock__head')
  // 줄이 사라지면(새 턴) 접어 둔다 — 다음 턴의 하위 작업이 펼친 채로 나타나지 않게
  const empty = running.length + finished.length === 0
  useEffect(() => {
    if (empty) setOpen(false)
  }, [empty])

  if (empty) return null
  const count = (waiting ? 1 : 0) + running.length
  return (
    <section className="jobs-dock" aria-label={t('jobs.title')} ref={root}>
      <button
        type="button"
        className="jobs-dock__head"
        aria-expanded={open}
        aria-label={lead ? t('jobs.buttonLabel', { count }) : undefined}
        onClick={() => setOpen((was) => !was)}
      >
        {lead ? <Spinner /> : <DoneIcon />}
        <span className="jobs-dock__title">{lead ? t('jobs.button', { count }) : t('jobs.finished', { count: finished.length })}</span>
        <span className="jobs-dock__lead" title={lead?.description || undefined}>
          {lead && [lead.agent || t('chat.subtask'), lead.description].filter(Boolean).join(' · ')}
        </span>
        {lead && since !== undefined && <span className="jobs-dock__time">{elapsed(now - since)}</span>}
        <svg className="jobs-dock__chevron" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M4 10L8 6L12 10" />
        </svg>
      </button>
      {open && (
        <div className="jobs-dock__body">
          <JobsList running={running} finished={finished} waiting={waiting} startedAt={startedAt} now={now} />
        </div>
      )}
    </section>
  )
}

/** 도는 하위 작업이 있으면 메인 한 줄(고정 — 메인 턴이 기다릴 때만) → 도는 것(3줄까지, 나머지는 "+N개 더 보기") → 끝난 작업(접힘).
 *  다 끝났으면 끝난 작업 줄만 (접지 않는다 — 접힌 줄이 이미 "끝난 작업 N" 이다).
 *  now 는 부모의 시계 — 접힌 줄의 경과와 메인 줄의 경과가 같은 초를 보이게 */
function JobsList({ running, finished, waiting, startedAt, now }: { running: Subtask[]; finished: Subtask[]; waiting: boolean; startedAt?: number; now: number }) {
  const t = useT()
  const [expanded, setExpanded] = useState<string>()
  const [showAll, setShowAll] = useState(false)
  const [showFinished, setShowFinished] = useState(false)
  const toggle = (id: string) => setExpanded((was) => (was === id ? undefined : id))
  const finishedRows = finished.map((item) => <JobRow key={item.id} item={item} now={now} open={expanded === item.id} onToggle={() => toggle(item.id)} />)
  if (running.length === 0) {
    return (
      <div className="jobs__list" role="list">
        {finishedRows}
      </div>
    )
  }
  const { shown, more } = capRows(running, showAll)
  return (
    <div className="jobs__list" role="list">
      {waiting && (
        <div className="jobs__row" data-job="main" role="listitem">
          <div className="jobs__line">
            <div className="jobs__cells">
              <span className="jobs__dot" aria-hidden="true" />
              <span className="jobs__kind">{t('jobs.main')}</span>
              <span className="jobs__title">{t('jobs.waiting')}</span>
              <span className="jobs__meta">{startedAt === undefined ? '…' : elapsed(now - startedAt)}</span>
            </div>
            <span className="jobs__actions" />
          </div>
        </div>
      )}
      {shown.map((item) => (
        <JobRow key={item.id} item={item} now={now} open={expanded === item.id} onToggle={() => toggle(item.id)} />
      ))}
      {more > 0 && (
        <button type="button" className="jobs__more" onClick={() => setShowAll(true)}>
          {t('jobs.more', { count: more })}
        </button>
      )}
      {showAll && running.length > VISIBLE_ROWS && (
        <button type="button" className="jobs__more" onClick={() => setShowAll(false)}>
          {t('jobs.less')}
        </button>
      )}
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
          {showFinished && finishedRows}
        </>
      )}
    </div>
  )
}

/** 하위 작업 한 줄 — ● 종류 · 제목 · 시간·토큰, 올리면(포커스) 중지·⌄. 누르면 아래에 전체 제목 · ▸ 지금 하는 일 · 최근 생각·도구 줄 */
function JobRow({ item, now, open, onToggle }: { item: Subtask; now: number; open: boolean; onToggle(): void }) {
  const t = useT()
  const [stopping, setStopping] = useState(false)
  const live = item.status === 'running' || item.status === 'preparing'
  const time = item.startedAt === undefined ? undefined : elapsed((live ? now : (item.endedAt ?? item.startedAt)) - item.startedAt)
  const last = live ? lastLine(item.items) : undefined
  /** 백그라운드 작업이 조용하다 — 죽이지 않고 표시만 (판단은 사람·메인) */
  const quiet = quietMinutes(item, now)
  const state =
    item.status === 'done'
      ? t('chat.completed')
      : item.status === 'error'
        ? t('chat.subtaskFailed')
        : item.status === 'stopped'
          ? t('chat.subtaskStopped')
          : item.status === 'preparing'
            ? t('chat.toolPreparing')
            : item.status === 'queued'
              ? t('jobs.queued') // 백그라운드 작업이 차례를 기다린다 (#321)
              : quiet !== undefined
                ? t('jobs.quiet', { minutes: quiet })
                : undefined
  const lines = recentLines(item.items)
  const meta = [time, item.tokens !== undefined ? compactTokens(item.tokens) : undefined].filter(Boolean).join(' · ')
  return (
    <div className="jobs__row" data-job="subtask" data-status={item.status} data-quiet={quiet !== undefined || undefined} data-open={open || undefined} role="listitem">
      <div className="jobs__line">
        <button type="button" className="jobs__cells" aria-expanded={open} title={item.description || undefined} onClick={onToggle}>
          <span className="jobs__dot" aria-hidden="true" />
          <span className="jobs__kind">{item.agent || t('chat.subtask')}</span>
          <span className="jobs__title">{item.description}</span>
          <span className="jobs__meta">
            {meta}
            {state && <span className="jobs__state">{meta ? ` · ${state}` : state}</span>}
          </span>
        </button>
        <span className="jobs__actions">
          {(item.status === 'running' || item.status === 'queued') && (
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
              <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                <rect x="3" y="3" width="10" height="10" rx="2" />
              </svg>
              {stopping ? t('jobs.stopping') : t('jobs.stopShort')}
            </button>
          )}
          {/* 펼침 단서 — 누르기는 줄(왼쪽 버튼)이 맡는다. 화살표를 눌러도 같은 일 */}
          <svg className="jobs__chevron" onClick={onToggle} width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M4 6L8 10L12 6" />
          </svg>
        </span>
      </div>
      {open && (
        <div className="jobs__detail">
          {item.description && <div className="jobs__full">{item.description}</div>}
          {last && (
            <div className={last.mono ? 'jobs__mono' : undefined} data-state="running">
              ▸ {last.text}
            </div>
          )}
          {item.error && <div data-state="error">▸ {item.error}</div>}
          {lines.map((line) => (
            <div key={line.id} className={line.mono ? 'jobs__mono' : undefined} data-state={line.state}>
              {line.mono ? `${line.text} ${line.state === 'done' ? '✓' : line.state === 'error' ? '✕' : '…'}` : `${t('chat.think')} · ${line.text}`}
            </div>
          ))}
          {lines.length === 0 && !item.error && <div className="jobs__empty">{t('chat.subtaskEmpty')}</div>}
        </div>
      )}
    </div>
  )
}

/** 다 끝난 표시 — 접힌 줄 앞 체크 */
function DoneIcon() {
  return (
    <svg className="jobs-dock__done" width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3.5 8.5l3 3 6-7" />
    </svg>
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
