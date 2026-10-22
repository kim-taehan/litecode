import { Fragment, useEffect, useRef, type Dispatch, type RefObject, type SetStateAction } from 'react'
import type { Attention, AttentionAnswer, AttentionTarget, HistoryMessage, Mode, PickedAttachment, TurnItem } from '../shared/ipc.ts'
import type { FeatureId } from '../shared/features.ts'
import { planEnded, switchedMode, applyHistory } from './chatState.ts'
import { AssistantTurn, UserMessage } from './ChatTurn.tsx'
import { Minimap } from './Minimap.tsx'
import { minimapTurnDetails, type MinimapTurn } from './turnView.ts'
import { openTurnTab } from './filePreviewStore.ts'
import { feedCompletedTurn } from './turnDetailStore.ts'
import { ScrollToBottom } from './ScrollToBottom.tsx'
import type { findModel } from './modelChoice.ts'
import { Trajectory } from './Trajectory.tsx'
import { ShellCard } from './ShellCard.tsx'
import type { Translate } from './settingsStore.ts'
import { OpenInButton } from './OpenInButton.tsx'
import { ConversationMenu } from './Report.tsx'
import { RightPanelButton } from './FilePreview.tsx'
import { ErrorBoundary } from './ErrorBoundary.tsx'
import { ChatFind, FindingProvider } from './ChatFind.tsx'
import type { Session } from './session.ts'

// 답·내 말(ChatTurn.tsx)은 memo 다 — 입력창에 글자를 칠 때마다 App 이 다시 그려져도 props 가 같으면 턴을 다시 그리지 않는다.
// 그래서 턴에 넘기는 "없음" 배열과 답 보내기 함수는 매번 새로 만들지 않는다
const NO_ITEMS: readonly TurnItem[] = []

/** 대화 처음 열 때·"이전 N개 보기" (스크롤 최상단 자동 로드) 에서 한 번에 불러 오는 메시지의 최대 개수.
 *  더 이전이 있으면 more=true·hiddenCount 로 표시해 스크롤 한 번 더 하면 다음 페이지가 보인다 */
export const RECENT_FIRST_LIMIT = 10
const answerAttention = (request: Attention, answer: AttentionAnswer, target?: AttentionTarget) =>
  window.litecode.replyAttention(request.sessionId, request.id, answer, target)

/** 끝난 assistant 턴의 startedAt — preceding user message 의 at. 없으면 undefined */
function precedingUserAt(messages: readonly HistoryMessage[], index: number): number | undefined {
  for (let i = index - 1; i >= 0; i--) {
    const message = messages[i]
    if (message && message.role === 'user' && message.at !== undefined) return message.at
  }
  return undefined
}

/** 그 assistant 턴을 바로 앞선 내 말 — 없으면(첨부만·오래된 기록) undefined */
function precedingUserText(messages: readonly HistoryMessage[], index: number): string | undefined {
  for (let i = index - 1; i >= 0; i--) {
    const message = messages[i]
    if (message && message.role === 'user') return message.text || undefined
  }
  return undefined
}

interface ConversationViewProps {
  t: Translate
  active: Session
  /** 새 대화는 제목 없이 두고 보일 때 번역한다 */
  titleOf(session: Session): string
  /** 켜진 기능 (설정 > 기능) */
  features: ReadonlySet<FeatureId>
  trajectoryOn: boolean
  view: 'chat' | 'trajectory'
  setView: Dispatch<SetStateAction<'chat' | 'trajectory'>>
  listRef: RefObject<HTMLDivElement | null>
  setFinding: Dispatch<SetStateAction<boolean>>
  finding: boolean
  following: RefObject<boolean>
  /** 이 대화의 모델 — 설정에서 지워졌으면 없다 */
  chosen: ReturnType<typeof findModel>
  send(command?: { text: string; display?: string; attachments?: PickedAttachment[] }, opts?: { mode?: Mode }): void
  shareShell(target: Session, cardId: string): Promise<string | undefined>
  /** "이전 N개 보기" — 전체를 다시 불러온다 */
  updateSession(id: string, recipe: (session: Session) => Session): void
}

/** 스크롤 최상단 근처(40px 미만) — Minimap の nearBottom 과 방향만 반대. 새 턴이 그 사이에 오면 그대로 둔다 */
const nearTop = (element: HTMLElement): boolean => element.scrollTop < 40

/** 지금 대화의 머리 줄·탭과 본문(말풍선·`!` 카드·도는 턴 또는 Trajectory). 상태는 App 이 쥐고 여기는 그리기만 한다 */
export function ConversationView({
  t,
  active,
  titleOf,
  features,
  trajectoryOn,
  view,
  setView,
  listRef,
  setFinding,
  finding,
  following,
  chosen,
  send,
  shareShell,
  updateSession,
}: ConversationViewProps) {
  /** 미니맵 줄 클릭 — 그 턴으로 스크롤(Minimap)은 한 뒤 우측 "턴 작업" 탭을 연다 (이슈 #575).
   *  끝난 턴은 채팅 items 로 기록을 보충해 오래된 턴도 보이고, 진행 중 턴(시작 시각만)은 실시간 저장소만 본다 */
  function openMinimapTurn(turn: MinimapTurn) {
    if (turn.startedAt === undefined) return
    if (turn.items.length > 0) feedCompletedTurn(turn.conversationId, turn.startedAt, turn.items, { duration: turn.duration, failed: turn.failed, interrupted: turn.interrupted, declined: turn.declined, userQuery: turn.text })
    openTurnTab(active.project, turn.conversationId, turn.startedAt, turn.text)
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

  /** limit=RECENT_FIRST_LIMIT 으로 이전 페이지만 불러와 앞에 붙인다. 더 있으면 historyMore 가 true 로 남는다 */
  function loadEarlier() {
    const id = active.id
    if (loadingRef.current) return
    const element = listRef.current
    const firstTurns = element ? [...element.querySelectorAll<HTMLElement>('.user-turn')] : []
    firstTurnRef.current = firstTurns[0] ?? null
    priorScrollTopRef.current = element ? element.scrollTop : 0
    loadingRef.current = true
    void window.litecode.loadConversation(id, RECENT_FIRST_LIMIT).then((loaded) => {
      loadingRef.current = false
      updateSession(id, (session) => ({
        ...applyHistory(session, [...loaded.messages, ...(loaded.error ? [{ role: 'assistant' as const, text: `⚠️ ${loaded.error}` }] : [])]),
        history: loaded.missingFolder ? 'missing' : 'loaded',
        ...(loaded.more ? { historyMore: true, hiddenCount: loaded.hiddenCount } : { historyMore: false, hiddenCount: undefined }),
      }))
    })
  }

  // 스크롤 최상단(nearTop)까지 올리면 자동으로 한 페이지만 더 불러온다 (이슈 #599).
  // 로딩 중 중복 로딩은 loadingRef 로 막고, 로딩 후 새 첫 내 말이 안에 보이게 스크롤 오프셋 보정한다
  const loadingRef = useRef(false)
  /** 로딩 전 첫 내 말 — 로딩 후 .user-turn 첫 개(새 페이지만의 첫 내 말)와 같은 y 가 되게 스크롤 보정 */
  const firstTurnRef = useRef<HTMLElement | null>(null)
  /** 이전 스크롤 위치 — 새 페이지만이 그 위에 붙었다면 그 위치를 유지 */
  const priorScrollTopRef = useRef(0)
  useEffect(() => {
    const element = listRef.current
    if (!element || !active.historyMore || active.history !== 'loaded') return
    const handler = () => {
      if (nearTop(element)) loadEarlier()
    }
    element.addEventListener('scroll', handler, { passive: true })
    return () => element.removeEventListener('scroll', handler)
  }, [listRef, active.history, active.historyMore])
  // 새 첫 내 말이 그려지면 로딩 전 스크롤 위치와 같은 y 에 보정 — 이전 첫 내 말과 새 첫 내 말이 겹치면 그 자리가
  useEffect(() => {
    const element = listRef.current
    if (!element || !firstTurnRef.current) return
    const priorScrollTop = priorScrollTopRef.current
    const old = firstTurnRef.current
    firstTurnRef.current = null
    priorScrollTopRef.current = 0
    if (!priorScrollTop) return
    requestAnimationFrame(() => {
      const newFirst = element.querySelector<HTMLElement>('.user-turn')
      if (!newFirst) return
      const targetTop = newFirst.getBoundingClientRect().top - element.getBoundingClientRect().top
      if (Math.abs(targetTop - priorScrollTop) > 4) element.scrollTop = priorScrollTop - targetTop
    })
  }, [listRef, active.messages])

  return (
    <>
      <div className="main__header">
        {titleOf(active)}
        {features.has('openIn') && <OpenInButton directory={active.project} />}
        <RightPanelButton directory={active.project} />
        {/* 더 보기 ⋯ — 대화 내보내기 (이슈 #177) */}
        <ConversationMenu key={active.id} conversationId={active.id} />
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
          <>
            {active.messages.length === 0 && <div className="empty">{t('chat.empty')}</div>}
            {active.historyMore && (
              <button type="button" className="run-plan" onClick={loadEarlier}>
                {t('chat.loadMore', { count: active.hiddenCount ?? '' })}
              </button>
            )}
          </>
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
              <UserMessage text={message.text} at={message.at} attachments={message.attachments} origin={message.origin} unanswered={message.unanswered} />
            ) : (
              <AssistantTurn
                items={message.items ?? NO_ITEMS}
                text={message.error ? `⚠️ ${message.error}` : message.text}
                failed={!!message.error}
                interrupted={message.interrupted}
                declined={message.declined}
                duration={message.duration}
                directory={active.project}
                conversationId={active.id}
                startedAt={precedingUserAt(active.messages, index)}
                userQuery={precedingUserText(active.messages, index)}
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
            conversationId={active.id}
            directory={active.project}
            attention={active.attention}
            onAnswer={answerAttention}
          />
        )}
        {shellCards(active, (position) => position > active.messages.length)}
        </div>
      </div>
      </FindingProvider>
      <Minimap scroller={listRef} turns={minimapTurnDetails(active.messages, active.id)} onTurnOpen={openMinimapTurn} />
      <ScrollToBottom scroller={listRef} following={following} />
      </div>
      )}
      </ErrorBoundary>
    </>
  )
}
