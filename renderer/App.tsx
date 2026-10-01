import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import type { Project, ProviderSummary } from '../shared/ipc.ts'
import { ago } from './ago.ts'
import { badgeColor, badgeLetters } from './badge.ts'
import { Markdown } from './Markdown.tsx'
import { findModel, initialModel, parseModelRef, type ModelRef } from './modelChoice.ts'
import { ModelSelect } from './ModelSelect.tsx'
import { SettingsModal } from './Settings.tsx'
import { StatsBar } from './StatsBar.tsx'
import { addTurn, chatStats, type ChatUsage } from './stats.ts'

interface ChatMessage {
  role: 'user' | 'assistant'
  text: string
}

interface Session {
  id: string
  /** 이 대화가 속한 프로젝트(작업 디렉터리) — 사이드바는 현재 프로젝트의 대화만 보여준다 */
  project: string
  /** 엔진 쪽 세션 id — 첫 메시지를 보낼 때 생기고, 그 뒤로는 계속 재사용한다 */
  engineSessionId?: string
  /** 입력창 드롭다운에서 고른 이 대화의 모델. 없으면(아직 안 고르고 안 보낸 새 대화) 마지막으로 고른 모델을 따른다.
   *  대화 중에 바꾸면 다음 턴부터 그 모델로 간다 (엔진 세션의 모델은 ctx.llm 이 바꾼다) */
  model?: ModelRef
  title: string
  messages: ChatMessage[]
  /** 답을 기다리는 중 — 대화마다 따로. 기다리는 동안 다른 대화·프로젝트는 보낼 수 있다 (03_qa) */
  pending?: boolean
  /** 마지막 활동 시각(ms) — 목록에 `38min`·`1d` 로 보이고, 보관 개수 제한의 기준이 된다 */
  updatedAt: number
  /** 입력창 아래 통계 줄의 값 — 턴마다 엔진이 주는 사용량·시간을 이 대화에 더한다. 없으면 "—" */
  usage?: ChatUsage
}

function newSession(project: string): Session {
  return { id: crypto.randomUUID(), project, title: '새 대화', messages: [], updatedAt: Date.now() }
}

/** 그 프로젝트에 대화가 하나도 없으면 새 대화를 하나 더한다 — 같은 값을 두 번 넣어도 한 번만 더해진다 */
function withSessionFor(project: string) {
  return (current: Session[]) => (current.some((session) => session.project === project) ? current : [newSession(project), ...current])
}

function Badge({ project }: { project: Project }) {
  return (
    <span className="project-switch__badge" style={{ background: badgeColor(project.path) }}>
      {badgeLetters(project.name)}
    </span>
  )
}

const cannotOpen = (dir: string) => `폴더를 열 수 없습니다: ${dir}`

// 잘린 경로를 보여주는 방식은 dsh ui-workspace 의 세션 행을 따른다: 마우스를 올리면 잘린 글자가 일정한 속도로 흘러가
// 끝부분을 보이고(양 끝은 페이드), 떼면 한 번에 제자리로. 거의 안 잘린 것(8px 이하)은 흔들림으로 보여 움직이지 않는다.
const MARQUEE_MIN_PX = 8
const MARQUEE_PX_PER_MS = 0.03
const marqueeFrames = new WeakMap<HTMLElement, number>()

/** 행 안에서 흘러갈 글자 — `.marquee` 를 붙인 한 줄짜리 요소 */
function pathOf(row: HTMLElement): HTMLElement | null {
  return row.querySelector<HTMLElement>('.marquee')
}

function isClipped(row: HTMLElement): boolean {
  const path = pathOf(row)
  return !!path && path.scrollWidth - path.clientWidth > MARQUEE_MIN_PX
}

function placePath(path: HTMLElement, left: number, range: number): void {
  path.scrollLeft = left
  path.toggleAttribute('data-scrolled', left > 0)
  path.toggleAttribute('data-clipped', left < range)
}

function startMarquee(row: HTMLElement): void {
  const path = pathOf(row)
  if (!path || !isClipped(row)) return
  const range = path.scrollWidth - path.clientWidth
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return placePath(path, range, range)
  cancelAnimationFrame(marqueeFrames.get(path) ?? 0)
  let previous: number | undefined
  let position = 0
  const step = (now: number): void => {
    position += previous === undefined ? 0 : (now - previous) * MARQUEE_PX_PER_MS
    previous = now
    placePath(path, Math.min(position, range), range)
    if (position < range) marqueeFrames.set(path, requestAnimationFrame(step))
  }
  marqueeFrames.set(path, requestAnimationFrame(step))
}

function stopMarquee(row: HTMLElement): void {
  const path = pathOf(row)
  if (!path) return
  cancelAnimationFrame(marqueeFrames.get(path) ?? 0)
  path.scrollLeft = 0
  path.removeAttribute('data-scrolled')
  path.removeAttribute('data-clipped')
}

// 사이드바 폭·숨김 — dsh ui-layout 의 범위(264~420px)를 따른다. 기본값은 승인 시안의 272px.
// 창마다의 편의 설정이라 localStorage 에 둔다(못 읽으면 기본값 — 사생활 모드·접근 막힘에도 화면은 뜬다)
const SIDEBAR_MIN = 264
const SIDEBAR_MAX = 420
const SIDEBAR_DEFAULT = 272
const LAYOUT_KEY = 'litecode.sidebar'
/** 마지막으로 고른 모델 — 새 대화가 이것으로 시작한다(재시작해도). 같은 편의 설정이라 localStorage 에 둔다 */
const LAST_MODEL_KEY = 'litecode.model'

function readLastModel(): ModelRef | undefined {
  try {
    return parseModelRef(localStorage.getItem(LAST_MODEL_KEY))
  } catch {
    return undefined
  }
}

function clampSidebar(px: number): number {
  return Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, Math.round(px)))
}

function readLayout(): { width: number; hidden: boolean } {
  try {
    const saved = JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? '{}') as { width?: unknown; hidden?: unknown }
    return { width: typeof saved.width === 'number' ? clampSidebar(saved.width) : SIDEBAR_DEFAULT, hidden: saved.hidden === true }
  } catch {
    return { width: SIDEBAR_DEFAULT, hidden: false }
  }
}

function SidebarIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <rect x="2.75" y="3.75" width="14.5" height="12.5" rx="2" stroke="currentColor" strokeWidth="1.5" />
      <path d="M7.5 4V16" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  )
}

/** 로고 아이콘 — 간단한 기하 도형(둥근 사각형 안의 >_). 다른 회사 로고는 쓰지 않는다 */
function LogoMark() {
  return (
    <svg className="sidebar__mark" width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">
      <rect width="24" height="24" rx="7" fill="currentColor" />
      <path d="M7.5 8.5L11 12L7.5 15.5M12.5 16H16.5" stroke="var(--bg)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </svg>
  )
}

type HoverCardContent = { title: string; detail?: string }

/** 잘린 행에 500ms 머물면 행 오른쪽 8px 에 전체 내용 카드 (dsh ui-primitives HoverCard). 흘러가는 글자도 함께 켜고 끈다 */
function useHoverCard() {
  const [card, setCard] = useState<HoverCardContent & { top: number; left: number }>()
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  return {
    card,
    /** always: 잘리지 않아도 카드를 띄운다 — 카드에 제목 말고 다른 정보(메시지 수 등)가 있을 때 */
    enter(row: HTMLElement, content: HoverCardContent, always = false): void {
      startMarquee(row)
      clearTimeout(timer.current)
      if (!always && !isClipped(row)) return
      timer.current = setTimeout(() => {
        // 행에 딸린 버튼(☆·✎·× 등)까지 포함한 줄 전체의 오른쪽 바깥에 붙인다 — 버튼을 덮지 않게
        const rect = (row.closest<HTMLElement>('[data-hover-row]') ?? row).getBoundingClientRect()
        setCard({ ...content, top: rect.top, left: rect.right + 8 })
      }, 500)
    },
    leave(row: HTMLElement): void {
      stopMarquee(row)
      clearTimeout(timer.current)
      setCard(undefined)
    },
  }
}

function HoverCard({ card }: { card?: HoverCardContent & { top: number; left: number } }) {
  if (!card) return null
  return (
    <div className="hover-card" role="tooltip" style={{ top: card.top, left: card.left }}>
      <div className="hover-card__name">{card.title}</div>
      {card.detail && <div className="hover-card__path">{card.detail}</div>}
    </div>
  )
}

export function App() {
  const [providers, setProviders] = useState<ProviderSummary[]>([])
  /** 최근 프로젝트(즐겨찾기 포함, 최근 순). 불러오기 전에는 undefined */
  const [projects, setProjects] = useState<Project[]>()
  /** 현재 프로젝트 경로 — 없으면 첫 실행 안내 */
  const [current, setCurrent] = useState<string>()
  const [sessions, setSessions] = useState<Session[]>([])
  /** 프로젝트별로 마지막에 보던 대화 */
  const [activeIds, setActiveIds] = useState<Record<string, string>>({})
  const [switching, setSwitching] = useState(false)
  /** 폴더를 고르거나 여는 중 — 한 번에 하나만 (dsh ui-workspace) */
  const [picking, setPicking] = useState(false)
  /** 프로젝트를 못 열었을 때의 사유 — 팝오버와 첫 실행 안내에 보인다 */
  const [openError, setOpenError] = useState<string>()
  const switchRef = useRef<HTMLButtonElement>(null)
  const [draft, setDraft] = useState('')
  const sessionHover = useHoverCard()
  // 목록의 `38min`·`1h` 가 저절로 늘어나게 30초마다 다시 그린다
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(tick)
  }, [])
  const [layout, setLayout] = useState(readLayout)
  const drag = useRef<{ x: number; width: number }>(undefined)
  useEffect(() => {
    try {
      localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout))
    } catch {
      // 못 쓰면 이번 실행 동안만 기억한다
    }
  }, [layout])
  const [lastModel, setLastModel] = useState(readLastModel)
  useEffect(() => {
    if (!lastModel) return
    try {
      localStorage.setItem(LAST_MODEL_KEY, JSON.stringify(lastModel))
    } catch {
      // 못 쓰면 이번 실행 동안만 기억한다
    }
  }, [lastModel])
  const listRef = useRef<HTMLDivElement>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const settingsRef = useRef<HTMLButtonElement>(null)
  // 닫으면 포커스를 설정 버튼으로 돌려준다. 모달의 Esc 구독이 매 렌더 다시 걸리지 않게 참조를 고정한다
  const closeSettings = useCallback(() => {
    setSettingsOpen(false)
    settingsRef.current?.focus()
  }, [])

  useEffect(() => {
    void window.litecode.listProviders().then(setProviders)
    // 앱을 켜면 마지막 프로젝트(목록 맨 앞)를 열어 본다. 디스크에서 지워졌으면 안내 화면에 사유를 보이고,
    // 다른 프로젝트로 몰래 넘어가지 않는다 — 사용자가 고르지 않은 폴더에서 대화가 돌면 안 된다.
    // 목록은 그 뒤에 보인다 (열어 보는 동안 안내 화면이 번쩍이지 않게).
    void window.litecode.listProjects().then(async (list) => {
      if (list[0]) await pick(() => window.litecode.openProject(list[0]!.path), cannotOpen(list[0].path))
      setProjects((loaded) => loaded ?? list)
    })
  }, [])

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight })
  })

  const project = projects?.find((candidate) => candidate.path === current)
  const visible = sessions.filter((session) => session.project === project?.path)
  const active = visible.find((session) => session.id === activeIds[project?.path ?? '']) ?? visible[0]
  /** 이 대화의 모델 — 설정에서 지워졌으면 chosen 이 없고 보내기가 막힌다 */
  const selected = active?.model ?? initialModel(providers, lastModel)
  const chosen = findModel(providers, selected)

  /** 팝오버를 닫는다. 키보드로 닫았거나 골랐으면 포커스를 전환 버튼으로 돌려준다 (dsh ui-primitives Menu) */
  function closeSwitcher(returnFocus: boolean): void {
    setSwitching(false)
    if (returnFocus) switchRef.current?.focus()
  }

  /** 프로젝트를 열어(최근 목록 맨 앞으로 올려) 현재 프로젝트로 보여준다. 못 열면 사유를 남기고 현재 선택은 그대로 */
  async function pick(request: () => Promise<Project | undefined>, failure: string): Promise<'opened' | 'cancelled' | 'failed'> {
    setPicking(true)
    setOpenError(undefined)
    try {
      const opened = await request()
      if (!opened) return 'cancelled' // 대화상자 취소
      setProjects(await window.litecode.listProjects())
      setCurrent(opened.path)
      setSessions(withSessionFor(opened.path))
      return 'opened'
    } catch {
      setOpenError(failure)
      return 'failed'
    } finally {
      setPicking(false)
    }
  }

  async function openFolder(): Promise<void> {
    closeSwitcher(false) // 대화상자를 띄우기 전에 팝오버를 닫는다 (dsh ui-workspace)
    const outcome = await pick(() => window.litecode.pickProjectFolder(), '폴더를 열 수 없습니다')
    if (outcome === 'opened') switchRef.current?.focus()
    if (outcome === 'failed' && current) setSwitching(true) // 사유를 팝오버에 (프로젝트가 없으면 안내 화면에 보인다)
  }

  async function pickRecent(target: Project): Promise<void> {
    if ((await pick(() => window.litecode.openProject(target.path), cannotOpen(target.path))) === 'opened') closeSwitcher(true)
  }

  async function toggleFavorite(target: Project): Promise<void> {
    setProjects(await window.litecode.setProjectFavorite(target.path, !target.favorite))
  }

  /** 목록에서만 뺀다(폴더는 그대로). 그 프로젝트의 메모리 속 대화는 버린다. 현재 프로젝트였으면 목록의 다음 것으로,
   *  남은 게 없으면 첫 실행 안내로 간다 (00_request C) */
  async function remove(target: Project): Promise<void> {
    const list = await window.litecode.removeProject(target.path)
    setProjects(list)
    setSessions((sessionsNow) => sessionsNow.filter((session) => session.project !== target.path))
    if (target.path !== current) return
    setCurrent(undefined)
    const next = list[0]
    if (next) await pick(() => window.litecode.openProject(next.path), cannotOpen(next.path))
    else closeSwitcher(true)
  }

  function updateSession(id: string, mutate: (session: Session) => Session): void {
    setSessions((sessionsNow) => sessionsNow.map((session) => (session.id === id ? mutate(session) : session)))
  }

  function chooseModel(next: ModelRef): void {
    if (active) updateSession(active.id, (session) => ({ ...session, model: next }))
    setLastModel(next)
  }

  async function send(): Promise<void> {
    const prompt = draft.trim()
    if (!prompt || !selected || !chosen || !active || active.pending) return

    // 답이 오기 전에 프로젝트·대화를 바꿔도 이 대화에 붙인다 — 보낸 시점의 대화를 쥔다
    const target = active
    setDraft('')
    updateSession(target.id, (session) => ({
      ...session,
      pending: true,
      updatedAt: Date.now(),
      model: session.model ?? selected, // 보낸 대화는 그 모델에 묶인다 — 나중에 다른 대화에서 고른 것을 따라가지 않는다
      title: session.messages.length === 0 ? prompt.slice(0, 24) : session.title,
      messages: [...session.messages, { role: 'user', text: prompt }],
    }))

    const result = await window.litecode.sendMessage(selected.providerId, selected.modelId, target.project, prompt, target.engineSessionId)
    updateSession(target.id, (session) => ({
      ...session,
      pending: false,
      updatedAt: Date.now(),
      engineSessionId: result.sessionId ?? session.engineSessionId,
      usage: result.usage ? addTurn(session.usage, result.usage) : session.usage,
      messages: [
        ...session.messages,
        { role: 'assistant', text: result.ok ? (result.text ?? '') : `⚠️ ${result.error}` },
      ],
    }))
  }

  return (
    <div className="app">
      <aside className="sidebar" style={{ width: layout.width, display: layout.hidden ? 'none' : undefined }}>
        <div
          className="sidebar__resize"
          role="separator"
          aria-orientation="vertical"
          aria-label="사이드바 폭"
          onPointerDown={(event) => {
            event.currentTarget.setPointerCapture(event.pointerId)
            drag.current = { x: event.clientX, width: layout.width }
          }}
          onPointerMove={(event) => {
            const start = drag.current
            if (start) setLayout((now) => ({ ...now, width: clampSidebar(start.width + event.clientX - start.x) }))
          }}
          onPointerUp={() => (drag.current = undefined)}
          onPointerCancel={() => (drag.current = undefined)}
        />
        {/* dsh ui-sidebar 로고 줄: 왼쪽 아이콘·이름, 오른쪽 끝 접기 */}
        <div className="sidebar__logo">
          <span className="sidebar__identity">
            <LogoMark />
            <span className="sidebar__brand">LiteCode</span>
          </span>
          <button
            type="button"
            className="sidebar-toggle"
            aria-label="사이드바 숨기기"
            title="사이드바 숨기기"
            onClick={() => setLayout((now) => ({ ...now, hidden: true }))}
          >
            <SidebarIcon />
          </button>
        </div>
        <div className="sidebar__project">
          <button
            type="button"
            className="project-switch"
            ref={switchRef}
            disabled={picking}
            // 고를 최근 프로젝트가 없으면 한 줄짜리 팝오버 대신 바로 폴더 열기 (dsh ui-workspace)
            onClick={() => (projects?.length === 0 ? void openFolder() : setSwitching((open) => !open))}
          >
            {project && <Badge project={project} />}
            <span className="project-switch__text" onMouseEnter={(event) => startMarquee(event.currentTarget)} onMouseLeave={(event) => stopMarquee(event.currentTarget)}>
              <span className="project-switch__name">{project?.name ?? '프로젝트 없음'}</span>
              {project && <span className="project-switch__path marquee">{project.displayPath}</span>}
            </span>
            <span className="project-switch__caret">▾</span>
          </button>
          {switching && (
            <ProjectPopover
              projects={projects ?? []}
              current={project?.path}
              busy={picking}
              error={openError}
              onPick={(picked) => void pickRecent(picked)}
              onOpenFolder={() => void openFolder()}
              onToggleFavorite={(target) => void toggleFavorite(target)}
              onRemove={remove}
              onRename={async (target, name) => setProjects(await window.litecode.renameProject(target.path, name))}
              onClose={closeSwitcher}
            />
          )}
        </div>

        <div className="sidebar__new">
          <button
            type="button"
            className="new-chat"
            disabled={!project}
            onClick={() => {
              if (!project) return
              // 빈 대화는 첫 메시지 전까지 하나만 (dsh ui-workspace) — 이미 있으면 새로 만들지 않고 그리로 간다
              const blank = sessions.find((session) => session.project === project.path && session.messages.length === 0)
              const session = blank ?? newSession(project.path)
              if (!blank) setSessions((sessionsNow) => [session, ...sessionsNow])
              setActiveIds((current) => ({ ...current, [project.path]: session.id }))
            }}
          >
            + 새 대화
          </button>
        </div>

        <div className="sidebar__label">대화 목록</div>

        <div className="sidebar__sessions">
          {visible.map((session) => (
            <button
              key={session.id}
              type="button"
              className={`session-item${session.id === active?.id ? ' session-item--active' : ''}`}
              onClick={() => setActiveIds((current) => ({ ...current, [session.project]: session.id }))}
              onMouseEnter={(event) =>
                sessionHover.enter(event.currentTarget, {
                  title: session.title,
                  detail: session.pending ? '답을 기다리는 중' : `메시지 ${session.messages.length}개`,
                }, true)
              }
              onMouseLeave={(event) => sessionHover.leave(event.currentTarget)}
            >
              <span className="session-item__title marquee">{session.title}</span>
              {session.messages.length > 0 && <span className="session-item__time">{ago(session.updatedAt, now)}</span>}
            </button>
          ))}
        </div>
        <HoverCard card={sessionHover.card} />

        <div className="sidebar__foot">
          <button type="button" className="settings-trigger" ref={settingsRef} onClick={() => setSettingsOpen(true)}>
            ⚙ 설정
          </button>
        </div>
      </aside>

      <main className={`main${layout.hidden ? ' main--full' : ''}`}>
        {/* 사이드바를 숨기면 로고 줄의 접기 버튼도 같이 사라지므로 그때만 여기서 다시 연다 */}
        {layout.hidden && (
          <button
            type="button"
            className="sidebar-toggle sidebar-toggle--floating"
            aria-label="사이드바 보이기"
            title="사이드바 보이기"
            onClick={() => setLayout((now) => ({ ...now, hidden: false }))}
          >
            <SidebarIcon />
          </button>
        )}
        {projects && !project && (
          <div className="open-guide">
            {openError && (
              <p className="open-guide__error" role="alert">
                {openError}
              </p>
            )}
            <p>작업할 폴더를 열어 주세요</p>
            <button type="button" className="open-guide__button" disabled={picking} onClick={() => void openFolder()}>
              폴더 열기…
            </button>
          </div>
        )}
        {active && (
          <>
            <div className="main__header">{active.title}</div>

            <div className="main__messages" ref={listRef}>
              {active.messages.length === 0 && <div className="empty">무엇을 도와드릴까요?</div>}
              {active.messages.map((message, index) => (
                <div key={index} className={`bubble bubble--${message.role}`}>
                  {/* 모델이 빈 줄로 답을 시작하기도 한다 — 앞뒤 공백은 보여 주지 않는다 (속 줄바꿈은 그대로). 답은 마크다운으로 */}
                  {message.role === 'assistant' ? <Markdown text={message.text.trim()} /> : message.text.trim()}
                </div>
              ))}
            </div>

            <div className="composer">
              {/* dsh InputBar: 둥근 카드 하나에 입력칸과 아래 줄(왼쪽 +, 오른쪽 모델 선택·둥근 보내기)을 담고, 카드 밑에 통계 줄 */}
              <div className="composer__box">
                <textarea
                  className="composer__input"
                  placeholder="메시지를 입력하세요…"
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={(event) => {
                    // 한글 등 입력기가 조합 중인 Enter 는 조합을 확정하는 키다 — 여기서 보내면 "안녕" 이 "아ㄴ녕" 으로 가고
                    // 마지막 글자가 입력창에 남는다. keyCode 229 는 isComposing 을 안 채우는 환경용
                    if (event.nativeEvent.isComposing || event.keyCode === 229) return
                    if (event.key === 'Enter' && !event.shiftKey) {
                      event.preventDefault()
                      void send()
                    }
                  }}
                />
                <div className="composer__row">
                  {/* dsh 에선 첨부 메뉴. 첨부 기능이 생길 때까지 모양만 두고 막는다 — 막힌 버튼은 툴팁을 못 띄워 감싼 쪽에 둔다 */}
                  <span className="composer__add-wrap" title="준비 중">
                    <button type="button" className="composer__add" aria-label="첨부 (준비 중)" disabled>
                      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" strokeWidth="1.3" aria-hidden="true">
                        <path d="M8 2V14M2 8H14" stroke="currentColor" />
                      </svg>
                    </button>
                  </span>
                  <div className="composer__trailing">
                    <ModelSelect providers={providers} value={selected} onChange={chooseModel} />
                    <button
                      type="button"
                      className="composer__send"
                      aria-label="보내기"
                      title="보내기 (Enter)"
                      onClick={() => void send()}
                      disabled={active.pending || !chosen || !draft.trim()}
                    >
                      {/* dsh 보내기 화살표 (16 격자) */}
                      <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
                        <path
                          d="M8.3125 0.980183C8.66767 1.0531 8.97902 1.20418 9.2627 1.43233C9.48724 1.61297 9.73029 1.85793 9.97949 2.10714L14.707 6.83468L13.293 8.24874L9 3.95577V15.0417H7V3.95577L2.70703 8.24874L1.29297 6.83468L6.02051 2.10714C6.26971 1.85793 6.51277 1.61297 6.7373 1.43233C6.97662 1.23986 7.28445 1.04402 7.6875 0.980183C7.8973 0.947006 8.1031 0.95516 8.3125 0.980183Z"
                          fill="currentColor"
                        />
                      </svg>
                    </button>
                  </div>
                </div>
              </div>
              {/* 컨텍스트 % 의 한도는 지금 고른 모델의 설정값 (설정 > 모델의 "컨텍스트 길이") */}
              <StatsBar stats={chatStats(active.usage, chosen?.model.contextLength)} />
            </div>
          </>
        )}
      </main>
      {settingsOpen && <SettingsModal providers={providers} onProvidersChange={setProviders} onClose={closeSettings} />}
    </div>
  )
}

interface ProjectPopoverProps {
  projects: Project[]
  current?: string
  /** 여는 중 — 행을 막는다 */
  busy: boolean
  error?: string
  onPick(project: Project): void
  onOpenFolder(): void
  onToggleFavorite(project: Project): void
  onRemove(project: Project): Promise<void>
  /** 보이는 이름만 바꾼다 (폴더는 그대로). 빈 이름이면 폴더 이름으로 */
  onRename(project: Project, name: string): Promise<void>
  /** returnFocus: 키보드(Esc)로 닫았으면 true — 포커스를 전환 버튼으로 돌려준다 */
  onClose(returnFocus: boolean): void
}

/** 전환 버튼 아래 팝오버 — 검색·즐겨찾기·최근 목록·폴더 열기 (시안 + 00_request B).
 *  시안이 안 정한 상호작용은 dsh ui-primitives Menu 를 따른다: ↑/↓ 로 행을 돌고(끝에서 처음으로) Home/End 로 끝으로,
 *  Esc 는 닫고 포커스를 전환 버튼으로, 바깥 클릭은 그냥 닫는다. (dsh 의 "창 포커스를 잃으면 닫기" 는 뺐다 — 같은 머신의
 *  다른 창이 포커스를 가져가면 실물 테스트 도중 팝오버가 닫혀 실패했다, 2026-09-30.) 목록이 길면 목록만 스크롤하고
 *  "폴더 열기" 는 아래에 고정한다. 행의 ☆·× 는 dsh ui-workspace 의 행 hover 버튼처럼 hover·포커스 때만 보인다
 *  (화살표는 행끼리만 걷고, 행 안의 버튼은 Tab 으로 닿는다). */
function ProjectPopover({ projects, current, busy, error, onPick, onOpenFolder, onToggleFavorite, onRemove, onRename, onClose }: ProjectPopoverProps) {
  const [query, setQuery] = useState('')
  // 이름 바꾸는 중인 행 — dsh ui-workspace 처럼 그 자리에서 입력칸으로 바뀐다. Enter·바깥으로 나가면 저장, Esc 는 취소
  const [editing, setEditing] = useState<string>()
  const ref = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const hover = useHoverCard()

  useEffect(() => {
    function onMouseDown(event: MouseEvent): void {
      // 전환 버튼(같은 .sidebar__project 안)은 스스로 토글하므로 바깥으로 치지 않는다
      if (!ref.current?.parentElement?.contains(event.target as Node)) onClose(false)
    }
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') onClose(true)
    }
    document.addEventListener('mousedown', onMouseDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onMouseDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [onClose])

  function walk(event: ReactKeyboardEvent): void {
    const inSearch = event.target instanceof HTMLInputElement
    if (!['ArrowDown', 'ArrowUp'].includes(event.key) && !(!inSearch && ['Home', 'End'].includes(event.key))) return
    const rows = [...(ref.current?.querySelectorAll<HTMLButtonElement>('.project-item__main:not(:disabled), .project-popover__open:not(:disabled)') ?? [])]
    if (rows.length === 0) return
    event.preventDefault()
    const from = rows.indexOf(document.activeElement as HTMLButtonElement)
    const step = event.key === 'ArrowDown' ? 1 : -1
    const next =
      event.key === 'Home' ? 0
      : event.key === 'End' ? rows.length - 1
      : from === -1 ? (step === 1 ? 0 : rows.length - 1)
      : (from + step + rows.length) % rows.length
    rows[next]?.focus()
  }

  const needle = query.trim().toLowerCase()
  const filtered = projects.filter((project) => project.name.toLowerCase().includes(needle))
  // 즐겨찾기한 것은 즐겨찾기 묶음에만 — 최근에 중복으로 안 나온다 (00_request B)
  const groups = [
    { name: '즐겨찾기', items: filtered.filter((project) => project.favorite) },
    { name: '최근', items: filtered.filter((project) => !project.favorite) },
  ]

  return (
    <div className="project-popover" ref={ref} onKeyDown={walk}>
      <input
        ref={searchRef}
        className="project-popover__search"
        placeholder="프로젝트 검색…"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        autoFocus
      />
      <div className="project-popover__list">
        {groups.map(
          (group) =>
            group.items.length > 0 && (
              <div key={group.name} role="group" aria-label={group.name}>
                <div className="project-popover__label">{group.name}</div>
                {group.items.map((project) => (
                  <div key={project.path} data-hover-row className={`project-item${project.path === current ? ' project-item--active' : ''}`}>
                    {editing === project.path ? (
                      <input
                        className="project-item__rename"
                        aria-label="프로젝트 이름"
                        defaultValue={project.name}
                        autoFocus
                        onFocus={(event) => event.currentTarget.select()}
                        onKeyDown={(event) => {
                          if (event.nativeEvent.isComposing || event.keyCode === 229) return // 한글 조합 확정 Enter
                          if (event.key === 'Enter') event.currentTarget.blur()
                          if (event.key === 'Escape') {
                            event.stopPropagation() // 팝오버까지 닫지 않는다
                            setEditing(undefined)
                          }
                        }}
                        onBlur={(event) => {
                          if (editing !== project.path) return
                          setEditing(undefined)
                          void onRename(project, event.currentTarget.value).then(() => searchRef.current?.focus())
                        }}
                      />
                    ) : (
                    <button
                      type="button"
                      className="project-item__main"
                      disabled={busy}
                      onMouseEnter={(event) => hover.enter(event.currentTarget, { title: project.name, detail: project.path }, true)}
                      onMouseLeave={(event) => hover.leave(event.currentTarget)}
                      onClick={() => onPick(project)}
                    >
                      <Badge project={project} />
                      <span className="project-switch__text">
                        <span className="project-item__name">{project.name}</span>
                        <span className="project-switch__path marquee">{project.displayPath}</span>
                      </span>
                      {project.path === current && <span className="project-item__dot" />}
                    </button>
                    )}
                    {project.favorite && (
                      <span className="project-item__marker" aria-hidden="true">
                        ★
                      </span>
                    )}
                    <span className="project-item__actions">
                      <button
                        type="button"
                        className="project-item__action"
                        aria-label="이름 바꾸기"
                        title="이름 바꾸기 (폴더 이름은 그대로)"
                        disabled={busy}
                        onClick={() => setEditing(project.path)}
                      >
                        ✎
                      </button>
                      <button
                        type="button"
                        className="project-item__action"
                        aria-label={project.favorite ? '즐겨찾기에서 빼기' : '즐겨찾기에 추가'}
                        title={project.favorite ? '즐겨찾기에서 빼기' : '즐겨찾기에 추가'}
                        disabled={busy}
                        onClick={() => onToggleFavorite(project)}
                      >
                        {project.favorite ? '★' : '☆'}
                      </button>
                      <button
                        type="button"
                        className="project-item__action"
                        aria-label="목록에서 빼기"
                        title="목록에서 빼기 (폴더는 그대로)"
                        disabled={busy}
                        // 뺀 행의 포커스가 사라지므로 검색 입력으로 돌려 키보드를 이어 쓰게 한다
                        onClick={() => void onRemove(project).then(() => searchRef.current?.focus())}
                      >
                        ×
                      </button>
                    </span>
                  </div>
                ))}
              </div>
            ),
        )}
        {needle && filtered.length === 0 && <div className="project-popover__empty">일치하는 프로젝트 없음</div>}
      </div>
      {error && (
        <div className="project-popover__error" role="alert">
          {error}
        </div>
      )}
      <div className="project-popover__divider" />
      <button type="button" className="project-popover__open" disabled={busy} onClick={onOpenFolder}>
        ＋ 폴더 열기…
      </button>
      <HoverCard card={hover.card} />
    </div>
  )
}
