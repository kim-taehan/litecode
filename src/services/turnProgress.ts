// 턴 중 진행 줄 (생각·도구·글·지시문) — opencode 이벤트를 화면이 그리는 중립 모양(TurnItem)으로 바꾼다. 화면은 opencode 이벤트
// 이름을 모른다. opencode 형식을 아는 것은 이 파일과 llm.ts 뿐이다 — 엔진을 바꾸면 이것도 바꾼다.
//
// 실측 (2026-10-01, opencode 1.18.18, _workspace/01g_stream_progress.md):
// - 세션 SSE: reasoning.started 는 생각 시작 즉시, 내용은 reasoning.ended.text 에 한 번. text.started 는 글 시작 때 오지만 text.ended 와
//   tool.called(입력 전체)는 **스트림 끝**에 온다. tool.input.started{callID,name} 만 인자 스트리밍 시작 때 온다
// - 조각(reasoning.delta·text.delta)은 **전역 /api/event 에만** 온다 (durable 아님, 재생 없음). 놓쳐도 *.ended 가 완성본으로 덮는다
// - reasoningID·textID 는 스텝마다 `-0` 부터 다시 → assistantMessageID 와 묶어 id 로 쓴다
// - 줄 순서는 처음 나타난 순서다: 도구 앞에 쓴 글은 text.started 가 tool.input.started 보다 먼저 와서 도구 위에 선다
// - 한 스텝의 여러 도구는 동시에 돌고 끝난 순서로 tool.success 가 온다 → callID 로 맞춘다

/** 진행 줄 하나. 같은 id 의 새 값이 오면 통째로 바꾼다 (누적 전체를 싣는다 — 조각을 놓쳐도 화면이 틀어지지 않는다) */
export type TurnItem =
  | { kind: 'think'; id: string; text: string; done: boolean }
  | { kind: 'text'; id: string; text: string; done: boolean }
  /** summary: 도구가 무엇을 하는지 한 줄 (bash 는 description, 없으면 command 등). input 은 인자 JSON, result 는 결과 글 */
  | { kind: 'tool'; id: string; name: string; status: 'preparing' | 'running' | 'done' | 'error'; summary?: string; input?: string; result?: string; error?: string }
  /** 대화 중 지시문(AGENTS.md 등)이 바뀌었다 — opencode 에 도구 목록 변화 이력은 없다 (01e) */
  | { kind: 'context'; id: string; text: string }

const PREFIX = 'session.next.'

/** 한 턴의 진행 줄을 쥐고, 이벤트 하나마다 바뀐 줄을 준다 (없으면 undefined) */
export class TurnTracker {
  private readonly items = new Map<string, TurnItem>()

  observe(type: string, data: Record<string, unknown>): TurnItem | undefined {
    if (!type.startsWith(PREFIX)) return undefined
    const event = type.slice(PREFIX.length)
    const message = String(data['assistantMessageID'] ?? '')
    switch (event) {
      case 'reasoning.started':
      case 'reasoning.delta':
      case 'reasoning.ended':
        return this.textual('think', `${message}:${String(data['reasoningID'])}`, event, data)
      case 'text.started':
      case 'text.delta':
      case 'text.ended':
        return this.textual('text', `${message}:${String(data['textID'])}`, event, data)
      case 'tool.input.started':
        return this.tool(`${message}:${String(data['callID'])}`, { name: String(data['name'] ?? '') })
      case 'tool.called': {
        const input = data['input']
        return this.tool(`${message}:${String(data['callID'])}`, {
          name: String(data['tool'] ?? ''),
          status: 'running',
          input: JSON.stringify(input ?? {}),
          summary: toolSummary(input),
        })
      }
      case 'tool.success': {
        if (!this.items.has(`${message}:${String(data['callID'])}`)) return undefined // 앞 턴에서 끊긴 도구의 매듭 (01c) — 이 턴 줄이 아니다
        const content = (data['content'] as { text?: string }[] | undefined) ?? []
        return this.tool(`${message}:${String(data['callID'])}`, { status: 'done', result: content.map((part) => part.text ?? '').join('') })
      }
      case 'tool.failed': {
        if (!this.items.has(`${message}:${String(data['callID'])}`)) return undefined
        const error = data['error'] as { message?: string } | undefined
        return this.tool(`${message}:${String(data['callID'])}`, { status: 'error', error: error?.message ?? '알 수 없는 오류' })
      }
      case 'context.updated': {
        const item: TurnItem = { kind: 'context', id: `context:${String(data['messageID'] ?? data['timestamp'])}`, text: contextText(String(data['text'] ?? '')) }
        this.items.set(item.id, item)
        return item
      }
      default:
        return undefined
    }
  }

  private textual(kind: 'think' | 'text', id: string, event: string, data: Record<string, unknown>): TurnItem | undefined {
    const previous = this.items.get(id) as Extract<TurnItem, { kind: 'think' | 'text' }> | undefined
    if (previous?.done) return undefined // 완성본 뒤에 늦게 온 조각
    let item: TurnItem
    if (event.endsWith('.ended')) item = { kind, id, text: String(data['text'] ?? previous?.text ?? ''), done: true }
    else if (event.endsWith('.delta')) item = { kind, id, text: (previous?.text ?? '') + String(data['delta'] ?? ''), done: false }
    else if (previous) return undefined // started 가 조각보다 늦게 왔다 (스트림이 둘이다)
    else item = { kind, id, text: '', done: false }
    this.items.set(id, item)
    return item
  }

  private tool(id: string, patch: Partial<Extract<TurnItem, { kind: 'tool' }>>): TurnItem {
    const previous = this.items.get(id) as Extract<TurnItem, { kind: 'tool' }> | undefined
    const item: TurnItem = { kind: 'tool', id, name: '', status: 'preparing', ...previous, ...patch }
    if (!item.name && previous?.name) item.name = previous.name
    this.items.set(id, item)
    return item
  }
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

/** 지시문 바뀜 본문(`Instructions from: <경로>` 줄들) → 한 줄. Trajectory 의 CONTEXT 줄과 같은 글 */
export function contextText(text: string): string {
  const sources = [...text.matchAll(/^Instructions from: (.+)$/gm)].map((match) => match[1]!.trim().split('/').pop())
  return sources.length > 0 ? `지시문 바뀜 · ${sources.join(', ')}` : '지시문 바뀜'
}

/** GET /message 의 assistant 파트 (01g 2e) — 지난 대화를 다시 열 때 같은 줄을 만든다 */
interface MessagePart {
  type: string
  id?: string
  text?: string
  name?: string
  state?: { status?: string; input?: unknown; content?: { text?: string }[]; error?: { message?: string } }
}

/** assistant 메시지 하나(스텝)의 파트 → 진행 줄. 끝난 기록이라 생각·글은 done 이다 (진행 중 파트는 내용이 "" — 그대로 둔다) */
export function messageItems(messageId: string, parts: readonly MessagePart[]): TurnItem[] {
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
      if (state.error) item.error = state.error.message ?? '알 수 없는 오류'
      items.push(item)
    }
  })
  return items
}
