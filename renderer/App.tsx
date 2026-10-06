import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactNode, type RefObject } from 'react'
import type { Attention, AttentionAnswer, AttentionTarget, AttachmentKind, ChatEvent, Conversation, ConversationStatus, Mode, OpenTarget, PickedAttachment, Project, ProviderSummary, QueuedSend, TurnItem } from '../shared/ipc.ts'
import { titleFrom, TITLE_MAX } from '../shared/chat.ts'
import { applyChat, applyHistory, applyLive, planEnded, switchedMode, type ChatFields } from './chatState.ts'
import { ago } from './ago.ts'
import { badgeColor, badgeLetters } from './badge.ts'
import { AssistantTurn, UserMessage } from './ChatTurn.tsx'
import { Minimap, useFollowBottom } from './Minimap.tsx'
import { minimapTurns } from './turnView.ts'
import { ScrollToBottom } from './ScrollToBottom.tsx'
import { findModel, initialModel, parseModelRef, type ModelRef } from './modelChoice.ts'
import { ModelSelect } from './ModelSelect.tsx'
import { SettingsModal } from './Settings.tsx'
import { RemotePairPrompt } from './MobileSettings.tsx'
import { StatsBar } from './StatsBar.tsx'
import { Trajectory } from './Trajectory.tsx'
import { chatStats, type ChatUsage } from './stats.ts'
import { useTriggers } from './useTriggers.ts'
import { TriggerPopup } from './TriggerPopup.tsx'
import { ShellDrawer } from './ShellDrawer.tsx'
import { useAppMcp } from './useAppMcp.ts'
import { ShellCard, type ShellCardView } from './ShellCard.tsx'
import { useSettings, useT } from './settingsStore.ts'
import { useFeatures } from './featuresStore.ts'
import { StatusDot, Toasts, useNotices } from './Notices.tsx'
import { otherProjectsStatus, projectStatus } from './noticeView.ts'
import { ModeChip, nextMode } from './ModeChip.tsx'
import { PlusMenu } from './PlusMenu.tsx'
import { useVoiceInput, VoiceButton, VoiceStrip } from './VoiceInput.tsx'
import { AttachmentChips } from './Attachments.tsx'
import { pasteIntent, useFileDrop } from './dropPaste.ts'
import { DropVeil } from './DropVeil.tsx'
import { countOf } from './attachmentsView.ts'
import { OpenInButton } from './OpenInButton.tsx'
import { JobsButton } from './Jobs.tsx'
import { FilePreviewPanel, RightPanelButton } from './FilePreview.tsx'
import { QueueDock } from './QueueDock.tsx'
import { TodoDock } from './Todo.tsx'
import { DelegationContext, FromIcon } from './Delegation.tsx'
import { peerOf, projectTargets, sidebarMark } from './delegationView.ts'
import { RunningCount, RunningFilter } from './Background.tsx'
import { runningIn, runningOutside } from './backgroundView.ts'
import { StopIcon, useEscapeTwice, useStopTurn } from './stopTurn.tsx'
import { changeDraft, draftOf, restoreInto, withoutDrafts, type Draft, type Drafts } from './drafts.ts'
import { browseHistory, sentTexts } from './inputHistory.ts'
import { questionDrafts } from './Attention.tsx'
import { ErrorBoundary } from './ErrorBoundary.tsx'
import { ChatFind, FindingProvider } from './ChatFind.tsx'
import { PinButton, PinnedMark, SessionSearch } from './SessionListTools.tsx'
import { matchesTitle, pinnedFirst } from './sessionListView.ts'

/** 말풍선·도는 턴(pending·progress·sentAt·attention)·대기열·제목·시각·통계는 메인(ctx.chat)이 정한다 — 이벤트로 받아 입힌다 (chatState.ts).
 *  답이 실패·중단이면 message.error 에 사유 (`⚠️ 사유` 로 그린다) */
interface Session extends ChatFields {
  id: string
  /** 이 대화가 속한 프로젝트(작업 디렉터리) — 사이드바는 현재 프로젝트의 대화만 보여준다 */
  project: string
  /** 엔진 쪽 세션 id — 첫 메시지를 보낼 때 생기고, 그 뒤로는 계속 재사용한다 */
  engineSessionId?: string
  /** 입력창 드롭다운에서 고른 이 대화의 모델. 없으면(아직 안 고르고 안 보낸 새 대화) 마지막으로 고른 모델을 따른다.
   *  대화 중에 바꾸면 다음 턴부터 그 모델로 간다 (엔진 세션의 모델은 ctx.llm 이 바꾼다) */
  model?: ModelRef
  /** 입력창 칩의 모드. 없으면 설정의 "새 대화 기본 모드". 바꾸면 다음 턴을 보낼 때 엔진 세션이 그 모드가 된다 (ctx.llm) */
  mode?: Mode
  /** `!명령` 결과 카드 — 저장된 것은 메인(ctx.sessions)이 정본이고, 여기는 화면 사본 + 돌고 있는 카드 */
  shells?: ShellCardView[]
  /** 마지막 활동 시각(ms) — 목록에 `38min`·`1d` 로 보이고, 보관 개수 제한의 기준이 된다 */
  updatedAt: number
  /** 고정한 대화 (이슈 #79) — 목록 맨 위 묶음. 정본은 메인(ctx.sessions) */
  pinned?: boolean
  /** 입력창 아래 통계 줄의 값 — 턴마다 엔진이 주는 사용량·시간을 메인이 이 대화에 더한다. 없으면 "—" */
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
function toConversation({ id, project, engineSessionId, title, updatedAt, model, mode, usage }: Session): Conversation {
  return { id, project, engineSessionId, title, updatedAt, model, mode, usage }
}

function fromConversation(conversation: Conversation): Session {
  return { ...conversation, usage: conversation.usage as ChatUsage | undefined, messages: [], history: 'unloaded', shells: conversation.shells }
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

// 답·내 말(ChatTurn.tsx)은 memo 다 — 입력창에 글자를 칠 때마다 App 이 다시 그려져도 props 가 같으면 턴을 다시 그리지 않는다.
// 그래서 턴에 넘기는 "없음" 배열과 답 보내기 함수는 매번 새로 만들지 않는다
const NO_ITEMS: readonly TurnItem[] = []
const answerAttention = (request: Attention, answer: AttentionAnswer, target?: AttentionTarget) =>
  window.litecode.replyAttention(request.sessionId, request.id, answer, target)

/** 16px 외곽선 톱니 — dsh 사이드바 설정 줄의 아이콘 자리 */
function GearIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" aria-hidden="true">
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

function PencilIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M11.2 2.6L13.4 4.8L5.6 12.6L2.8 13.2L3.4 10.4Z" />
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

function SidebarIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" aria-hidden="true">
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
  /** 켜진 기능 (설정 > 기능) — 꺼진 기능의 버튼·탭·단축키는 그리지 않는다 */
  const features = useFeatures()
  const featuresRef = useRef(features)
  featuresRef.current = features
  /** Trajectory 탭 — 설정 > 기능의 추론 과정이 켜져야 보인다 */
  const trajectoryOn = features.has('trajectory')
  const terminalOn = features.has('terminal')
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
  /** 프로젝트 경로 → 마지막에 보던 **저장된** 대화 (이슈 #137) — 메인이 저장한다(앱을 껐다 켜도 남는다). 다른 프로젝트에 지시를 보낼 때 받는 대화.
   *  activeIds 와 다르다: 그쪽은 이번 실행 동안만이고 빈 새 대화도 가리킨다 */
  const [lastViewed, setLastViewed] = useState<Record<string, string>>({})
  const [switching, setSwitching] = useState(false)
  /** 폴더를 고르거나 여는 중 — 한 번에 하나만 (dsh ui-workspace) */
  const [picking, setPicking] = useState(false)
  /** 프로젝트를 못 열었을 때의 사유 — 팝오버와 첫 실행 안내에 보인다 */
  const [openError, setOpenError] = useState<string>()
  /** 못 연 프로젝트 경로 — 안내 화면이 그 폴더의 저장된 대화를 "폴더가 없습니다" 로 보이고 지우게만 한다 (열지 않는다 — opencode 요청 0) */
  const [failedProject, setFailedProject] = useState<string>()
  const switchRef = useRef<HTMLButtonElement>(null)
  /** 입력창의 글과 붙여 둔 파일·이미지 칩 (이슈 #44) — 대화마다 따로 둔다 (drafts.ts). 대화를 바꾸면 그 대화의 초안이 돌아온다 */
  const [drafts, setDrafts] = useState<Drafts>({})
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
  /** 다른 대화의 지시로 새로 생긴 대화 — 사이드바에 "새로 생김" 으로 보이고 한 번 열면 빠진다 (이슈 #55). 화면이 떠 있는 동안만 기억한다 */
  const [fresh, setFresh] = useState<ReadonlySet<string>>(new Set())

  useEffect(() => {
    void window.litecode.listProviders().then(setProviders)
    // 이번 실행에 이미 본 것(아래 효과가 적는다)이 먼저다
    void window.litecode.lastViewed().then((stored) => setLastViewed((now) => ({ ...stored, ...now })), () => {})
    // 저장된 대화 목록을 먼저 올린다 — 프로젝트를 열 때 "대화가 없으면 새 대화" 가 저장된 대화를 보고 판단하게.
    // 앱을 켜면 마지막 프로젝트(목록 맨 앞)를 열어 본다. 디스크에서 지워졌으면 안내 화면에 사유를 보이고,
    // 다른 프로젝트로 몰래 넘어가지 않는다 — 사용자가 고르지 않은 폴더에서 대화가 돌면 안 된다.
    // 목록은 그 뒤에 보인다 (열어 보는 동안 안내 화면이 번쩍이지 않게). 켠 직후에는 저장된 대화 위의 새 대화에서 시작한다
    void (async () => {
      const stored = (await window.litecode.listConversations()).map(fromConversation)
      // 메인이 쥔 도는 턴·대기열을 입힌다 — 창을 닫았다 열어도 진행 줄·대기열이 이어져 보인다 (그 뒤는 이벤트로)
      const live = await window.litecode.chatSnapshot()
      setSessions(stored.map((session) => applyLive(session, live[session.id])))
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

  /** 보관 개수를 넘어 지워진 대화는 화면에서도 뺀다 */
  function forgetPruned(ids: string[]): void {
    if (ids.length === 0) return
    setSessions((sessionsNow) => sessionsNow.filter((session) => !ids.includes(session.id)))
    setDrafts((now) => withoutDrafts(now, ids))
  }

  // 대화의 턴·대기열은 메인(ctx.chat)이 쥔다 — 내 말·진행 줄·승인 카드·답·대기열을 이벤트로 받아 그 대화에 입힌다 (대화 id 로 온다).
  // 제목·시각·통계도 메인이 저장한 것이 실려 온다. 턴이 시작되면 맨 아래를 따라간다
  useEffect(() => {
    const apply = (event: ChatEvent & { data: { cid: string } }) => updateSession(event.data.cid, (session) => applyChat(session, event))
    const offs = [
      window.litecode.onTurnStarted((data) => {
        // 보는 대화의 턴일 때만 — 다른 대화의 턴이 지금 읽던 자리를 맨 아래로 끌고 가지 않게
        if (data.cid === activeIdRef.current) following.current = true
        // 화면이 모르는 대화의 턴 — 화면 밖(짝지은 폰)에서 새로 만든 대화다. 메인이 저장한 목록 정보로 목록에 넣는다.
        // 내용은 이 턴이 전부라 엔진에서 다시 부르지 않는다 (history 없음 = 이번 실행에 만든 대화)
        if (!sessionsRef.current.some((session) => session.id === data.cid)) {
          const created: Session = { ...fromConversation(data.conversation), history: undefined }
          setSessions((sessionsNow) => (sessionsNow.some((session) => session.id === data.cid) ? sessionsNow : [created, ...sessionsNow]))
          if (data.origin !== 'user') setFresh((now) => new Set(now).add(data.cid))
        }
        apply({ event: 'turn.started', data })
      }),
      window.litecode.onTurnProgress((cid, item) => apply({ event: 'turn.progress', data: { cid, item } })),
      window.litecode.onTurnAttention((cid, requests) => apply({ event: 'turn.attention', data: { cid, requests } })),
      window.litecode.onTurnEnded((data) => apply({ event: 'turn.ended', data })),
      window.litecode.onQueueChanged((data) => apply({ event: 'queue.changed', data })),
      window.litecode.onConversationsChanged((data) => forgetPruned(data.removed)),
    ]
    return () => offs.forEach((off) => off())
  }, [])
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
  const activeIdRef = useRef<string>(undefined)
  activeIdRef.current = active?.id
  /** 지금 대화의 초안 — 아래 함수들은 이 그리기의 대화에 묶인다 (기다린 뒤에 불려도 그때 보던 대화의 초안을 고친다) */
  const { text: draft, attached } = draftOf(drafts, active?.id)
  function changeDraftOf(id: string, change: (draft: Draft) => Draft): void {
    setDrafts((now) => changeDraft(now, id, change))
  }
  const setDraft = (text: string): void => {
    if (active) changeDraftOf(active.id, (now) => (now.text === text ? now : { ...now, text }))
  }
  const setAttached = (change: (now: PickedAttachment[]) => PickedAttachment[]): void => {
    if (active) changeDraftOf(active.id, (now) => ({ ...now, attached: change(now.attached) }))
  }
  /** 입력 기록(↑/↓)으로 불러와 있는 글의 자리 — 그 대화의 것만 (inputHistory.ts) */
  const browsing = useRef<{ id: string; index: number }>(undefined)
  // 질문 카드에 쓰던 답은 요청이 기다리는 동안만 쥔다 — 풀린 요청(답함·거절·턴 끝)의 것은 버린다
  useEffect(() => questionDrafts.keepOnly(sessions.flatMap((session) => (session.attention ?? []).map((request) => request.id))), [sessions])
  // 맨 아래에 있으면 내용이 늘 때 따라 내려간다 — 위로 올려 읽는 중(미니맵 이동 포함)이면 그대로 둔다
  const following = useFollowBottom(listRef, `${active?.id}:${view}`)
  /** 이 대화의 모델 — 설정에서 지워졌으면 chosen 이 없고 보내기가 막힌다 */
  const selected = active?.model ?? initialModel(providers, lastModel)
  const chosen = findModel(providers, selected)
  /** 이 대화의 모드 — 고른 적 없으면 새 대화 기본 모드 */
  const mode = active?.mode ?? settings.defaultMode
  /** 알림 — 메인이 쥔 대화별 상태(점)와 앞일 때의 토스트. 지금 보는 대화를 메인에 알린다 */
  const notices = useNotices(active?.id, features.has('notifications'))
  /** 지금 프로젝트에서 도는 대화 — "진행 중 N" 을 누르면 목록이 이것만 보인다. 알림 기능과 무관하다 — 대화별 pending 으로 센다 (backgroundView.ts) */
  const running = runningIn(sessions, project?.path)
  const [runningOnly, setRunningOnly] = useState(false)
  /** 대화 목록 위 찾기 칸의 글 (이슈 #79) — 제목으로 거른다. "진행 중" 필터와 함께 걸린다. 고정한 대화가 위 */
  const [titleQuery, setTitleQuery] = useState('')
  const listed = pinnedFirst(
    (runningOnly && running.length > 0 ? visible.filter((session) => running.includes(session.id)) : visible).filter((session) => matchesTitle(titleOf(session), titleQuery)),
  )
  /** 대화 안 찾기가 찾는 중 (이슈 #79) — 접힌 작업 줄이 숨긴 채 그려진다 (ChatFind.tsx) */
  const [finding, setFinding] = useState(false)
  /** 답변 중지 — 입력창 ■·행 ■·Esc 두 번 (이슈 #3). 대기열은 보내지 않고 입력창으로 되돌린다 */
  const stopTurn = useStopTurn(active?.id, !!active?.held, restoreQueued)
  useEscapeTwice('.chat-pane, .composer', active?.pending ? active.id : undefined, stopTurn)
  // 파일을 대화 영역 위로 끌면 놓을 자리 표시, 놓으면 칩 (이슈 #80). 쓸 수 없는 대화면 받지 않는다 — 어느 쪽이든 창 이동은 막는다
  const dropping = useFileDrop('.main', active && canWrite(active) ? (files) => void attachFiles(files) : undefined)

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
    if (!featuresRef.current.has('notifications')) return
    const target = await window.litecode.takePendingOpen().catch(() => undefined)
    if (target) await openNotice(target)
  }

  /** 휴지통을 눌러 "삭제 확인" 을 기다리는 대화 */
  const [confirming, setConfirming] = useState<string>()
  /** 이름을 바꾸는 중인 대화 (이슈 #63) — 프로젝트 이름 바꾸기처럼 행이 그 자리에서 입력칸으로 바뀐다. Enter·바깥으로 나가면 저장, Esc 는 취소 */
  const [renaming, setRenaming] = useState<string>()
  /** Esc 로 그만둔 입력칸이 사라지며 내는 blur 는 저장하지 않는다 */
  const renameCancelled = useRef(false)
  // 한 번 연 대화는 "새로 생김" 이 아니다
  useEffect(() => {
    if (active && fresh.has(active.id)) setFresh((now) => new Set([...now].filter((id) => id !== active.id)))
  }, [active?.id, fresh])
  // 지금 보는 저장된 대화를 그 프로젝트의 "마지막에 보던 대화" 로 메인에 알린다 (이슈 #137). 빈 새 대화는 알리지 않는다 — 첫 글을 보내 저장되면
  // (saved 가 바뀐다) 그때 알린다. 메인은 저장 안 된 id 를 무시한다
  const viewedId = active && !isBlank(active) ? active.id : undefined
  const viewedProject = active?.project
  useEffect(() => {
    if (!viewedId || !viewedProject) return
    setLastViewed((now) => (now[viewedProject] === viewedId ? now : { ...now, [viewedProject]: viewedId }))
    void window.litecode.markViewed(viewedId).catch(() => {})
  }, [viewedId, viewedProject])
  /** 다른 프로젝트에 지시 보내기 (이슈 #55·#137) 의 화면 조각이 쓰는 것 — 저장된 대화 전부(제목·상태·모드), 다른 프로젝트마다 마지막에 보던 대화,
   *  지금 대화의 모드·지금 프로젝트의 이름, 대화 열기(다른 프로젝트의 대화면 그 프로젝트로 넘어간다 — 알림을 눌렀을 때와 같은 길).
   *  값이 같으면 같은 객체다 — 컨텍스트를 읽는 작업 줄이 타자마다 다시 그려지지 않게 */
  const projectPath = project?.path
  const projectName = project?.name
  const openConversation = useRef(openNotice)
  openConversation.current = openNotice
  const delegation = useMemo(() => {
    const peers = sessions
      .filter((session) => !isBlank(session))
      .map((session) => peerOf(session, notices.state[session.id]?.status, session.history !== 'missing' && !!findModel(providers, session.model)))
    return {
      peers,
      targets: projectTargets(projects ?? [], lastViewed, peers, projectPath),
      self: { mode, project: projectName },
      open: (id: string) => {
        const target = sessionsRef.current.find((session) => session.id === id)
        if (target) void openConversation.current({ project: target.project, conversationId: id })
      },
    }
  }, [sessions, projects, lastViewed, projectPath, projectName, notices.state, providers, mode])
  /** 터미널 칸이 펴진 프로젝트 — 프로젝트마다 따로 (closed-code 셸 서랍) */
  const [shellOpen, setShellOpen] = useState<Record<string, boolean>>({})
  /** ⌘↓ 를 누른 횟수 — 칸이 이미 펴져 있어도 키를 칸으로 내린다 */
  const [shellFocus, setShellFocus] = useState(0)
  /** AI 가 칸을 폈을 때의 shellFocus (앱 MCP open(터미널), 이슈 #51) — 그렇게 편 칸은 키를 가져가지 않는다. ⌘↓ 를 누르면 값이 달라져 풀린다 */
  const [shellQuietAt, setShellQuietAt] = useState<number>()
  useAppMcp(features.has('appMcp'), active?.project, (directory) => {
    setShellQuietAt(shellFocus)
    setShellOpen((open) => ({ ...open, [directory]: true }))
  })
  const trigger = useTriggers({
    directory: active?.project,
    conversation: active?.id,
    draft,
    setDraft,
    onSend: (text, display) => send({ text, display }),
    onShell: (_directory, command) => void runShell(command),
    onApp: async (command) => {
      if (command === 'clear') return void startNewChat()
      if (!active) return undefined
      // 아직 한 번도 안 보낸 대화(메인에 없다)도 메인이 "요약할 내용이 없다" 로 답한다
      const started = await window.litecode.compactChat(active.id)
      return started.ok ? undefined : started.error
    },
  })
  /** 음성 입력 (이슈 #109) — 받아쓴 글은 녹음을 시작한 대화의 초안에 넣기만 한다 (VoiceInput.tsx) */
  const voice = useVoiceInput({
    sessionId: active?.id,
    inputRef: trigger.inputRef,
    hasSession: (id) => sessions.some((session) => session.id === id),
    edit: (id, change) => changeDraftOf(id, (now) => ({ ...now, text: change(now.text) })),
  })
  /** Enter·보내기 — 입력 트리거(`/`·`!`)가 다루지 않으면 평범하게 보낸다 */
  const submit = () =>
    void trigger.submit().then((handled) => {
      if (!handled) send()
    })

  // 터미널 칸 — ⌘↓ 로 펴고 키를 칸으로 내리고, ⌘↑ 로 접고 입력창으로 올라온다 (closed-code useShellDrawer. Windows·Linux 는 Ctrl).
  // `!` 로는 안 열린다(`!명령` 은 대화 카드). ⌘⇧↑ 은 글 선택 확장이라 건드리지 않는다. 칸이 접혀 있으면 ⌘↑ 은 입력창의 것이다
  const drawerProject = active?.project
  const drawerOpen = !!drawerProject && !!shellOpen[drawerProject]
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      const command = navigator.platform.startsWith('Mac') ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey
      if (!command || event.shiftKey || event.altKey || !drawerProject || !terminalOn) return
      // 판(aria-modal)이 떠 있으면 물러난다 (⌘F 와 같다 — ChatFind.tsx). 입력창·터미널 칸이 아닌 글 칸에서는 ⌘↓/⌘↑ 이 그 칸의 커서 이동이다
      if (document.querySelector('[aria-modal="true"]')) return
      const target = event.target instanceof HTMLElement ? event.target : undefined
      if (target?.matches('input, textarea, [contenteditable]') && !target.closest('.composer__input, .shell-drawer')) return
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
  }, [drawerProject, drawerOpen, terminalOn])

  // 저장된 대화를 처음 열면 내용을 엔진에서 부른다. 폴더가 없으면 엔진에 묻지 않고 "폴더가 없습니다" (ctx.llm.history)
  useEffect(() => {
    if (active?.history !== 'unloaded') return
    const id = active.id
    updateSession(id, (session) => ({ ...session, history: 'loading' }))
    void window.litecode.loadConversation(id).then((loaded) =>
      updateSession(id, (session) => ({
        ...applyHistory(session, [...loaded.messages, ...(loaded.error ? [{ role: 'assistant' as const, text: `⚠️ ${loaded.error}` }] : [])]),
        history: loaded.missingFolder ? 'missing' : 'loaded',
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

  /** 전환 버튼(사이드바 카드·접힌 줄의 배지) — 고를 최근 프로젝트가 없으면 한 줄짜리 팝오버 대신 바로 폴더 열기 (dsh ui-workspace) */
  function toggleSwitcher(): void {
    if (projects?.length === 0) void openFolder()
    else setSwitching((open) => !open)
  }

  /** 새 대화 — 빈 대화는 첫 메시지 전까지 하나만 (dsh ui-workspace). 이미 있으면 새로 만들지 않고 그리로 간다 */
  function startNewChat(): void {
    if (!project) return
    const blank = sessions.find((session) => session.project === project.path && isBlank(session))
    const session = blank ?? newSession(project.path)
    if (!blank) setSessions((sessionsNow) => [session, ...sessionsNow])
    setActiveIds((current) => ({ ...current, [project.path]: session.id }))
  }

  function updateSession(id: string, mutate: (session: Session) => Session): void {
    setSessions((sessionsNow) => sessionsNow.map((session) => (session.id === id ? mutate(session) : session)))
  }

  /** 대화를 지운다 — 목록에서 빼고 엔진 세션도 (ctx.sessions). 되돌리기 없음. 그 프로젝트에 대화가 안 남으면 새 대화를 둔다 */
  async function removeConversation(target: Session): Promise<void> {
    setConfirming(undefined)
    await window.litecode.removeConversation(target.id)
    setDrafts((now) => withoutDrafts(now, [target.id]))
    const rest = (sessionsNow: Session[]) => sessionsNow.filter((session) => session.id !== target.id)
    // 안내 화면(못 연 프로젝트)에서 지운 것이면 새 대화를 두지 않는다 — 열린 프로젝트에만
    setSessions((sessionsNow) => (target.project === current ? withSessionFor(target.project)(rest(sessionsNow)) : rest(sessionsNow)))
  }

  /** 대화 이름 바꾸기 (이슈 #63) — 제목은 메인(ctx.chat)이 적는다. 빈 이름·그대로인 이름은 보내지 않는다. 도는 중이어도 된다 */
  async function renameConversation(target: Session, name: string): Promise<void> {
    const title = name.trim()
    if (!title || title === target.title) return
    const renamed = await window.litecode.renameConversation(target.id, title)
    if (renamed) updateSession(target.id, (session) => ({ ...session, title: renamed.title }))
  }

  /** 대화 고정·해제 (이슈 #79) — 이름 바꾸기처럼 메인(ctx.chat)이 적는다 */
  async function pinConversation(target: Session): Promise<void> {
    const changed = await window.litecode.pinConversation(target.id, !target.pinned)
    if (changed) updateSession(target.id, (session) => ({ ...session, pinned: changed.pinned }))
  }

  // 고른 모드·모델은 저장된 대화면 메인에도 적는다 (새 대화는 첫 보내기가 정한다) — 대기열의 다음 턴이 그것으로 간다
  function chooseMode(next: Mode): void {
    if (!active) return
    updateSession(active.id, (session) => ({ ...session, mode: next }))
    void window.litecode.patchConversation(active.id, { mode: next })
  }

  function chooseModel(next: ModelRef): void {
    if (active) {
      updateSession(active.id, (session) => ({ ...session, model: next }))
      void window.litecode.patchConversation(active.id, { model: next })
    }
    setLastModel(next)
  }

  /** 대기열에서 꺼낸 것(되돌리기·멈춘 턴)을 그 대화의 초안으로 — 글은 입력 앞에, 첨부 칩도 함께 */
  function restoreQueued(id: string, taken: QueuedSend): void {
    changeDraftOf(id, (now) => restoreInto(now, taken))
  }

  /** `+` 메뉴의 파일 추가·이미지 추가 — 메인이 OS 파일 고르기를 띄우고 거른다. 고른 것은 칩으로 쌓고, 못 붙인 사유는 짧은 안내로.
   *  상한(한 메시지 N개)은 입력 카드의 칩과 이 대화 대기열의 첨부를 합쳐 센다 — 턴 끝에 한 메시지로 합쳐 나간다 */
  async function addAttachments(kind: AttachmentKind): Promise<void> {
    if (!active) return
    const result = await window.litecode.pickAttachments(kind, active.project, countOf(kind, attached, active.queuedAttachments))
    setAttached((now) => [...now, ...result.picked.filter((item) => !now.some((held) => held.path === item.path && held.kind === item.kind))])
    for (const reason of result.rejected) notices.say(reason)
    trigger.inputRef.current?.focus()
  }

  /** 붙여넣거나 끌어다 놓은 파일 (이슈 #80) — File 객체를 그대로 넘긴다(경로는 preload, 종류·상한·사유는 메인). 그 뒤는 고른 것과 같은 칩 */
  async function attachFiles(files: File[]): Promise<void> {
    if (!active || files.length === 0) return
    const id = active.id
    const held = { file: countOf('file', attached, active.queuedAttachments), image: countOf('image', attached, active.queuedAttachments) }
    const result = await window.litecode.attachFiles(id, files, held, selected)
    changeDraftOf(id, (now) => ({ ...now, attached: [...now.attached, ...result.picked.filter((item) => !now.attached.some((had) => had.path === item.path && had.kind === item.kind))] }))
    for (const reason of result.rejected) notices.say(reason)
    trigger.inputRef.current?.focus()
  }

  /** command: `/` 명령 — text 를 보내고 말풍선·제목엔 display. mode: 이 턴부터 그 모드로 ("이 계획대로 실행").
   *  보내기는 메인(ctx.chat)에 부탁한다 — 그 대화의 턴이 도는 중이면 메인이 대기열에 쌓고 턴 끝에 합쳐 보낸다. 내 말·답은 이벤트로 온다.
   *  첨부는 command.attachments(없음을 뜻하는 빈 목록), 안 주면 입력 카드의 칩 — 보내면 칩을 비운다 */
  function send(command?: { text: string; display?: string; attachments?: PickedAttachment[] }, opts: { mode?: Mode } = {}): void {
    const target = active
    const prompt = command?.text ?? draft.trim()
    const fromCard = !command?.attachments
    const files = command?.attachments ?? attached
    const selected = target?.model ?? initialModel(providers, lastModel)
    if ((!prompt && files.length === 0) || !selected || !findModel(providers, selected) || !target || !canWrite(target)) return
    // 보낸 대화의 초안만 비운다
    changeDraftOf(target.id, (now) => ({ text: '', attached: fromCard ? [] : now.attached }))
    void window.litecode.sendMessage(target.id, {
      project: target.project,
      text: prompt,
      display: command?.display,
      mode: opts.mode ?? mode,
      model: selected,
      ...(files.length > 0 && { attachments: files }),
    })
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
      title: isBlank(session) ? titleFrom(`!${command}`) : session.title,
      shells: [...(session.shells ?? []), card],
    })
    updateSession(target.id, start)
    // 카드를 붙일 대화가 메인에 먼저 있어야 한다 — 빈 새 대화는 아직 저장 전이라 여기서 넣는다. 저장된 대화는 시각만 고친다
    // (통째로 저장하면 메인이 적은 통계·엔진 세션을 덮을 수 있다)
    const conversation = toConversation(start(target))
    if (isBlank(target)) forgetPruned(await window.litecode.saveConversation(conversation))
    else await window.litecode.patchConversation(target.id, { updatedAt: conversation.updatedAt })
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
    if (!features.has('shell')) return [] // 설정 > 기능에서 `!명령` 을 껐다 — 카드는 sessions.json 에 남고 다시 켜면 보인다
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

  // 프로젝트 전환 팝오버 — 펼친 사이드바에선 전환 카드 아래, 접힌 줄에선 배지 옆에 뜬다 (한 번에 한 곳)
  const popover = switching && (
    <ProjectPopover
      projects={projects ?? []}
      current={project?.path}
      statusOf={(dir) => projectStatus(notices.state, dir)}
      runningOf={(dir) => runningIn(sessions, dir).length}
      busy={picking}
      error={openError}
      onPick={(picked) => void pickRecent(picked)}
      onOpenFolder={() => void openFolder()}
      onToggleFavorite={(target) => void toggleFavorite(target)}
      onRemove={remove}
      onRename={async (target, name) => setProjects(await window.litecode.renameProject(target.path, name))}
      onClose={closeSwitcher}
    />
  )

  return (
    <div className="app">
      {/* 사이드바를 접으면 56px 아이콘 줄이 남는다 (이슈 #60 시안). 대화 머리(창 끌기 줄)와 나란히 놓여 겹치지 않으므로 줄의 버튼은
          끌기 영역에 덮이지 않는다 (styles.css 창 끌기 주석) */}
      {layout.hidden && (
        <Rail
          project={project}
          picking={picking}
          notice={otherProjectsStatus(notices.state, project?.path)}
          running={running.length}
          switchRef={switchRef}
          settingsRef={settingsRef}
          onExpand={() => setLayout((now) => ({ ...now, hidden: false }))}
          onNewChat={startNewChat}
          onSwitch={toggleSwitcher}
          onRunning={() => {
            setLayout((now) => ({ ...now, hidden: false }))
            setRunningOnly(true)
          }}
          onSettings={() => setSettingsOpen(true)}
        >
          {popover}
        </Rail>
      )}
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
            ref={layout.hidden ? undefined : switchRef}
            disabled={picking}
            onClick={toggleSwitcher}
          >
            {project && <Badge project={project} />}
            <span className="project-switch__text" onMouseEnter={(event) => startMarquee(event.currentTarget)} onMouseLeave={(event) => stopMarquee(event.currentTarget)}>
              <span className="project-switch__name">{project?.name ?? t('sidebar.noProject')}</span>
              {project && <span className="project-switch__path marquee">{project.displayPath}</span>}
            </span>
            {otherProjectsStatus(notices.state, project?.path) && (
              <StatusDot status={otherProjectsStatus(notices.state, project?.path)!} className="project-switch__notice" />
            )}
            <RunningCount
              count={runningOutside(sessions, project?.path)}
              label={t('sidebar.runningElsewhere', { count: runningOutside(sessions, project?.path) })}
              className="project-switch__running"
            />
            <span className="project-switch__caret">▾</span>
          </button>
          {!layout.hidden && popover}
        </div>

        <div className="sidebar__new">
          <button
            type="button"
            className="new-chat"
            disabled={!project}
            onClick={startNewChat}
          >
            {t('sidebar.newChat')}
          </button>
        </div>

        <div className="sidebar__label">
          {t('sidebar.conversations')}
          <RunningFilter count={running.length} on={runningOnly} onToggle={() => setRunningOnly((on) => !on)} />
        </div>
        <SessionSearch value={titleQuery} onChange={setTitleQuery} />

        <div className="sidebar__sessions">
          {/* 행의 휴지통은 dsh ui-workspace 세션 행의 hover 버튼처럼 hover·포커스 때만 시각 자리에 보인다. 누르면 "삭제 확인" 으로
              바뀌고 한 번 더 눌러야 지운다(설정 화면 provider 삭제와 같은 방식). 포커스를 잃거나 Esc 면 되돌린다 */}
          {listed.length === 0 && titleQuery.trim() && <div className="session-list__empty">{t('sidebar.noMatch')}</div>}
          {listed.map((session, at) => (
            <Fragment key={session.id}>
            {/* 고정 묶음과 나머지 사이의 선 */}
            {at > 0 && !session.pinned && listed[at - 1]!.pinned && <div className="session-list__divider" role="separator" />}
            <div
              data-hover-row
              className={`session-item${session.id === active?.id ? ' session-item--active' : ''}${confirming === session.id ? ' session-item--confirming' : ''}`}
            >
              {renaming === session.id ? (
                <input
                  className="session-item__rename"
                  aria-label={t('sidebar.chatNameLabel')}
                  defaultValue={session.title}
                  maxLength={TITLE_MAX}
                  autoFocus
                  onFocus={(event) => event.currentTarget.select()}
                  onKeyDown={(event) => {
                    if (event.nativeEvent.isComposing || event.keyCode === 229) return // 한글 조합 확정 Enter
                    if (event.key === 'Enter') event.currentTarget.blur()
                    if (event.key === 'Escape') {
                      event.preventDefault() // 이 Esc 는 여기서 썼다 — 녹음(VoiceInput)까지 취소하지 않게
                      renameCancelled.current = true
                      setRenaming(undefined)
                    }
                  }}
                  onBlur={(event) => {
                    setRenaming(undefined)
                    if (!renameCancelled.current) void renameConversation(session, event.currentTarget.value)
                  }}
                />
              ) : (
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
                {session.pinned && <PinnedMark />}
                {/* 시각 자리 — 지시로 새로 생긴 대화는 "새로 생김", 다른 대화가 시킨 일을 하는 중이면 그 아이콘 (이슈 #55 시안) */}
                {sidebarMark(session, fresh) === 'fresh' ? (
                  <span className="session-item__fresh">{t('delegate.sidebar.fresh')}</span>
                ) : sidebarMark(session, fresh) === 'delegated' ? (
                  <span className="session-item__mark">
                    <FromIcon size={14} label={t('delegate.sidebar.running')} />
                  </span>
                ) : (
                  !isBlank(session) && <span className="session-item__time">{ago(session.updatedAt, now)}</span>
                )}
              </button>
              )}
              {/* 연필 — 이름 바꾸기 (저장된 대화만, 도는 중에도). 도는 대화는 휴지통 자리에 ■ — 답변 중지 (01l A4) */}
              {renaming !== session.id && (session.pending || !isBlank(session)) && (
                <span className="session-item__actions">
                  {!isBlank(session) && confirming !== session.id && (
                    <button
                      type="button"
                      className="session-item__action"
                      aria-label={t('sidebar.renameChat')}
                      title={t('sidebar.renameChat')}
                      onClick={() => {
                        renameCancelled.current = false
                        setRenaming(session.id)
                      }}
                    >
                      <PencilIcon />
                    </button>
                  )}
                  {!isBlank(session) && confirming !== session.id && <PinButton pinned={!!session.pinned} onToggle={() => void pinConversation(session)} />}
                  {session.pending ? (
                    <button
                      type="button"
                      className="session-item__action session-item__stop"
                      aria-label={t('sidebar.stopChat')}
                      title={t('sidebar.stopChat')}
                      onClick={() => stopTurn(session.id)}
                    >
                      <StopIcon size={14} />
                    </button>
                  ) : confirming === session.id ? (
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
            </Fragment>
          ))}
        </div>
        <div className="sidebar__fade" aria-hidden="true" />
        <HoverCard card={sessionHover.card} />

        <div className="sidebar__foot">
          <button
            type="button"
            className="settings-trigger"
            ref={layout.hidden ? undefined : settingsRef}
            onClick={() => setSettingsOpen(true)}
          >
            <GearIcon />
            {t('sidebar.settings')}
          </button>
        </div>
      </aside>

      <main className={`main${layout.hidden ? ' main--railed' : ''}`}>
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
          <DelegationContext.Provider value={delegation}>
            <div className="main__header">
              {titleOf(active)}
              {/* 도는 작업 목록 (#32) — 하위 작업이 있는 턴이 도는 동안만, 열기 버튼 왼쪽 */}
              {active.pending && <JobsButton key={active.id} items={active.progress ?? []} startedAt={active.sentAt} />}
              {features.has('openIn') && <OpenInButton directory={active.project} />}
              <RightPanelButton directory={active.project} />
            </div>
            {/* 설정 > 기능의 추론 과정을 끄면 탭 줄째 숨기고 대화만 (dsh Coding Tools) */}
            {trajectoryOn && (
              <div className="main__tabs" role="tablist" aria-label={t('main.views')}>
                {(['chat', 'trajectory'] as const).map((tab) => (
                  <button key={tab} type="button" role="tab" className="main__tab" aria-selected={view === tab} onClick={() => setView(tab)}>
                    {tab === 'chat' ? t('main.tabChat') : t('main.tabTrajectory')}
                  </button>
                ))}
              </div>
            )}

            {/* 대화 본문의 그리기 오류가 사이드바·입력창까지 내리지 않게 — 다른 대화·탭으로 가면 풀린다 (ErrorBoundary.tsx) */}
            <ErrorBoundary scope="section" className="crash--fill" resetKey={`${active.id}:${view}`}>
            {trajectoryOn && view === 'trajectory' ? (
              <Trajectory key={active.id} directory={active.project} sessionId={active.engineSessionId} pending={!!active.pending} />
            ) : (
            <div className="chat-pane">
            {/* 대화 안 찾기 (이슈 #79) — ⌘F. 대화를 바꾸면 닫힌다 (key) */}
            <ChatFind key={active.id} scroller={listRef} onFinding={setFinding} />
            <FindingProvider value={finding}>
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
                  {message.role === 'user' && switchedMode(active.messages, index) && (
                    <div className="mode-divider" data-mode={message.mode} role="separator">
                      {t('mode.switched', { name: t(`mode.${message.mode!}`) })}
                    </div>
                  )}
                  {message.role === 'user' ? (
                    <UserMessage text={message.text} at={message.at} attachments={message.attachments} origin={message.origin} />
                  ) : (
                    <AssistantTurn
                      items={message.items ?? NO_ITEMS}
                      text={message.error ? `⚠️ ${message.error}` : message.text}
                      failed={!!message.error}
                      interrupted={message.interrupted}
                      declined={message.declined}
                      duration={message.duration}
                      directory={active.project}
                    />
                  )}
                </Fragment>
              ))}
              {/* 계획 모드로 끝난 마지막 턴 — 누르면 기본 모드로 바꾸고 이어 실행. 신규 세대 opencode 는 "이제 실행해도 된다" 를
                  안 붙이므로 보내는 문장이 그 역할을 한다 (01k §5) */}
              {!active.pending && planEnded(active.messages) && (
                <button
                  type="button"
                  className="run-plan"
                  disabled={!chosen}
                  onClick={() => {
                    const text = t('mode.runPlanPrompt')
                    send({ text, display: text, attachments: [] }, { mode: 'build' }) // 입력 카드의 칩은 그대로 둔다
                  }}
                >
                  {t('mode.runPlan')}
                </button>
              )}
              {shellCards(active, (position) => position === active.messages.length)}
              {active.pending && (
                <AssistantTurn
                  key="running"
                  running
                  items={active.progress ?? NO_ITEMS}
                  text=""
                  startedAt={active.sentAt}
                  directory={active.project}
                  attention={active.attention}
                  onAnswer={answerAttention}
                />
              )}
              {shellCards(active, (position) => position > active.messages.length)}
              </div>
            </div>
            </FindingProvider>
            <Minimap scroller={listRef} turns={minimapTurns(active.messages)} />
            <ScrollToBottom scroller={listRef} following={following} />
            </div>
            )}
            </ErrorBoundary>

            <div className="composer">
              {/* AI 의 지금 할 일 목록 (이슈 #83) — 남은 일이 있을 때만. 대화를 바꾸면 접힌다 (key) */}
              <TodoDock key={active.id} messages={active.messages} progress={active.progress} running={!!active.pending} />
              <QueueDock
                items={active.queue ?? []}
                sources={active.queueSources}
                onDrop={(index) => void window.litecode.dropQueued(active.id, index)}
                onRestore={() => {
                  void window.litecode.takeQueue(active.id).then((taken) => taken && restoreQueued(active.id, taken))
                  trigger.inputRef.current?.focus()
                }}
              />
              {/* dsh InputBar: 둥근 카드 하나에 입력칸과 아래 줄(왼쪽 +, 오른쪽 모델 선택·둥근 보내기)을 담고, 카드 밑에 통계 줄 */}
              <div className={`composer__box${trigger.query?.tone ? ` composer__box--${trigger.query.tone}` : ''}`}>
                <TriggerPopup trigger={trigger} />
                {/* 붙인 파일·이미지 칩 — 글 입력칸 위 (이슈 #44 시안). × 로 뺀다 */}
                {attached.length > 0 && (
                  <div className="composer__attachments">
                    <AttachmentChips
                      items={attached}
                      onRemove={(index) => {
                        void window.litecode.discardAttachments([attached[index]!.path]) // 붙여넣은 이미지면 임시 파일을 지운다 (이슈 #80)
                        setAttached((now) => now.filter((_, at) => at !== index))
                      }}
                    />
                  </div>
                )}
                <textarea
                  ref={trigger.inputRef}
                  {...trigger.inputProps}
                  className="composer__input"
                  placeholder={mode === 'plan' ? t('composer.planPlaceholder') : t('composer.placeholder')}
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  onPaste={(event) => {
                    // 클립보드의 파일·이미지는 칩으로 (이슈 #80) — 글만 있으면 손대지 않는다 (dropPaste.ts)
                    const files = [...event.clipboardData.files]
                    if (pasteIntent(event.clipboardData.types, files.length) !== 'attach') return
                    if (!canWrite(active)) return
                    event.preventDefault()
                    void attachFiles(files)
                  }}
                  onKeyDown={(event) => {
                    // 한글 등 입력기가 조합 중인 Enter 는 조합을 확정하는 키다 — 여기서 보내면 "안녕" 이 "아ㄴ녕" 으로 가고
                    // 마지막 글자가 입력창에 남는다. keyCode 229 는 isComposing 을 안 채우는 환경용
                    if (event.nativeEvent.isComposing || event.keyCode === 229) return
                    if (trigger.onKeyDown(event)) return
                    // Shift+Tab — 모드 순환 (opencode TUI·Claude Code 와 같은 키). 입력창에서만 브라우저 기본(뒤로 포커스)을 막는다
                    if (event.key === 'Tab' && event.shiftKey && !event.altKey && !event.metaKey && !event.ctrlKey) {
                      event.preventDefault()
                      if (!active.pending) chooseMode(nextMode(mode))
                      return
                    }
                    // ↑/↓ — 빈 입력창에서 이 대화에 보낸 이전 글을 불러온다 (셸의 기록처럼). 쓰던 글·여러 줄 안의 커서 이동은 그대로 (inputHistory.ts).
                    // 후보 팝업이 떠 있으면 위에서 이미 팝업이 썼다
                    if ((event.key === 'ArrowUp' || event.key === 'ArrowDown') && !event.shiftKey && !event.altKey && !event.metaKey && !event.ctrlKey) {
                      const recalled = browseHistory(
                        sentTexts(active.messages),
                        browsing.current?.id === active.id ? browsing.current.index : undefined,
                        event.key === 'ArrowUp' ? 'up' : 'down',
                        { text: draft, start: event.currentTarget.selectionStart, end: event.currentTarget.selectionEnd },
                      )
                      if (recalled) {
                        event.preventDefault()
                        browsing.current = recalled.index === undefined ? undefined : { id: active.id, index: recalled.index }
                        setDraft(recalled.text)
                        return
                      }
                    }
                    if (event.key === 'Enter' && !event.shiftKey) {
                      event.preventDefault()
                      // 누르고 있는 Enter 는 한 번만 — 초안은 보낸 뒤에 비워져서, 반복 키가 같은 글을 또 보낸다
                      if (event.repeat) return
                      submit()
                    }
                  }}
                />
                <VoiceStrip voice={voice} />
                <div className="composer__row">
                  {/* `+` 메뉴 — 파일·이미지 추가(이슈 #44)와 지금 프로젝트의 스킬·MCP 서버 팝업(이슈 #43). 이미지는 고른 모델이 받을 때만 */}
                  <PlusMenu
                    project={projects?.find((candidate) => candidate.path === active.project)}
                    imageInput={!!chosen?.model.imageInput}
                    onAttach={(kind) => void addAttachments(kind)}
                  />
                  <ModeChip value={mode} locked={!!active.pending} onChange={chooseMode} />
                  <div className="composer__trailing">
                    <ModelSelect providers={providers} value={selected} onChange={chooseModel} />
                    <VoiceButton voice={voice} />
                    {/* dsh InputBar: 턴이 도는 동안 입력이 비면 보내기 자리가 ■, 글을 쓰면 다시 보내기(=큐) */}
                    {active.pending && !draft.trim() && attached.length === 0 ? (
                      <button
                        type="button"
                        className="composer__send composer__stop"
                        aria-label={t('composer.stop')}
                        title={t('composer.stopTitle')}
                        onClick={() => stopTurn(active.id)}
                      >
                        <StopIcon />
                      </button>
                    ) : (
                    <button
                      type="button"
                      className="composer__send"
                      aria-label={t('composer.send')}
                      title={t('composer.sendTitle')}
                      onClick={submit}
                      disabled={!chosen || (!draft.trim() && attached.length === 0) || !canWrite(active)}
                    >
                      {/* dsh 보내기 화살표 (16 격자) */}
                      <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
                        <path
                          d="M8.3125 0.980183C8.66767 1.0531 8.97902 1.20418 9.2627 1.43233C9.48724 1.61297 9.73029 1.85793 9.97949 2.10714L14.707 6.83468L13.293 8.24874L9 3.95577V15.0417H7V3.95577L2.70703 8.24874L1.29297 6.83468L6.02051 2.10714C6.26971 1.85793 6.51277 1.61297 6.7373 1.43233C6.97662 1.23986 7.28445 1.04402 7.6875 0.980183C7.8973 0.947006 8.1031 0.95516 8.3125 0.980183Z"
                          fill="currentColor"
                        />
                      </svg>
                    </button>
                    )}
                  </div>
                </div>
              </div>
              {/* 컨텍스트 % 의 한도는 지금 고른 모델의 설정값 (설정 > 모델의 "컨텍스트 길이") */}
              <StatsBar stats={chatStats(active.usage, chosen?.model.contextLength, chosen?.model.maxOutput)} />
            </div>
            {terminalOn && shellOpen[active.project] && (
              <ShellDrawer
                key={active.project}
                directory={active.project}
                focusSignal={shellFocus}
                quiet={shellQuietAt === shellFocus}
                onClose={() => {
                  setShellOpen((open) => ({ ...open, [active.project]: false }))
                  trigger.inputRef.current?.focus()
                }}
              />
            )}
          </DelegationContext.Provider>
        )}
        {dropping && <DropVeil />}
      </main>
      {/* 답의 파일 칩을 누르면 채팅 오른쪽에 붙는 파일 미리보기 (이슈 #17) */}
      <ErrorBoundary scope="section" className="crash--side" resetKey={active?.project}>
        <FilePreviewPanel directory={active?.project} />
      </ErrorBoundary>
      {settingsOpen && <SettingsModal providers={providers} onProvidersChange={setProviders} onClose={closeSettings} />}
      {/* 폰의 짝짓기 요청 — 설정을 닫아도 뜬다 (이슈 #56) */}
      <RemotePairPrompt on={features.has('remote')} />
      <Toasts items={notices.toasts} onOpen={(target) => void openNotice(target)} onDismiss={notices.dismiss} />
    </div>
  )
}

interface RailProps {
  project?: Project
  /** 폴더를 고르거나 여는 중 — 배지를 막는다 */
  picking: boolean
  /** 다른 프로젝트에 확인할 대화가 있다 — 배지 모서리의 점 (펼친 사이드바 전환 카드의 점과 같은 값) */
  notice?: ConversationStatus
  /** 지금 프로젝트에서 도는 대화 수 — 0 이면 그 아이콘은 없다 */
  running: number
  switchRef: RefObject<HTMLButtonElement | null>
  settingsRef: RefObject<HTMLButtonElement | null>
  onExpand(): void
  onNewChat(): void
  onSwitch(): void
  /** 사이드바를 펼치고 "진행 중" 만 보이게 */
  onRunning(): void
  onSettings(): void
  /** 프로젝트 전환 팝오버 — 배지 옆에 뜬다 */
  children?: ReactNode
}

/** 접힌 사이드바 — 56px 아이콘 줄 (이슈 #60 시안, dsh ui-sidebar 의 collapsed rail). 위에서부터 펼치기 · 새 대화 · 프로젝트 배지 ·
 *  진행 중인 대화 수, 맨 아래 설정. 글자가 없으므로 아이콘마다 aria-label 과 옆 카드(HoverCard)로 이름을 보인다.
 *  macOS 는 맨 위 52px 가 창 버튼 자리다 — 빈 끌기 줄(.rail__top)이 차지하고 아이콘은 그 아래부터 */
function Rail({ project, picking, notice, running, switchRef, settingsRef, onExpand, onNewChat, onSwitch, onRunning, onSettings, children }: RailProps) {
  const t = useT()
  const hover = useHoverCard()
  /** 이름 카드 — 누르면 바로 거둔다 (열린 팝오버·모달 위에 뜨지 않게) */
  const tip = (title: string) => ({
    'aria-label': title,
    onMouseEnter: (event: ReactMouseEvent<HTMLElement>) => hover.enter(event.currentTarget, { title }, true),
    onMouseLeave: (event: ReactMouseEvent<HTMLElement>) => hover.leave(event.currentTarget),
    onMouseDown: (event: ReactMouseEvent<HTMLElement>) => hover.leave(event.currentTarget),
  })
  return (
    <aside className="rail" aria-label={t('rail.label')}>
      <div className="rail__top" />
      <button type="button" className="rail__button" {...tip(t('sidebar.show'))} onClick={onExpand}>
        <SidebarIcon size={18} />
      </button>
      <button type="button" className="rail__button rail__button--raised" {...tip(t('rail.newChat'))} disabled={!project} onClick={onNewChat}>
        <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M8 2.5H4A1.5 1.5 0 0 0 2.5 4v8A1.5 1.5 0 0 0 4 13.5h8a1.5 1.5 0 0 0 1.5-1.5V8" />
          <path d="M12 2.2l1.8 1.8-5 5H7V7.2z" />
        </svg>
      </button>
      <div className="rail__project">
        <button
          type="button"
          className="rail__button"
          ref={switchRef}
          disabled={picking}
          {...tip(project ? t('rail.project', { name: project.name }) : t('rail.openProject'))}
          onClick={onSwitch}
        >
          {project ? <Badge project={project} /> : <span className="project-switch__badge" />}
          {notice && <StatusDot status={notice} className="rail__notice" />}
        </button>
        {children}
      </div>
      {running > 0 && (
        <button type="button" className="rail__button" {...tip(t('rail.running', { count: running }))} onClick={onRunning}>
          <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M2.5 3.5h11v7.5h-6l-3 2.5v-2.5h-2z" />
          </svg>
          <span className="rail__count" aria-hidden="true">
            {running}
          </span>
        </button>
      )}
      <span className="rail__spacer" />
      <button type="button" className="rail__button" ref={settingsRef} {...tip(t('sidebar.settings'))} onClick={onSettings}>
        <GearIcon size={18} />
      </button>
      <HoverCard card={hover.card} />
    </aside>
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
  /** 그 프로젝트에서 도는 대화 수 — 실행 중 점 대신 점 + 숫자 */
  runningOf(project: string): number
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
function ProjectPopover({ projects, current, statusOf, runningOf, busy, error, onPick, onOpenFolder, onToggleFavorite, onRemove, onRename, onClose }: ProjectPopoverProps) {
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
      if (event.key !== 'Escape' || event.isComposing) return // 한글 조합 취소 Esc 에 닫지 않는다
      event.preventDefault() // 이 Esc 는 여기서 썼다 — 녹음(VoiceInput)까지 취소하지 않게
      onClose(true)
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
                      {/* 실행 중은 점 대신 점 + 숫자, 그 밖의 상태(답 필요·안 본 끝남)는 점 그대로 */}
                      {statusOf(project.path) && statusOf(project.path) !== 'running' && <StatusDot status={statusOf(project.path)!} />}
                      <RunningCount count={runningOf(project.path)} label={t('sidebar.running', { count: runningOf(project.path) })} />
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
