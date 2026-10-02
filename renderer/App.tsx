import { Fragment, useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import type { Conversation, ConversationStatus, HistoryMessage, OpenTarget, Project, ProviderSummary, TurnItem } from '../shared/ipc.ts'
import { ago } from './ago.ts'
import { badgeColor, badgeLetters } from './badge.ts'
import { AssistantTurn, UserMessage } from './ChatTurn.tsx'
import { Minimap, useFollowBottom } from './Minimap.tsx'
import { ScrollToBottom } from './ScrollToBottom.tsx'
import { upsertItem } from './turnView.ts'
import { findModel, initialModel, parseModelRef, type ModelRef } from './modelChoice.ts'
import { ModelSelect } from './ModelSelect.tsx'
import { SettingsModal } from './Settings.tsx'
import { StatsBar } from './StatsBar.tsx'
import { Trajectory } from './Trajectory.tsx'
import { addTurn, chatStats, type ChatUsage } from './stats.ts'
import { useTriggers } from './useTriggers.ts'
import { TriggerPopup } from './TriggerPopup.tsx'
import { ShellDrawer } from './ShellDrawer.tsx'
import { ShellCard, type ShellCardView } from './ShellCard.tsx'
import { useSettings, useT } from './settingsStore.ts'
import { StatusDot, Toasts, useNotices } from './Notices.tsx'
import { otherProjectsStatus, projectStatus } from './noticeView.ts'

interface ChatMessage {
  role: 'user' | 'assistant'
  /** assistant 가 실패했으면 `⚠️ 사유` */
  text: string
  /** user: 보낸 시각 */
  at?: number
  /** assistant: 그 턴의 진행 줄 (생각·도구·글) */
  items?: TurnItem[]
  /** assistant: 걸린 시간(ms) */
  duration?: number
  failed?: boolean
  interrupted?: boolean
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
  /** 답을 기다리는 턴의 진행 줄 (메인이 실시간으로 민다) 과 보낸 시각 — 턴이 끝나면 답에 옮긴다 */
  progress?: TurnItem[]
  sentAt?: number
  /** `!명령` 결과 카드 — 저장된 것은 메인(ctx.sessions)이 정본이고, 여기는 화면 사본 + 돌고 있는 카드 */
  shells?: ShellCardView[]
  /** 마지막 활동 시각(ms) — 목록에 `38min`·`1d` 로 보이고, 보관 개수 제한의 기준이 된다 */
  updatedAt: number
  /** 입력창 아래 통계 줄의 값 — 턴마다 엔진이 주는 사용량·시간을 이 대화에 더한다. 없으면 "—" */
  usage?: ChatUsage
  /** 지난 실행에서 저장된 대화의 내용 상태 — 목록 정보만 저장되고 내용은 열 때 엔진에서 부른다(ctx.sessions). 이번 실행에 만든 대화는 없다 */
  history?: 'unloaded' | 'loading' | 'loaded' | 'missing'
}

function newSession(project: string): Session {
  return { id: crypto.randomUUID(), project, title: '', messages: [], updatedAt: Date.now() }
}

/** 아직 아무것도 안 보낸 새 대화 — 저장하지 않고, 지울 것도 없다 */
function isBlank(session: Session): boolean {
  return session.messages.length === 0 && !session.history && !session.shells?.length
}

/** 저장할 목록 정보 (말풍선·대기 상태·카드는 빼고 — 카드는 메인이 저장한다) */
function toConversation({ id, project, engineSessionId, title, updatedAt, model, usage }: Session): Conversation {
  return { id, project, engineSessionId, title, updatedAt, model, usage }
}

function fromConversation(conversation: Conversation): Session {
  return { ...conversation, usage: conversation.usage as ChatUsage | undefined, messages: [], history: 'unloaded', shells: conversation.shells }
}

/** 실시간 턴과 같은 모양 — 실패·중단이면 사유를 ⚠️ 로 */
function toChatMessage({ role, text, error, at, items, duration, interrupted }: HistoryMessage): ChatMessage {
  return { role, text: error ? `⚠️ ${error}` : text, at, items, duration, failed: !!error, interrupted }
}

/** 그 프로젝트에 대화가 하나도 없으면 새 대화를 하나 더한다 — 같은 값을 두 번 넣어도 한 번만 더해진다 */
function withSessionFor(project: string) {
  return (current: Session[]) => (current.some((session) => session.project === project) ? current : [newSession(project), ...current])
}

/** 그 프로젝트에 빈 새 대화가 없으면 맨 앞에 더한다 — 앱을 켜면 저장된 대화 위에 새 대화로 시작한다 */
function withBlankFor(project: string) {
  return (current: Session[]) =>
    current.some((session) => session.project === project && isBlank(session)) ? current : [newSession(project), ...current]
}

/** 16px 외곽선 톱니 — dsh 사이드바 설정 줄의 아이콘 자리 */
function GearIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" aria-hidden="true">
      <path d="M15.64 8.26L17.35 8.51L17.35 11.49L15.64 11.74L15.22 12.75L16.25 14.14L14.14 16.25L12.75 15.22L11.74 15.64L11.49 17.35L8.51 17.35L8.26 15.64L7.25 15.22L5.86 16.25L3.75 14.14L4.78 12.75L4.36 11.74L2.65 11.49L2.65 8.51L4.36 8.26L4.78 7.25L3.75 5.86L5.86 3.75L7.25 4.78L8.26 4.36L8.51 2.65L11.49 2.65L11.74 4.36L12.75 4.78L14.14 3.75L16.25 5.86L15.22 7.25Z" />
      <circle cx="10" cy="10" r="2.5" />
    </svg>
  )
}

/** 팝오버의 지금 프로젝트 표시 — dsh Menu 선택 항목의 14px ✓ */
function CheckIcon() {
  return (
    <svg className="project-item__check" width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2.5 7.5L5.5 10.5L11.5 3.5" />
    </svg>
  )
}

function TrashIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" aria-hidden="true">
      <path d="M2.5 4.5H13.5M6.5 4.5V3H9.5V4.5M4 4.5L4.7 13.2C4.75 13.65 5.1 14 5.55 14H10.45C10.9 14 11.25 13.65 11.3 13.2L12 4.5M6.75 7V11.5M9.25 7V11.5" />
    </svg>
  )
}

function Badge({ project }: { project: Project }) {
  return (
    <span className="project-switch__badge" style={{ background: badgeColor(project.path) }}>
      {badgeLetters(project.name)}
    </span>
  )
}

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

/** 잘린 행에 800ms 머물면 행 오른쪽 8px 에 전체 내용 카드 (dsh ui-primitives HoverCard). 흘러가는 글자도 함께 켜고 끈다 */
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
      }, 800) // dsh HoverCard 열림 지연
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
  const t = useT()
  const settings = useSettings()
  /** 새 대화는 제목 없이 두고 보일 때 번역한다 — 언어를 바꾸면 같이 바뀐다 (첫 메시지가 제목이 된다) */
  const titleOf = (session: Session) => session.title || t('sidebar.untitled')
  const cannotOpen = (dir: string) => t('project.cannotOpen', { dir })
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
  /** 못 연 프로젝트 경로 — 안내 화면이 그 폴더의 저장된 대화를 "폴더가 없습니다" 로 보이고 지우게만 한다 (열지 않는다 — opencode 요청 0) */
  const [failedProject, setFailedProject] = useState<string>()
  const switchRef = useRef<HTMLButtonElement>(null)
  const [draft, setDraft] = useState('')
  /** 본문 탭 — 대화(Chat) 또는 스텝·도구 기록(Trajectory) */
  const [view, setView] = useState<'chat' | 'trajectory'>('chat')
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

  /** 첫 목록을 다 올렸나 — 그 전에 온 알림 열기 신호는 첫 목록 뒤에 당겨 간다 */
  const loaded = useRef(false)
  /** 비동기 이동(알림 열기)이 지금 대화 목록을 보게 */
  const sessionsRef = useRef<Session[]>([])
  sessionsRef.current = sessions

  /** 대화 id → 마지막으로 저장한 목록 정보(JSON) — 바뀐 대화만 저장한다 */
  const saved = useRef(new Map<string, string>())

  useEffect(() => {
    void window.litecode.listProviders().then(setProviders)
    // 저장된 대화 목록을 먼저 올린다 — 프로젝트를 열 때 "대화가 없으면 새 대화" 가 저장된 대화를 보고 판단하게.
    // 앱을 켜면 마지막 프로젝트(목록 맨 앞)를 열어 본다. 디스크에서 지워졌으면 안내 화면에 사유를 보이고,
    // 다른 프로젝트로 몰래 넘어가지 않는다 — 사용자가 고르지 않은 폴더에서 대화가 돌면 안 된다.
    // 목록은 그 뒤에 보인다 (열어 보는 동안 안내 화면이 번쩍이지 않게). 켠 직후에는 저장된 대화 위의 새 대화에서 시작한다
    void (async () => {
      const stored = (await window.litecode.listConversations()).map(fromConversation)
      for (const session of stored) saved.current.set(session.id, JSON.stringify(toConversation(session)))
      setSessions(stored)
      const list = await window.litecode.listProjects()
      if (list[0] && (await pick(() => window.litecode.openProject(list[0]!.path), cannotOpen(list[0].path), list[0].path)) === 'opened') {
        setSessions(withBlankFor(list[0].path))
      }
      setProjects((loaded) => loaded ?? list)
      // 눌린 PC 알림으로 창이 새로 생겼으면 열 곳이 기다리고 있다 — 목록을 다 올린 뒤에 당겨 간다 (그 전엔 대화가 "지워졌다" 로 보인다)
      loaded.current = true
      await pullPendingOpen()
    })()
    const offOpen = window.litecode.onNotificationOpen(() => {
      if (loaded.current) void pullPendingOpen()
    })
    return offOpen
  }, [])

  // 대화 목록 정보가 바뀌면 저장한다 (제목·시각·엔진 세션·모델·통계). 빈 새 대화는 저장하지 않는다.
  // 보관 개수를 넘어 지워진 대화는 화면에서도 뺀다
  useEffect(() => {
    for (const session of sessions) {
      if (isBlank(session)) continue
      const conversation = toConversation(session)
      const key = JSON.stringify(conversation)
      if (saved.current.get(session.id) === key) continue
      saved.current.set(session.id, key)
      void window.litecode.saveConversation(conversation).then(forgetPruned)
    }
  }, [sessions])

  function forgetPruned(ids: string[]): void {
    if (ids.length === 0) return
    for (const id of ids) saved.current.delete(id)
    setSessions((sessionsNow) => sessionsNow.filter((session) => !ids.includes(session.id)))
  }

  // 답을 기다리는 턴의 진행 줄 — 보낸 대화에 쌓는다 (대화 id 로 온다. 끝난 뒤 늦게 온 것은 버린다)
  useEffect(
    () =>
      window.litecode.onTurnProgress((conversationId, item) =>
        updateSession(conversationId, (session) => (session.pending ? { ...session, progress: upsertItem(session.progress, item) } : session)),
      ),
    [],
  )
  // 돌고 있는 `!명령` 카드의 출력 조각 — 카드 id 로 찾는다
  useEffect(
    () =>
      window.litecode.onShellData((runId, chunk) =>
        setSessions((sessionsNow) =>
          sessionsNow.map((session) =>
            session.shells?.some((shell) => shell.id === runId && shell.running)
              ? { ...session, shells: session.shells.map((shell) => (shell.id === runId ? { ...shell, output: shell.output + chunk } : shell)) }
              : session,
          ),
        ),
      ),
    [],
  )

  const project = projects?.find((candidate) => candidate.path === current)
  const visible = sessions.filter((session) => session.project === project?.path)
  const active = visible.find((session) => session.id === activeIds[project?.path ?? '']) ?? visible[0]
  // 맨 아래에 있으면 내용이 늘 때 따라 내려간다 — 위로 올려 읽는 중(미니맵 이동 포함)이면 그대로 둔다
  const following = useFollowBottom(listRef, `${active?.id}:${view}`)
  /** 이 대화의 모델 — 설정에서 지워졌으면 chosen 이 없고 보내기가 막힌다 */
  const selected = active?.model ?? initialModel(providers, lastModel)
  const chosen = findModel(providers, selected)
  /** 알림 — 메인이 쥔 대화별 상태(점)와 앞일 때의 토스트. 지금 보는 대화를 메인에 알린다 */
  const notices = useNotices(active?.id)

  /** 알림(토스트·PC 알림)을 누르면 — 기존 프로젝트 열기 경로로 그 프로젝트를 열고(목록에서 빠졌으면 다시 넣는다) 그 대화를 고른다.
   *  대화가 지워졌으면 프로젝트만 열고 안내, 폴더가 없으면 팝오버에 "폴더를 열 수 없습니다" (결정 Q8) */
  async function openNotice(target: OpenTarget): Promise<void> {
    setSwitching(false)
    const outcome = await pick(() => window.litecode.openProject(target.project), cannotOpen(target.project), target.project)
    if (outcome === 'failed') {
      setSwitching(true)
      return
    }
    if (outcome !== 'opened') return
    if (sessionsRef.current.some((session) => session.id === target.conversationId)) setActiveIds((now) => ({ ...now, [target.project]: target.conversationId }))
    else notices.say(t('notify.conversationGone'))
  }

  async function pullPendingOpen(): Promise<void> {
    const target = await window.litecode.takePendingOpen().catch(() => undefined)
    if (target) await openNotice(target)
  }

  /** 휴지통을 눌러 "삭제 확인" 을 기다리는 대화 */
  const [confirming, setConfirming] = useState<string>()
  /** 터미널 칸이 펴진 프로젝트 — 프로젝트마다 따로 (closed-code 셸 서랍) */
  const [shellOpen, setShellOpen] = useState<Record<string, boolean>>({})
  /** ⌘↓ 를 누른 횟수 — 칸이 이미 펴져 있어도 키를 칸으로 내린다 */
  const [shellFocus, setShellFocus] = useState(0)
  const trigger = useTriggers({
    directory: active?.project,
    draft,
    setDraft,
    onSend: (text, display) => void send({ text, display }),
    onShell: (_directory, command) => void runShell(command),
  })
  /** Enter·보내기 — 입력 트리거(`/`·`!`)가 다루지 않으면 평범하게 보낸다 */
  const submit = () =>
    void trigger.submit().then((handled) => {
      if (!handled) void send()
    })

  // 터미널 칸 — ⌘↓ 로 펴고 키를 칸으로 내리고, ⌘↑ 로 접고 입력창으로 올라온다 (closed-code useShellDrawer. Windows·Linux 는 Ctrl).
  // `!` 로는 안 열린다(`!명령` 은 대화 카드). ⌘⇧↑ 은 글 선택 확장이라 건드리지 않는다. 칸이 접혀 있으면 ⌘↑ 은 입력창의 것이다
  const drawerProject = active?.project
  const drawerOpen = !!drawerProject && !!shellOpen[drawerProject]
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      const command = navigator.platform.startsWith('Mac') ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey
      if (!command || event.shiftKey || event.altKey || !drawerProject) return
      if (event.key === 'ArrowDown') {
        setShellOpen((open) => ({ ...open, [drawerProject]: true }))
        setShellFocus((count) => count + 1)
      } else if (event.key === 'ArrowUp' && drawerOpen) {
        setShellOpen((open) => ({ ...open, [drawerProject]: false }))
        trigger.inputRef.current?.focus()
      } else return
      event.preventDefault()
      event.stopPropagation()
    }
    window.addEventListener('keydown', onKeyDown, true) // 칸(xterm)이 키를 먹기 전에
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [drawerProject, drawerOpen])

  // 저장된 대화를 처음 열면 내용을 엔진에서 부른다. 폴더가 없으면 엔진에 묻지 않고 "폴더가 없습니다" (ctx.llm.history)
  useEffect(() => {
    if (active?.history !== 'unloaded') return
    const id = active.id
    updateSession(id, (session) => ({ ...session, history: 'loading' }))
    void window.litecode.loadConversation(id).then((loaded) =>
      updateSession(id, (session) => ({
        ...session,
        history: loaded.missingFolder ? 'missing' : 'loaded',
        messages: [...loaded.messages.map(toChatMessage), ...(loaded.error ? [{ role: 'assistant' as const, text: `⚠️ ${loaded.error}` }] : [])],
      })),
    )
  }, [active?.id, active?.history])

  /** 팝오버를 닫는다. 키보드로 닫았거나 골랐으면 포커스를 전환 버튼으로 돌려준다 (dsh ui-primitives Menu) */
  function closeSwitcher(returnFocus: boolean): void {
    setSwitching(false)
    if (returnFocus) switchRef.current?.focus()
  }

  /** 프로젝트를 열어(최근 목록 맨 앞으로 올려) 현재 프로젝트로 보여준다. 못 열면 사유를 남기고 현재 선택은 그대로 */
  async function pick(request: () => Promise<Project | undefined>, failure: string, dir?: string): Promise<'opened' | 'cancelled' | 'failed'> {
    setPicking(true)
    setOpenError(undefined)
    setFailedProject(undefined)
    try {
      const opened = await request()
      if (!opened) return 'cancelled' // 대화상자 취소
      setProjects(await window.litecode.listProjects())
      setCurrent(opened.path)
      // 폴더가 되살아났으면 "폴더가 없습니다" 였던 대화를 다시 불러 본다
      setSessions((sessionsNow) =>
        withSessionFor(opened.path)(
          sessionsNow.map((session) => (session.project === opened.path && session.history === 'missing' ? { ...session, history: 'unloaded' } : session)),
        ),
      )
      return 'opened'
    } catch {
      setOpenError(failure)
      setFailedProject(dir)
      return 'failed'
    } finally {
      setPicking(false)
    }
  }

  async function openFolder(): Promise<void> {
    closeSwitcher(false) // 대화상자를 띄우기 전에 팝오버를 닫는다 (dsh ui-workspace)
    const outcome = await pick(() => window.litecode.pickProjectFolder(), t('project.cannotOpenPicked'))
    if (outcome === 'opened') switchRef.current?.focus()
    if (outcome === 'failed' && current) setSwitching(true) // 사유를 팝오버에 (프로젝트가 없으면 안내 화면에 보인다)
  }

  async function pickRecent(target: Project): Promise<void> {
    if ((await pick(() => window.litecode.openProject(target.path), cannotOpen(target.path), target.path)) === 'opened') closeSwitcher(true)
  }

  async function toggleFavorite(target: Project): Promise<void> {
    setProjects(await window.litecode.setProjectFavorite(target.path, !target.favorite))
  }

  /** 목록에서만 뺀다(폴더는 그대로). 저장된 대화는 남는다 — 같은 폴더를 다시 열면 돌아온다. 빈 새 대화만 버린다.
   *  현재 프로젝트였으면 목록의 다음 것으로, 남은 게 없으면 첫 실행 안내로 간다 (00_request C) */
  async function remove(target: Project): Promise<void> {
    const list = await window.litecode.removeProject(target.path)
    setProjects(list)
    setSessions((sessionsNow) => sessionsNow.filter((session) => session.project !== target.path || !isBlank(session)))
    if (target.path === failedProject) setFailedProject(undefined)
    if (target.path !== current) return
    setCurrent(undefined)
    const next = list[0]
    if (next) await pick(() => window.litecode.openProject(next.path), cannotOpen(next.path), next.path)
    else closeSwitcher(true)
  }

  function updateSession(id: string, mutate: (session: Session) => Session): void {
    setSessions((sessionsNow) => sessionsNow.map((session) => (session.id === id ? mutate(session) : session)))
  }

  /** 대화를 지운다 — 목록에서 빼고 엔진 세션도 (ctx.sessions). 되돌리기 없음. 그 프로젝트에 대화가 안 남으면 새 대화를 둔다 */
  async function removeConversation(target: Session): Promise<void> {
    setConfirming(undefined)
    await window.litecode.removeConversation(target.id)
    saved.current.delete(target.id)
    const rest = (sessionsNow: Session[]) => sessionsNow.filter((session) => session.id !== target.id)
    // 안내 화면(못 연 프로젝트)에서 지운 것이면 새 대화를 두지 않는다 — 열린 프로젝트에만
    setSessions((sessionsNow) => (target.project === current ? withSessionFor(target.project)(rest(sessionsNow)) : rest(sessionsNow)))
  }

  function chooseModel(next: ModelRef): void {
    if (active) updateSession(active.id, (session) => ({ ...session, model: next }))
    setLastModel(next)
  }

  /** command: `/` 명령 — text 를 보내고 말풍선·제목엔 display */
  async function send(command?: { text: string; display: string }): Promise<void> {
    const prompt = command?.text ?? draft.trim()
    const shown = command?.display ?? prompt
    if (!prompt || !selected || !chosen || !active || active.pending || !canWrite(active)) return

    // 답이 오기 전에 프로젝트·대화를 바꿔도 이 대화에 붙인다 — 보낸 시점의 대화를 쥔다
    const target = active
    setDraft('')
    following.current = true
    const sentAt = Date.now()
    const start = (session: Session): Session => ({
      ...session,
      pending: true,
      progress: [],
      sentAt,
      updatedAt: Date.now(),
      model: session.model ?? selected, // 보낸 대화는 그 모델에 묶인다 — 나중에 다른 대화에서 고른 것을 따라가지 않는다
      title: isBlank(session) ? shown.slice(0, 24) : session.title,
      messages: [...session.messages, { role: 'user', text: shown, at: sentAt }],
    })
    updateSession(target.id, start)
    // 보내기 전에 목록에 저장해 둔다 — 엔진 세션이 생기면 메인 프로세스가 여기에 붙인다 (답을 기다리는 중 앱이 꺼져도 다시 열리게)
    const conversation = toConversation(start(target))
    saved.current.set(target.id, JSON.stringify(conversation))
    forgetPruned(await window.litecode.saveConversation(conversation))

    const result = await window.litecode.sendMessage(target.id, selected.providerId, selected.modelId, target.project, prompt, target.engineSessionId, command?.display)
    updateSession(target.id, (session) => ({
      ...session,
      pending: false,
      progress: undefined,
      sentAt: undefined,
      updatedAt: Date.now(),
      engineSessionId: result.sessionId ?? session.engineSessionId,
      usage: result.usage ? addTurn(session.usage, result.usage) : session.usage,
      messages: [
        ...session.messages,
        {
          role: 'assistant',
          text: result.ok ? (result.text ?? '') : `⚠️ ${result.error}`,
          items: session.progress,
          duration: Date.now() - sentAt,
          failed: !result.ok,
          interrupted: result.interrupted,
        },
      ],
    }))
  }

  /** `!명령` — 그 대화에 카드를 붙이고 메인이 프로젝트 폴더에서 돌린다. 맥락에는 안 들어간다. 자리는 지금 말풍선 수
   *  (답을 기다리는 중이면 그 답 뒤) — 다시 열 때 같은 자리에 끼운다 */
  async function runShell(command: string): Promise<void> {
    if (!active || !canWrite(active)) return
    const target = active
    const runId = crypto.randomUUID()
    const card: ShellCardView = {
      id: runId,
      command,
      output: '',
      exitCode: null,
      status: 'done',
      truncated: false,
      at: Date.now(),
      position: target.messages.length + (target.pending ? 1 : 0),
      running: true,
    }
    following.current = true
    const start = (session: Session): Session => ({
      ...session,
      updatedAt: Date.now(),
      title: isBlank(session) ? `!${command}`.slice(0, 24) : session.title,
      shells: [...(session.shells ?? []), card],
    })
    updateSession(target.id, start)
    // 카드를 붙일 대화가 메인에 먼저 있어야 한다 (빈 새 대화는 아직 저장 전이다)
    const conversation = toConversation(start(target))
    saved.current.set(target.id, JSON.stringify(conversation))
    forgetPruned(await window.litecode.saveConversation(conversation))
    const done = await window.litecode.runShell(target.id, runId, target.project, command, card.position)
    updateSession(target.id, (session) => ({ ...session, shells: session.shells?.map((shell) => (shell.id === runId ? done : shell)) }))
  }

  /** 카드를 AI 에게 — 맥락에만 넣는다. 세션이 없었으면 생긴 세션·모델을 이 대화에 붙인다. 실패하면 사유를 준다 */
  async function shareShell(target: Session, cardId: string): Promise<string | undefined> {
    if (!selected) return t('shellCard.shareNoModel')
    const result = await window.litecode.shareShell(target.id, cardId, selected.providerId, selected.modelId)
    if (!result.ok) return result.error
    updateSession(target.id, (session) => ({
      ...session,
      model: session.model ?? selected,
      engineSessionId: result.sessionId ?? session.engineSessionId,
      shells: session.shells?.map((shell) => (shell.id === cardId ? { ...shell, sharedMessageId: shell.sharedMessageId ?? 'shared' } : shell)),
    }))
    return undefined
  }

  /** 그 자리의 `!` 카드들 (실행한 순서) */
  function shellCards(session: Session, at: (position: number) => boolean) {
    if (session.history === 'unloaded' || session.history === 'loading') return [] // 자리를 셀 말풍선이 아직 없다
    return (session.shells ?? [])
      .filter((card) => at(card.position))
      .map((card) => (
        <ShellCard
          key={card.id}
          card={card}
          shareBlocked={session.pending ? t('shellCard.shareBusy') : !chosen ? t('shellCard.shareNoModel') : undefined}
          onStop={() => void window.litecode.stopShell(card.id)}
          onShare={() => shareShell(session, card.id)}
        />
      ))
  }

  /** 내용을 다 불러온 대화에만 보낸다 — 폴더가 없는 대화는 지우기만 된다 */
  function canWrite(session: Session): boolean {
    return !session.history || session.history === 'loaded'
  }

  return (
    <div className="app">
      <aside className="sidebar" style={{ width: layout.width, display: layout.hidden ? 'none' : undefined }}>
        <div
          className="sidebar__resize"
          role="separator"
          aria-orientation="vertical"
          aria-label={t('sidebar.resize')}
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
            aria-label={t('sidebar.hide')}
            title={t('sidebar.hide')}
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
              <span className="project-switch__name">{project?.name ?? t('sidebar.noProject')}</span>
              {project && <span className="project-switch__path marquee">{project.displayPath}</span>}
            </span>
            {otherProjectsStatus(notices.state, project?.path) && (
              <StatusDot status={otherProjectsStatus(notices.state, project?.path)!} className="project-switch__notice" />
            )}
            <span className="project-switch__caret">▾</span>
          </button>
          {switching && (
            <ProjectPopover
              projects={projects ?? []}
              current={project?.path}
              statusOf={(dir) => projectStatus(notices.state, dir)}
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
              const blank = sessions.find((session) => session.project === project.path && isBlank(session))
              const session = blank ?? newSession(project.path)
              if (!blank) setSessions((sessionsNow) => [session, ...sessionsNow])
              setActiveIds((current) => ({ ...current, [project.path]: session.id }))
            }}
          >
            {t('sidebar.newChat')}
          </button>
        </div>

        <div className="sidebar__label">{t('sidebar.conversations')}</div>

        <div className="sidebar__sessions">
          {/* 행의 휴지통은 dsh ui-workspace 세션 행의 hover 버튼처럼 hover·포커스 때만 시각 자리에 보인다. 누르면 "삭제 확인" 으로
              바뀌고 한 번 더 눌러야 지운다(설정 화면 provider 삭제와 같은 방식). 포커스를 잃거나 Esc 면 되돌린다 */}
          {visible.map((session) => (
            <div
              key={session.id}
              data-hover-row
              className={`session-item${session.id === active?.id ? ' session-item--active' : ''}${confirming === session.id ? ' session-item--confirming' : ''}`}
            >
              <button
                type="button"
                className="session-item__main"
                onClick={() => setActiveIds((current) => ({ ...current, [session.project]: session.id }))}
                onMouseEnter={(event) =>
                  sessionHover.enter(event.currentTarget, {
                    title: titleOf(session),
                    detail: session.pending
                      ? t('sidebar.waiting')
                      : session.history === 'unloaded' || session.history === 'loading'
                        ? undefined
                        : t('sidebar.messageCount', { count: session.messages.length }),
                  }, true)
                }
                onMouseLeave={(event) => sessionHover.leave(event.currentTarget)}
              >
                {/* 상태 점 자리는 늘 있다 — 점이 생기고 사라져도 제목이 안 움직인다 (dsh 세션 행) */}
                <span className="session-item__slot">
                  {notices.state[session.id] && <StatusDot status={notices.state[session.id]!.status} className="session-item__notice" />}
                </span>
                <span className="session-item__title marquee">{titleOf(session)}</span>
                {!isBlank(session) && <span className="session-item__time">{ago(session.updatedAt, now)}</span>}
              </button>
              {!isBlank(session) && !session.pending && (
                <span className="session-item__actions">
                  {confirming === session.id ? (
                    <button
                      type="button"
                      className="session-item__confirm"
                      autoFocus
                      onClick={() => void removeConversation(session)}
                      onBlur={() => setConfirming(undefined)}
                      onKeyDown={(event) => event.key === 'Escape' && setConfirming(undefined)}
                    >
                      {t('sidebar.confirmDelete')}
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="session-item__action"
                      aria-label={t('sidebar.deleteChat')}
                      title={t('sidebar.deleteChat')}
                      onClick={() => setConfirming(session.id)}
                    >
                      <TrashIcon />
                    </button>
                  )}
                </span>
              )}
            </div>
          ))}
        </div>
        <div className="sidebar__fade" aria-hidden="true" />
        <HoverCard card={sessionHover.card} />

        <div className="sidebar__foot">
          <button
            type="button"
            className="settings-trigger"
            ref={settingsRef}
            onClick={() => setSettingsOpen(true)}
          >
            <GearIcon />
            {t('sidebar.settings')}
          </button>
        </div>
      </aside>

      <main className={`main${layout.hidden ? ' main--full' : ''}`}>
        {/* 사이드바를 숨기면 로고 줄의 접기 버튼도 같이 사라지므로 그때만 여기서 다시 연다 */}
        {layout.hidden && (
          <button
            type="button"
            className="sidebar-toggle sidebar-toggle--floating"
            aria-label={t('sidebar.show')}
            title={t('sidebar.show')}
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
            {failedProject && (
              <MissingConversations
                sessions={sessions.filter((session) => session.project === failedProject && !isBlank(session))}
                onRemove={removeConversation}
              />
            )}
            <p>{t('guide.prompt')}</p>
            <button type="button" className="open-guide__button" disabled={picking} onClick={() => void openFolder()}>
              {t('guide.openFolder')}
            </button>
          </div>
        )}
        {active && (
          <>
            <div className="main__header">{titleOf(active)}</div>
            {/* 설정 > 일반의 코딩 뷰를 끄면 탭 줄째 숨기고 대화만 (dsh Coding Tools) */}
            {settings.codingView && (
              <div className="main__tabs" role="tablist" aria-label={t('main.views')}>
                {(['chat', 'trajectory'] as const).map((tab) => (
                  <button key={tab} type="button" role="tab" className="main__tab" aria-selected={view === tab} onClick={() => setView(tab)}>
                    {tab === 'chat' ? t('main.tabChat') : t('main.tabTrajectory')}
                  </button>
                ))}
              </div>
            )}

            {settings.codingView && view === 'trajectory' ? (
              <Trajectory key={active.id} directory={active.project} sessionId={active.engineSessionId} pending={!!active.pending} />
            ) : (
            <div className="chat-pane">
            <div className="main__messages" ref={listRef}>
              <div className="chat-column">
              {active.history === 'missing' ? (
                <div className="empty" role="alert">
                  {t('chat.missingFolder', { dir: active.project })}
                </div>
              ) : active.history === 'unloaded' || active.history === 'loading' ? (
                <div className="empty">{t('chat.loading')}</div>
              ) : (
                active.messages.length === 0 && <div className="empty">{t('chat.empty')}</div>
              )}
              {/* 내 말은 말풍선, 답은 본문 폭 전체의 글 + 턴 머리 (ChatTurn.tsx) */}
              {active.messages.map((message, index) => (
                <Fragment key={index}>
                  {shellCards(active, (position) => position === index)}
                  {message.role === 'user' ? (
                    <UserMessage text={message.text} at={message.at} />
                  ) : (
                    <AssistantTurn
                      items={message.items ?? []}
                      text={message.text}
                      failed={message.failed}
                      interrupted={message.interrupted}
                      duration={message.duration}
                      directory={active.project}
                    />
                  )}
                </Fragment>
              ))}
              {shellCards(active, (position) => position === active.messages.length)}
              {active.pending && (
                <AssistantTurn key="running" running items={active.progress ?? []} text="" startedAt={active.sentAt} directory={active.project} />
              )}
              {shellCards(active, (position) => position > active.messages.length)}
              </div>
            </div>
            <Minimap scroller={listRef} turns={active.messages.filter((message) => message.role === 'user').map((message) => message.text)} />
            <ScrollToBottom scroller={listRef} following={following} />
            </div>
            )}

            <div className="composer">
              {/* dsh InputBar: 둥근 카드 하나에 입력칸과 아래 줄(왼쪽 +, 오른쪽 모델 선택·둥근 보내기)을 담고, 카드 밑에 통계 줄 */}
              <div className={`composer__box${trigger.query?.tone ? ` composer__box--${trigger.query.tone}` : ''}`}>
                <TriggerPopup trigger={trigger} />
                <textarea
                  ref={trigger.inputRef}
                  {...trigger.inputProps}
                  className="composer__input"
                  placeholder={t('composer.placeholder')}
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={(event) => {
                    // 한글 등 입력기가 조합 중인 Enter 는 조합을 확정하는 키다 — 여기서 보내면 "안녕" 이 "아ㄴ녕" 으로 가고
                    // 마지막 글자가 입력창에 남는다. keyCode 229 는 isComposing 을 안 채우는 환경용
                    if (event.nativeEvent.isComposing || event.keyCode === 229) return
                    if (trigger.onKeyDown(event)) return
                    if (event.key === 'Enter' && !event.shiftKey) {
                      event.preventDefault()
                      submit()
                    }
                  }}
                />
                <div className="composer__row">
                  {/* dsh 에선 첨부 메뉴. 첨부 기능이 생길 때까지 모양만 두고 막는다 — 막힌 버튼은 툴팁을 못 띄워 감싼 쪽에 둔다 */}
                  <span className="composer__add-wrap" title={t('composer.comingSoon')}>
                    <button type="button" className="composer__add" aria-label={t('composer.attach')} disabled>
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
                      aria-label={t('composer.send')}
                      title={t('composer.sendTitle')}
                      onClick={submit}
                      disabled={active.pending || !chosen || !draft.trim() || !canWrite(active)}
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
            {shellOpen[active.project] && (
              <ShellDrawer
                key={active.project}
                directory={active.project}
                focusSignal={shellFocus}
                onClose={() => {
                  setShellOpen((open) => ({ ...open, [active.project]: false }))
                  trigger.inputRef.current?.focus()
                }}
              />
            )}
          </>
        )}
      </main>
      {settingsOpen && <SettingsModal providers={providers} onProvidersChange={setProviders} onClose={closeSettings} />}
      <Toasts items={notices.toasts} onOpen={(target) => void openNotice(target)} onDismiss={notices.dismiss} />
    </div>
  )
}

/** 못 연(폴더가 없는) 프로젝트의 저장된 대화 — 열 수 없고 지우기만 된다. 내용을 부르지 않는다(없는 경로를 opencode 에 넘기면
 *  그 경로가 재시작 전까지 500 — 01c Q5). 지우기는 대화 목록 행과 같은 휴지통 → "삭제 확인" */
function MissingConversations({ sessions, onRemove }: { sessions: Session[]; onRemove(session: Session): Promise<void> }) {
  const t = useT()
  const [confirming, setConfirming] = useState<string>()
  if (sessions.length === 0) return null
  return (
    <ul className="missing-list" aria-label={t('missing.list')}>
      {sessions.map((session) => (
        <li key={session.id} className="missing-list__item">
          <span className="missing-list__title">{session.title}</span>
          <span className="missing-list__note">{t('missing.note')}</span>
          {confirming === session.id ? (
            <button
              type="button"
              className="session-item__confirm"
              autoFocus
              onClick={() => void onRemove(session)}
              onBlur={() => setConfirming(undefined)}
              onKeyDown={(event) => event.key === 'Escape' && setConfirming(undefined)}
            >
              {t('sidebar.confirmDelete')}
            </button>
          ) : (
            <button type="button" className="session-item__action" aria-label={t('sidebar.deleteChat')} title={t('sidebar.deleteChat')} onClick={() => setConfirming(session.id)}>
              <TrashIcon />
            </button>
          )}
        </li>
      ))}
    </ul>
  )
}

interface ProjectPopoverProps {
  projects: Project[]
  current?: string
  /** 그 프로젝트 대화의 알림 점 (없으면 점 없음) */
  statusOf(project: string): ConversationStatus | undefined
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
function ProjectPopover({ projects, current, statusOf, busy, error, onPick, onOpenFolder, onToggleFavorite, onRemove, onRename, onClose }: ProjectPopoverProps) {
  const t = useT()
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
    { name: t('project.favorites'), items: filtered.filter((project) => project.favorite) },
    { name: t('project.recent'), items: filtered.filter((project) => !project.favorite) },
  ]

  return (
    <div className="project-popover" ref={ref} onKeyDown={walk}>
      <input
        ref={searchRef}
        className="project-popover__search"
        placeholder={t('project.search')}
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
                        aria-label={t('project.nameLabel')}
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
                      {statusOf(project.path) && <StatusDot status={statusOf(project.path)!} />}
                      {project.path === current && <CheckIcon />}
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
                        aria-label={t('project.rename')}
                        title={t('project.renameTitle')}
                        disabled={busy}
                        onClick={() => setEditing(project.path)}
                      >
                        ✎
                      </button>
                      <button
                        type="button"
                        className="project-item__action"
                        aria-label={project.favorite ? t('project.unfavorite') : t('project.favorite')}
                        title={project.favorite ? t('project.unfavorite') : t('project.favorite')}
                        disabled={busy}
                        onClick={() => onToggleFavorite(project)}
                      >
                        {project.favorite ? '★' : '☆'}
                      </button>
                      <button
                        type="button"
                        className="project-item__action"
                        aria-label={t('project.remove')}
                        title={t('project.removeTitle')}
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
        {needle && filtered.length === 0 && <div className="project-popover__empty">{t('project.noMatch')}</div>}
      </div>
      {error && (
        <div className="project-popover__error" role="alert">
          {error}
        </div>
      )}
      <div className="project-popover__divider" />
      <button type="button" className="project-popover__open" disabled={busy} onClick={onOpenFolder}>
        {t('project.openFolder')}
      </button>
      <HoverCard card={hover.card} />
    </div>
  )
}
