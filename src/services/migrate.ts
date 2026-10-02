// 레거시 전환 전에 쌓인 대화(신규 세대 기록) 이어 쓰기 — 이슈 #21 L3. ctx.llm 만 쓴다 (opencode 형식을 아는 곳).
//
// 실측 (2026-10-02, opencode 1.18.18, _workspace/01w_legacy_migration.md 2절 `s9_migrate.py`):
// - 신규 세대(`/api/session/*`)로 쌓은 기록과 레거시(`/session/*`) 기록은 **같은 세션 id 여도 서로 안 보인다** — 레거시 턴의 LLM 요청엔 신규 기록이
//   안 실리고(4/4), 레거시 `/session/{id}/message` 엔 0건, 레거시 턴은 `/api/session/{id}/message` 에 안 보인다. 세션 행(제목·삭제)만 공유한다
// - 첫 레거시 턴 직전에 `prompt_async {noReply:true, parts:[{type:"text", synthetic:true, text:"<previous-conversation>…"}]}` 를 넣으면 다음 LLM 요청에
//   그 글이 user 맥락으로 실린다(1/1). synthetic 이라 다시 열 때 말풍선에서 숨길 수 있다 (historyMessages 가 합성 글뿐인 user 를 건너뛴다)
// - 잃는 것: 생각·도구 호출·결과 (글만 넘긴다)
//
// "한 번만" 의 근거는 opencode DB 다 — 레거시 기록이 하나라도 있으면 이미 옮겼거나 레거시로 시작한 대화다. 앱 파일(sessions.json)에 표시를 따로 두면
// 주입과 표시 쓰기 사이에 앱이 꺼질 때 둘이 어긋난다(두 번 넣거나 영영 안 넣는다).

import { randomInt } from 'node:crypto'
import { toolSummary, type TurnItem } from './turnProgress.ts'
import type { HistoryMessage } from './llm.ts'
import type { Mode } from '../../shared/modes.ts'
import { turnError } from './contextOverflow.ts'
import { tr } from '../i18n.ts'
import type { EngineConnection } from './engine.ts'

/** 신규 세대 GET /api/session/{id}/message 의 메시지 중 우리가 읽는 필드 (01c Q2·01g 2e·01k 실측) */
export interface PreviousMessage {
  id?: string
  /** user·assistant·system(지시문 바뀜)·compaction·agent-switched·model-switched … */
  type: string
  /** user 의 글 */
  text?: string
  /** assistant: 그 메시지를 낸 에이전트. agent-switched: 바꾼 에이전트 */
  agent?: string
  time?: { created?: number; completed?: number }
  content?: PreviousPart[]
  error?: { message?: string }
}

interface PreviousPart {
  type: string
  id?: string
  text?: string
  name?: string
  state?: { status?: string; input?: unknown; content?: { text?: string }[]; error?: { message?: string } }
}

/** 옛 대화 글의 상한(글자 수) — 넘치면 **뒤에서부터** 이만큼만 넘긴다(최근 대화가 이어 쓰기에 중요하다). 1만 2천 자는 영어로 ~3천 토큰,
 *  한국어로 ~8천~1만 2천 토큰이다. 설정이 경고하는 가장 작은 컨텍스트(24000)에서 opencode 가 출력·요약 몫으로 비우는 20000 을 빼면 남는 자리가 작아,
 *  이보다 크면 첫 턴부터 자동 요약이 돌거나 한도를 넘을 수 있다 */
export const PREVIOUS_CONVERSATION_LIMIT = 12_000

/** 신규 세대 메시지(asc) → 말풍선. 레거시 전환 전 historyMessages 와 같은 규칙(도구 스텝은 한 답으로, 끝나지 않은 마지막 답은 "중단됨").
 *  신규 세대로는 더 돌지 않으므로 늘 끝난 기록으로 본다. diff(바꾼 파일)는 싣지 않는다 — 옛 기록이라 글·도구 줄만 */
export function previousHistory(raw: readonly PreviousMessage[], modeOf: (agent: string | undefined) => Mode | undefined): HistoryMessage[] {
  const messages: HistoryMessage[] = []
  let sentAt: number | undefined
  let agent: string | undefined
  let asked: HistoryMessage | undefined
  let context: TurnItem[] = []
  for (const message of raw) {
    if (message.type === 'agent-switched') {
      agent = message.agent
      continue
    }
    if (message.type === 'user') {
      sentAt = message.time?.created
      const mode = modeOf(agent)
      asked = { ...(message.id && { id: message.id }), role: 'user', text: message.text ?? '', ...(sentAt !== undefined && { at: sentAt }), ...(mode && { mode }) }
      messages.push(asked)
      continue
    }
    if (message.type === 'compaction') {
      context.push({ kind: 'compaction', id: `compaction:${message.id ?? context.length}`, status: 'done' })
      continue
    }
    if (message.type !== 'assistant') continue // 지시문 바뀜·모델 바꿈은 옛 기록에선 그리지 않는다
    if (message.agent) {
      agent = message.agent
      const mode = modeOf(agent)
      if (asked && mode) asked.mode = mode
    }
    const previous = messages.at(-1)
    const reply: HistoryMessage = previous?.role === 'assistant' ? previous : { role: 'assistant', text: '', items: [] }
    if (reply !== previous) messages.push(reply)
    reply.text += assistantText(message)
    reply.items = [...(reply.items ?? []), ...context, ...previousItems(message.id ?? String(messages.length), message.content ?? [])]
    context = []
    const completed = message.time?.completed
    if (completed !== undefined && sentAt !== undefined) reply.duration = completed - sentAt
    else delete reply.duration
    if (message.error) reply.error = message.error.message ? turnError(message.error.message) : tr('error.unknown')
    const last = message.content?.at(-1)
    if (last?.type === 'tool' && last.state?.status === 'error') reply.declined = true
    else delete reply.declined
  }
  const last = raw.filter((message) => message.type === 'user' || message.type === 'assistant').at(-1)
  const lastPart = last?.content?.at(-1)
  const declinedEnd = lastPart?.type === 'tool' && lastPart.state?.status === 'error'
  if (last && !declinedEnd && (last.type === 'user' || !last.time?.completed)) {
    const reply = messages.at(-1)
    if (reply?.role === 'assistant') Object.assign(reply, { error: tr('error.interrupted'), interrupted: true })
    else messages.push({ role: 'assistant', text: '', error: tr('error.interrupted'), interrupted: true })
  }
  return messages
}

/** assistant 스텝 하나의 파트 → 진행 줄 (생각·글·도구). 끝난 기록이라 done */
function previousItems(messageId: string, parts: readonly PreviousPart[]): TurnItem[] {
  const items: TurnItem[] = []
  parts.forEach((part, index) => {
    const id = `${messageId}:${part.id ?? index}`
    if (part.type === 'reasoning') items.push({ kind: 'think', id, text: part.text ?? '', done: true })
    else if (part.type === 'text') items.push({ kind: 'text', id, text: part.text ?? '', done: true })
    else if (part.type === 'tool') {
      const state = part.state ?? {}
      const status = state.status === 'error' ? 'error' : state.status === 'completed' ? 'done' : state.status === 'pending' ? 'preparing' : 'running'
      const item: TurnItem = { kind: 'tool', id, name: part.name ?? '', status }
      if (state.input !== undefined && state.input !== '') {
        item.input = JSON.stringify(state.input)
        item.summary = toolSummary(state.input)
      }
      if (state.content) item.result = state.content.map((content) => content.text ?? '').join('')
      if (state.error) item.error = state.error.message ?? tr('error.unknown')
      items.push(item)
    }
  })
  return items
}

function assistantText(message: PreviousMessage): string {
  return (message.content ?? []).filter((part) => part.type === 'text').map((part) => part.text ?? '').join('')
}

/** 옛 대화를 LLM 에 넘길 글 — user·assistant 글만 차례로. 넘길 것이 없으면 undefined. limit 을 넘으면 뒤에서부터 자르고 앞에 잘렸다고 적는다.
 *  user 글은 보낸 본문 그대로다(`/` 명령은 풀어 쓴 template — LLM 이 본 것) */
export function previousConversation(raw: readonly PreviousMessage[], limit = PREVIOUS_CONVERSATION_LIMIT): string | undefined {
  const lines: string[] = []
  for (const message of raw) {
    if (message.type === 'user' && message.text?.trim()) lines.push(`user: ${message.text.trim()}`)
    else if (message.type === 'assistant') {
      const text = assistantText(message).trim()
      if (!text) continue
      const last = lines.at(-1)
      if (last?.startsWith('assistant: ')) lines[lines.length - 1] = `${last}\n${text}` // 도구 스텝 뒤 이어 쓴 글은 한 답으로
      else lines.push(`assistant: ${text}`)
    }
  }
  if (lines.length === 0) return undefined
  let body = lines.join('\n')
  let cut = false
  if (body.length > limit) {
    body = body.slice(body.length - limit)
    cut = true
  }
  const head = 'Earlier messages of this conversation, for context:'
  return `<previous-conversation>\n${head}\n${cut ? '[earlier part omitted]\n…' : ''}${body}\n</previous-conversation>`
}

/** 이 id 바로 앞에 서는 메시지 id — 옛 글을 이번 턴 user 메시지보다 먼저 세운다 (opencode 는 메시지를 id 순으로 다룬다 — 01w 9절).
 *  id 는 `msg_` + 시각·순번 12자리 hex + 무작위 14자(ascendingId) — hex 를 하나 줄이고 무작위 꼬리를 새로 뽑는다 */
export function precedingId(id: string): string {
  const match = /^([a-z]+)_([0-9a-f]{12})/.exec(id)
  if (!match) throw new Error(`unexpected message id: ${id}`)
  const value = BigInt(`0x${match[2]}`) - 1n
  let random = ''
  for (let i = 0; i < 14; i++) random += BASE62[randomInt(62)]
  return `${match[1]}_${value.toString(16).padStart(12, '0')}${random}`
}

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'

// /api/session/{id}/message 의 limit 상한은 200 이다(넘기면 400, 안 주면 50 — 2026-10-01 실측). 상한보다 낮게 잡고 cursor 로 끝까지 넘긴다
const PAGE = 100
/** 옛 글을 넣은 뒤 레거시 기록에 보일 때까지 기다리는 한도 — prompt_async 는 204 를 먼저 주고 저장은 뒤에 한다 */
const STORED_TIMEOUT_MS = 3_000

/** 신규 세대 기록 전부 (asc, 읽기 전용). cursor 는 order 와 같이 못 준다(/doc). 마지막 쪽에도 cursor.next 가 오므로 받은 개수 < limit 이거나
 *  빈 쪽이면 끝이다 (01c Q1). 레거시로 만든 세션은 빈 목록이다 */
export async function readPreviousMessages(conn: EngineConnection, sessionId: string): Promise<PreviousMessage[]> {
  const messages: PreviousMessage[] = []
  let query = `order=asc&limit=${PAGE}`
  while (true) {
    const res = await fetch(`${conn.url}/api/session/${sessionId}/message?${query}`, { headers: conn.headers })
    if (!res.ok) throw new Error(tr('error.messageRead', { status: res.status }))
    const page = (await res.json()) as { data: PreviousMessage[]; cursor?: { next?: string | null } }
    messages.push(...page.data)
    if (page.data.length < PAGE || !page.cursor?.next) return messages
    query = new URLSearchParams({ cursor: page.cursor.next, limit: String(PAGE) }).toString()
  }
}

/** 레거시 기록이 하나라도 있나 (limit=1 은 최근 1개 — 01w) */
async function hasLegacyMessages(conn: EngineConnection, sessionId: string, workdir: string): Promise<boolean> {
  const res = await fetch(`${conn.url}/session/${sessionId}/message?directory=${encodeURIComponent(workdir)}&limit=1`, { headers: conn.headers })
  if (!res.ok) throw new Error(tr('error.messageRead', { status: res.status }))
  return ((await res.json()) as unknown[]).length > 0
}

/** 이어 쓰는 세션의 첫 레거시 입력 직전에 부른다 — 레거시 기록이 없고 신규 세대 기록이 있으면 옛 대화 글을 합성(synthetic)·답하지 않음(noReply)으로
 *  한 번 넣고 레거시 기록에 보일 때까지 기다린다. beforeId 는 곧 보낼 입력의 메시지 id — 옛 글을 그 앞에 세운다. 넣었으면 true.
 *  실패하면 던진다 — 넣지 못한 채 입력을 보내면 레거시 기록이 생겨 다시는 안 넣으므로 그 입력도 보내지 않아야 한다 */
export async function carryOver(
  conn: EngineConnection,
  sessionId: string,
  workdir: string,
  model: { providerID: string; modelID: string },
  beforeId: string,
): Promise<boolean> {
  if (await hasLegacyMessages(conn, sessionId, workdir)) return false
  const text = previousConversation(await readPreviousMessages(conn, sessionId))
  if (!text) return false
  const res = await fetch(`${conn.url}/session/${sessionId}/prompt_async?directory=${encodeURIComponent(workdir)}`, {
    method: 'POST',
    headers: { ...conn.headers, 'content-type': 'application/json' },
    body: JSON.stringify({ messageID: precedingId(beforeId), noReply: true, model, parts: [{ type: 'text', synthetic: true, text }] }),
  })
  if (!res.ok) throw new Error(tr('error.contextAdd', { status: res.status }))
  const deadline = Date.now() + STORED_TIMEOUT_MS
  while (!(await hasLegacyMessages(conn, sessionId, workdir))) {
    if (Date.now() >= deadline) throw new Error(tr('error.contextAdd', { status: 'timeout' }))
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return true
}
