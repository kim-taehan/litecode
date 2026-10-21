import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent, type RefObject } from 'react'
import type { DirectoryListing, ExtensionEntryResult, ExtensionSummary, FilePreview, HtmlAsset } from '../shared/ipc.ts'
import { CheckIcon, CopyIcon, Markdown } from './Markdown.tsx'
import { GitPanel, GitTabCount } from './Git.tsx'
import { BranchIcon } from './GitIcons.tsx'
import {
  GIT_TAB,
  closeExtensionTabs,
  closeFilePreview,
  closeTab,
  compareCandidates,
  exitCompare,
  extensionFrameKey,
  extensionIdOf,
  isExtensionTab,
  isFileTab,
  isTaskTab,
  isTerminalTab,
  isTurnTab,
  openExtensionTab,
  onFilesSearch,
  openFilePreview,
  panelTakesFocus,
  openFilesTab,
  openTerminalTab,
  revealPanel,
  selectTab,
  startCompare,
  taskIdOf,
  terminalIdOf,
  toggleFullscreen,
  TURN_PREFIX,
  turnRefOf,
  usePanelState,
  useGitSub,
  type PanelState,
} from './filePreviewStore.ts'
import { Tokens, useHighlight } from './Highlighted.tsx'
import { languageOfPath } from './highlight.ts'
import { requestCompose } from './composeRequest.ts'
import { bridgeReply, bridgeRequestOf, ConsentQueue, runBridgeCall } from './extensionBridge.ts'
import { buildHtmlDocument, collectReferences } from './htmlPreview.ts'
import { useExtensions } from './extensionsStore.ts'
import { failureLines, lineSummary } from './extensionsView.ts'
import { useFeatures } from './featuresStore.ts'
import { reason } from './ipcError.ts'
import { lineJump } from './lineJump.ts'
import { PermissionIcon } from './PermissionIcon.tsx'
import { PuzzleIcon } from './PuzzleIcon.tsx'
import { useT } from './settingsStore.ts'
import { menuExtensions, TabAddMenu } from './TabAddMenu.tsx'
import { TaskTab } from './TaskTab.tsx'
import { TurnTab } from './TurnTab.tsx'
import { taskTitle } from './taskTabView.ts'
import { findTask, useTaskMap } from './tasksStore.ts'
import { TerminalView } from './TerminalView.tsx'
import './filePreview.css'

// 오른쪽 패널 (이슈 #17 파일 미리보기 → #29 탭·폴더 탐색·HTML 실행). dsh ui-sidebar-right·ui-sidebar-files·ui-sidebar-documentpreview 참조
// (모양·치수·동작만, 코드는 새로 씀): 앱 틀의 오른쪽 열, 첫 폭 = 창의 45%, 끌어서 300 ~ 창의 70%(대화는 400 이상 남긴다).
// 맨 위 탭 줄(대화 머리와 같은 52px, 창 끌기 영역) — 고정 "파일" 탭 + 연 파일 탭(28px 칩, 고른 칩과 hover 에 ×) + "+"(파일 탭으로), 오른쪽 끝에
// 전체 화면·닫기. 그 아래 38px 경로 줄 — 경로(폴더는 옅게, 파일 이름 굵게, 길면 앞이 잘리며 흐려짐)·종류·보기 전환·다시 읽기·Finder·복사.
// 파일 탭 본문은 고정폭 줄 번호, .md 는 마크다운, .html 은 격리된 iframe 에서 실제로 렌더링(htmlPreview.ts). 읽기·판정은 메인.
// 이미지(png·jpg·gif·webp·svg)는 <img>, PDF 는 안내 + 기본 앱에서 열기 (이슈 #214).
// dsh 와 다른 점: 분할 보기(두 창)는 없다, "파일" 탭은 닫을 수 없다, "+" 는 안내 탭 대신 파일 탭으로.
// 확장 탭 (이슈 #511): 설치한 패널 확장(한 파일짜리 HTML)을 HTML 미리보기와 같은 격리된 iframe(SandboxFrame)에서 돌린다 — 탭 이름은 manifest name, 퍼즐 아이콘.

const WIDTH_KEY = 'litecode.filePreview.width'
const MIN_WIDTH = 300
const MAX_RATIO = 0.7
const DEFAULT_RATIO = 0.45
/** 패널을 넓혀도 대화 칸에 남기는 폭 (dsh CENTER_MIN) */
const CHAT_MIN = 400
const COPIED_MS = 1_500

function readWidth(): number {
  try {
    const saved = Number(localStorage.getItem(WIDTH_KEY))
    if (saved > 0) return saved
  } catch {
    // 못 읽으면 기본값
  }
  return Math.round(window.innerWidth * DEFAULT_RATIO)
}

export interface FilePreviewPanelProps {
  directory?: string
  /** “턴 작업” 탭(이슈 #462) — 그 턴의 대화 제목을 알려 주는 것. 없으면 대화 줄을 안 그린다 */
  titleFor?: (conversationId: string) => string
  /** 지금 보고 있는 대화 — “턴 작업” 탭의 대화 줄이 화살표를 안 띄울 판정 */
  activeConversationId?: string
  /** 그 대화로 이동(알림 열기와 같은 길) */
  onOpenConversation?: (conversationId: string) => void
}

/** 지금 보는 대화의 프로젝트 패널일 때만 그린다 — 프로젝트를 옮기면 숨긴다.
 *  패널이 닫혀 있어도 늘 마운트돼 있어서 확장 목록(이슈 #511)을 여기서 듣는다: 꺼졌거나·삭제됐거나·상태가 정상이 아닌 확장의 탭을 닫고,
 *  설정 화면의 [열기]가 탭을 열 자리(지금 프로젝트)를 알린다 */
export function FilePreviewPanel({ directory, titleFor, activeConversationId, onOpenConversation }: FilePreviewPanelProps) {
  const state = usePanelState(activeConversationId, directory)
  const extensions = useExtensions()
  const convId = activeConversationId
  const dir = directory
  const stale = !!state?.open && state.directory !== directory
  useEffect(() => {
    if (stale && dir) closeFilePreview(dir, convId)
  }, [stale])
  // 바뀜 이벤트만 — 첫 읽기 전의 빈 목록으로 탭을 닫지 않게
  useEffect(() => window.litecode.onExtensionsChanged(closeExtensionTabs), [])
  return state?.open && !stale ? (
    <Panel state={state} extensions={extensions} titleFor={titleFor} activeConversationId={activeConversationId} onOpenConversation={onOpenConversation} directory={directory!} />
  ) : null
}

/** 대화 머리 오른쪽 끝 — 오른쪽 패널을 열고 숨기는 버튼 (왼쪽 사이드바 접기 그림을 뒤집은 것). 늘 보인다 — 숨겨도 탭은 남는다 (사용자 요청 2026-10-04) */
export function RightPanelButton({ directory, conversationId }: { directory: string; conversationId?: string }) {
  const t = useT()
  const state = usePanelState(conversationId, directory)
  const open = !!state?.open && state.directory === directory
  const label = open ? t('filePreview.hidePanel') : t('filePreview.openPanel')
  return (
    <button
      type="button"
      className="right-panel-open"
      aria-label={label}
      title={label}
      aria-pressed={open}
      onClick={() => (open ? closeFilePreview(directory, conversationId) : revealPanel(directory, conversationId))}
    >
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden="true">
        <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="2" />
        <path d="M10 2.75V13.25" />
      </svg>
    </button>
  )
}

/** 비교 보기 아이콘 — 상하로 쪼개진 판 (위아래 50/50, 이슈 #424) */
function CompareIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" aria-hidden="true">
      <rect x="2.5" y="2.75" width="11" height="10.5" rx="1.5" />
      <path d="M2.5 8h11" />
    </svg>
  )
}

function Panel({
  state,
  extensions,
  titleFor,
  activeConversationId,
  onOpenConversation,
  directory,
}: {
  state: PanelState
  extensions: readonly ExtensionSummary[]
  directory: string
  activeConversationId?: string
  onOpenConversation?: (conversationId: string) => void
  titleFor?: (conversationId: string) => string
}) {
  const t = useT()
  const [width, setWidth] = useState(readWidth)
  const root = useRef<HTMLElement>(null)
  const returnFocus = useRef<Element | null>(null)
  const drag = useRef<{ x: number; width: number; max: number }>(undefined)
  // Git 탭 (이슈 #290, #579) — 기능 git 이 켜져 있을 때 항상 보인다. Git 은 프로젝트(directory) 단위: sub/스크롤 상태는 gitSubs 에
  const gitOn = useFeatures().has('git')
  const gitSub = useGitSub(directory ?? '')
  // 터미널 탭 (이슈 #303) — 기능 terminal 이 켜져 있을 때만. 꺼졌으면 터미널 탭은 보이지 않는다
  const terminalOn = useFeatures().has('terminal')
  const { tabs: allTabs, fullscreen, jump } = state
  // 기능이 꺼지면(셸도 다 끝났다) 터미널 탭은 보이지 않는다
  const tabs = terminalOn ? allTabs : allTabs.filter((key) => !isTerminalTab(key))
  const active = state.active === GIT_TAB && !gitOn ? undefined : isTerminalTab(state.active) && !terminalOn ? undefined : state.active
  // 고른 “턴 작업” 탭의 열쇠 (이슈 #462) — 대화 줄(제목·이동)에 쓴다
  const turnRef = isTurnTab(active) ? turnRefOf(active) : undefined
  // 비교 보기 (이슈 #424) — 비교하는 파일 탭 둘 다 남아 있을 때만 (닫거나 프로젝트를 옮기면 저장소가 먼저 지운다 — 여기서는 안전망)
  const compare =
    state.compare && isFileTab(state.compare.a) && isFileTab(state.compare.b) && allTabs.includes(state.compare.a) && allTabs.includes(state.compare.b)
      ? state.compare
      : undefined
  // 파일 탭은 한 번 본 뒤부터 계속 마운트 — 다른 탭에 갔다 와도 펼친 폴더·스크롤이 그대로 (dsh keepMounted, 안 본 탭은 미리 안 그린다)
  const filesVisited = useRef(false)
  if (active === undefined) filesVisited.current = true
  // 작업 탭 (이슈 #325) — 이름(작업 N · 설명)은 작업 목록 저장소에서. 기능 묶음과 무관하다 (작업이 있는 대화에서만 열린다)
  const taskMap = useTaskMap()

  // 열 때마다(칩·버튼) 패널이 포커스를 잡는다 — Esc 로 닫고, 닫으면 누른 자리(칩)로 돌아간다.
  // AI 가 연 것(open(파일))은 잡지 않는다 — 닫혀 있던 패널이 새로 뜰 때도 (치던 입력창의 글이 끊기지 않게)
  useLayoutEffect(() => {
    if (!panelTakesFocus(state)) return
    if (isTerminalTab(state.active)) return // 터미널 탭 본문이 키를 가져간다 (TerminalView)
    if (!root.current?.contains(document.activeElement)) returnFocus.current = document.activeElement
    root.current?.focus({ preventScroll: true })
  }, [state.focus])

  useEffect(() => {
    try {
      localStorage.setItem(WIDTH_KEY, String(width))
    } catch {
      // 저장 못 해도 이번 실행은 그 폭
    }
  }, [width])

  function close(): void {
    const back = returnFocus.current
    closeFilePreview(directory, activeConversationId)
    if (back instanceof HTMLElement && back.isConnected) back.focus()
    else document.querySelector<HTMLElement>('.composer__input')?.focus()
  }

  /** 터미널 탭을 닫는다 — 셸도 끝낸다(메인), 탭은 closeTab 이 이웃을 고른다. 패널은 닫지 않는다 */
  function closeTerminal(key: string, terminalId: number): void {
    void window.litecode.closeTerminal(directory, terminalId).catch(() => {})
    closeTab(key, directory, activeConversationId)
  }

  // Esc — 비교 보기면 먼저 끝내고, 전체 화면이면 풀고, 아니면 닫는다
  function onKeyDown(event: KeyboardEvent<HTMLElement>): void {
    if (event.key !== 'Escape' || event.defaultPrevented || event.nativeEvent.isComposing) return
    event.preventDefault()
    if (compare) exitCompare(directory, activeConversationId)
    else if (fullscreen) toggleFullscreen(directory, activeConversationId)
    else close()
  }

  return (
    <aside
      ref={root}
      className={fullscreen ? 'file-preview file-preview--full' : 'file-preview'}
      aria-label={t('filePreview.label')}
      tabIndex={-1}
      style={fullscreen ? undefined : { width }}
      onKeyDown={onKeyDown}
    >
      {!fullscreen && (
        <div
          className="file-preview__resize"
          role="separator"
          aria-orientation="vertical"
          aria-label={t('filePreview.resize')}
          onPointerDown={(event) => {
            event.currentTarget.setPointerCapture(event.pointerId)
            const panel = root.current!.getBoundingClientRect().width
            const chat = root.current!.previousElementSibling?.getBoundingClientRect().width ?? 0
            drag.current = { x: event.clientX, width: panel, max: Math.min(window.innerWidth * MAX_RATIO, panel + chat - CHAT_MIN) }
          }}
          onPointerMove={(event) => {
            const start = drag.current
            if (start) setWidth(Math.round(Math.max(MIN_WIDTH, Math.min(start.max, start.width - (event.clientX - start.x)))))
          }}
          onPointerUp={() => (drag.current = undefined)}
          onPointerCancel={() => (drag.current = undefined)}
        />
      )}
      {/* 탭 줄 — 빈 곳은 창 끌기(styles.css 의 .file-preview__head), 탭(role=tab)·버튼은 no-drag 규칙 하나로 빠진다 */}
      <div className="file-preview__head">
        <div className="file-preview__tabs" role="tablist" aria-label={t('filePreview.tabs')}>
          <div
            role="tab"
            tabIndex={0}
            className="file-preview__tab file-preview__tab--files"
            aria-selected={active === undefined}
            onClick={() => selectTab(undefined, directory, activeConversationId)}
            onKeyDown={(event) => activateOnKey(event, () => selectTab(undefined, directory, activeConversationId))}
          >
            <FolderIcon className="file-preview__tab-icon file-preview__tab-icon--folder" />
            <span className="file-preview__tab-title">{t('filePreview.files')}</span>
          </div>
          {gitOn && (
            <div
              role="tab"
              tabIndex={0}
              className="file-preview__tab file-preview__tab--files file-preview__tab--git"
              aria-selected={active === GIT_TAB}
            onClick={() => selectTab(GIT_TAB, directory, activeConversationId)}
                onKeyDown={(event) => activateOnKey(event, () => selectTab(GIT_TAB, directory, activeConversationId))}
            >
              <BranchIcon className="file-preview__tab-icon" />
              <span className="file-preview__tab-title">{t('git.tab')}</span>
              <GitTabCount directory={directory} />
            </div>
          )}
          {tabs.map((key) => {
            const taskId = taskIdOf(key)
            if (taskId !== undefined) {
              const { number, description } = taskTitle(taskId, findTask(taskMap, taskId))
              const name = description ? t('taskTab.tabNamed', { number, description }) : t('taskTab.tab', { number })
              return (
                <div
                  key={key}
                  role="tab"
                  tabIndex={0}
                  className="file-preview__tab file-preview__tab--task"
                  aria-selected={active === key}
                  title={name}
                  aria-label={name}
                  data-task={taskId}
                  onClick={() => selectTab(key, directory, activeConversationId)}
                  onKeyDown={(event) => activateOnKey(event, () => selectTab(key, directory, activeConversationId))}
                  onAuxClick={(event) => event.button === 1 && closeTab(key, directory, activeConversationId)}
                >
                  <TaskIcon className="file-preview__tab-icon" />
                  <span className="file-preview__tab-title">{name}</span>
                  <button
                    type="button"
                    className="file-preview__tab-close"
                    aria-label={t('filePreview.closeTab', { name })}
                    title={t('filePreview.closeTab', { name })}
                    onClick={(event) => {
                      event.stopPropagation()
                      closeTab(key, directory, activeConversationId)
                    }}
                  >
                    <CrossIcon size={12} />
                  </button>
                </div>
              )
            }
            const turnRef = turnRefOf(key)
            if (turnRef !== undefined) {
              const name = t('turnTab.tab')
              return (
                <div
                  key={key}
                  role="tab"
                  tabIndex={0}
                  className="file-preview__tab file-preview__tab--turn"
                  aria-selected={active === key}
                  title={name}
                  aria-label={name}
                  data-turn={key.slice(TURN_PREFIX.length)}
                  onClick={() => selectTab(key, directory, activeConversationId)}
                  onKeyDown={(event) => activateOnKey(event, () => selectTab(key, directory, activeConversationId))}
                  onAuxClick={(event) => event.button === 1 && closeTab(key, directory, activeConversationId)}
                >
                  <TurnTabIcon className="file-preview__tab-icon" />
                  <span className="file-preview__tab-title">{name}</span>
                  <button
                    type="button"
                    className="file-preview__tab-close"
                    aria-label={t('filePreview.closeTab', { name })}
                    title={t('filePreview.closeTab', { name })}
                    onClick={(event) => {
                      event.stopPropagation()
                      closeTab(key, directory, activeConversationId)
                    }}
                  >
                    <CrossIcon size={12} />
                  </button>
                </div>
              )
            }
            const extensionId = extensionIdOf(key)
            if (extensionId !== undefined) {
              const name = extensions.find((extension) => extension.id === extensionId)?.name ?? extensionId
              return (
                <div
                  key={key}
                  role="tab"
                  tabIndex={0}
                  className="file-preview__tab file-preview__tab--extension"
                  aria-selected={active === key}
                  title={name}
                  aria-label={name}
                  data-extension={extensionId}
                  onClick={() => selectTab(key, directory, activeConversationId)}
                  onKeyDown={(event) => activateOnKey(event, () => selectTab(key, directory, activeConversationId))}
                  onAuxClick={(event) => event.button === 1 && closeTab(key, directory, activeConversationId)}
                >
                  <PuzzleIcon size={14} className="file-preview__tab-icon file-preview__tab-icon--extension" />
                  <span className="file-preview__tab-title">{name}</span>
                  <button
                    type="button"
                    className="file-preview__tab-close"
                    aria-label={t('filePreview.closeTab', { name })}
                    title={t('filePreview.closeTab', { name })}
                    onClick={(event) => {
                      event.stopPropagation()
                      closeTab(key, directory, activeConversationId)
                    }}
                  >
                    <CrossIcon size={12} />
                  </button>
                </div>
              )
            }
            const terminalId = terminalIdOf(key)
            if (terminalId !== undefined) {
              const name = t('terminal.tab', { id: terminalId })
              return (
                <div
                  key={key}
                  role="tab"
                  tabIndex={0}
                  className="file-preview__tab file-preview__tab--term"
                  aria-selected={active === key}
                  title={`${name} · ${directory}`}
                  aria-label={name}
                  data-terminal={terminalId}
                  onClick={() => selectTab(key, directory, activeConversationId)}
                  onKeyDown={(event) => activateOnKey(event, () => selectTab(key, directory, activeConversationId))}
                  onAuxClick={(event) => event.button === 1 && closeTerminal(key, terminalId)}
                >
                  <TerminalIcon className="file-preview__tab-icon" />
                  <span className="file-preview__tab-title">{name}</span>
                  <button
                    type="button"
                    className="file-preview__tab-close"
                    aria-label={t('terminal.close', { name })}
                    title={t('terminal.close', { name })}
                    onClick={(event) => {
                      event.stopPropagation()
                      closeTerminal(key, terminalId)
                    }}
                  >
                    <CrossIcon size={12} />
                  </button>
                </div>
              )
            }
            return (
              <div
                key={key}
                role="tab"
                tabIndex={0}
                className="file-preview__tab"
                aria-selected={active === key}
                title={key}
                aria-label={baseName(key)}
                data-file={key}
                onClick={() => selectTab(key, directory, activeConversationId)}
                onKeyDown={(event) => activateOnKey(event, () => selectTab(key, directory, activeConversationId))}
                onAuxClick={(event) => event.button === 1 && closeTab(key, directory, activeConversationId)}
              >
                <FileIcon className="file-preview__tab-icon" />
                <span className="file-preview__tab-title">{baseName(key)}</span>
                <button
                  type="button"
                  className="file-preview__tab-close"
                  aria-label={t('filePreview.closeTab', { name: baseName(key) })}
                  title={t('filePreview.closeTab', { name: baseName(key) })}
                  onClick={(event) => {
                    event.stopPropagation()
                    closeTab(key, directory, activeConversationId)
                  }}
                >
                  <CrossIcon size={12} />
                </button>
              </div>
            )
          })}
        </div>
        {/* `+` 하나 — 파일 목록 / 새 터미널(메인이 번호를 폴더에서 1부터 매겨 열고 그 탭으로) / 켜 둔 확장(이슈 #511) */}
        <TabAddMenu
          terminal={terminalOn}
          extensions={menuExtensions(extensions)}
          onFiles={() => openFilesTab(directory, activeConversationId)}
          onTerminal={() => void window.litecode.openTerminal(directory).then(({ id }) => openTerminalTab(directory, id, {}, activeConversationId)).catch(() => {})}
          onExtension={(id) => openExtensionTab(directory, id, activeConversationId)}
        />
        <span className="file-preview__chrome">
          {compare && (
            <>
              <span className="file-preview__compare-pill" title={t('filePreview.comparePill')}>
                A|B
              </span>
              <button
                type="button"
                className="file-preview__tool file-preview__compare-off"
                aria-label={t('filePreview.compareOff')}
                title={t('filePreview.compareOff')}
                onClick={() => exitCompare(directory, activeConversationId)}
              >
                <CompareIcon />
              </button>
            </>
          )}
          <button
            type="button"
            className="file-preview__tool file-preview__fullscreen"
            aria-label={fullscreen ? t('filePreview.exitFullscreen') : t('filePreview.fullscreen')}
            title={fullscreen ? t('filePreview.exitFullscreen') : t('filePreview.fullscreen')}
            aria-pressed={fullscreen}
            onClick={() => toggleFullscreen(directory, activeConversationId)}
          >
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              {fullscreen ? (
                <path d="M6 2.5V6H2.5M10 2.5V6H13.5M6 13.5V10H2.5M10 13.5V10H13.5" />
              ) : (
                <path d="M2.5 6V2.5H6M13.5 6V2.5H10M2.5 10V13.5H6M13.5 10V13.5H10" />
              )}
            </svg>
          </button>
          <button type="button" className="file-preview__tool file-preview__close" aria-label={t('filePreview.close')} title={t('filePreview.close')} onClick={close}>
            <CrossIcon size={14} />
          </button>
        </span>
      </div>
      {filesVisited.current && <FilesView directory={directory} hidden={active !== undefined} conversationId={activeConversationId} />}
      {active === GIT_TAB && <GitPanel directory={directory} gitSub={gitSub} conversationId={activeConversationId} />}
      {active !== undefined && isTerminalTab(active) && (
        <TerminalView key={active} directory={directory} terminalId={terminalIdOf(active)!} focus={state.focus} quiet={!!state.quiet} />
      )}
      {active !== undefined && isTaskTab(active) && <TaskTab key={active} taskId={taskIdOf(active)!} directory={directory} />}
      {turnRef !== undefined && active !== undefined && (
        <TurnTab
          key={active}
          conversationId={turnRef.conversationId}
          startedAt={turnRef.startedAt}
          directory={directory}
          title={titleFor?.(turnRef.conversationId)}
          here={activeConversationId === turnRef.conversationId}
          onJump={onOpenConversation ? () => onOpenConversation(turnRef.conversationId) : undefined}
        />
      )}
      {/* 확장 탭 (이슈 #511) — 연 것은 모두 마운트해 두고 고른 것만 보인다(다른 탭에 갔다 와도 iframe 안 상태가 그대로). 탭을 닫으면 iframe 도 사라진다.
          버전이 바뀌면(업그레이드) key 가 바뀌어 새 HTML 로 다시 그린다 */}
      {tabs.map((key) => {
        const id = extensionIdOf(key)
        if (id === undefined) return null
        const extension = extensions.find((item) => item.id === id)
        return <ExtensionTab key={extensionFrameKey(id, extension?.version)} id={id} name={extension?.name ?? id} hidden={active !== key} directory={directory} conversationId={activeConversationId} />
      })}
      {active !== undefined && !isTerminalTab(active) && !isTaskTab(active) && !isTurnTab(active) && !isExtensionTab(active) && active !== GIT_TAB && (
        <CompareSplit compare={compare} directory={directory} active={active} jump={jump} tabs={tabs} conversationId={activeConversationId} />
      )}
    </aside>
  )
}

function activateOnKey(event: KeyboardEvent<HTMLElement>, activate: () => void): void {
  if (event.target !== event.currentTarget || (event.key !== 'Enter' && event.key !== ' ')) return
  event.preventDefault()
  activate()
}

function baseName(key: string): string {
  return key.slice(key.lastIndexOf('/') + 1) || key
}

/** 파일 탭 자리 — 보통은 FileView 하나. 비교 보기면 FileView 두 개를 위아래 50/50 (각각의 미리보기·워치가 그대로 — 그 파일만 바뀌면 그 절반만 다시 그린다) */
function CompareSplit({
  compare,
  directory,
  active,
  jump,
  tabs,
  conversationId,
}: {
  compare: { a: string; b: string } | undefined
  directory: string
  active: string
  jump?: { key: string; line: number; seq: number }
  tabs: string[]
  conversationId?: string
}) {
  if (compare && compare.a === active) {
    return (
      <div className="file-preview__compare">
        <FileView key={compare.a} directory={directory} token={compare.a} compareOn />
        <FileView key={compare.b} directory={directory} token={compare.b} compareOn />
      </div>
    )
  }
  return (
    <FileView
      key={active}
      directory={directory}
      token={active}
      jump={jump?.key === active ? jump : undefined}
      compareCandidates={compareCandidates(tabs, active)}
      onCompare={(other) => startCompare(directory, active, other, conversationId)}
    />
  )
}

/** 비교 보기 열기 — 다른 연 파일 탭이 후보. 메뉴는 + 버튼(TabAddMenu)과 같은 모양 */
function CompareMenu({ candidates, onPick }: { candidates: string[]; onPick(key: string): void }) {
  const t = useT()
  const [at, setAt] = useState<{ left: number; top: number }>()
  const root = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    if (!at) return
    root.current?.querySelector<HTMLButtonElement>('.open-in__item')?.focus()
    const onMouseDown = (event: globalThis.MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) setAt(undefined)
    }
    document.addEventListener('mousedown', onMouseDown)
    return () => document.removeEventListener('mousedown', onMouseDown)
  }, [at])

  return (
    <span ref={root} onKeyDown={(event) => event.key === 'Escape' && setAt(undefined)}>
      <button
        type="button"
        className="file-preview__tool"
        aria-label={t('filePreview.compare')}
        title={t('filePreview.compare')}
        aria-haspopup="menu"
        aria-expanded={at !== undefined}
        onClick={(event) => {
          if (at) return setAt(undefined)
          const rect = event.currentTarget.getBoundingClientRect()
          setAt({ left: rect.left, top: rect.bottom + 4 })
        }}
      >
        <CompareIcon />
      </button>
      {at && (
        <div className="open-in__menu file-preview__add-menu" role="menu" style={{ left: at.left, top: at.top }}>
          {candidates.map((key) => (
            <button
              key={key}
              type="button"
              role="menuitem"
              className="open-in__item"
              onClick={() => {
                setAt(undefined)
                onPick(key)
              }}
            >
              {baseName(key)}
            </button>
          ))}
        </div>
      )}
    </span>
  )
}

// ── 파일 탭 (dsh ui-sidebar-files) — 루트 경로 줄 + 다시 읽기, 그 아래 한 단계씩 펼치는 나무. 폴더 먼저·이름 순서는 메인이 정한다 ──

type Level = 'loading' | Extract<DirectoryListing, { status: 'ok' }> | 'failed'

function FilesView({ directory, hidden, conversationId }: { directory: string; hidden: boolean; conversationId?: string }) {
  const t = useT()
  const [levels, setLevels] = useState<Record<string, Level>>({})
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const [filter, setFilter] = useState('')
  const searchRef = useRef<HTMLInputElement>(null)
  const epoch = useRef(0)

  function list(relative: string): void {
    const at = epoch.current
    setLevels((now) => (now[relative] && now[relative] !== 'failed' ? now : { ...now, [relative]: 'loading' }))
    window.litecode.listDirectory(directory, relative).then(
      (listing) => at === epoch.current && setLevels((now) => ({ ...now, [relative]: listing.status === 'ok' ? listing : 'failed' })),
      () => at === epoch.current && setLevels((now) => ({ ...now, [relative]: 'failed' })),
    )
  }

  useEffect(() => {
    epoch.current++
    setLevels({})
    setExpanded(new Set())
    setFilter('')
    list('')
  }, [directory])

  // ⌘P — 파일 찾기 신호 (이슈 #528)
  useEffect(
    () =>
      onFilesSearch(() => {
        setFilter('')
        setExpanded(new Set())
        requestAnimationFrame(() => searchRef.current?.focus())
      }),
    [],
  )

  /** 다시 읽기 — 루트와 펼친 폴더를 보이는 목록은 둔 채 다시 묻는다 (dsh 처럼 나무를 비우지 않는다) */
  function reload(): void {
    for (const relative of ['', ...expanded]) list(relative)
  }

  function toggle(relative: string): void {
    const next = new Set(expanded)
    if (next.has(relative)) next.delete(relative)
    else {
      next.add(relative)
      list(relative) // 다시 펼치면 다시 읽는다 (dsh)
    }
    setExpanded(next)
  }

  const rootLevel = levels['']
  const query = filter.trim().toLowerCase()
  return (
    <div className="file-tree" hidden={hidden}>
      <div className="file-preview__bar">
        <PathLabel path={typeof rootLevel === 'object' ? rootLevel.absolute : directory} />
        <span className="file-preview__tools">
          <ReloadButton onClick={reload} />
        </span>
      </div>
      <div className="file-tree__search">
        <input
          ref={searchRef}
          type="text"
          className="file-tree__search-input"
          placeholder={t('filePreview.searchPlaceholder')}
          aria-label={t('filePreview.filesLabel')}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.stopPropagation()
              setFilter('')
              searchRef.current?.blur()
            }
          }}
        />
        {filter && (
          <button type="button" className="file-tree__search-clear" aria-label={t('filePreview.searchClear')} onClick={() => { setFilter(''); searchRef.current?.focus() }}>
            <CrossIcon size={10} />
          </button>
        )}
      </div>
      <div className="file-tree__body">
        <ul className="file-tree__level" role="tree" aria-label={t('filePreview.filesLabel')}>
          <TreeLevel relative="" levels={levels} expanded={expanded} onToggle={toggle} onOpen={(file) => openFilePreview(directory, file, undefined, {}, conversationId)} filter={query} />
        </ul>
      </div>
    </div>
  )
}

function TreeLevel({
  relative,
  levels,
  expanded,
  onToggle,
  onOpen,
  filter = '',
}: {
  relative: string
  levels: Record<string, Level>
  expanded: ReadonlySet<string>
  onToggle(relative: string): void
  onOpen(relative: string): void
  filter?: string
}) {
  const t = useT()
  const level = levels[relative]
  if (level === undefined || level === 'loading') return <li className="file-tree__note">{t('filePreview.loading')}</li>
  if (level === 'failed') return <li className="file-tree__note" role="alert">{t('filePreview.folderUnavailable')}</li>

  // 필터가 있으면 이름에 맞는 항목만 보인다
  const visibleEntries = filter
    ? level.entries.filter((entry) => entry.name.toLowerCase().includes(filter))
    : level.entries

  return (
    <>
      {visibleEntries.length === 0 && !filter && <li className="file-tree__note">{t('filePreview.emptyFolder')}</li>}
      {filter && visibleEntries.length === 0 && relative === '' && <li className="file-tree__note">{t('filePreview.noMatches')}</li>}
      {visibleEntries.map((entry) => {
        const child = relative ? `${relative}/${entry.name}` : entry.name
        if (entry.type === 'directory') {
          const open = expanded.has(child)
          return (
            <li key={entry.name} className="file-tree__item" role="treeitem" aria-expanded={open} data-path={child}>
              <button type="button" className="file-tree__row" onClick={() => onToggle(child)}>
                <FolderIcon className="file-tree__icon" open={open} />
                <span className="file-tree__name">{entry.name}</span>
              </button>
              {open && (
                <ul className="file-tree__level" role="group">
                  <TreeLevel relative={child} levels={levels} expanded={expanded} onToggle={onToggle} onOpen={onOpen} filter={filter} />
                </ul>
              )}
            </li>
          )
        }
        if (entry.type === 'file') {
          return (
            <li key={entry.name} className="file-tree__item" role="treeitem" data-path={child}>
              <button type="button" className="file-tree__row" onClick={() => onOpen(child)}>
                <FileIcon className="file-tree__icon" />
                <span className="file-tree__name">{entry.name}</span>
              </button>
            </li>
          )
        }
        return (
          <li key={entry.name} className="file-tree__item" role="treeitem" data-path={child}>
            <span className="file-tree__row file-tree__row--other" aria-disabled="true" title={t('filePreview.notAFile')}>
              <span className="file-tree__name">{entry.name}</span>
            </span>
          </li>
        )
      })}
      {level.truncated && !filter && <li className="file-tree__note">{t('filePreview.truncatedFolder')}</li>}
    </>
  )
}

// ── 파일 탭 하나 — 경로 줄 + 본문 ──

/** jump — 그 줄로 가서 강조한다 (AI 의 open(파일)). 줄은 원문의 줄이라 마크다운·HTML 도 원문 보기로 바꾼다 */
function FileView({
  directory,
  token,
  jump,
  compareOn = false,
  compareCandidates,
  onCompare,
}: {
  directory: string
  token: string
  jump?: { line: number; seq: number }
  /** 비교 보기(위아래)의 절반이면 후보 메뉴를 안 그린다 — 끝내기·다시 열기는 패널 머리(알약·버튼)에서 */
  compareOn?: boolean
  compareCandidates?: string[]
  onCompare?: (other: string) => void
}) {
  const t = useT()
  const [preview, setPreview] = useState<FilePreview | 'loading'>('loading')
  const [revision, setRevision] = useState(0)
  const [source, setSource] = useState(!!jump)
  useEffect(() => {
    if (jump) setSource(true)
  }, [jump?.seq])
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    let live = true
    window.litecode.previewFile(directory, token).then(
      (result) => live && setPreview(result),
      () => live && setPreview({ status: 'unavailable' }),
    )
    return () => {
      live = false
    }
  }, [directory, token, revision])

  // 라이트코드 디자인 (이슈 #422) — 기능이 켜져 있으면 탭이 열려 있는 동안(이 컴포넌트가 마운트) 메인이 이 파일을 본다.
  // 파일이 디스크에서 바뀌면(AI 수정·터미널·바깥 에디터) 다시 읽어서 렌더링이 갱신된다
  const designOn = useFeatures().has('design')
  const watchedAbsolute = preview !== 'loading' && preview.status !== 'unavailable' ? preview.absolute : undefined
  useEffect(() => {
    if (!designOn) return
    void window.litecode.watchPreview(directory, token).catch(() => {})
    return () => {
      void window.litecode.unwatchPreview(directory, token).catch(() => {})
    }
  }, [directory, token, designOn])
  useEffect(() => {
    if (!designOn || !watchedAbsolute) return
    return window.litecode.onPreviewChanged((changed) => {
      if (changed === watchedAbsolute) setRevision((now) => now + 1)
    })
  }, [designOn, watchedAbsolute])

  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), COPIED_MS)
    return () => clearTimeout(timer)
  }, [copied])

  const file = preview !== 'loading' && preview.status !== 'unavailable' ? preview : undefined
  const text = preview !== 'loading' && preview.status === 'text' ? preview : undefined
  const markdown = !!text && /\.(md|markdown)$/i.test(text.path)
  // 잘린 HTML(1MB 넘음)은 렌더링하지 않는다 — 반쪽 문서를 돌리지 않는다
  const html = !!text && /\.html?$/i.test(text.path) && !text.truncated
  // svg (이슈 #214) — 기본은 이미지(<img>), 원문 보기로 글
  const svgSource = preview !== 'loading' && preview.status === 'image' ? preview.source : undefined
  const copyLabel = copied ? t('filePreview.copied') : t('filePreview.copyPath')

  return (
    <div className="file-view">
      <div className="file-preview__bar">
        <PathLabel path={file?.path ?? token} title={file?.absolute ?? token} />
        <span className="file-preview__tools">
          <span className="file-preview__kind">{kindOf(file?.path ?? token, t('filePreview.kindText'))}</span>
          {(markdown || html || svgSource !== undefined) && (
            <button type="button" className="file-preview__toggle" aria-pressed={source} onClick={() => setSource((now) => !now)}>
              {source ? (markdown ? t('filePreview.showRendered') : t('filePreview.showRenderedHtml')) : t('filePreview.showSource')}
            </button>
          )}
          <ReloadButton onClick={() => setRevision((now) => now + 1)} />
          {file && (
            <button
              type="button"
              className="file-preview__tool file-preview__reveal"
              aria-label={t('filePreview.reveal')}
              title={t('filePreview.reveal')}
              onClick={() => void window.litecode.revealFile(directory, token)}
            >
              <FolderIcon />
            </button>
          )}
          {file && (
            <button
              type="button"
              className="file-preview__tool file-preview__copy"
              aria-label={copyLabel}
              title={copyLabel}
              data-copied={copied}
              onClick={() => {
                navigator.clipboard.writeText(file.absolute).then(
                  () => setCopied(true),
                  () => {},
                )
              }}
            >
              {copied ? <CheckIcon /> : <CopyIcon />}
            </button>
          )}
          {!compareOn && compareCandidates && compareCandidates.length > 0 && onCompare && (
            <CompareMenu candidates={compareCandidates} onPick={onCompare} />
          )}
        </span>
      </div>
      {text?.truncated && (
        <p className="file-preview__notice" role="note">
          {t('filePreview.truncated', { shown: formatBytes(new TextEncoder().encode(text.text).length), size: formatBytes(text.size) })}
        </p>
      )}
      <div className={html && !source ? 'file-preview__body file-preview__body--frame' : 'file-preview__body'}>
        {preview === 'loading' ? (
          <p className="file-preview__empty">{t('filePreview.loading')}</p>
        ) : preview.status === 'unavailable' ? (
          <p className="file-preview__empty" role="alert">
            {t('filePreview.unavailable')}
          </p>
        ) : preview.status === 'binary' ? (
          <p className="file-preview__empty">{t('filePreview.binary', { size: formatBytes(preview.size) })}</p>
        ) : preview.status === 'tooLarge' ? (
          <p className="file-preview__empty">{t('filePreview.imageTooLarge', { size: formatBytes(preview.size), max: formatBytes(preview.limit) })}</p>
        ) : preview.status === 'pdf' ? (
          <PdfNotice directory={directory} token={token} size={preview.size} />
        ) : preview.status === 'image' ? (
          svgSource !== undefined && source ? (
            <CodeLines text={svgSource} path={preview.path} jump={jump} />
          ) : (
            <ImagePreviewBody src={preview.dataUrl} path={preview.path} />
          )
        ) : html && !source ? (
          <HtmlFrame key={revision} directory={directory} token={token} html={preview.text} />
        ) : markdown && !source ? (
          <div className="file-preview__md">
            <Markdown text={preview.text} directory={directory} />
          </div>
        ) : (
          <CodeLines text={preview.text} path={preview.path} jump={jump} />
        )}
      </div>
    </div>
  )
}

/** HTML 을 실제로 돌린다 — 격리는 htmlPreview.ts 머리 주석. 같은 폴더 리소스를 메인에서 받은 뒤에 문서를 싣는다 */
function HtmlFrame({ directory, token, html }: { directory: string; token: string; html: string }) {
  const t = useT()
  const [doc, setDoc] = useState<string>()
  useEffect(() => {
    let live = true
    const references = collectReferences(html)
    const assets: Promise<HtmlAsset[]> = references.length > 0 ? window.litecode.previewAssets(directory, token, references) : Promise.resolve([])
    assets.then(
      (found) => live && setDoc(buildHtmlDocument(html, found)),
      () => live && setDoc(buildHtmlDocument(html, [])),
    )
    return () => {
      live = false
    }
  }, [directory, token, html])
  if (doc === undefined) return <p className="file-preview__empty">{t('filePreview.loading')}</p>
  return <SandboxFrame doc={doc} title={t('filePreview.frame')} />
}

/** 격리된 iframe — HTML 미리보기와 확장 탭(이슈 #511)이 같이 쓴다. sandbox 는 allow-scripts 만(same-origin 없음), 문서는 buildHtmlDocument(CSP 를 맨 앞에) */
function SandboxFrame({ doc, title, frameRef }: { doc: string; title: string; frameRef?: RefObject<HTMLIFrameElement | null> }) {
  return <iframe ref={frameRef} className="file-preview__frame" sandbox="allow-scripts" srcDoc={doc} title={title} referrerPolicy="no-referrer" />
}

/** 확장 탭 (이슈 #511) — 켜진 정상 확장의 진입 HTML 을 메인에서 받아(read-entry) HTML 미리보기와 같은 격리 경로로 돌린다.
 *  한 파일짜리라 같은 폴더 리소스는 끼우지 않는다(assets 없음 — 상대 경로 리소스는 CSP 에 막힌다).
 *  통로 (이슈 #536): 이 탭의 iframe 이 보낸 요청만 받아(extensionBridge.bridgeRequestOf — 확장 id 는 탭이 쥔 id) 메인에 넘기고 그 iframe 으로 답한다.
 *  허용하지 않은 주소면 iframe 위에 동의 띠를 그린다(앱이 그린다 — 확장이 흉내 낼 수 없게 iframe 바깥) */
function ExtensionTab({ id, name, hidden, directory, conversationId }: { id: string; name: string; hidden: boolean; directory: string; conversationId?: string }) {
  const [result, setResult] = useState<ExtensionEntryResult>()
  const frameRef = useRef<HTMLIFrameElement>(null)
  const [consent] = useState(() => new ConsentQueue())
  const asking = useSyncExternalStore(
    (listener) => consent.subscribe(listener),
    () => consent.current,
  )
  useEffect(() => {
    let live = true
    window.litecode.readExtensionEntry(id).then(
      (read) => live && setResult(read),
      (error: unknown) => live && setResult({ ok: false, failure: { code: 'entry-unreadable', params: { message: reason(error) } } }),
    )
    return () => {
      live = false
    }
  }, [id])
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const frame = frameRef.current?.contentWindow
      const request = bridgeRequestOf(event, frame)
      if (!request || !frame) return
      void runBridgeCall(request, {
        call: (method, params) => window.litecode.callExtension(id, method, params, directory),
        ask: (origin) => consent.ask(origin),
        allow: (origin) => window.litecode.allowExtensionOrigin(id, origin),
        open: (path, line) => openFilePreview(directory, path, line, {}, conversationId),
        compose: (text, send) => requestCompose(directory, text, send),
      }).then((reply) => frame.postMessage(bridgeReply(request.id, reply), '*'))
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [id, directory, consent])
  // 탭이 닫히면 남은 질문은 거절로 — 기다리던 요청이 끝난다
  useEffect(() => () => consent.clear(), [consent])
  return (
    <div className="file-view file-preview__extension" hidden={hidden} data-extension={id}>
      {asking !== undefined && <ExtensionConsentBar name={name} origin={asking} onAnswer={(allowed) => consent.answer(allowed)} />}
      <ExtensionTabBody name={name} result={result} frameRef={frameRef} dimmed={asking !== undefined} />
    </div>
  )
}

/** 동의 띠 (이슈 #536, 시안 _workspace/mock-sonarqube-ext Ask) — 확장이 허용하지 않은 주소에 접속하려 한다. [거절][허용] */
export function ExtensionConsentBar({ name, origin, onAnswer }: { name: string; origin: string; onAnswer(allowed: boolean): void }) {
  const t = useT()
  const title = t('extensions.consent.title', { name })
  return (
    <div className="extension-consent" role="alertdialog" aria-label={title}>
      <div className="extension-consent__head">
        <PermissionIcon permission="network" className="extension-consent__icon" />
        <div className="extension-consent__text">
          <b>{title}</b>
          <code>{origin}</code>
          <span className="extension-consent__note">{t('extensions.consent.note')}</span>
        </div>
      </div>
      <div className="extension-consent__actions">
        <button type="button" className="settings-button settings-button--compact" onClick={() => onAnswer(false)}>
          {t('extensions.consent.deny')}
        </button>
        <button type="button" className="settings-button settings-button--compact settings-button--primary" onClick={() => onAnswer(true)}>
          {t('extensions.consent.allow')}
        </button>
      </div>
    </div>
  )
}

/** 확장 탭 본문 — 읽기 전이면 불러오는 중, 실패면 한 줄 오류(미리보기의 빈 상태 모양), 읽었으면 격리된 iframe. dimmed — 동의 띠가 묻는 동안 흐리게 */
export function ExtensionTabBody({
  name,
  result,
  frameRef,
  dimmed = false,
}: {
  name: string
  result: ExtensionEntryResult | undefined
  frameRef?: RefObject<HTMLIFrameElement | null>
  dimmed?: boolean
}) {
  const t = useT()
  const doc = useMemo(() => (result?.ok ? buildHtmlDocument(result.html, []) : undefined), [result])
  if (!result) return <p className="file-preview__empty">{t('filePreview.loading')}</p>
  if (!result.ok) {
    const text = failureLines(result.failure).map((line) => lineSummary(line, t)).join(' · ')
    return (
      <p className="file-preview__empty" role="alert">
        {t('extensions.tab.failed', { reason: text })}
      </p>
    )
  }
  return (
    <div className={dimmed ? 'file-preview__body file-preview__body--frame file-preview__body--dimmed' : 'file-preview__body file-preview__body--frame'}>
      <SandboxFrame doc={doc!} title={name} frameRef={frameRef} />
    </div>
  )
}

/** 이미지 (이슈 #214, dsh ui-sidebar-documentpreview ImageBody 참조) — 메인이 준 data: 주소를 <img> 하나로, 패널 폭에 맞춰 줄인다(늘리지 않는다).
 *  svg 도 <img> 로만 — 이미지로 그려진 svg 는 스크립트·외부 리소스가 돌지 않는다 */
export function ImagePreviewBody({ src, path }: { src: string; path: string }) {
  return (
    <div className="file-preview__image">
      <img src={src} alt={path} draggable={false} referrerPolicy="no-referrer" />
    </div>
  )
}

/** PDF (이슈 #214) — 패널 안에서는 그리지 않는다: 앱 창이 Chromium 내장 PDF 뷰어(plugins)를 켜지 않았고, 미리보기 하위 프레임은 이동·권한이
 *  막혀 있다(main.ts will-frame-navigate, resilience.ts allowPermission). 대신 "다른 앱에서 열기" 기능(ctx.openIn)이 켜졌으면 OS 기본 앱으로 */
export function PdfNotice({ directory, token, size }: { directory: string; token: string; size: number }) {
  const t = useT()
  const canOpen = useFeatures().has('openIn')
  const [error, setError] = useState<string>()
  return (
    <div className="file-preview__empty file-preview__pdf">
      <span>{t('filePreview.pdfNotice', { size: formatBytes(size) })}</span>
      {canOpen && (
        <button
          type="button"
          className="file-preview__toggle"
          onClick={() => {
            setError(undefined)
            window.litecode.openFileIn(directory, token).catch((failure: unknown) => setError(reason(failure)))
          }}
        >
          {t('filePreview.pdfOpen')}
        </button>
      )}
      {error && <span role="alert">{error}</span>}
    </div>
  )
}

/** 경로 — 폴더는 옅게, 마지막 이름은 굵게. 넘치면 앞(왼쪽)이 잘리고 흐려진다 — 파일 이름이 끝까지 보이게 (dsh PathLabel) */
function PathLabel({ path, title }: { path: string; title?: string }) {
  const outer = useRef<HTMLSpanElement>(null)
  const inner = useRef<HTMLSpanElement>(null)
  const [clipped, setClipped] = useState(false)
  useLayoutEffect(() => {
    const measure = () => setClipped(!!outer.current && !!inner.current && inner.current.offsetWidth > outer.current.clientWidth)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(outer.current!)
    return () => observer.disconnect()
  }, [path])
  const cut = path.lastIndexOf('/') + 1
  return (
    <span ref={outer} className="file-preview__path" title={title ?? path} data-clipped={clipped || undefined}>
      <span ref={inner} className="file-preview__path-inner">
        {cut > 0 && <span className="file-preview__path-dir">{path.slice(0, cut)}</span>}
        <strong className="file-preview__path-name">{path.slice(cut)}</strong>
      </span>
    </span>
  )
}

function ReloadButton({ onClick }: { onClick(): void }) {
  const t = useT()
  return (
    <button type="button" className="file-preview__tool file-preview__reload" aria-label={t('filePreview.reload')} title={t('filePreview.reload')} onClick={onClick}>
      <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M13.25 8A5.25 5.25 0 1 1 11.7 4.3" />
        <path d="M13.25 2.5V5H10.75" />
      </svg>
    </button>
  )
}

/** 경로 줄의 종류 — 확장자로 (dsh 는 고른 렌더러 이름) */
export function kindOf(file: string, text: string): string {
  const ext = /\.([^./]+)$/.exec(file)?.[1]?.toLowerCase()
  if (!ext) return text
  const known: Record<string, string> = {
    html: 'HTML', htm: 'HTML', md: 'Markdown', markdown: 'Markdown', ts: 'TypeScript', tsx: 'TypeScript', mts: 'TypeScript', cts: 'TypeScript',
    js: 'JavaScript', jsx: 'JavaScript', mjs: 'JavaScript', cjs: 'JavaScript', json: 'JSON', css: 'CSS', py: 'Python', sh: 'Shell',
    yml: 'YAML', yaml: 'YAML', txt: text,
  }
  return known[ext] ?? ext.toUpperCase()
}

/** 줄 번호 + 글 — 두 열을 줄 단위 요소로 쪼개지 않는다(1MB 파일도 요소 두 개). 줄바꿈 없이(white-space: pre) 같은 줄 높이라 줄이 맞는다.
 *  글자의 문법 색은 확장자로 고른 언어로(highlight.ts — 5,000줄·30만 자를 넘으면 색 없이). 색은 글자색만 바꿔 줄 높이는 그대로다.
 *  jump 가 있으면 그 줄로 스크롤하고 그 줄에 띠를 깐다 — 줄 높이가 같아 자리는 곱셈이다(lineJump.ts). 줄 높이는 줄 번호 열을 재서 안다 */
function CodeLines({ text, path, jump }: { text: string; path: string; jump?: { line: number; seq: number } }) {
  const lines = text.endsWith('\n') ? text.slice(0, -1).split('\n') : text.split('\n')
  const code = lines.join('\n')
  const tokens = useHighlight(code, languageOfPath(path))
  const numbers = lines.map((_, index) => index + 1).join('\n')
  const gutter = useRef<HTMLPreElement>(null)
  const [mark, setMark] = useState<{ line: number; top: number; height: number }>()
  useLayoutEffect(() => {
    const column = gutter.current
    const scroller = column?.closest<HTMLElement>('.file-preview__body')
    if (!jump || !column || !scroller) return setMark(undefined)
    const height = column.offsetHeight / lines.length
    const target = lineJump(jump.line, lines.length, height, scroller.clientHeight, column.offsetTop)
    setMark({ line: target.line, top: column.offsetTop + target.top, height })
    scroller.scrollTop = target.scrollTop
  }, [jump?.seq, jump?.line, text])
  return (
    <div className="file-preview__code">
      {mark && <div className="file-preview__mark" data-line={mark.line} style={{ top: mark.top, height: mark.height }} />}
      <pre ref={gutter} className="file-preview__gutter" aria-hidden="true">
        {numbers}
      </pre>
      <pre className="file-preview__text">
        <code>{tokens ? <Tokens tokens={tokens} /> : code}</code>
      </pre>
    </div>
  )
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function FileIcon({ className = 'file-preview__icon' }: { className?: string }) {
  return (
    <svg className={className} width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 1.75H9.5L12.5 4.75V14.25H4Z" />
      <path d="M9.5 1.75V4.75H12.5" />
    </svg>
  )
}

function FolderIcon({ className, open }: { className?: string; open?: boolean }) {
  return (
    <svg className={className} width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" aria-hidden="true">
      {open ? (
        <path d="M1.75 12.25V4.25C1.75 3.42 2.42 2.75 3.25 2.75H6.25L7.75 4.25H12C12.83 4.25 13.5 4.92 13.5 5.75V6.75M1.75 12.25L3.4 7.6C3.6 7.06 4.1 6.75 4.66 6.75H14.1C14.62 6.75 14.98 7.27 14.8 7.76L13.3 12.25C13.1 12.8 12.6 13.25 12 13.25H2.75C2.2 13.25 1.75 12.8 1.75 12.25Z" />
      ) : (
        <path d="M1.75 4.25C1.75 3.42 2.42 2.75 3.25 2.75H6.25L7.75 4.25H12.75C13.58 4.25 14.25 4.92 14.25 5.75V11.75C14.25 12.58 13.58 13.25 12.75 13.25H3.25C2.42 13.25 1.75 12.58 1.75 11.75Z" />
      )}
    </svg>
  )
}

function TerminalIcon({ className = 'file-preview__icon', size = 14 }: { className?: string; size?: number }) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 4.5L6.5 8L3 11.5" />
      <path d="M8.5 12H13" />
    </svg>
  )
}

/** 작업 탭 — 목록 그림 (점 셋 + 줄) */
function TaskIcon({ className = 'file-preview__icon' }: { className?: string }) {
  return (
    <svg className={className} width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" aria-hidden="true">
      <circle cx="3.5" cy="4.5" r="0.9" fill="currentColor" stroke="none" />
      <circle cx="3.5" cy="8" r="0.9" fill="currentColor" stroke="none" />
      <circle cx="3.5" cy="11.5" r="0.9" fill="currentColor" stroke="none" />
      <path d="M6.5 4.5H13M6.5 8H13M6.5 11.5H11" />
    </svg>
  )
}

/** "턴 작업" 탭 — 번개 (이슈 #416, 대화 진행 중 줄의 아이콘과 같은 번개) */
function TurnTabIcon({ className = 'file-preview__icon' }: { className?: string }) {
  return (
    <svg className={className} width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M8 1L9.6 6.4L15 8L9.6 9.6L8 15L6.4 9.6L1 8L6.4 6.4Z" />
    </svg>
  )
}

function CrossIcon({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden="true">
      <path d="M4 4L12 12M12 4L4 12" />
    </svg>
  )
}
