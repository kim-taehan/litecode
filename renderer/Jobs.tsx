import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import type { Subtask, TurnItem } from '../shared/ipc.ts'
import { useNow } from './useNow.ts'
import { compactTokens, elapsed, jobList, lastLine, peekLine, quietMinutes, recentLines } from './jobsView.ts'
import { openTaskTab } from './filePreviewStore.ts'
import { useT } from './settingsStore.ts'
import { useTaskMap } from './tasksStore.ts'
import './jobs.css'

// 작업 목록 — 대화 머리의 "작업 N" 트리거 + 그 아래 드롭다운 (이슈 #610, dsh ui-jobs 모양).
// #295(입력 카드 위 줄)로 옮겼던 것을 다시 머리 줄로 옮긴다 — "dsh 의 형태" 요청(2026-10-23).
// 줄 모양은 그대로 "● 종류 · 제목 · 시간·토큰", 올리면(포커스) ■ 중지 · ⌄.
// 역할은 dsh ui-jobs(도는 것·끝난 것 묶음, 오르는 시간, 줄마다 중지)·ui-subagent 참조 — 코드는 새로 썼다.
// 데이터는 도는 턴의 진행 줄(chat:progress)뿐이다: 메인 한 줄 + 하위 작업(#31 Subtask) 줄. 하위 작업이 없는 턴은 줄이 없다.
// 중지는 그 하위 작업만 멈춘다(ctx.llm.stopSubtask) — 턴은 남은 결과로 이어 간다. 눌림은 두 번: 첫 클릭은 붉게 "중지" 준비, 두 번째가 실제.
// 백그라운드 하위 작업(#319, litecode_task_start)은 메인 턴이 끝난 뒤에도 돈다 — 메인이 쥔 대화별 목록(chat:tasks)을 같은 메뉴에 더한다.
// 그 작업이 도는 동안 메인은 기다리지 않으므로 "메인" 줄은 메인 턴이 내장 하위 작업을 기다릴 때만 보인다.
// 백그라운드 작업 줄은 Claude Code 에이전트 뷰처럼 (#325): 줄을 누르면 훑어보기(마지막 활동 한 줄),
// 줄 끝 › 는 오른쪽 패널의 "작업 N" 탭(TaskTab.tsx — 전체 기록). 턴의 하위 작업 줄은 예전 펼침 그대로(턴이 끝나면 사라져 탭이 없다)

/** 그 대화의 백그라운드 하위 작업 (이슈 #319) — 처음 한 번 받고 그 뒤는 알림으로. 대화를 바꾸면 그 대화 것으로 */
export function useBackgroundTasks(conversationId: string | undefined): Subtask[] {
  const all = useTaskMap() // 작업 탭(#325)과 같은 저장소
  return (conversationId && all[conversationId]) || NO_TASKS
}
const NO_TASKS: Subtask[] = []

/** 바깥을 누르거나 Esc 면 닫는다. Esc 는 여기서 쓴 것으로 표시한다 — 답변 중지의 "Esc 두 번" 에 세지 않게 (stopTurn.tsx).
 *  keydown 은 캡처(문서)로 먼저 받는다 — 열면 포커스를 빼가는 오른쪽 패널(FilePreview)의 Esc(패널 닫기)가
 *  버블 단계에서 defaultPrevented 로 표기하면 이 메뉴는 영원히 닫히지 않는다. 메뉴가 위에 뜨는 층이므로 Esc 는 메뉴가 먼저 쓴다 */
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
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('mousedown', onMouseDown)
      document.removeEventListener('keydown', onKeyDown, true)
    }
  }, [open, root, setOpen, focusSelector])
}

interface JobsHeaderProps {
  /** 도는 턴의 진행 줄 (턴이 안 돌면 undefined) */
  items: readonly TurnItem[] | undefined
  /** 그 대화의 턴이 도는 중 */
  pending: boolean
  /** 턴을 보낸 시각 — 메인 줄의 경과 시간 */
  startedAt?: number
  /** 그 대화의 백그라운드 하위 작업 (#319) — 턴과 상관없이 돈다 */
  background?: readonly Subtask[]
  /** 그 대화의 프로젝트 — 백그라운드 작업 줄의 › 가 이 프로젝트의 오른쪽 패널에 작업 탭을 연다 (#325) */
  directory?: string
}

/** 대화 머리의 "작업 N" 트리거 — 도는 것(턴 하위 작업 + 백그라운드 작업)이 있으면 "작업 N"(스피너),
 *  다 끝났으면 "끝난 작업 N"(체크). 턴이 끝난 뒤에도 그 턴의 끝난 작업을 새 턴을 보낼 때까지 보인다 —
 *  진행 줄은 턴이 끝나면 비므로 돌던 동안의 진행 줄을 잡아 둔다(새 턴이 시작되면 빈 진행 줄로 바뀐다).
 *  누르면 트리거 아래 메뉴: "진행 중" 섹션(메인 줄 + 도는 것)과 접을 수 있는 "끝난 작업 N" 섹션.
 *  대화를 바꾸면 key 로 새로 그려 잊는다 */
export function JobsHeader({ items, pending, startedAt, background = [], directory }: JobsHeaderProps) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const [kept, setKept] = useState<readonly TurnItem[]>()
  const [settledOpen, setSettledOpen] = useState<boolean>()
  const [expanded, setExpanded] = useState<string>()
  const [cleared, setCleared] = useState<ReadonlySet<string>>(NO_IDS)
  const [shift, setShift] = useState(false)
  /** 중지 눌림 상태 — 같은 줄의 armed 이 3s 만 넘으면 풀리고, pending·failed 는 4s 뒤 스스로 정리된다 */
  const [kill, setKill] = useState<{ id: string; state: 'armed' | 'pending' | 'failed' }>()
  const root = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLUListElement>(null)
  useEffect(() => {
    if (pending) setKept(items)
  }, [pending, items])
  const turn = jobList((pending ? items : kept) ?? [], !pending)
  const tasks = jobList(background)
  const running = [...turn.running, ...tasks.running]
  const finished = [...turn.finished, ...tasks.finished]
  /** 메인 턴이 내장 하위 작업을 기다리는 중 — 백그라운드 작업만 돌면 메인은 쉬거나 제 일을 한다 */
  const waiting = turn.running.length > 0
  const liveCount = (waiting ? 1 : 0) + running.length
  const visibleSettled = finished.filter((item) => !cleared.has(item.id))
  const visibleCount = liveCount + visibleSettled.length
  const now = useNow(open && liveCount > 0)
  useDismiss(open, root, setOpen, '.jobs-trigger')
  // 줄이 다 사라지면(새 턴) 닫힌다
  useEffect(() => {
    if (visibleCount === 0) setOpen(false)
  }, [visibleCount])
  // 펼쳤던 줄이 도는 것·보이는 끝난 것에서 벗어났으면 접는다
  useEffect(() => {
    if (expanded && !running.some((item) => item.id === expanded) && !visibleSettled.some((item) => item.id === expanded)) setExpanded(undefined)
  }, [expanded, running, visibleSettled])
  // armed 은 3s, pending·failed 는 4s 뒤 스스로 풀린다
  useEffect(() => {
    if (!kill) return
    const timer = setTimeout(() => setKill(undefined), kill.state === 'armed' ? 3_000 : 4_000)
    return () => clearTimeout(timer)
  }, [kill])
  // pending·failed 는 그 줄이 더 이상 못 멈추게 되면 정리
  useEffect(() => {
    if (!kill || kill.state === 'armed') return
    const item = running.find((row) => row.id === kill.id)
    if (!item || (item.status !== 'running' && item.status !== 'queued')) setKill(undefined)
  }, [kill, running])
  // 열어서 메뉴가 창 오른쪽을 넘으면 트리거 오른쪽 정렬로
  useLayoutEffect(() => {
    if (!open) {
      setShift(false)
      return
    }
    setShift((menuRef.current?.getBoundingClientRect().right ?? 0) > window.innerWidth - 8)
  }, [open, now, visibleCount])

  if (visibleCount === 0) return null

  const label = liveCount > 0 ? t('jobs.triggerLive', { count: liveCount }) : t('jobs.finished', { count: visibleSettled.length })
  /** 끝난 작업 섹션 — 도는 것이 없으면 펼친 채로 (메뉴 자체가 그 목록이다), 있으면 접힌 채로 */
  const settledExpanded = settledOpen ?? (liveCount === 0)
  const stop = (id: string) => {
    void window.litecode.stopSubtask(id).then(
      (stopped) => {
        if (!stopped) setKill((was) => (was && was.id === id && was.state === 'pending' ? { ...was, state: 'failed' } : was))
      },
      () => setKill((was) => (was && was.id === id && was.state === 'pending' ? { ...was, state: 'failed' } : was)),
    )
  }
  const clickKill = (id: string) => {
    if (kill && kill.id === id && kill.state === 'armed') {
      setKill({ id, state: 'pending' })
      stop(id)
    } else setKill({ id, state: 'armed' })
  }
  const clearFinished = () => {
    setCleared(new Set(finished.map((item) => item.id)))
    setExpanded(undefined)
  }
  const onOpen = directory === undefined ? undefined : (item: Subtask) => (background.includes(item) ? () => openTaskTab(directory, item.id) : undefined)
  const toggleRow = (id: string) => setExpanded((was) => (was === id ? undefined : id))
  return (
    <div className="jobs-header" ref={root}>
      <button type="button" className="jobs-trigger" aria-expanded={open} aria-label={label} onClick={() => setOpen((was) => !was)}>
        {liveCount > 0 ? <Spinner /> : <DoneIcon />}
        <span className="jobs-trigger__label">{label}</span>
        <svg className="jobs-trigger__chevron" width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M4 10L8 6L12 10" />
        </svg>
      </button>
      {open && (
        <ul className={shift ? 'jobs-menu jobs-menu--shift' : 'jobs-menu'} ref={menuRef} aria-label={t('jobs.title')}>
          {liveCount > 0 && <li className="jobs-menu__section">{t('jobs.running')}</li>}
          {waiting && (
            <li className="jobs__row" data-job="main">
              <div className="jobs__line">
                <div className="jobs__cells">
                  <span className="jobs__dot" aria-hidden="true" />
                  <span className="jobs__kind">{t('jobs.main')}</span>
                  <span className="jobs__title">{t('jobs.waiting')}</span>
                  <span className="jobs__meta">{startedAt === undefined ? '…' : elapsed(now - startedAt)}</span>
                </div>
                <span className="jobs__actions" />
              </div>
            </li>
          )}
          {running.map((item) => (
            <JobRow
              key={item.id}
              item={item}
              now={now}
              open={expanded === item.id}
              onToggle={() => toggleRow(item.id)}
              onOpen={onOpen?.(item)}
              killState={kill && kill.id === item.id ? kill.state : undefined}
              onStop={clickKill}
            />
          ))}
          {visibleSettled.length > 0 && (
            <>
              <li className="jobs-menu__section">
                <button
                  type="button"
                  className="jobs-menu__fold"
                  aria-expanded={settledExpanded}
                  aria-label={settledExpanded ? t('jobs.hideFinished') : t('jobs.showFinished')}
                  onClick={() => setSettledOpen(!settledExpanded)}
                >
                  {t('jobs.finished', { count: visibleSettled.length })}
                  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M4 6L8 10L12 6" />
                  </svg>
                </button>
                <button type="button" className="jobs-menu__clear" onClick={clearFinished}>
                  {t('jobs.clear')}
                </button>
              </li>
              {settledExpanded &&
                visibleSettled.map((item) => (
                  <JobRow key={item.id} item={item} now={now} open={expanded === item.id} onToggle={() => toggleRow(item.id)} onOpen={onOpen?.(item)} />
                ))}
            </>
          )}
        </ul>
      )}
    </div>
  )
}
const NO_IDS: ReadonlySet<string> = new Set()

/** 하위 작업 한 줄 — ● 종류 · 제목 · 시간·토큰, 올리면(포커스) 중지·⌄. 누르면 아래에 전체 제목 · ▸ 지금 하는 일 · 최근 생각·도구 줄.
 *  onOpen 이 있으면(백그라운드 작업, #325) 누르면 훑어보기 한 줄(peekLine)만, ⌄ 대신 › 가 작업 탭을 연다.
 *  onStop 이 있으면(도는 것) ■ 는 두 번: 첫 클릭 armed(붉게 "중지"), 두 번째에 실제 중지 */
function JobRow({
  item,
  now,
  open,
  onToggle,
  onOpen,
  killState,
  onStop,
}: {
  item: Subtask
  now: number
  open: boolean
  onToggle(): void
  onOpen?: () => void
  killState?: 'armed' | 'pending' | 'failed'
  onStop?: (id: string) => void
}) {
  const t = useT()
  const live = item.status === 'running' || item.status === 'preparing'
  /** 도는 줄(스피너가 아닌 점) — 카드 바탕 */
  const card = live || item.status === 'queued'
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
    <li
      className={card ? 'jobs__row jobs__row--live' : 'jobs__row'}
      data-job="subtask"
      data-status={item.status}
      data-quiet={quiet !== undefined || undefined}
      data-open={open || undefined}
    >
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
          {(item.status === 'running' || item.status === 'queued') && onStop && (
            <button
              type="button"
              className={killState ? `jobs__stop jobs__stop--${killState}` : 'jobs__stop'}
              data-kill-state={killState ?? 'idle'}
              aria-label={t('jobs.stop')}
              title={t('jobs.stop')}
              disabled={killState === 'pending'}
              onClick={() => onStop(item.id)}
            >
              <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                <rect x="3" y="3" width="10" height="10" rx="2" />
              </svg>
              {killState === 'armed' ? t('jobs.stopShort') : killState === 'pending' ? t('jobs.stopping') : killState === 'failed' ? t('jobs.stopFailed') : ''}
            </button>
          )}
          {onOpen ? (
            <button type="button" className="jobs__open" aria-label={t('jobs.openTab')} title={t('jobs.openTab')} onClick={onOpen}>
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M6 4L10 8L6 12" />
              </svg>
            </button>
          ) : (
            /* 펼침 단서 — 누르기는 줄(왼쪽 버튼)이 맡는다. 화살표를 눌러도 같은 일 */
            <svg className="jobs__chevron" onClick={onToggle} width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M4 6L8 10L12 6" />
            </svg>
          )}
        </span>
      </div>
      {open && onOpen && <JobPeek item={item} />}
      {open && !onOpen && (
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
    </li>
  )
}

/** 훑어보기 (#325) — 마지막 활동 한 줄(실패면 사유). 전체 기록은 › 의 작업 탭 */
function JobPeek({ item }: { item: Subtask }) {
  const t = useT()
  const line = peekLine(item)
  return (
    <div className="jobs__detail jobs__peek">
      {line ? (
        <div className={line.mono ? 'jobs__mono' : undefined} data-state={line.state}>
          ▸ {line.text}
        </div>
      ) : (
        <div className="jobs__empty">{t('chat.subtaskEmpty')}</div>
      )}
    </div>
  )
}

/** 다 끝난 표시 — 트리거 앞 체크 */
function DoneIcon() {
  return (
    <svg className="jobs-trigger__done" width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3.5 8.5l3 3 6-7" />
    </svg>
  )
}

/** 도는 표시 — 12px 고리 */
function Spinner() {
  return (
    <svg className="jobs__spinner" width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <circle cx="6" cy="6" r="4.5" stroke="currentColor" strokeOpacity="0.25" strokeWidth="1.5" />
      <path d="M6 1.5a4.5 4.5 0 0 1 4.5 4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}
