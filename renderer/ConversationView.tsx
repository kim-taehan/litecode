import { Fragment, type Dispatch, type RefObject, type SetStateAction } from 'react'
import type { Attention, AttentionAnswer, AttentionTarget, HistoryMessage, Mode, PickedAttachment, PlanReviewCard, TurnItem } from '../shared/ipc.ts'
import type { FeatureId } from '../shared/features.ts'
import { planEnded, switchedMode } from './chatState.ts'
import { AssistantTurn, UserMessage } from './ChatTurn.tsx'
import { Minimap } from './Minimap.tsx'
import { minimapTurnDetails, type MinimapTurn } from './turnView.ts'
import { ScrollToBottom } from './ScrollToBottom.tsx'
import type { findModel } from './modelChoice.ts'
import { Trajectory } from './Trajectory.tsx'
import { ShellCard } from './ShellCard.tsx'
import { PlanReviewCard as PlanReviewCardView } from './GoalDock.tsx'
import type { CommandLine } from './commandLine.ts'
import type { Translate } from './settingsStore.ts'
import { JobsHeader, useBackgroundTasks } from './Jobs.tsx'
import { OpenInButton } from './OpenInButton.tsx'
import { ConversationMenu } from './Report.tsx'
import { RightPanelButton } from './FilePreview.tsx'
import { ErrorBoundary } from './ErrorBoundary.tsx'
import { ChatFind, FindingProvider } from './ChatFind.tsx'
import type { Session } from './session.ts'

// 답·내 말(ChatTurn.tsx)은 memo 다 — 입력창에 글자를 칠 때마다 App 이 다시 그려져도 props 가 같으면 턴을 다시 그리지 않는다.
// 그래서 턴에 넘기는 "없음" 배열과 답 보내기 함수는 매번 새로 만들지 않는다
const NO_ITEMS: readonly TurnItem[] = []

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
  /** 앱 명령 줄 (이슈 #626) — 엔진에 안 간 내 말과 그 결과. 임시(리로드면 없다) */
  commandLines?: readonly CommandLine[]
  /** 계획 검토 카드 (이슈 #626) — 이 대화가 계획 검토를 기다리면 */
  planReview?: PlanReviewCard
  onPlanAnswer(id: string, decision: 'approve' | 'revise', feedback?: string): void
}

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
  commandLines,
  planReview,
  onPlanAnswer,
}: ConversationViewProps) {
  // 그 대화의 백그라운드 작업 (#319) — 머리의 작업 트리거(Jobs.tsx)에서 도는 것 + 끝난 것을 센다
  const backgroundTasks = useBackgroundTasks(active.id)
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

  return (
    <>
      <div className="main__header">
        {titleOf(active)}
        {/* 작업 목록 (이슈 #610, dsh ui-jobs 모양 — #32 머리 버튼 + #295 입력 카드 위 줄을 대신한다) —
            하위 작업이 있는 턴만. 턴이 끝나도 새 턴 전까지 끝난 작업을 남긴다. 대화를 바꾸면 key 로 잊는다 */}
        <JobsHeader key={`jobs-${active.id}`} items={active.progress} pending={!!active.pending} startedAt={active.sentAt} background={backgroundTasks} directory={active.project} />
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
                tokens={message.tokens}
                finishedAt={message.finishedAt}
                directory={active.project}
                startedAt={precedingUserAt(active.messages, index)}
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
        {/* 앱 명령 줄 (이슈 #626) — /goal·/plan 처럼 엔진에 안 간 내 말(에코)과 그 결과. 도는 턴 앞에 붙인다 */}
        {(commandLines?.length ?? 0) > 0 &&
          commandLines?.map((line) => (
            <div key={line.id} className="command-line">
              <div className="command-line__echo">{line.echo}</div>
              <pre className="command-line__result">{line.result}</pre>
            </div>
          ))}
        {/* 계획 검토 카드 (이슈 #626) — 승인·계속 계획. 답하면 main 이 카드를 닫아 준다 */}
        {planReview && (
          <PlanReviewCardView
            t={t}
            plan={planReview.plan}
            onAnswer={(decision: 'approve' | 'revise', feedback?: string) => onPlanAnswer(planReview.id, decision, feedback)}
          />
        )}
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
      <Minimap scroller={listRef} turns={minimapTurnDetails(active.messages, active.id)} />
      <ScrollToBottom scroller={listRef} following={following} />
      </div>
      )}
      </ErrorBoundary>
    </>
  )
}
