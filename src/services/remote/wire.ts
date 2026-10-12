import type { ChatLive } from '../../../shared/chat.ts'
import type { AttentionAnswer, Conversation } from '../../../shared/contract.ts'
import type { RemoteConversation, RemoteEventMap } from '../../../shared/remote.ts'

// 계약(shared/remote.ts)의 모양으로 바꾸는 순수 함수 (이슈 #298 에서 remote.ts 에서 옮김) — 이벤트 글자(frame)·합칠 열쇠·출처·도는 턴 상태·대화 목록 줄·답 검사

/** ctx.chat 의 출처를 계약의 origin 으로 — 폰이 보낸 것은 그 기기 id, 그 밖(데스크탑 화면·다른 대화의 지시)은 'desktop' */
export function remoteOrigin(origin: string): string {
  return origin.startsWith('device:') ? origin.slice('device:'.length) : 'desktop'
}

/** 도는 턴의 상태 — 승인·질문을 기다리면 답 필요, 아니면 진행 중. 도는 턴이 없으면 없다 */
export function liveStatus(live: ChatLive | undefined): 'running' | 'attention' | undefined {
  if (!live?.turn) return undefined
  return live.turn.attention.length > 0 ? 'attention' : 'running'
}

/** 목록 정보에서 폰에 안 주는 것(통계·보일 글 표·첨부 표·`!` 카드)을 뺀다 */
export function toRemote({ id, project, engineSessionId, title, updatedAt, model, mode }: Conversation, status?: RemoteConversation['status']): RemoteConversation {
  return { id, project, title, updatedAt, ...(engineSessionId && { engineSessionId }), ...(model && { model }), ...(mode && { mode }), ...(status && { status }) }
}

export function isAnswer(value: unknown): value is AttentionAnswer {
  return value === 'once' || value === 'reject' || (Array.isArray(value) && value.every((entry) => Array.isArray(entry) && entry.every((label) => typeof label === 'string')))
}

export function frame(event: string, data: unknown, id?: number): string {
  return `${id === undefined ? '' : `id: ${id}\n`}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

/** 밀릴 때 합칠 열쇠 — `turn.progress` 는 같은 진행 줄(cid·item.id)을 누적 전체로 다시 보낸다. 그 밖의 이벤트는 합치지 않는다 */
export function coalesceKey(event: string, data: unknown): string | undefined {
  if (event !== 'turn.progress') return undefined
  const { cid, item } = data as RemoteEventMap['turn.progress']
  return `${cid}\n${item.id}`
}
