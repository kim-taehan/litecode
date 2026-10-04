import type { Attention, ConversationStatus, HistoryMessage, Mode, TurnItem } from '../shared/ipc.ts'
import type { AttentionTarget, MessageOrigin } from '../shared/contract.ts'
import { DELEGATION_SERVER, READ_TOOL, SEND_TOOL, shortIds, START_TOOL, widerMode } from '../shared/delegation.ts'

// 다른 대화에 지시 보내기 (이슈 #55) 의 화면 모양 — 보낸 대화의 진행 줄("지시 보냄 → 제목 · 상태", "결과 읽기 · 제목 · 상태"), 승인 카드의 내용,
// 사이드바 표시를 정한다. 순수 함수다 (React·IPC 없음). 도구의 인자·결과 글(영어, 모델용)은 src/services/appMcp/tools/sessions.ts 가 만든다 —
// 화면은 그 인자의 짧은 id(`c-xxxxxxxx`)를 같은 규칙(shared/delegation.ts shortIds)으로 풀어 지금 그 대화의 제목·상태를 보인다.
// 그래서 줄의 상태는 "보낸 그때" 가 아니라 **받는 대화의 지금**을 따라간다 (다시 열어도 같은 계산이다).
// 받을 대화는 승인 카드에서 사용자가 고른다 (이슈 #67) — 그래서 끝난 보내기 줄의 대상은 도구 인자(AI 가 고른 것)가 아니라 **결과 글의 실제 대상**이다

type PermissionRequest = Extract<Attention, { kind: 'permission' }>

/** 같은 프로젝트의 대화 하나 — 줄·카드가 제목·상태·모드를 찾는다 */
export interface Peer {
  id: string
  title: string
  mode?: Mode
  /** 턴이 도는 중 */
  running: boolean
  /** 도는 턴을 보낸 시각(ms) */
  startedAt?: number
  /** 쉬는 대화의 마지막 턴이 실패·중단으로 끝났다 (없으면 잘 끝났거나 모른다) */
  outcome?: 'failed' | 'interrupted'
  /** 마지막 활동 시각(ms) — 받을 대화 목록의 순서 */
  updatedAt?: number
  /** 지시를 받을 수 없다 (모델이 설정에서 사라졌거나 폴더가 없다) — 받을 대화 목록에서 뺀다 */
  unusable?: true
}

/** 화면의 대화 → Peer. status 는 알림 상태(안 본 끝남·실패) — 기록을 안 연 대화도 실패·중단을 안다. usable: 그 대화의 모델·폴더가 있다 */
export function peerOf(
  session: { id: string; title: string; mode?: Mode; pending?: boolean; sentAt?: number; updatedAt?: number; messages: readonly HistoryMessage[] },
  status?: ConversationStatus,
  usable = true,
): Peer {
  const last = [...session.messages].reverse().find((message) => message.role === 'assistant')
  const outcome = status === 'failed' || status === 'interrupted' ? status : last?.interrupted ? 'interrupted' : last?.error ? 'failed' : undefined
  return {
    id: session.id,
    title: session.title,
    mode: session.mode,
    running: !!session.pending,
    ...(session.pending && session.sentAt !== undefined && { startedAt: session.sentAt }),
    ...(!session.pending && outcome && { outcome }),
    ...(session.updatedAt !== undefined && { updatedAt: session.updatedAt }),
    ...(!usable && { unusable: true as const }),
  }
}

/** asking: 승인을 기다리거나 보내는 중. notSent: 거절·오류로 못 보냈다. gone: 받는 대화가 지워졌다. 나머지는 받는 대화의 지금 상태 */
export type SentState = 'asking' | 'notSent' | 'running' | 'done' | 'failed' | 'interrupted' | 'gone'
/** reading: 읽는(기다리는) 중. running·waiting: 읽었더니 아직 돌거나 사람 답을 기다린다. read: 읽었다. failed: 못 읽었다 */
export type ReadState = 'reading' | 'running' | 'waiting' | 'read' | 'failed'

export type DelegationLine =
  | { kind: 'sent'; title: string; targetId?: string; state: SentState; startedAt?: number }
  | { kind: 'read'; title: string; targetId?: string; state: ReadState }

function parse(json: string | undefined): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(json ?? '{}')
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/** 결과 글의 `"제목" (c-…)`·`"제목" (id c-…)` — 실제로 보낸 대화. 제목에 따옴표가 있어도 마지막 `" (…c-…)` 앞까지가 제목이다 */
function named(result: string | undefined): { title?: string; short?: string } {
  const match = /"(.*)" \((?:id )?(c-[0-9a-f]+)\)/s.exec(result ?? '')
  return match ? { title: match[1], short: match[2] } : {}
}

/** 앱 MCP 의 보내기·읽기 도구 줄이면 그 모양을, 아니면 undefined (보통의 MCP 줄로 그린다) */
export function delegationLine(item: TurnItem, peers: readonly Peer[]): DelegationLine | undefined {
  if (item.kind !== 'tool' || item.mcp?.server !== DELEGATION_SERVER) return undefined
  const tool = item.mcp.tool
  if (tool !== SEND_TOOL && tool !== START_TOOL && tool !== READ_TOOL) return undefined
  const input = parse(item.input)
  const result = named(item.result)
  // 보내기 둘은 결과 글의 대상이 먼저다 — 사용자가 승인 카드에서 다른 대화(나 새 대화)를 골랐을 수 있다 (이슈 #67). 결과가 오기 전엔 인자의 것
  const asked = tool !== START_TOOL && typeof input['session'] === 'string' ? input['session'].trim() : undefined
  const short = tool === READ_TOOL ? asked : (result.short ?? asked)
  const ids = shortIds(peers.map((peer) => peer.id))
  const peer = short === undefined ? undefined : peers.find((candidate) => ids.get(candidate.id) === short)
  const title = peer?.title || result.title || (typeof input['title'] === 'string' ? input['title'] : '') || short || ''
  const target = peer && { targetId: peer.id }
  if (tool === READ_TOOL) {
    const state: ReadState =
      item.status === 'error' ? 'failed' : item.status !== 'done' ? 'reading' : /^state: running/.test(item.result ?? '') ? 'running' : /^state: waiting/.test(item.result ?? '') ? 'waiting' : 'read'
    return { kind: 'read', title, ...target, state }
  }
  if (item.status === 'error') return { kind: 'sent', title, ...target, state: 'notSent' }
  if (item.status !== 'done') return { kind: 'sent', title, ...target, state: 'asking' }
  if (!peer) return { kind: 'sent', title, state: 'gone' }
  return { kind: 'sent', title, targetId: peer.id, state: peer.running ? 'running' : (peer.outcome ?? 'done'), ...(peer.running && peer.startedAt !== undefined && { startedAt: peer.startedAt }) }
}

/** 받을 대화 목록의 한 줄 — 기존 대화 하나 또는 맨 아래 "새 대화" */
export interface TargetChoice {
  /** 대화 id, 새 대화 줄은 'new' */
  key: string
  /** 허용할 때 메인에 보낼 값 */
  target: AttentionTarget
  /** 대화 제목 — 새 대화 줄은 AI 가 준 제목(start_session), 없으면 빈 글 */
  title: string
  /** AI 가 고른 대상 */
  byAi: boolean
  mode?: Mode
  /** 그 대화의 모드가 이 대화보다 권한이 넓다 — 경고색 */
  wider: boolean
  /** 도는 중 — 대기열에 들어간다 */
  busy: boolean
}

/** 승인 카드의 내용 (이슈 #67) — 받을 대화는 사용자가 고른다: 같은 프로젝트의 대화 목록(최근 활동 순) + 맨 아래 새 대화, 그리고 보낼 글 전문.
 *  initial: 처음 골라 둘 줄(AI 가 고른 대상). missing: AI 가 고른 id 의 대화가 목록에 없다 — 사용자가 골라야 보낼 수 있다 */
export interface TargetPicker {
  kind: 'send' | 'start'
  message: string
  choices: TargetChoice[]
  initial?: string
  missing?: string
}

export const NEW_TARGET = 'new'

/** 보내기 도구의 승인 요청이면 고르기 카드 내용을, 아니면(다른 권한·인자를 못 이었다) undefined — 보통의 승인 카드로 그린다.
 *  목록에서 빼는 것: 보낸 대화 자신(self.id), 지시를 받을 수 없는 대화(unusable) */
export function targetPicker(request: PermissionRequest, peers: readonly Peer[], self: { id?: string; mode: Mode }): TargetPicker | undefined {
  if (request.mcp?.server !== DELEGATION_SERVER || request.input === undefined) return undefined
  const tool = request.mcp.tool
  if (tool !== SEND_TOOL && tool !== START_TOOL) return undefined
  const input = parse(request.input)
  const message = typeof input['message'] === 'string' ? input['message'] : ''
  // 짧은 id 는 메인과 같은 묶음(그 프로젝트의 저장된 대화 전부)으로 푼다 — 뺀 대화가 있어도 id 가 달라지지 않게
  const ids = shortIds(peers.map((peer) => peer.id))
  const asked = tool === SEND_TOOL && typeof input['session'] === 'string' ? input['session'].trim() : undefined
  const existing = peers
    .filter((peer) => peer.id !== self.id && !peer.unusable)
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
    .map((peer): TargetChoice => ({
      key: peer.id,
      target: { kind: 'conversation', conversationId: peer.id },
      title: peer.title,
      byAi: asked !== undefined && ids.get(peer.id) === asked,
      ...(peer.mode && { mode: peer.mode }),
      wider: !!peer.mode && widerMode(peer.mode, self.mode),
      busy: peer.running,
    }))
  const fresh: TargetChoice = {
    key: NEW_TARGET,
    target: { kind: 'new' },
    title: tool === START_TOOL && typeof input['title'] === 'string' ? input['title'] : '',
    byAi: tool === START_TOOL,
    mode: self.mode,
    wider: false,
    busy: false,
  }
  const choices = [...existing, fresh]
  const initial = choices.find((choice) => choice.byAi)?.key
  return { kind: tool === START_TOOL ? 'start' : 'send', message, choices, ...(initial && { initial }), ...(!initial && asked !== undefined && { missing: asked }) }
}

/** 도는 턴이 다른 대화가 보낸 지시로 시작됐으면 그 출처 */
export function runningOrigin(session: { pending?: boolean; messages: readonly HistoryMessage[] }): MessageOrigin | undefined {
  if (!session.pending) return undefined
  return [...session.messages].reverse().find((message) => message.role === 'user')?.origin
}

/** 사이드바 대화 행의 표시 — fresh: 지시로 새로 생긴 대화(한 번 열면 사라진다), delegated: 다른 대화가 시킨 일을 하는 중 */
export function sidebarMark(session: { id: string; pending?: boolean; messages: readonly HistoryMessage[] }, fresh: ReadonlySet<string>): 'fresh' | 'delegated' | undefined {
  if (fresh.has(session.id)) return 'fresh'
  return runningOrigin(session) ? 'delegated' : undefined
}
