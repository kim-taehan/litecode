import { MODE_AGENT } from './engine.ts'
import { MODES, type Mode } from '../../shared/modes.ts'
import { messageItems, type EngineMessageInfo, type EnginePart, type McpToolResolver, type SubtaskHistory, type TurnItem } from './turnProgress.ts'
import { instructionsNote } from './instructions.ts'
import { turnError } from './contextOverflow.ts'
import { tr } from '../i18n.ts'
import type { EngineMessage } from './llm.ts'
import type { Attachment, HistoryMessage } from '../../shared/contract.ts'

// 엔진 기록(레거시 GET /session/{id}/message) → 말풍선 변환 (이슈 #182 — llm.ts 에서 옮겼다). 순수 함수만 둔다. opencode 형식을 아는 곳이라
// ctx.llm 과 함께 엔진 경계 안쪽이다 — 엔진을 바꾸면 이 변환도 바꾼다 (trajectory.ts 의 레코드 변환과 같은 원천).

/** 엔진 재시작·크래시로 끊긴 턴의 사유 — 지금 언어로 (그래서 상수가 아니다. 중단 판정은 문구가 아니라 interrupted 로 한다) */
export function interruptedError(): string {
  return tr('error.interrupted')
}

/** opencode 에이전트 → 모드 (모르는 에이전트면 없음) */
export function modeOf(agent: string | undefined): Mode | undefined {
  return agent === undefined ? undefined : MODES.find((mode) => MODE_AGENT[mode] === agent)
}

/** 레거시 메시지(asc) → 말풍선. 한 턴의 assistant 여럿(도구 스텝)은 한 답으로 합치고 텍스트만 쓴다 — 실시간 턴이 글 줄만 모으는 것과 같은 모양.
 *  끊긴 턴: 엔진 재시작 뒤 그 턴은 완료 시각 없는 assistant(+ running 도구)로 남는다(01w) — 그 세션이 돌고 있지 않은데 마지막이 답 없는 user 이거나
 *  완료 시각 없는 assistant 면 끝에 "중단됨" 을 단다. 마지막이 아닌 턴도 같은 모양이면 중단이다. 사용자가 멈춘 턴은 MessageAbortedError 다.
 *  자동 요약(L2): 요약 user(compaction 파트)는 그 턴 답의 요약 줄(끝나면 done — 화면은 구분선)이고, 요약 답(summary:true)의 글은 답이 아니다.
 *  요약 뒤 user 하나(합성 Continue·한도 초과 뒤 앞 user 의 복사본)는 말풍선이 아니라 이음이다 — 그 답은 같은 턴 답에 붙는다 (TurnScope 와 같은 규칙).
 *  첨부(01y 5절): user 의 file 파트는 칩 정보(종류·이름)만 싣는다 — url(data: 통째)은 안 넘긴다. opencode 가 덧붙인 synthetic 글은 내 말이 아니다.
 *  root 는 세션 폴더 — 바꾼 파일 경로를 그 기준 상대로 보인다. children 은 task 파트가 띄운 자식 세션의 기록 — 하위 작업 줄 안에 넣는다 (#31) */
export function historyMessages(raw: readonly EngineMessage[], running: boolean, root = '', mcp?: McpToolResolver, children?: SubtaskHistory): HistoryMessage[] {
  const messages: HistoryMessage[] = []
  let sentAt: number | undefined
  let asked: HistoryMessage | undefined
  /** 지금 답의 마지막 assistant — 다음 user 가 오면 그 턴이 끝났는지 본다 */
  let lastStep: EngineMessage | undefined
  /** 요약 user 를 봤다 — 다음 user 는 이음이다 (요약이 실패하면 이음이 없다) */
  let awaitingContinuation = false
  /** 지금 턴의 지시문 항목 (이슈 #176) — 답 말풍선을 만들 때 진행 줄 맨 앞에 둔다 */
  let note: TurnItem | undefined
  const closeTurn = (final: boolean): void => {
    if (final && running) return
    const reply = messages.at(-1)
    if (!asked) return
    if (reply?.role === 'assistant') {
      if (lastStep && !lastStep.info.time?.completed && !reply.error && !reply.declined) Object.assign(reply, { error: interruptedError(), interrupted: true })
    } else if (final) messages.push({ role: 'assistant', text: '', error: interruptedError(), interrupted: true })
  }
  /** 지금 턴의 답 말풍선 — 없으면 만든다 */
  const currentReply = (): HistoryMessage => {
    const previous = messages.at(-1)
    if (previous?.role === 'assistant') return previous
    const reply: HistoryMessage = { role: 'assistant', text: '', items: note ? [note] : [] }
    note = undefined
    messages.push(reply)
    return reply
  }
  const finishedAt = (completed: number | undefined, reply: HistoryMessage): void => {
    if (completed !== undefined && sentAt !== undefined) reply.duration = completed - sentAt
    else delete reply.duration // 마지막 스텝이 안 끝났다
  }
  for (const message of raw) {
    const { info, parts } = message
    if (info.role === 'user') {
      if (parts.some((part) => part.type === 'compaction' && part.auto === false)) {
        // 손으로 부른 요약 (/compact, 이슈 #144) — 그 자체가 한 턴이다: 글 없는 내 말(보일 글은 앱이 이 id 로 적어 둔다) + 요약 줄. 이음 user 가 없다
        closeTurn(false)
        sentAt = info.time?.created
        lastStep = undefined
        const mode = modeOf(info.agent)
        asked = { id: info.id, role: 'user', text: '', ...(sentAt !== undefined && { at: sentAt }), ...(mode && { mode }) }
        messages.push(asked, { role: 'assistant', text: '', items: [{ kind: 'compaction', id: `${info.id}:compaction`, status: 'running' }] })
        continue
      }
      if (asked && parts.some((part) => part.type === 'compaction')) {
        const reply = currentReply()
        reply.items = [...(reply.items ?? []), { kind: 'compaction', id: `${info.id}:compaction`, status: 'running' }]
        awaitingContinuation = true
        continue
      }
      if (awaitingContinuation) {
        awaitingContinuation = false
        continue
      }
      const text = parts.filter((part) => part.type === 'text' && !part.synthetic).map((part) => part.text ?? '').join('')
      const attachments = parts
        .filter((part) => part.type === 'file')
        .map((part): Attachment => ({ kind: part.mime?.startsWith('image/') ? 'image' : 'file', name: part.filename ?? '' }))
      if (!parts.some((part) => part.type === 'text' && !part.synthetic) && attachments.length === 0) continue // 합성 글뿐
      closeTurn(false)
      sentAt = info.time?.created
      lastStep = undefined
      const mode = modeOf(info.agent)
      asked = { id: info.id, role: 'user', text, ...(sentAt !== undefined && { at: sentAt }), ...(mode && { mode }), ...(attachments.length > 0 && { attachments }) }
      const noted = instructionsNote(info.system, root)
      note = noted ? { kind: 'context', id: `${info.id}:instructions`, text: noted } : undefined
      messages.push(asked)
      continue
    }
    if (info.summary === true) {
      const reply = currentReply()
      const id = `${info.parentID ?? ''}:compaction`
      const status = info.error ? 'failed' : info.time?.completed !== undefined ? 'done' : 'running'
      reply.items = (reply.items ?? []).map((item) => (item.kind === 'compaction' && item.id === id ? { ...item, status } : item))
      if (info.error) {
        awaitingContinuation = false
        reply.error = failureText(info.error)
      }
      lastStep = message
      finishedAt(info.time?.completed, reply)
      continue
    }
    const reply = currentReply()
    reply.text += parts.filter((part) => part.type === 'text' && !part.synthetic).map((part) => part.text ?? '').join('')
    reply.items = [...(reply.items ?? []), ...messageItems(parts, root, mcp, children)]
    lastStep = message
    finishedAt(info.time?.completed, reply)
    if (info.error?.name === 'MessageAbortedError') Object.assign(reply, { error: tr('error.stopped'), interrupted: true })
    else if (info.error) reply.error = failureText(info.error)
    // 턴의 마지막 답 메시지가 정한다 — 앞 스텝의 실패한 도구는 다음 스텝이 이어 덮는다
    if (!info.error && endedByDecline(parts)) reply.declined = true
    else delete reply.declined
  }
  closeTurn(true)
  return messages
}

/** 끝나지 않은 손 요약(compaction 파트 auto:false 인 user — 끝난 요약 답이 없다)의 메시지 id — 지울 순서대로 (요약 답 먼저, 그 user 다음) */
export function unfinishedCompactions(raw: readonly EngineMessage[]): string[] {
  return raw
    .filter((message) => message.info.role === 'user' && message.parts.some((part) => part.type === 'compaction' && part.auto === false))
    .flatMap((asked) => {
      const answers = raw.filter((message) => message.info.summary === true && message.info.parentID === asked.info.id)
      if (answers.some((answer) => !answer.info.error && answer.info.time?.completed !== undefined)) return []
      return [...answers.map((answer) => answer.info.id), asked.info.id]
    })
}

/** 엔진 실패 → 화면 사유. 한도 초과(게이트웨이 오류가 자동 요약으로도 안 줄었다 — opencode 가 ContextOverflowError 로 분류)는 "새 대화로" 안내 */
export function failureText(error: EngineMessageInfo['error']): string {
  const message = error?.data?.message
  // 레거시 APIError 는 상태 코드를 따로 싣는다 (01w: session.error{APIError, statusCode}) — 사람이 읽는 문구는 turnError 가 붙인다
  const status = typeof error?.data?.statusCode === 'number' ? error.data.statusCode : undefined
  if (error?.name === 'ContextOverflowError' && status !== 413) return tr('error.contextOverflow')
  return message ? turnError(message, status) : tr('error.unknown')
}

/** 답 메시지의 마지막 파트가 오류로 끝난 도구인가 — 턴의 마지막 메시지가 이러면 승인·질문 거절이다: 거절하면 그 도구가 error 로 끝나고 다음 스텝
 *  없이 idle 이 온다 (01w). 그 밖의 도구 오류는 다음 스텝이 이어 덮는다 (step-finish 는 거르고 본다) */
function endedByDecline(parts: readonly EnginePart[]): boolean {
  const last = parts.filter((part) => part.type !== 'step-finish' && part.type !== 'step-start' && part.type !== 'patch').at(-1)
  return last?.type === 'tool' && last.state?.status === 'error'
}
