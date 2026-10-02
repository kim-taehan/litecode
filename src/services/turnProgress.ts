// 턴 중 진행 줄 (생각·도구·글·지시문) — opencode 이벤트를 화면이 그리는 중립 모양(TurnItem)으로 바꾼다. 화면은 opencode 이벤트
// 이름을 모른다. opencode 형식을 아는 것은 이 파일과 llm.ts 뿐이다 — 엔진을 바꾸면 이것도 바꾼다.
//
// 레거시 경로 실측 (2026-10-02, opencode 1.18.18, _workspace/01w_legacy_migration.md 1절 — 이슈 #13 L1):
// - 이벤트는 `GET /event?directory=` 의 `{type, properties}`. 한 프롬프트가 만든 assistant 메시지는 모두 `info.parentID = 그 user messageID` 다
//   → TurnScope 가 그것으로 이 턴 메시지를 가린다 (같은 세션에 다른 클라이언트가 보낸 턴·자식 세션은 섞이지 않는다)
// - 글·생각: `message.part.updated{part:{type:"text"|"reasoning", id, messageID, text, time:{start,end?}}}` 가 시작(빈 글)과 끝(완성본, time.end)에
//   오고, 그 사이 `message.part.delta{messageID, partID, field, delta}` 가 온다. ⚠️ delta 의 field 는 생각에서도 "text" 다 → partID → 종류 표로 가른다
// - 사용자 메시지의 글도 text part.updated 로 온다(에코) → assistant 메시지 것만 줄로 만든다
// - 도구: 같은 part id 를 덮어쓴다 — pending{input:{}} → running{input, time.start} → (bash) running{metadata.output: 누적 출력} 여러 번 →
//   completed{output, metadata, time} | error{error(문자열)}
// - 줄 순서는 처음 나타난 순서다 (Map 삽입 순서)
// - 파일을 바꾼 도구의 diffs(레거시 metadata.filediff)는 L2 — 지금은 싣지 않는다

import type { FileDiff } from './toolDiffs.ts'

/** 진행 줄 하나. 같은 id 의 새 값이 오면 통째로 바꾼다 (누적 전체를 싣는다 — 조각을 놓쳐도 화면이 틀어지지 않는다) */
export type TurnItem =
  | { kind: 'think'; id: string; text: string; done: boolean }
  | { kind: 'text'; id: string; text: string; done: boolean }
  /** summary: 도구가 무엇을 하는지 한 줄 (bash 는 description, 없으면 command 등). input 은 인자 JSON, result 는 결과 글 */
  | { kind: 'tool'; id: string; name: string; status: 'preparing' | 'running' | 'done' | 'error'; summary?: string; input?: string; result?: string; error?: string; diffs?: FileDiff[] }
  /** 대화 중 지시문(AGENTS.md 등)이 바뀌었다 — opencode 에 도구 목록 변화 이력은 없다 (01e) */
  | { kind: 'context'; id: string; text: string }
  /** 엔진이 앞 대화를 요약(자동 압축)한다 — running 동안 "요약 중", done 이면 그 자리에 구분선, failed(요약 요청 실패 — ended 없이 스텝이
   *  이어졌다)는 그리지 않는다 (01o) */
  | { kind: 'compaction'; id: string; status: 'running' | 'done' | 'failed' }

type Props = Record<string, unknown>

/** 레거시 메시지 파트 중 우리가 읽는 필드 (01w 실측) */
export interface EnginePart {
  id?: string
  messageID?: string
  type: string
  text?: string
  synthetic?: boolean
  time?: { start?: number; end?: number }
  /** tool */
  tool?: string
  callID?: string
  state?: {
    status?: string
    input?: unknown
    output?: string
    error?: string
    metadata?: { output?: unknown; exit?: unknown }
    time?: { start?: number; end?: number }
  }
  /** step-finish */
  tokens?: { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } }
  reason?: string
}

/** 레거시 메시지 정보 중 우리가 읽는 필드 */
export interface EngineMessageInfo {
  id: string
  sessionID?: string
  role: 'user' | 'assistant'
  parentID?: string
  agent?: string
  /** assistant 의 summary:true 는 자동 요약 답이다 (user 는 {diffs} 객체) */
  summary?: unknown
  time?: { created?: number; completed?: number }
  error?: { name?: string; data?: { message?: string } }
}

/** 이 턴(내가 보낸 user 메시지)에 속한 이벤트를 가린다. 답 메시지는 message.updated 의 parentID 로 배운다 — 답의 파트보다 먼저 온다 (01w 실측) */
export class TurnScope {
  private readonly assistants = new Set<string>()

  constructor(
    readonly sessionId: string,
    readonly userMessageId: string,
  ) {}

  /** 이 턴의 user 메시지 이벤트면 'user', 답 메시지 이벤트면 'assistant', 아니면 undefined */
  of(type: string, props: Props): 'user' | 'assistant' | undefined {
    if (type === 'message.updated') {
      const info = props['info'] as EngineMessageInfo | undefined
      if (!info || info.sessionID !== this.sessionId) return undefined
      if (info.id === this.userMessageId) return 'user'
      if (info.role === 'assistant' && info.parentID === this.userMessageId) this.assistants.add(info.id)
      return this.assistants.has(info.id) ? 'assistant' : undefined
    }
    const messageId =
      type === 'message.part.updated' ? (props['part'] as EnginePart | undefined)?.messageID : type === 'message.part.delta' ? props['messageID'] : undefined
    if (typeof messageId !== 'string' || props['sessionID'] !== this.sessionId) return undefined
    if (messageId === this.userMessageId) return 'user'
    return this.assistants.has(messageId) ? 'assistant' : undefined
  }

  /** 이 턴의 답 메시지인가 (승인·질문 요청의 tool.messageID 를 가린다) */
  owns(messageId: string | undefined): boolean {
    return messageId !== undefined && this.assistants.has(messageId)
  }
}

/** 한 턴의 진행 줄을 쥐고, 이 턴 답 메시지의 이벤트 하나마다 바뀐 줄을 준다 (없으면 undefined). 걸러 넣는 것은 TurnScope */
export class TurnTracker {
  private readonly items = new Map<string, TurnItem>()
  /** partID → 줄 id (delta 는 partID 만 싣는다) */
  private readonly ids = new Map<string, string>()

  observe(type: string, props: Props): TurnItem | undefined {
    if (type === 'message.part.updated') {
      const part = props['part'] as EnginePart
      const item = partItem(part, false)
      if (!item) return undefined
      this.ids.set(part.id ?? '', item.id)
      const previous = this.items.get(item.id)
      if (previous && (previous.kind === 'think' || previous.kind === 'text') && previous.done) return undefined
      if (previous && JSON.stringify(previous) === JSON.stringify(item)) return undefined
      // 시작(빈 글)이 조각보다 늦게 와도 쌓인 조각을 지우지 않는다
      if (previous && (item.kind === 'think' || item.kind === 'text') && !item.done && item.text === '' && previous.kind === item.kind) return undefined
      this.items.set(item.id, item)
      return item
    }
    if (type === 'message.part.delta') {
      const id = this.ids.get(String(props['partID']))
      const previous = id ? this.items.get(id) : undefined
      if (!previous || (previous.kind !== 'think' && previous.kind !== 'text') || previous.done) return undefined
      const item: TurnItem = { ...previous, text: previous.text + String(props['delta'] ?? '') }
      this.items.set(item.id, item)
      return item
    }
    return undefined
  }

  /** 이 턴 답의 글 — 글 줄을 나타난 순서대로 잇는다 (도구 결과·생각은 빼고) */
  text(): string {
    return [...this.items.values()].map((item) => (item.kind === 'text' ? item.text : '')).join('')
  }
}

/** 파트 하나 → 진행 줄 (줄이 아닌 파트면 undefined). done 이면 끝난 기록이다 (다시 열기) */
function partItem(part: EnginePart, done: boolean): TurnItem | undefined {
  const id = `${part.messageID ?? ''}:${part.id ?? ''}`
  if (part.type === 'reasoning' || part.type === 'text') {
    if (part.synthetic) return undefined
    return { kind: part.type === 'reasoning' ? 'think' : 'text', id, text: part.text ?? '', done: done || part.time?.end !== undefined }
  }
  if (part.type !== 'tool') return undefined
  const state = part.state ?? {}
  const status = state.status === 'error' ? 'error' : state.status === 'completed' ? 'done' : state.status === 'pending' ? 'preparing' : 'running'
  const item: Extract<TurnItem, { kind: 'tool' }> = { kind: 'tool', id, name: part.tool ?? '', status }
  const input = state.input
  if (input !== undefined && input !== '' && !(typeof input === 'object' && input !== null && Object.keys(input).length === 0)) {
    item.input = JSON.stringify(input)
    item.summary = toolSummary(input)
  }
  if (status === 'done') item.result = state.output ?? ''
  else if (status === 'running' && typeof state.metadata?.output === 'string' && state.metadata.output !== '') item.result = state.metadata.output // bash 실시간 출력
  if (status === 'error') item.error = state.error || '알 수 없는 오류'
  return item
}

/** 도구 줄의 한 줄 요약 — bash 는 description(필수 인자, 01g), 없으면 command. 그 밖의 도구는 흔한 인자 하나 */
export function toolSummary(input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined
  const args = input as Record<string, unknown>
  for (const key of ['description', 'command', 'filePath', 'path', 'pattern', 'url', 'query']) {
    const value = args[key]
    if (typeof value === 'string' && value.trim()) return value.trim().split('\n')[0]
  }
  return undefined
}

/** assistant 메시지 하나(스텝)의 파트 → 진행 줄. 끝난 기록이라 생각·글은 done 이다 */
export function messageItems(parts: readonly EnginePart[]): TurnItem[] {
  return parts.flatMap((part) => partItem(part, true) ?? [])
}
