// 상태 → 화면에 쓸 글·모양 (순수 함수, React 없음 — tests/view.test.ts). 화면 컴포넌트는 이것을 그리기만 한다.

import type { Attention, ConversationStatus, HistoryMessage, QuestionAttention, TurnItem } from '../../../shared/contract.ts'
import { stopFeedbackReason } from '../../../shared/hooks.ts'
import type { RemoteConversation } from '../../../shared/remote.ts'
import type { ConnectionStatus, ConversationView } from '../core/index.ts'
import { S } from './strings.ts'

const SECOND = 1_000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** 목록 오른쪽의 "지금 · 12초 · 2분 · 어제 · 3일" */
export function ago(at: number, now: number): string {
  const elapsed = Math.max(0, now - at)
  if (elapsed < 5 * SECOND) return S.now
  if (elapsed < MINUTE) return S.secondsAgo(Math.floor(elapsed / SECOND))
  if (elapsed < HOUR) return S.minutesAgo(Math.floor(elapsed / MINUTE))
  if (elapsed < DAY) return S.hoursAgo(Math.floor(elapsed / HOUR))
  if (elapsed < 2 * DAY) return S.yesterday
  return S.daysAgo(Math.floor(elapsed / DAY))
}

/** 프로젝트 배지의 두 글자 (billing-api → BA) */
export function initials(name: string): string {
  const words = name.split(/[^\p{L}\p{N}]+/u).filter(Boolean)
  const letters = words.length >= 2 ? words[0]![0]! + words[1]![0]! : (words[0] ?? '').slice(0, 2)
  return letters.toUpperCase()
}

/** 승인·질문 카드의 제목 */
export function attentionTitle(request: Attention): string {
  if (request.kind === 'question') return S.question
  if (request.action === 'bash') return S.approveCommand
  if (request.action === 'edit') return S.approveEdit
  return S.approveOther
}

/**
 * 질문 카드의 모양. pick: 질문 하나 + 보기 + 하나 고르기 — 보기를 누르면 그것이 답이다.
 * desktop: 그 밖(보기 없는 직접 입력형·여러 질문·여럿 고르기)은 폰에서 못 그린다 — 질문 글과 "데스크탑에서 답해 주세요" 만. 거절은 둘 다 된다
 */
export type QuestionView = { kind: 'pick'; question: string; options: string[] } | { kind: 'desktop'; questions: string[] }

export function questionView(request: QuestionAttention): QuestionView {
  const [only] = request.questions
  if (request.questions.length === 1 && only && only.options.length > 0 && !only.multiple) return { kind: 'pick', question: only.question, options: only.options.map((option) => option.label) }
  return { kind: 'desktop', questions: request.questions.map((question) => question.question) }
}

/**
 * 내 말(user) 하나의 모양 — 데스크탑 ChatTurn 의 UserMessage 와 같은 판정.
 * hook: 턴 끝 훅이 이어 보낸 글 — 말풍선이 아니라 구분되는 줄(사유는 빈 글일 수 있다).
 * bubble: 첨부 이름(있으면) + 다른 대화가 보낸 지시면 그 대화 제목(origin) + 글. 글이 비면(첨부만 보냄) 말풍선은 그리지 않는다
 */
export type UserMessageView = { kind: 'hook'; reason: string } | { kind: 'bubble'; text: string; attachments: string[]; origin?: string }

export function userMessageView(message: HistoryMessage): UserMessageView {
  const reason = stopFeedbackReason(message.text)
  if (reason !== undefined) return { kind: 'hook', reason }
  return {
    kind: 'bubble',
    text: message.text.trim(),
    attachments: (message.attachments ?? []).map((attachment) => attachment.name),
    ...(message.origin && { origin: message.origin.title || S.untitled }),
  }
}

function firstLine(text: string): string {
  return text.split('\n').find((line) => line.trim() !== '')?.trim() ?? ''
}

export interface RowView {
  /** attention: 주황 채운 점(+ 행 배경) · running: 파란 고리 · unread: 파란 채운 점 · failed: 빨간 점 · none: 점 없음 */
  dot: 'attention' | 'running' | 'unread' | 'failed' | 'none'
  title: string
  subtitle: string
}

/**
 * 대화 목록의 행 하나. 상태(status)는 notices 에서, 덧붙는 글(무슨 승인인지·하위 작업 수·마지막 답 한 줄)은 그 대화를 받아 둔
 * 경우(view)에만 안다 — 목록 계약(RemoteConversation)에는 미리보기 글이 없다.
 */
export function rowView(conversation: RemoteConversation, status: ConversationStatus | undefined, view: ConversationView | undefined): RowView {
  const title = conversation.title || S.untitled
  const lastAnswer = firstLine([...(view?.messages ?? [])].reverse().find((message) => message.role === 'assistant')?.text ?? '')
  const join = (...parts: (string | undefined)[]): string => parts.filter(Boolean).join(' · ')
  switch (status) {
    case 'attention':
      return { dot: 'attention', title, subtitle: join(S.needsAnswer, view?.attention[0] && attentionTitle(view.attention[0])) }
    case 'running': {
      const subtasks = runningSubtasks(view?.progress ?? [])
      return { dot: 'running', title, subtitle: join(S.running, subtasks > 0 ? S.subtasks(subtasks) : undefined) }
    }
    case 'done':
      return { dot: 'unread', title, subtitle: join(S.done, lastAnswer) }
    case 'failed':
      return { dot: 'failed', title, subtitle: join(S.failed, lastAnswer) }
    case 'interrupted':
      return { dot: 'unread', title, subtitle: join(S.interrupted, lastAnswer) }
    default:
      return { dot: 'none', title, subtitle: lastAnswer }
  }
}

/** 도는 하위 작업 수 — 대화 머리의 "작업 N" */
export function runningSubtasks(items: readonly TurnItem[]): number {
  return items.filter((item) => item.kind === 'subtask' && (item.status === 'running' || item.status === 'preparing')).length
}

/** 턴 머리 "진행 중 · 18초 · 생각 1 · 도구 3" — 0 인 것은 뺀다 */
export function turnHead(label: string, durationMs: number | undefined, items: readonly TurnItem[]): string {
  const thinks = items.filter((item) => item.kind === 'think').length
  const tools = items.filter((item) => item.kind === 'tool').length
  return [label, durationMs === undefined ? undefined : S.seconds(Math.max(0, Math.round(durationMs / SECOND))), thinks ? S.thinkCount(thinks) : undefined, tools ? S.toolCount(tools) : undefined]
    .filter(Boolean)
    .join(' · ')
}

/** 끝난 답의 머리 글자 */
export function outcomeLabel(message: HistoryMessage): string {
  if (message.declined) return S.declined
  if (message.interrupted) return S.interrupted
  if (message.error) return S.failed
  return S.done
}

export interface TurnLine {
  id: string
  text: string
  /** 도구 줄은 고정폭 */
  mono: boolean
}

/** 펼친 턴의 줄 — 생각과 도구. 아직 시작 안 한 도구(preparing — 승인을 기다리는 것 포함)는 줄로 그리지 않는다. 글은 줄이 아니라 본문이다 */
export function turnLines(items: readonly TurnItem[]): TurnLine[] {
  return items.flatMap((item): TurnLine[] => {
    if (item.kind === 'think') return item.text.trim() ? [{ id: item.id, text: `${S.think} · ${firstLine(item.text)}`, mono: false }] : []
    if (item.kind !== 'tool' || item.status === 'preparing') return []
    const added = item.diffs?.reduce((sum, diff) => sum + diff.added, 0) ?? 0
    const removed = item.diffs?.reduce((sum, diff) => sum + diff.removed, 0) ?? 0
    const name = item.mcp ? `${item.mcp.server}/${item.mcp.tool}` : item.name
    return [{ id: item.id, text: [name, item.summary, item.diffs?.length ? `+${added} −${removed}` : undefined].filter(Boolean).join(' '), mono: true }]
  })
}

/** 진행 줄의 글(text) 조각들 — 본문으로 그린다 */
export function turnTexts(items: readonly TurnItem[]): { id: string; text: string }[] {
  return items.flatMap((item) => (item.kind === 'text' && item.text.trim() ? [{ id: item.id, text: item.text }] : []))
}

/** 도는 턴이 시작한 때 — 마지막 내 말의 시각 */
export function turnStartedAt(view: ConversationView): number | undefined {
  return [...view.messages].reverse().find((message) => message.role === 'user')?.at
}

/** 입력 카드 아래 여백(dp) */
const COMPOSER_GAP = 12

/**
 * 대화 입력 카드의 아래 여백. 평소에는 시스템 내비게이션 바 높이(insetBottom)만큼 띄운다(edge-to-edge 라 화면이 바 밑까지 그려진다).
 * 키보드가 떠 있으면 더하지 않는다 — 키보드가 그 바 자리까지 덮고 KeyboardAvoidingView 가 키보드 높이만큼 이미 밀어 올렸는데,
 * safe-area 의 아래 값은 키보드가 떠도 그대로라 더하면 그만큼 빈 띠가 생긴다 (실측: Pixel 7 · Android 15 · 3버튼 — 띠 158px = 48dp + 12dp).
 */
export function composerBottomMargin(insetBottom: number, keyboardVisible: boolean): number {
  return keyboardVisible ? COMPOSER_GAP : insetBottom + COMPOSER_GAP
}

/** 목록 위 띠의 글. 붙어 있으면 띠가 없다 */
export function statusBanner(status: ConnectionStatus, now: number): string | undefined {
  switch (status.kind) {
    case 'reconnecting':
      return S.reconnecting(Math.max(0, Math.ceil((status.retryAt - now) / SECOND)))
    case 'unresponsive':
      return S.unresponsive
    case 'revoked':
      return S.revoked
    case 'connecting':
      return S.connecting
    default:
      return undefined
  }
}
