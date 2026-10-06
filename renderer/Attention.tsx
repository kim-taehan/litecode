import { useEffect, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import type { Attention, AttentionAnswer, AttentionQuestion, AttentionTarget } from '../shared/ipc.ts'
import { useT } from './settingsStore.ts'
import { reason } from './ipcError.ts'
import { TargetPickerBody, useDelegation } from './Delegation.tsx'
import { readRequest, targetPicker } from './delegationView.ts'
import { QuestionDrafts } from './questionDrafts.ts'
import './attention.css'

// 턴이 사람을 기다릴 때 대화 안에 뜨는 카드 (라운드 A). 승인 카드는 dsh ui-approval(주황 띠 "승인 대기" + 제목 + 명령 + [거절][한 번 허용],
// 카드에 포커스가 있으면 Enter 허용·Esc 거절), 질문 카드는 dsh ui-user-questions(보기 버튼 + 직접 입력)의 모양·동작을 litecode 로 새로 썼다.
// "항상 허용" 은 두지 않는다(사용자 결정 — 되돌릴 화면이 없다). 답은 메인(ctx.llm.reply)으로 가고, 답한 카드는 메인이 목록에서 뺀다.

interface CardProps<T extends Attention> {
  request: T
  /** target: 지시 보내기를 허용하며 고른 받을 대화 (이슈 #67) */
  onAnswer(answer: AttentionAnswer, target?: AttentionTarget): Promise<void>
}

export function AttentionCard({ request, onAnswer }: CardProps<Attention>) {
  return request.kind === 'permission' ? <ApprovalCard request={request} onAnswer={onAnswer} /> : <QuestionCard request={request} onAnswer={onAnswer} />
}

/** 한 번만 보낸다 — 실패하면 사유를 보이고 다시 누를 수 있다 */
function useAnswer(onAnswer: CardProps<Attention>['onAnswer']) {
  const t = useT()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const answer = (value: AttentionAnswer, target?: AttentionTarget): void => {
    if (busy) return
    setBusy(true)
    setError(undefined)
    onAnswer(value, target).catch((cause: unknown) => {
      setBusy(false)
      setError(t('approval.sendError', { reason: reason(cause) }))
    })
  }
  return { busy, error, answer }
}

/** 하위 작업(자식 세션)이 물었으면 띠 오른쪽에 어느 하위 작업인지 (이슈 #31) */
function SubtaskLabel({ request }: { request: Attention }) {
  const t = useT()
  if (!request.subtask) return null
  const name = [request.subtask.agent, request.subtask.description].filter(Boolean).join(' · ')
  return <span className="attention-card__from">{t('approval.fromSubtask', { name })}</span>
}

const ACTIONS = ['bash', 'edit', 'read', 'external_directory', 'webfetch'] as const

function ApprovalCard({ request, onAnswer }: CardProps<Extract<Attention, { kind: 'permission' }>>) {
  const t = useT()
  const { busy, error, answer } = useAnswer(onAnswer)
  const known = (ACTIONS as readonly string[]).includes(request.action) ? (request.action as (typeof ACTIONS)[number]) : undefined
  // 다른 프로젝트에 지시 보내기 (이슈 #55·#67·#137) — 보낼 때마다 받을 프로젝트를 사용자가 고르고(AI 가 고른 곳이 먼저 선택돼 있다) 보낼 글
  // 전문을 본다. 고른 대상은 허용과 함께 메인으로 간다 — 엔진에는 once 만 간다. "항상 허용" 은 이 도구에 특히 없어야 한다: 엔진의 always 는
  // 그 폴더의 모든 대화에 걸린다 (01z 1-3)
  const { targets, self } = useDelegation()
  const delegation = targetPicker(request, targets, self)
  /** 다른 프로젝트의 대화 읽기 (이슈 #137) — 읽을 곳(프로젝트 · 대화)을 보이는 보통의 승인 카드 */
  const reading = readRequest(request, targets)
  const [picked, setPicked] = useState(delegation?.initial)
  /** 지금 고른 줄 — 고른 대화가 그사이 목록에서 빠졌으면(지워짐) 없다. 없으면 보낼 수 없다 */
  const chosen = delegation?.choices.find((choice) => choice.key === picked)
  const allow = (): void => {
    if (!delegation) return answer('once')
    if (chosen) answer('once', chosen.target)
  }
  const keydown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'Enter' && event.key !== 'Escape') return
    if (event.key === 'Enter' && (event.target as Element).closest('button')) return // 포커스된 버튼은 자기 동작
    if (event.nativeEvent.isComposing || event.keyCode === 229) return
    event.preventDefault()
    if (event.key === 'Enter') allow()
    else answer('reject')
  }
  return (
    <div className="attention-card" data-kind="permission" data-delegation={delegation ? 'send' : undefined} aria-busy={busy} onKeyDown={keydown}>
      <div className="attention-card__strip">
        <span className="attention-card__dot" aria-hidden="true" />
        {t('approval.waiting')}
        <SubtaskLabel request={request} />
      </div>
      <div className="attention-card__body" tabIndex={0} role="group" aria-label={t('approval.waiting')}>
        {delegation ? (
          <TargetPickerBody picker={delegation} selected={chosen?.key} disabled={busy} onSelect={setPicked} />
        ) : (
          <div className="attention-card__headline">
            {reading !== undefined ? t('delegate.card.read') : request.mcp ? t('approval.mcp') : known ? t(`approval.${known}`) : t('approval.other', { action: request.action })}
          </div>
        )}
        {/* MCP 도구 요청의 patterns 는 늘 ["*"] 라 서버·도구 이름을 보인다 (이슈 #28) */}
        {delegation ? null : reading !== undefined ? (
          <div className="attention-card__command">{reading}</div>
        ) : request.mcp ? (
          <div className="attention-card__command" data-mcp={`${request.mcp.server}/${request.mcp.tool}`}>
            {`${t('mcp.chat')} · ${request.mcp.server} · ${request.mcp.tool}`}
          </div>
        ) : (
          request.resources.map((resource) => (
            <div key={resource} className="attention-card__command">
              {resource}
            </div>
          ))
        )}
      </div>
      {error && (
        <p className="attention-card__error" role="alert">
          {error}
        </p>
      )}
      <div className="attention-card__actions">
        {delegation && <span className="attention-card__actions-note">{t('delegate.card.note')}</span>}
        <button type="button" className="attention-card__button attention-card__button--reject" disabled={busy} onClick={() => answer('reject')}>
          {t('approval.reject')}
        </button>
        <button type="button" className="attention-card__button attention-card__button--primary" disabled={busy || (!!delegation && !chosen)} onClick={allow}>
          {!delegation ? t('approval.allowOnce') : chosen ? t('delegate.pick.send', { project: chosen.project.name }) : t('delegate.pick.sendNone')}
        </button>
      </div>
    </div>
  )
}

interface Draft {
  selected: string[]
  custom: string
}

/** 질문 카드에 쓰던 답 — 대화·탭을 바꿔 카드가 내려가도 요청 id 로 남는다. 요청이 풀리면 App 이 버린다 (keepOnly) */
export const questionDrafts = new QuestionDrafts<Draft[]>()

/** 질문마다 고른 보기 + 직접 쓴 글. 하나만 고르는 질문에서 직접 쓰면 그것이 답이다 */
function answerOf(question: AttentionQuestion, draft: Draft): string[] {
  const custom = draft.custom.trim()
  if (!custom) return draft.selected
  return question.multiple ? [...draft.selected, custom] : [custom]
}

function QuestionCard({ request, onAnswer }: CardProps<Extract<Attention, { kind: 'question' }>>) {
  const t = useT()
  const { busy, error, answer } = useAnswer(onAnswer)
  const [drafts, setDrafts] = useState<Draft[]>(() => {
    const saved = questionDrafts.load(request.id)
    return saved?.length === request.questions.length ? saved : request.questions.map(() => ({ selected: [], custom: '' }))
  })
  useEffect(() => questionDrafts.save(request.id, drafts), [request.id, drafts])
  const answers = request.questions.map((question, index) => answerOf(question, drafts[index]!))
  const ready = answers.every((entry) => entry.length > 0) // 빈 답은 막는다 — opencode 는 빈 답도 받는다 (01i 2-b)
  const update = (index: number, change: (draft: Draft) => Draft) => setDrafts((now) => now.map((draft, at) => (at === index ? change(draft) : draft)))

  return (
    <div className="attention-card" data-kind="question" aria-busy={busy}>
      <div className="attention-card__strip">
        <span className="attention-card__dot" aria-hidden="true" />
        {t('question.waiting')}
        <SubtaskLabel request={request} />
      </div>
      <div className="attention-card__body">
        {request.questions.map((question, index) => (
          <fieldset key={index} className="attention-question" disabled={busy}>
            <legend className="attention-card__headline">
              {question.header && <span className="attention-question__header">{question.header}</span>}
              {question.question}
            </legend>
            {question.options.length > 0 && (
              <div className="attention-question__options">
                {question.options.map((option) => (
                  <button
                    key={option.label}
                    type="button"
                    className="attention-question__option"
                    aria-pressed={drafts[index]!.selected.includes(option.label)}
                    title={option.description}
                    onClick={() =>
                      update(index, (draft) =>
                        question.multiple
                          ? { ...draft, selected: draft.selected.includes(option.label) ? draft.selected.filter((label) => label !== option.label) : [...draft.selected, option.label] }
                          : { selected: draft.selected.includes(option.label) ? [] : [option.label], custom: '' },
                      )
                    }
                  >
                    <span className="attention-question__label">{option.label}</span>
                    {option.description && <span className="attention-question__description">{option.description}</span>}
                  </button>
                ))}
              </div>
            )}
            <input
              className="attention-question__custom"
              placeholder={t('question.custom')}
              aria-label={t('question.custom')}
              value={drafts[index]!.custom}
              onChange={(event) => {
                const custom = event.target.value
                update(index, (draft) => ({ selected: question.multiple ? draft.selected : [], custom }))
              }}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing || event.keyCode === 229) return
                if (event.key === 'Enter' && ready) answer(answers)
              }}
            />
          </fieldset>
        ))}
      </div>
      {error && (
        <p className="attention-card__error" role="alert">
          {error}
        </p>
      )}
      <div className="attention-card__actions">
        <button type="button" className="attention-card__button attention-card__button--reject" disabled={busy} onClick={() => answer('reject')}>
          {t('question.reject')}
        </button>
        <button type="button" className="attention-card__button attention-card__button--primary" disabled={busy || !ready} onClick={() => answer(answers)}>
          {t('question.send')}
        </button>
      </div>
    </div>
  )
}
