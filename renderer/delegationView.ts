import type { Attention, ConversationStatus, HistoryMessage, Mode, Project, TurnItem } from '../shared/ipc.ts'
import type { AttentionTarget, MessageOrigin } from '../shared/contract.ts'
import { DELEGATION_SERVER, NEW_CONVERSATION_TOOL, projectId, READ_TOOL, SEND_TOOL, shortIds, widerMode } from '../shared/delegation.ts'

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
  /** 마지막 활동 시각(ms) — 카드의 대화 목록 순서 */
  updatedAt: number
  /** 도는 턴을 보낸 시각(ms) */
  startedAt?: number
  /** 쉬는 대화의 마지막 턴이 실패·중단으로 끝났다 (없으면 잘 끝났거나 모른다) */
  outcome?: 'failed' | 'interrupted'
  /** 지시를 받을 수 없다 (모델이 설정에서 사라졌거나 폴더가 없다) — 받을 목록에서 뺀다 */
  unusable?: true
}

/** 화면의 대화 → Peer. status 는 알림 상태(안 본 끝남·실패) — 기록을 안 연 대화도 실패·중단을 안다. usable: 그 대화의 모델·폴더가 있다 */
export function peerOf(
  session: { id: string; project: string; title: string; mode?: Mode; pending?: boolean; sentAt?: number; updatedAt: number; messages: readonly HistoryMessage[] },
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
    updatedAt: session.updatedAt,
    ...(session.pending && session.sentAt !== undefined && { startedAt: session.sentAt }),
    ...(!session.pending && outcome && { outcome }),
    ...(!usable && { unusable: true as const }),
  }
}

/** 프로젝트 하나와 그 프로젝트에서 사용자가 마지막에 보던 대화 — 지시를 받는 곳 (사용자 결정 2026-10-06). #351: 지금 프로젝트도 포함한다
 *  (승인 카드의 "이 프로젝트" 그룹·진행 줄이 쓴다; Projects 탭 패널은 자기 프로젝트를 스스로 빼고, 메인 세션 도구의 목록은 메인이 제외한다) */
export interface ProjectTarget {
  /** 모델에게 보이는 프로젝트 id (p-…) */
  id: string
  path: string
  name: string
  displayPath: string
  peer: Peer
}

/** 프로젝트마다 마지막에 보던 대화 하나 — 본 대화가 없거나 그 대화가 지워진 프로젝트는 없다 (다른 대화로 대신하지 않는다).
 *  lastViewed: 프로젝트 경로 → 대화 id (메인이 저장한다). 순서는 프로젝트 목록 그대로(최근 순). 메인(세션 도구)이 같은 규칙으로 다시 본다 */
export function projectTargets(
  projects: readonly Pick<Project, 'path' | 'name' | 'displayPath'>[],
  lastViewed: Readonly<Record<string, string>>,
  peers: readonly Peer[],
): ProjectTarget[] {
  return projects.flatMap((project) => {
    const peer = peers.find((candidate) => candidate.id === lastViewed[project.path] && candidate.project === project.path)
    return peer ? [{ id: projectId(project.path), path: project.path, name: project.name, displayPath: project.displayPath, peer }] : []
  })
}

/** asking: 승인을 기다리거나 보내는 중. notSent: 거절·오류로 못 보냈다. gone: 받는 대화가 지워졌다. 나머지는 받는 대화의 지금 상태 */
export type SentState = 'asking' | 'notSent' | 'running' | 'done' | 'failed' | 'interrupted' | 'gone'
/** reading: 승인을 기다리거나 읽는(기다리는) 중. running·waiting: 읽었더니 아직 돌거나 사람 답을 기다린다. read: 읽었다. failed: 못 읽었다(거절 포함) */
export type ReadState = 'reading' | 'running' | 'waiting' | 'read' | 'failed'

/** title: 받는 곳 — "프로젝트 이름 · 대화 제목" (아는 만큼). targetId: 누르면 갈 대화. new: 이 프로젝트의 새 대화를 만든 줄 (이슈 #415) —
 *  제목은 대화 제목뿐(프로젝트 이름이 안 붙는다) */
export type DelegationLine =
  | { kind: 'sent'; title: string; targetId?: string; state: SentState; startedAt?: number; new?: boolean }
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
  if (tool !== SEND_TOOL && tool !== READ_TOOL && tool !== NEW_CONVERSATION_TOOL) return undefined
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
  const isNew = tool === NEW_CONVERSATION_TOOL && { new: true as const }
  if (item.status === 'error') return { kind: 'sent', title, ...link, ...isNew, state: 'notSent' }
  if (item.status !== 'done') return { kind: 'sent', title, ...link, ...isNew, state: 'asking' }
  if (!peer) return { kind: 'sent', title, ...isNew, state: 'gone' }
  return { kind: 'sent', title, targetId: peer.id, ...isNew, state: peer.running ? 'running' : (peer.outcome ?? 'done'), ...(peer.running && peer.startedAt !== undefined && { startedAt: peer.startedAt }) }
}

/** 카드의 대화 목록 크기 (이슈 #348) — 프로젝트마다 최근 활동 순으로 이만큼. 마지막에 보던 대화는 항상 넣는다 */
export const PICK_CONVERSATION_LIMIT = 10

/** 받을 목록의 한 줄 — 프로젝트의 대화 하나, 또는 "**새 대화**" 줄 (이슈 #348: 프로젝트가 아니라 **대화** 단위로 고른다; #351: 새 대화·접기) */
export interface TargetChoice {
  /** 받는 대화 id (새 대화 줄은 `new:<프로젝트 id>`) */
  key: string
  /** 허용할 때 메인에 보낼 값 */
  target: AttentionTarget
  project: { name: string; displayPath: string }
  /** 프로젝트 id (접기·펼치기의 그룹 키) */
  projectId: string
  /** 받는 대화의 제목 (새 대화 줄은 빈 글 — 화면이 "새 대화" 로 쓴다) */
  title: string
  /** 처음 골라 둘 줄 — AI 가 고른 프로젝트의 마지막에 보던 대화 */
  byAi: boolean
  /** 그 프로젝트에서 마지막에 보던 대화 */
  lastViewed?: boolean
  mode?: Mode
  /** 그 대화의 모드가 이 대화보다 권한이 넓다 — 경고색 */
  wider: boolean
  /** 도는 중 — 대기열에 들어간다 */
  busy: boolean
  /** 새 대화 줄 — 그 프로젝트에 새 대화를 만들어 받는다. 모델·모드는 그 프로젝트의 대화 것 (마지막에 본 대화) (사용자 결정 2026-10-14) */
  newConversation?: true
  /** 프로젝트의 상한(PICK_CONVERSATION_LIMIT)을 넘은 대화 — 처음엔 접혀 있다, 사용자가 펼쳐야 보인다 */
  folded?: true
}

/** 승인 카드의 내용 (이슈 #67·#137, 대화까지 고르는 것 #348 — 시안 _workspace/mock-cross-project) — 받을 **프로젝트와 그 프로젝트의 대화**를
 *  사용자가 고른다: 다른 프로젝트마다 그 대화 목록(최근 활동 순, 상한), 그리고 보낼 글 전문. initial: 처음 골라 둘 줄(AI 가 고른 프로젝트의
 *  마지막에 보던 대화). missing: AI 가 고른 id 의 프로젝트가 목록에 없다 — 사용자가 골라야 보낼 수 있다 */
export interface TargetPicker {
  message: string
  choices: TargetChoice[]
  initial?: string
  missing?: string
}

/** 보내기 도구의 승인 요청이면 고르기 카드 내용을, 아니면(다른 권한·인자를 못 이었다) undefined — 보통의 승인 카드로 그린다.
 *  지시를 받을 수 없는 대화(unusable)만 뺀다 — 그 프로젝트의 다른 대화가 남아 있으면 그걸로 프로젝트를 보여 준다.
 *  #351: targets 에 지금(보내는) 프로젝트도 있으니 그 그룹도 보인다 — 단 **지금 보내는 대화(self.id) 자신**은 빼고, 각 그룹 첫 줄에
 *  "**새 대화**" 줄(그 프로젝트에 새 대화로 받는다)이 있다. 상한을 넘은 대화는 folded 로 접는다 */
export function targetPicker(request: PermissionRequest, targets: readonly ProjectTarget[], peers: readonly Peer[], self: { mode: Mode; id?: string }): TargetPicker | undefined {
  if (request.mcp?.server !== DELEGATION_SERVER || request.mcp.tool !== SEND_TOOL || request.input === undefined) return undefined
  const input = parse(request.input)
  const message = typeof input['message'] === 'string' ? input['message'] : ''
  const asked = typeof input['project'] === 'string' ? input['project'].trim() : undefined
  const choices: TargetChoice[] = []
  for (const target of targets) {
    const viewed = peers.find((peer) => peer.id === target.peer.id && peer.project === target.path)
    // 그 프로젝트에서 지시를 받을 수 있는 대화 — 최근 활동 순. 지금의 대화 자신(self.id)은 받을 대상이 아니다
    const usable = peers.filter((peer) => peer.project === target.path && !peer.unusable && peer.id !== self.id).sort((a, b) => b.updatedAt - a.updatedAt)
    const limited = usable.slice(0, PICK_CONVERSATION_LIMIT)
    const hasViewed = limited.some((peer) => peer.id === target.peer.id)
    const visible = (hasViewed || target.peer.unusable ? limited : [target.peer, ...limited]).filter((peer) => peer.id !== self.id)
    const visibleIds = new Set(visible.map((peer) => peer.id))
    // 새 대화 줄 — 그룹의 첫 줄. 모델·모드는 그 프로젝트의 대화 것: 마지막에 본 대화(쓸 수 있으면), 없으면 최근 대화
    const inherit = viewed && !viewed.unusable ? viewed : usable[0]
    const inheritMode = inherit?.mode
    choices.push({
      key: `new:${target.id}`,
      target: { kind: 'new-conversation', projectId: target.id },
      project: { name: target.name, displayPath: target.displayPath },
      projectId: target.id,
      title: '',
      byAi: false,
      ...(inheritMode && { mode: inheritMode }),
      wider: !!inheritMode && widerMode(inheritMode, self.mode),
      busy: false,
      newConversation: true,
    })
    // 보이는 줄 (상한 안) + 접힌 줄 (상한 밖 — folded, #351)
    for (const peer of [...visible, ...usable.filter((candidate) => !visibleIds.has(candidate.id))]) {
      const folded = !visibleIds.has(peer.id)
      const byAi = !folded && target.id === asked && peer.id === target.peer.id
      choices.push({
        key: peer.id,
        target: { kind: 'conversation', conversationId: peer.id },
        project: { name: target.name, displayPath: target.displayPath },
        projectId: target.id,
        title: peer.title,
        byAi,
        ...(!byAi && peer.id === target.peer.id && { lastViewed: true as const }),
        ...(peer.mode && { mode: peer.mode }),
        wider: !!peer.mode && widerMode(peer.mode, self.mode),
        busy: peer.running,
        ...(folded && { folded: true as const }),
      })
    }
  }
  const initial = choices.find((choice) => choice.byAi)?.key
  return { message, choices, ...(initial && { initial }), ...(!initial && asked !== undefined && { missing: asked }) }
}

/** 새 대화 도구(new_conversation, 이슈 #415)의 승인 요청이면 모델이 고른 제목과 보낼 글 전문을, 아니면 undefined — 보통의 승인 카드에 실린다 */
export function newConversationRequest(request: PermissionRequest): { title: string; message: string } | undefined {
  if (request.mcp?.server !== DELEGATION_SERVER || request.mcp.tool !== NEW_CONVERSATION_TOOL || request.input === undefined) return undefined
  const input = parse(request.input)
  const title = typeof input['title'] === 'string' ? input['title'] : ''
  const message = typeof input['message'] === 'string' ? input['message'] : ''
  return title || message ? { title, message } : undefined
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
