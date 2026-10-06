import type { Attention, ConversationStatus, HistoryMessage, Mode, Project, TurnItem } from '../shared/ipc.ts'
import type { AttentionTarget, MessageOrigin } from '../shared/contract.ts'
import { DELEGATION_SERVER, projectId, READ_TOOL, SEND_TOOL, shortIds, widerMode } from '../shared/delegation.ts'

// 다른 프로젝트에 지시 보내기 (이슈 #55·#137) 의 화면 모양 — 보낸 대화의 진행 줄("지시 보냄 → 프로젝트 · 대화 · 상태", "결과 읽기 · … · 상태"),
// 승인 카드의 내용, 사이드바 표시를 정한다. 순수 함수다 (React·IPC 없음). 도구의 인자·결과 글(영어, 모델용)은
// src/services/appMcp/tools/sessions.ts 가 만든다 — 화면은 그 인자의 프로젝트 id(`p-xxxxxxxx`)와 결과 글의 대화 id(`c-xxxxxxxx`)를 같은 규칙
// (shared/delegation.ts projectId·shortIds)으로 풀어 지금 그 대화의 제목·상태를 보인다.
// 그래서 줄의 상태는 "보낸 그때" 가 아니라 **받는 대화의 지금**을 따라간다 (다시 열어도 같은 계산이다).
// 받을 프로젝트는 승인 카드에서 사용자가 고른다 (이슈 #67) — 그래서 끝난 보내기 줄의 대상은 도구 인자(AI 가 고른 것)가 아니라 **결과 글의 실제 대상**이다

type PermissionRequest = Extract<Attention, { kind: 'permission' }>

/** 저장된 대화 하나 (모든 프로젝트) — 줄·카드가 제목·상태·모드를 찾는다 */
export interface Peer {
  id: string
  /** 그 대화의 프로젝트 경로 */
  project: string
  title: string
  mode?: Mode
  /** 턴이 도는 중 */
  running: boolean
  /** 도는 턴을 보낸 시각(ms) */
  startedAt?: number
  /** 쉬는 대화의 마지막 턴이 실패·중단으로 끝났다 (없으면 잘 끝났거나 모른다) */
  outcome?: 'failed' | 'interrupted'
  /** 지시를 받을 수 없다 (모델이 설정에서 사라졌거나 폴더가 없다) — 받을 프로젝트 목록에서 뺀다 */
  unusable?: true
}

/** 화면의 대화 → Peer. status 는 알림 상태(안 본 끝남·실패) — 기록을 안 연 대화도 실패·중단을 안다. usable: 그 대화의 모델·폴더가 있다 */
export function peerOf(
  session: { id: string; project: string; title: string; mode?: Mode; pending?: boolean; sentAt?: number; messages: readonly HistoryMessage[] },
  status?: ConversationStatus,
  usable = true,
): Peer {
  const last = [...session.messages].reverse().find((message) => message.role === 'assistant')
  const outcome = status === 'failed' || status === 'interrupted' ? status : last?.interrupted ? 'interrupted' : last?.error ? 'failed' : undefined
  return {
    id: session.id,
    project: session.project,
    title: session.title,
    mode: session.mode,
    running: !!session.pending,
    ...(session.pending && session.sentAt !== undefined && { startedAt: session.sentAt }),
    ...(!session.pending && outcome && { outcome }),
    ...(!usable && { unusable: true as const }),
  }
}

/** 다른 프로젝트 하나와 그 프로젝트에서 사용자가 마지막에 보던 대화 — 지시를 받는 곳 (사용자 결정 2026-10-06) */
export interface ProjectTarget {
  /** 모델에게 보이는 프로젝트 id (p-…) */
  id: string
  path: string
  name: string
  displayPath: string
  peer: Peer
}

/** 지금 프로젝트(current)가 아닌 프로젝트마다 마지막에 보던 대화 하나 — 본 대화가 없거나 그 대화가 지워진 프로젝트는 없다 (다른 대화로 대신하지 않는다).
 *  lastViewed: 프로젝트 경로 → 대화 id (메인이 저장한다). 순서는 프로젝트 목록 그대로(최근 순). 메인(세션 도구)이 같은 규칙으로 다시 본다 */
export function projectTargets(
  projects: readonly Pick<Project, 'path' | 'name' | 'displayPath'>[],
  lastViewed: Readonly<Record<string, string>>,
  peers: readonly Peer[],
  current: string | undefined,
): ProjectTarget[] {
  return projects.flatMap((project) => {
    if (project.path === current) return []
    const peer = peers.find((candidate) => candidate.id === lastViewed[project.path] && candidate.project === project.path)
    return peer ? [{ id: projectId(project.path), path: project.path, name: project.name, displayPath: project.displayPath, peer }] : []
  })
}

/** asking: 승인을 기다리거나 보내는 중. notSent: 거절·오류로 못 보냈다. gone: 받는 대화가 지워졌다. 나머지는 받는 대화의 지금 상태 */
export type SentState = 'asking' | 'notSent' | 'running' | 'done' | 'failed' | 'interrupted' | 'gone'
/** reading: 승인을 기다리거나 읽는(기다리는) 중. running·waiting: 읽었더니 아직 돌거나 사람 답을 기다린다. read: 읽었다. failed: 못 읽었다(거절 포함) */
export type ReadState = 'reading' | 'running' | 'waiting' | 'read' | 'failed'

/** title: 받는 곳 — "프로젝트 이름 · 대화 제목" (아는 만큼). targetId: 누르면 갈 대화 */
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

/** 보내기 결과 글의 `"이름" (p-…)`·`"이름" (id p-…)` — 실제로 보낸 프로젝트 */
function namedProject(result: string): { name?: string; id?: string } {
  const match = /"(.*?)" \((?:id )?(p-[0-9a-f]{8})\)/s.exec(result)
  return match ? { name: match[1], id: match[2] } : {}
}

/** 결과 글의 `conversation "제목" (c-…)`·`conversation: "제목" (c-…)` — 받은(읽은) 대화. 제목에 따옴표가 있어도 마지막 `" (c-…)` 앞까지가 제목이다 */
function namedConversation(result: string): { title?: string; short?: string } {
  const match = /conversation:? "(.*)" \((c-[0-9a-f]+)\)/s.exec(result)
  return match ? { title: match[1], short: match[2] } : {}
}

/** 앱 MCP 의 보내기·읽기 도구 줄이면 그 모양을, 아니면 undefined (보통의 MCP 줄로 그린다). targets: 다른 프로젝트와 그 마지막에 보던 대화,
 *  peers: 저장된 대화 전부 (결과 글의 대화 id 를 푼다 — 보낸 뒤 사용자가 그 프로젝트에서 다른 대화를 봐도 줄은 받은 대화를 가리킨다) */
export function delegationLine(item: TurnItem, targets: readonly ProjectTarget[], peers: readonly Peer[]): DelegationLine | undefined {
  if (item.kind !== 'tool' || item.mcp?.server !== DELEGATION_SERVER) return undefined
  const tool = item.mcp.tool
  if (tool !== SEND_TOOL && tool !== READ_TOOL) return undefined
  const input = parse(item.input)
  const asked = typeof input['project'] === 'string' ? input['project'].trim() : undefined
  const result = item.status === 'done' ? (item.result ?? '') : ''
  // 보내기는 결과 글의 대상이 먼저다 — 사용자가 승인 카드에서 다른 프로젝트를 골랐을 수 있다 (이슈 #67). 결과가 오기 전엔 인자의 것.
  // 읽기 결과는 첫 줄만 본다 (그 아래는 다른 대화의 글이다)
  const project = tool === SEND_TOOL ? namedProject(result) : {}
  const conversation = namedConversation(tool === SEND_TOOL ? result : (result.split('\n')[0] ?? ''))
  const id = project.id ?? asked
  const target = id === undefined ? undefined : targets.find((candidate) => candidate.id === id)
  const ids = shortIds(peers.map((peer) => peer.id))
  const peer = conversation.short === undefined ? (item.status === 'done' ? undefined : target?.peer) : peers.find((candidate) => ids.get(candidate.id) === conversation.short)
  const title = [target?.name ?? project.name ?? id, peer?.title ?? conversation.title].filter(Boolean).join(' · ')
  const link = peer && { targetId: peer.id }
  if (tool === READ_TOOL) {
    const state: ReadState =
      item.status === 'error' ? 'failed' : item.status !== 'done' ? 'reading' : /^state: running/m.test(result) ? 'running' : /^state: waiting/m.test(result) ? 'waiting' : 'read'
    return { kind: 'read', title, ...link, state }
  }
  if (item.status === 'error') return { kind: 'sent', title, ...link, state: 'notSent' }
  if (item.status !== 'done') return { kind: 'sent', title, ...link, state: 'asking' }
  if (!peer) return { kind: 'sent', title, state: 'gone' }
  return { kind: 'sent', title, targetId: peer.id, state: peer.running ? 'running' : (peer.outcome ?? 'done'), ...(peer.running && peer.startedAt !== undefined && { startedAt: peer.startedAt }) }
}

/** 받을 프로젝트 목록의 한 묶음 — 프로젝트 줄과 그 아래 마지막에 보던 대화 한 줄 */
export interface TargetChoice {
  /** 받는 대화 id */
  key: string
  /** 허용할 때 메인에 보낼 값 */
  target: AttentionTarget
  project: { name: string; displayPath: string }
  /** 받는 대화의 제목 */
  title: string
  /** AI 가 고른 프로젝트 */
  byAi: boolean
  mode?: Mode
  /** 그 대화의 모드가 이 대화보다 권한이 넓다 — 경고색 */
  wider: boolean
  /** 도는 중 — 대기열에 들어간다 */
  busy: boolean
}

/** 승인 카드의 내용 (이슈 #67·#137 — 시안 _workspace/mock-cross-project) — 받을 프로젝트는 사용자가 고른다: 다른 프로젝트마다 마지막에 보던 대화 하나,
 *  그리고 보낼 글 전문. initial: 처음 골라 둘 줄(AI 가 고른 프로젝트). missing: AI 가 고른 id 의 프로젝트가 목록에 없다 — 사용자가 골라야 보낼 수 있다 */
export interface TargetPicker {
  message: string
  choices: TargetChoice[]
  initial?: string
  missing?: string
}

/** 보내기 도구의 승인 요청이면 고르기 카드 내용을, 아니면(다른 권한·인자를 못 이었다) undefined — 보통의 승인 카드로 그린다.
 *  지시를 받을 수 없는 대화(unusable)의 프로젝트는 목록에서 뺀다 */
export function targetPicker(request: PermissionRequest, targets: readonly ProjectTarget[], self: { mode: Mode }): TargetPicker | undefined {
  if (request.mcp?.server !== DELEGATION_SERVER || request.mcp.tool !== SEND_TOOL || request.input === undefined) return undefined
  const input = parse(request.input)
  const message = typeof input['message'] === 'string' ? input['message'] : ''
  const asked = typeof input['project'] === 'string' ? input['project'].trim() : undefined
  const choices = targets
    .filter((target) => !target.peer.unusable)
    .map((target): TargetChoice => ({
      key: target.peer.id,
      target: { kind: 'conversation', conversationId: target.peer.id },
      project: { name: target.name, displayPath: target.displayPath },
      title: target.peer.title,
      byAi: target.id === asked,
      ...(target.peer.mode && { mode: target.peer.mode }),
      wider: !!target.peer.mode && widerMode(target.peer.mode, self.mode),
      busy: target.peer.running,
    }))
  const initial = choices.find((choice) => choice.byAi)?.key
  return { message, choices, ...(initial && { initial }), ...(!initial && asked !== undefined && { missing: asked }) }
}

/** 읽기 도구의 승인 요청이면 읽을 곳("프로젝트 이름 · 대화 제목", 모르는 id 면 그 id)을, 아니면 undefined (이슈 #137 — 읽기도 묻는다) */
export function readRequest(request: PermissionRequest, targets: readonly ProjectTarget[]): string | undefined {
  if (request.mcp?.server !== DELEGATION_SERVER || request.mcp.tool !== READ_TOOL || request.input === undefined) return undefined
  const input = parse(request.input)
  const asked = typeof input['project'] === 'string' ? input['project'].trim() : ''
  const target = targets.find((candidate) => candidate.id === asked)
  return target ? `${target.name} · ${target.peer.title}` : asked
}

/** 도는 턴이 다른 대화가 보낸 지시로 시작됐으면 그 출처 */
export function runningOrigin(session: { pending?: boolean; messages: readonly HistoryMessage[] }): MessageOrigin | undefined {
  if (!session.pending) return undefined
  return [...session.messages].reverse().find((message) => message.role === 'user')?.origin
}

/** 사이드바 대화 행의 표시 — fresh: 화면이 모르던 대화가 새로 생겼다(짝지은 폰이 만든 대화 — 한 번 열면 사라진다), delegated: 다른 대화가 시킨 일을 하는 중 */
export function sidebarMark(session: { id: string; pending?: boolean; messages: readonly HistoryMessage[] }, fresh: ReadonlySet<string>): 'fresh' | 'delegated' | undefined {
  if (fresh.has(session.id)) return 'fresh'
  return runningOrigin(session) ? 'delegated' : undefined
}
