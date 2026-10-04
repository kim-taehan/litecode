// 다른 대화에 지시 보내기 (이슈 #55 — 설계 _workspace/01z_desktop_mcp.md 3-3·3-4) 의 공용 규칙 — 메인(세션 도구)과 화면(진행 줄·승인 카드)이
// 같은 것을 쓴다. 타입 + 순수 함수뿐이다 (Node·Electron·React·엔진을 모른다)

import type { ChatOrigin } from './chat.ts'
import type { Mode } from './modes.ts'

/** 앱 MCP 서버 이름 (src/services/mcp.ts 의 APP_MCP_NAME 과 같다 — 화면은 서비스 파일을 import 못 한다) */
export const DELEGATION_SERVER = 'litecode'
export const LIST_TOOL = 'list_sessions'
export const READ_TOOL = 'read_session'
export const SEND_TOOL = 'send_to_session'
export const START_TOOL = 'start_session'

/** 한 턴에 보낼 수 있는 지시 수 (send + start) */
export const MAX_SENDS_PER_TURN = 5
/** 받는 대화의 대기열 상한 */
export const QUEUE_LIMIT = 5
export const MESSAGE_MAX = 20_000
export const START_TITLE_MAX = 60
/** read_session 이 기다리는 한도(초) — MCP 호출 기한 60초 안 (01z 1-4) */
export const WAIT_SECONDS_MAX = 45
/** read_session 이 글 하나(요청·답)를 자르는 길이 */
export const READ_CLIP = 8_000
export const READ_TURNS_MAX = 5
export const LIST_MAX = 20

const SHORT_PREFIX = 'c-'
const SHORT_LENGTH = 8

/** 대화 id → 모델에게 보이는 짧은 id `c-xxxxxxxx` (앱 대화 id 의 앞 8자). 그 묶음 안에서 겹치면 겹치지 않을 때까지 길이를 늘린다 */
export function shortIds(ids: readonly string[]): Map<string, string> {
  const plain = ids.map((id) => id.replaceAll('-', ''))
  const longest = Math.max(SHORT_LENGTH, ...plain.map((id) => id.length))
  for (let length = SHORT_LENGTH; length <= longest; length++) {
    const cut = plain.map((id) => id.slice(0, length))
    if (new Set(cut).size === new Set(plain).size || length === longest) return new Map(ids.map((id, index) => [id, `${SHORT_PREFIX}${cut[index]}`]))
  }
  return new Map()
}

/** 짧은 id → 대화 id (모르는 id·제목으로 부른 것은 undefined) */
export function resolveShortId(ids: readonly string[], short: string): string | undefined {
  for (const [id, value] of shortIds(ids)) if (value === short.trim()) return id
  return undefined
}

export function originOfConversation(conversationId: string): ChatOrigin {
  return `session:${conversationId}`
}

/** 출처 → 보낸 대화 id (사람이 보낸 것이면 undefined) */
export function senderOf(origin: string | undefined): string | undefined {
  return origin?.startsWith('session:') ? origin.slice('session:'.length) : undefined
}

function attribute(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replace(/\s+/g, ' ')
}

/** 받는 대화의 LLM 에 가는 글 — 감싸서 "사용자가 친 글이 아님" 을 모델이 알게 한다 (dsh 식 감싸기). id 는 보낸 대화의 짧은 id */
export function wrapInstruction(sender: { id: string; title: string }, message: string): string {
  return `<message-from-conversation id="${attribute(sender.id)}" title="${attribute(sender.title)}">\n${message}\n</message-from-conversation>`
}

/** 권한이 넓은 순서 — 계획 < 매번 묻기 < 기본 < 전체 권한 */
const MODE_RANK: Record<Mode, number> = { plan: 0, ask: 1, build: 2, full: 3 }

/** 받는 대화의 모드가 보낸 쪽보다 권한이 넓은가 — 승인 카드가 경고색으로 보인다 (모드 건너뛰기, 01z 3-2) */
export function widerMode(target: Mode, sender: Mode): boolean {
  return MODE_RANK[target] > MODE_RANK[sender]
}
