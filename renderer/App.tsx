import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AttachmentKind, Mode, OpenTarget, PickedAttachment, Project, ProviderSummary, QueuedSend } from '../shared/ipc.ts'
import { titleFrom } from '../shared/chat.ts'
import { applyHistory, applyLive } from './chatState.ts'
import { focusComposerInput } from './composerFocus.ts'
import { useFollowBottom } from './Minimap.tsx'
import { findModel, initialModel, type ModelRef } from './modelChoice.ts'
import { SettingsModal } from './Settings.tsx'
import { RemotePairPrompt } from './MobileSettings.tsx'
import { useTriggers } from './useTriggers.ts'
import { closeFilePreview, getPanelState, openTerminalTab, requestFilesSearch, revealPanel, terminalIdOf } from './filePreviewStore.ts'
import { useAppMcp } from './useAppMcp.ts'
import { useGitWatch } from './gitStore.ts'
import type { ShellCardView } from './ShellCard.tsx'
import { useSettings, useT } from './settingsStore.ts'
import { useFeatures } from './featuresStore.ts'
import { Toasts, useNotices } from './Notices.tsx'
import { otherProjectsStatus, projectStatus } from './noticeView.ts'
import { useVoiceInput } from './VoiceInput.tsx'
import { voiceChatBlock } from './voiceView.ts'
import { useFileDrop } from './dropPaste.ts'
import { DropVeil } from './DropVeil.tsx'
import { countOf } from './attachmentsView.ts'
import { FilePreviewPanel } from './FilePreview.tsx'
import { DelegationContext } from './Delegation.tsx'
import { peerOf, projectTargets } from './delegationView.ts'
import { runningIn } from './backgroundView.ts'
import { useEscapeTwice, useStopTurn } from './stopTurn.tsx'
import { onCompose, type ComposeRequest } from './composeRequest.ts'
import { changeDraft, draftOf, restoreInto, withoutDrafts, type Draft, type Drafts } from './drafts.ts'
import { questionDrafts } from './Attention.tsx'
import { ErrorBoundary } from './ErrorBoundary.tsx'
import { matchesTitle, pinnedFirst } from './sessionListView.ts'
import { useHoverCard } from './hoverCard.tsx'
import { Rail } from './Rail.tsx'
import { MissingConversations } from './MissingConversations.tsx'
import { ProjectQuickOpen } from './ProjectQuickOpen.tsx'
import { canWrite, fromConversation, isBlank, newSession, toConversation, withBlankFor, withSessionFor, type Session } from './session.ts'
import { useSidebarLayout } from './useSidebarLayout.ts'
import { useLastModel } from './useLastModel.ts'
import { useChatEvents } from './useChatEvents.ts'
import { feedTurnSnapshot } from './turnDetailStore.ts'
import { useTerminalKeys } from './useTerminalKeys.ts'
import { useSessionNav } from './useSessionNav.ts'
import { Sidebar } from './Sidebar.tsx'
import { ConversationView } from './ConversationView.tsx'
import { Composer } from './Composer.tsx'

export type { Session } from './session.ts'

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
  /** ⌘K 반복 (#375·#379) — 빠른 열기가 열려 있을 때 ⌘K 마다 1씩 올려 패널의 강조(선택 행)가 다음 프로젝트로.
   *  Enter 로 확정(고른 프로젝트를 열고 닫는다)까지 하면 실제 전환 */
  const [cycle, setCycle] = useState(0)
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
  const { layout, setLayout, drag } = useSidebarLayout()
  const [lastModel, setLastModel] = useLastModel()
  const listRef = useRef<HTMLDivElement>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const settingsRef = useRef<HTMLButtonElement>(null)
  // 닫으면 포커스는 입력창으로 (이슈 #382) — 입력 카드가 안 보이는 화면(추론 과정 탭)이면 설정 버튼으로.
  // 모달의 Esc 구독이 매 렌더 다시 걸리지 않게 참조를 고정한다
  const closeSettings = useCallback(() => {
    setSettingsOpen(false)
    if (!focusComposerInput()) settingsRef.current?.focus()
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
      // 메인이 쥔 도는 턴·대기열을 입힌다 — 창을 닫았다 열어도 진행 줄·대기열이 이어져 보인다 (그 뒤는 이벤트로).
      // "턴 작업" 탭(이슈 #416) 도 같은 스냅샷으로 이어 붙인다
      const live = await window.litecode.chatSnapshot()
      for (const session of stored) {
        const turn = live[session.id]?.turn
        if (turn) feedTurnSnapshot(session.id, turn.startedAt, turn.progress)
      }
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

  useChatEvents({
    setSessions,
    setFresh,
    sessionsRef,
    updateSession,
    forgetPruned,
    follow: (cid) => {
      if (cid === activeIdRef.current) following.current = true
    },
  })

  const project = projects?.find((candidate) => candidate.path === current)
  const visible = sessions.filter((session) => session.project === project?.path && !isBlank(session))
  const all = sessions.filter((session) => session.project === project?.path)
  const active = all.find((session) => session.id === activeIds[project?.path ?? '']) ?? visible[0] ?? all[0]
  const activeIdRef = useRef<string>(undefined)
  activeIdRef.current = active?.id
  // 본문 탭(view)은 대화별로 새로 시작 — 추론 과정을 보다가 다른 대화로 가면 대화 탭으로 돌아온다 (이슈 #364)
  useEffect(() => {
    setView('chat')
  }, [active?.id])
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

  // 최근 대화 팝오버 (제목찾기 옆 버튼) — 전 프로젝트 저장된 대화를 한 번에. 열림 상태만 여기, 그리기는 Sidebar
  const [recentOpen, setRecentOpen] = useState(false)
  function toggleRecent(): void {
    setRecentOpen((on) => !on)
  }
  function closeRecent(): void {
    setRecentOpen(false)
  }
  /** 행 클릭 — 그 대화의 프로젝트로 열고 그 대화를 본다(알림을 눌렀을 때와 같은 길) */
  function openRecentConversation(id: string): void {
    const session = sessionsRef.current.find((s) => s.id === id)
    if (!session) return
    void openNotice({ project: session.project, conversationId: session.id })
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
  // “턴 작업” 탭의 대화 줄 (이슈 #462) — 그 턴의 대화 제목과 그 대화로 이동(알림 열기와 같은 길). ref 로 정체성을 고정해
  // 채팅 이벤트마다 오른쪽 패널이 다시 그려지지 않게
  const titleOfRef = useRef(titleOf)
  titleOfRef.current = titleOf
  const panelTitleFor = useRef((conversationId: string): string => {
    const session = sessionsRef.current.find((candidate) => candidate.id === conversationId)
    return session ? titleOfRef.current(session) : ''
  }).current
  const panelOpenConversation = useRef((conversationId: string): void => {
    const target = sessionsRef.current.find((session) => session.id === conversationId)
    if (target) void openConversation.current({ project: target.project, conversationId })
  }).current
  const delegation = useMemo(() => {
    const peers = sessions
      .filter((session) => !isBlank(session))
      .map((session) => peerOf(session, notices.state[session.id]?.status, session.history !== 'missing' && !!findModel(providers, session.model)))
    return {
      peers,
      // #351: 지금 프로젝트도 포함 — 승인 카드의 "이 프로젝트" 그룹·진행 줄이 쓴다 (Projects 탭 패널은 자기 프로젝트를 스스로 빼고,
      // 세션 도구의 목록·읽기는 메인이 제외한다)
      targets: projectTargets(projects ?? [], lastViewed, peers),
      self: { mode, project: projectName, id: active?.id },
      open: (id: string) => {
        const target = sessionsRef.current.find((session) => session.id === id)
        if (target) void openConversation.current({ project: target.project, conversationId: id })
      },
    }
  }, [sessions, projects, lastViewed, projectPath, projectName, notices.state, providers, mode])
  // 터미널은 오른쪽 패널의 탭 (이슈 #303) — 열린 탭·고른 탭은 filePreviewStore 가 쥔다. AI 가 open(터미널) 을 부른 것은(id) 조용히 연다 —
  // 키(포커스)를 가져오지 않게 (이슈 #51)
  useAppMcp(features.has('appMcp'), active?.project, (directory, id) => {
    openTerminalTab(directory, id, { quiet: true })
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
  // 세션 이동에 입력창 포커스 (이슈 #374) — 사이드바 대화 행 클릭·⌘↑/⌘↓·알림으로 대화 열기, 어느 길로 오든
  // 키가 옛 화면에 남아 있으면 마우스를 다시 대야 하므로 입력창에게 건다. 첫 출현(앱 기동)은 이동이 아니라서 그대로 둔다.
  // 판(aria-modal)·프로젝트 빠른 열기가 열려 있으면 포커스를 가져가지 않는다 — ⌘N·⌘↑/⌘↓ 과 같은 전역 키 규칙.
  // (빠른 열기로 프로젝트만 바꾼 것은 입력 창이 없는 그 패널이 닫히면 전환 버튼이 키를 가지므로 여기서 포기한다)
  // 추론 과정(#364) 탭에는 입력 창이 없다 — 그 탭에서 오면 대화 탭으로 돌아온 다음 그리기에 건다 (view 의존)
  const prevActiveId = useRef<string | undefined>(undefined)
  const composerFocusId = useRef<string | undefined>(undefined)
  useEffect(() => {
    const id = active?.id
    if (id !== undefined && prevActiveId.current !== undefined && id !== prevActiveId.current) composerFocusId.current = id
    prevActiveId.current = id
    if (composerFocusId.current !== id || (trajectoryOn && view === 'trajectory')) return
    composerFocusId.current = undefined
    if (document.querySelector('[aria-modal="true"], .project-open__panel')) return
    trigger.inputRef.current?.focus()
  }, [active?.id, view, trajectoryOn])

  // Git 상태 다시 읽기 (이슈 #290) — 작업 뒤·턴 끝·창 포커스. 탭 숫자와 브랜치 알약이 같은 값을 본다
  useGitWatch(features.has('git'), active?.project)
  /** 음성 대화가 보는 지금 대화의 턴 상태 — 도는 턴·대기열·붙잡힌 대기열, 승인·질문 카드 */
  const voiceActivity = {
    busy: !!active && (!!active.pending || (active.queue?.length ?? 0) > 0 || !!active.held),
    attention: (active?.attention?.length ?? 0) > 0,
  }
  /** 음성 대화 (이슈 #109·#238·#244) — 말을 멈추면 받아쓴 글을 보내고, 끄면 들은 글은 녹음을 시작한 대화의 초안에 넣는다 (VoiceInput.tsx) */
  const voice = useVoiceInput({
    sessionId: active?.id,
    inputRef: trigger.inputRef,
    hasSession: (id) => sessions.some((session) => session.id === id),
    edit: (id, change) => changeDraftOf(id, (now) => ({ ...now, text: change(now.text) })),
    // 음성 대화 모드 (#238) — 받아쓴 글만 보낸다(첨부·트리거 없이). 보낼 수 없는 경우는 send 가 말없이 돌아가기 전에 금지 표가 사유로 막는다.
    // 답이 오는 중이면 메인이 그 턴에 끼워 넣는다 (#240·#250)
    chat: {
      activity: voiceActivity,
      block: (transcript) =>
        voiceChatBlock({ draft, attachments: attached.length, model: !!findModel(providers, selected), writable: !!active && canWrite(active), attention: voiceActivity.attention }, transcript),
      send: (text) => send({ text, attachments: [] }),
    },
  })
  /** Enter·보내기 — 입력 트리거(`/`·`!`)가 다루지 않으면 평범하게 보낸다 */
  const submit = () =>
    void trigger.submit().then((handled) => {
      if (!handled) send()
    })

  // 터미널 탭의 단축키 — ⌘T(새 터미널) · ⌘[·⌘](이전/다음) (useTerminalKeys.ts)
  useTerminalKeys({ project: active?.project, terminalOn })

  // 프로젝트 전환 — 패널의 탭 묶음은 건너가지 않는다(이전부터 그랬고). 다만 터미널은 메인에 셸로 남아 있으므로 떠나면
  // 그 프로젝트의 터미널 셸을 끝낸다 — 안 하면 탭은 사라지고 셸만 남는다 (이슈 #303 받아들인 한계)
  const prevTerminalProject = useRef(active?.project)
  useEffect(() => {
    const prev = prevTerminalProject.current
    const next = active?.project
    prevTerminalProject.current = next
    if (prev === undefined || next === undefined || prev === next) return
    const panel = getPanelState()
    if (panel?.directory !== prev) return // 이미 새 프로젝트 상태로 바뀌었다면 할 일이 없다
    for (const key of panel.tabs) {
      const id = terminalIdOf(key)
      if (id !== undefined) void window.litecode.closeTerminal(prev, id).catch(() => {})
    }
  }, [active?.project])

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

  /** 전환 버튼(사이드바 카드·접힌 줄의 배지) — 열려 있으면 닫고, 아니면 빠른 열기 패널을 연다. 고를 최근 프로젝트가 없으면 바로 폴더 열기 (이슈 #305) */
  function toggleSwitcher(): void {
    if (switching) closeSwitcher(false)
    else if (projects?.length === 0) void openFolder()
    else setSwitching(true)
  }

  /** ⌘K / Ctrl+K (이슈 #305) — 닫혀 있으면 연다. 열려 있으면 강조(선택 행)를 다음 프로젝트로 (#379 —
   *  Enter 로 확정하면 실제로 열고 닫힌다). 핸들러는 처음 한 번만 끼우고 그 안은 래퍼가 최신이라
   *  projects·switching 값이 오래되지 않는다 */
  const switchingRef = useRef(switching)
  switchingRef.current = switching
  const toggleSwitcherRef = useRef(toggleSwitcher)
  toggleSwitcherRef.current = toggleSwitcher
  useEffect(() => {
    function onKey(event: KeyboardEvent): void {
      if (event.isComposing || !(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'k') return
      event.preventDefault()
      if (!switchingRef.current) toggleSwitcherRef.current()
      else setCycle((count) => count + 1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // ⌘N / Ctrl+N — 새 대화 (이슈 #344). startNewChat 이 프로젝트 가드·빈 대화 하나로 다 하고 포커스까지 잡는다 (#343)
  const startNewChatRef = useRef(startNewChat)
  startNewChatRef.current = startNewChat
  useEffect(() => {
    function onKey(event: KeyboardEvent): void {
      if (event.isComposing || !(event.metaKey || event.ctrlKey) || event.shiftKey || event.altKey || event.key.toLowerCase() !== 'n') return
      // 판(aria-modal) 이나 프로젝트 전환(빠른 열기) 이 열려 있으면 물러난다 (⌘↑/⌘↓ 과 같은 전역 키 규칙)
      if (document.querySelector('[aria-modal="true"], .project-open__panel')) return
      event.preventDefault()
      startNewChatRef.current()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // ⌘P / Ctrl+P — 파일 찾기 (이슈 #528). 오른쪽 패널 Files 탭의 검색 칸에 포커스.
  const projectPathRef = useRef(project?.path)
  projectPathRef.current = project?.path
  useEffect(() => {
    function onKey(event: KeyboardEvent): void {
      if (event.isComposing || !(event.metaKey || event.ctrlKey) || event.shiftKey || event.altKey || event.key.toLowerCase() !== 'p') return
      event.preventDefault()
      const dir = projectPathRef.current
      if (dir) requestFilesSearch(dir)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // ⌘, / Ctrl+, — 설정 판 열기 (이슈 #384). macOS 의 설정 표준 키 — 모든 앱이 쓰니까 배울 필요 없이 누른다.
  // 열면 닫는 것은 ×/Esc (닫히면 포커스는 #382 대로).
  // 키를 문자(',') 가 아니라 물리 키(event.code 'Comma') 로 본다 — 한국어(두벌식) 입력 체계에서
  // 콤마 물리 키가 event.key= '.' 으로 올 수 있기 때문
  useEffect(() => {
    function onKey(event: KeyboardEvent): void {
      if (event.isComposing || !(event.metaKey || event.ctrlKey) || event.shiftKey || event.altKey || event.code !== 'Comma') return
      // 판(aria-modal) 이나 프로젝트 전환(빠른 열기) 이 열려 있으면 물러난다 (⌘N 과 같은 전역 키 규칙)
      if (document.querySelector('[aria-modal="true"], .project-open__panel')) return
      event.preventDefault()
      setSettingsOpen(true)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // ⌘B / Ctrl+B — 우측 패널 토글 (이슈 #444). 열려 있으면 닫기 버튼(×) 처럼 숨긴다(탭은 남고), 닫혀 있으면 머리 버튼처럼 다시 연다.
  // 닫으면 포커스는 입력창으로 (#382), 판(aria-modal)·프로젝트 빠른 열기 열려 있으면 다른 전역 키처럼 무시
  const panelDirectoryRef = useRef(project?.path)
  panelDirectoryRef.current = project?.path
  useEffect(() => {
    function onKey(event: KeyboardEvent): void {
      if (event.isComposing || !(event.metaKey || event.ctrlKey) || event.shiftKey || event.altKey || event.key.toLowerCase() !== 'b') return
      if (document.querySelector('[aria-modal="true"], .project-open__panel')) return
      const directory = panelDirectoryRef.current
      if (!directory) return
      event.preventDefault()
      const state = getPanelState()
      if (state?.open && state.directory === directory) {
        closeFilePreview()
        if (!focusComposerInput()) return
      } else revealPanel(directory)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // ⌘↑/⌘↓ (2026-10-13 피드백 #3) — 바로 이전/다음 대화로. 사이드바 대화 목록 순서(진행중만 보기·찾기·고정 순) 기준, 끝에서 감돈다
  const listedNavRef = useRef(listed)
  listedNavRef.current = listed
  useSessionNav({
    onStep: (dir) => {
      const list = listedNavRef.current
      if (list.length === 0) return
      const index = Math.max(0, list.findIndex((session) => session.id === activeIdRef.current))
      const next = list[(index + dir + list.length) % list.length]
      if (next && next.id !== activeIdRef.current) setActiveIds((ids) => ({ ...ids, [next.project]: next.id }))
    },
  })

  /** 새 대화 — 빈 대화는 첫 메시지 전까지 하나만 (dsh ui-workspace). 이미 있으면 새로 만들지 않고 그리로 간다. 연 대화의 id 를 준다 */
  function startNewChat(): string | undefined {
    if (!project) return undefined
    const blank = sessions.find((session) => session.project === project.path && isBlank(session))
    const session = blank ?? newSession(project.path)
    if (!blank) setSessions((sessionsNow) => [session, ...sessionsNow])
    setActiveIds((current) => ({ ...current, [project.path]: session.id }))
    // 열린 즉시 바로 쓸 수 있도록 (이슈 #343) — `/clear` 도 이 함수라 같은 효과가 붙는다
    trigger.inputRef.current?.focus()
    return session.id
  }

  // 확장의 "수정 요청" (이슈 #557, chat.compose) — 지금 프로젝트의 확장 탭이면 새 대화를 열고 입력창을 채운다.
  // send 면 그 대화가 활성이 된 뒤 곧바로 보낸다(#559) — 보낼 수 없으면(모델 없음 등) 글은 입력창에 남는다
  const composeRef = useRef<(request: ComposeRequest) => void>(() => {})
  const pendingSend = useRef<string | undefined>(undefined)
  composeRef.current = ({ directory, text, send: sendNow }) => {
    if (!project || project.path !== directory) return
    const id = startNewChat()
    if (!id) return
    changeDraftOf(id, (draft) => ({ ...draft, text }))
    if (sendNow) pendingSend.current = id
  }
  useEffect(() => onCompose((request) => composeRef.current(request)), [])
  useEffect(() => {
    if (!pendingSend.current || active?.id !== pendingSend.current || !draft.trim()) return
    pendingSend.current = undefined
    // Enter 와 같은 길 — 글이 `/스킬 …` 로 시작하면 앱이 그 SKILL.md 본문을 결정적으로 붙여 보낸다 (이슈 #561)
    submit()
  })

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
   *  보내기는 메인(ctx.chat)에 부탁한다 — 그 대화의 턴이 도는 중이면 메인이 그 턴에 끼워 넣는다(#250, 엔진이 아직 안 받았으면 대기열). 내 말·답은 이벤트로 온다.
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


  // 프로젝트 빠른 열기 (이슈 #305) — 전환 카드 우측(사이드바 옆)에 뜬다 (⌘K 또는 전환 버튼, 2026-10-13 피드백 #1).
  // 열려 있으면 ⌘K 가 강조(선택 행)를 다음 프로젝트로 이동하고 Enter 로 확정 (#379)
  const quickOpen = switching && (
    <ProjectQuickOpen
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
      switchButton={switchRef}
      cycle={cycle}
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
        />
      )}
      <Sidebar
        t={t}
        layout={layout}
        setLayout={setLayout}
        drag={drag}
        project={project}
        picking={picking}
        switchRef={switchRef}
        settingsRef={settingsRef}
        notices={notices}
        sessions={sessions}
        running={running}
        runningOnly={runningOnly}
        setRunningOnly={setRunningOnly}
        titleQuery={titleQuery}
        setTitleQuery={setTitleQuery}
        listed={listed}
        active={active}
        setActiveIds={setActiveIds}
        confirming={confirming}
        setConfirming={setConfirming}
        renaming={renaming}
        setRenaming={setRenaming}
        renameCancelled={renameCancelled}
        fresh={fresh}
        now={now}
        sessionHover={sessionHover}
        titleOf={titleOf}
        toggleSwitcher={toggleSwitcher}
        startNewChat={startNewChat}
        stopTurn={stopTurn}
        removeConversation={removeConversation}
        renameConversation={renameConversation}
        pinConversation={pinConversation}
        setSettingsOpen={setSettingsOpen}
        recentOpen={recentOpen}
        allProjects={projects ?? []}
        toggleRecent={toggleRecent}
        closeRecent={closeRecent}
        openRecentConversation={openRecentConversation}
      />

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
            <ConversationView
              t={t}
              active={active}
              titleOf={titleOf}
              features={features}
              trajectoryOn={trajectoryOn}
              view={view}
              setView={setView}
              listRef={listRef}
              setFinding={setFinding}
              finding={finding}
              following={following}
              chosen={chosen}
              send={send}
              shareShell={shareShell}
            />

            {/* 추론 과정(trajectory) 은 읽기 전용 기록 보기 — 입력 카드(채팅창)는 숨기고 대화 탭에서 다시 보인다 (이슈 #364) */}
            {!(trajectoryOn && view === 'trajectory') && (
            <Composer
              t={t}
              active={active}
              restoreQueued={restoreQueued}
              trigger={trigger}
              draft={draft}
              setDraft={setDraft}
              attached={attached}
              setAttached={setAttached}
              browsing={browsing}
              mode={mode}
              chooseMode={chooseMode}
              providers={providers}
              projects={projects}
              selected={selected}
              chosen={chosen}
              chooseModel={chooseModel}
              voice={voice}
              submit={submit}
              stopTurn={stopTurn}
              attachFiles={attachFiles}
              addAttachments={addAttachments}
            />
            )}
          </DelegationContext.Provider>
        )}
        {dropping && <DropVeil />}
      </main>
      {/* 답의 파일 칩을 누르면 채팅 오른쪽에 붙는 파일 미리보기 (이슈 #17) */}
      <ErrorBoundary scope="section" className="crash--side" resetKey={active?.project}>
        <FilePreviewPanel directory={active?.project} activeConversationId={active?.id} titleFor={panelTitleFor} onOpenConversation={panelOpenConversation} />
      </ErrorBoundary>
      {settingsOpen && <SettingsModal providers={providers} onProvidersChange={setProviders} onClose={closeSettings} />}
      {/* 폰의 짝짓기 요청 — 설정을 닫아도 뜬다 (이슈 #56) */}
      <RemotePairPrompt on={features.has('remote')} />
      {quickOpen}
      <Toasts items={notices.toasts} onOpen={(target) => void openNotice(target)} onDismiss={notices.dismiss} />
    </div>
  )
}
