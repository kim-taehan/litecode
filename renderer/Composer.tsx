import type { RefObject } from 'react'
import type { AttachmentKind, Mode, PickedAttachment, Project, ProviderSummary, QueuedSend } from '../shared/ipc.ts'
import type { findModel, ModelRef } from './modelChoice.ts'
import { ModelSelect } from './ModelSelect.tsx'
import { StatsBar } from './StatsBar.tsx'
import { chatStats } from './stats.ts'
import type { Triggers } from './useTriggers.ts'
import { TriggerPopup } from './TriggerPopup.tsx'
import type { Translate } from './settingsStore.ts'
import { ModeChip, nextMode } from './ModeChip.tsx'
import { PlusMenu } from './PlusMenu.tsx'
import { VoiceButton, VoiceStrip, type VoiceInput } from './VoiceInput.tsx'
import { AttachmentChips } from './Attachments.tsx'
import { pasteIntent } from './dropPaste.ts'
import { QueueDock } from './QueueDock.tsx'
import { TodoDock } from './Todo.tsx'
import { GoalDock, type useGoal } from './Goal.tsx'
import { StopIcon } from './stopTurn.tsx'
import { browseHistory, sentTexts } from './inputHistory.ts'
import { canWrite, type Session } from './session.ts'

interface ComposerProps {
  t: Translate
  active: Session
  /** 지금 대화의 목표 (이슈 #285) */
  goal: ReturnType<typeof useGoal>
  goalAction(id: string, action: 'pause' | 'resume' | 'clear'): void
  restoreQueued(id: string, taken: QueuedSend): void
  trigger: Triggers
  /** 지금 대화의 초안 — 글과 붙여 둔 칩 */
  draft: string
  setDraft(text: string): void
  attached: PickedAttachment[]
  setAttached(change: (now: PickedAttachment[]) => PickedAttachment[]): void
  /** 입력 기록(↑/↓)으로 불러와 있는 글의 자리 */
  browsing: RefObject<{ id: string; index: number } | undefined>
  mode: Mode
  chooseMode(next: Mode): void
  providers: ProviderSummary[]
  projects: Project[] | undefined
  selected: ModelRef | undefined
  chosen: ReturnType<typeof findModel>
  chooseModel(next: ModelRef): void
  voice: VoiceInput
  submit(): void
  stopTurn(id: string): void
  attachFiles(files: File[]): Promise<void>
  addAttachments(kind: AttachmentKind): Promise<void>
}

/** 입력 카드 — 목표·할 일·대기열 줄, 입력칸과 아래 줄(+ · 모드 · 모델 · 음성 · 보내기), 통계 줄. 상태는 App 이 쥐고 여기는 그리기만 한다 */
export function Composer({
  t,
  active,
  goal,
  goalAction,
  restoreQueued,
  trigger,
  draft,
  setDraft,
  attached,
  setAttached,
  browsing,
  mode,
  chooseMode,
  providers,
  projects,
  selected,
  chosen,
  chooseModel,
  voice,
  submit,
  stopTurn,
  attachFiles,
  addAttachments,
}: ComposerProps) {
  return (
    <div className="composer">
      {/* 이 대화의 목표 (이슈 #285) — 판이 여럿이면 맨 위 */}
      {goal && <GoalDock goal={goal} onCommand={(action) => goalAction(active.id, action)} />}
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
  )
}
