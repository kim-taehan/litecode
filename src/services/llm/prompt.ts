import { randomInt } from 'node:crypto'
import { sanitizeMcpName } from '../turnProgress.ts'
import type { ChatImage } from './types.ts'

/** 새 세션의 제목 — 앱이 따로 들고 있어 쓰이지 않는다. 주는 이유는 opencode 의 제목 LLM 호출을 막는 것 (01w) */
export function sessionTitle(text: string): string {
  return text.trim().split('\n')[0]?.slice(0, 80) || 'litecode'
}

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
let lastIdTime = 0
let idCounter = 0

/** opencode Identifier 형식의 오름차순 id — `<prefix>_` + (ms × 0x1000 + 순번)의 아래 48비트 hex 12자 + base62 무작위 14자.
 *  opencode 가 만든 id(msg_0fb2398b20010dJ8a8bQ1z0neE = 1790919809202 ms, 순번 1 — 01w 기록)와 같은 규칙이라 서로 섞여도 시간 순으로 선다 */
export function ascendingId(prefix: string, now = Date.now()): string {
  if (now !== lastIdTime) {
    lastIdTime = now
    idCounter = 0
  }
  idCounter++
  const value = (BigInt(now) * 0x1000n + BigInt(idCounter)) & 0xffffffffffffn
  let random = ''
  for (let i = 0; i < 14; i++) random += BASE62[randomInt(62)]
  return `${prefix}_${value.toString(16).padStart(12, '0')}${random}`
}

/** prompt_async 의 tools 에 늘 넣는 표지 — 엔진 도구 이름이 될 수 없는 글자(`:`)라 아무 도구도 안 가린다 (promptTools) */
export const MCP_TOOLS_MARKER = 'litecode:no-tool'

/** prompt_async 의 tools — 숨긴 MCP 도구를 엔진 이름으로 false (이슈 #164, 실측 2026-10-06 opencode 1.18.18 + 가짜 LLM, docs/opencode-protocol.md):
 *  - `{이름: false}` 는 그 턴의 LLM 요청 도구 목록에서 그 도구를 뺀다. 이름은 `<서버>_<도구>`, 둘 다 [A-Za-z0-9_-] 밖 글자는 `_` (sanitizeMcpName)
 *  - 이 맵은 세션 permission 을 **통째로 바꾸고 다음 턴에도 남는다** — 필드가 없거나 빈 맵이면 그대로 둔다. 그래서 숨길 것이 없어도 표지 하나를
 *    넣어 늘 바꾼다 (앞 턴·앞 실행의 숨김이 남지 않게)
 *  - `true` 는 그 도구의 allow 규칙이 되어 모드의 승인(ask)을 건너뛴다 — 싣지 않는다 */
export function promptTools(hidden: Readonly<Record<string, readonly string[]>> = {}): Record<string, false> {
  const tools: Record<string, false> = { [MCP_TOOLS_MARKER]: false }
  for (const [server, names] of Object.entries(hidden)) for (const name of names) tools[`${sanitizeMcpName(server)}_${sanitizeMcpName(name)}`] = false
  return tools
}

/** 숨길 MCP 도구 둘을 서버별로 합친다 — 폴더의 숨김(ctx.mcp)과 그 턴만의 숨김(백그라운드 작업 턴이 작업 도구를 뺀다, #319) */
export function mergeHidden(
  a: Readonly<Record<string, readonly string[]>>,
  b: Readonly<Record<string, readonly string[]>>,
): Record<string, readonly string[]> {
  const merged: Record<string, readonly string[]> = { ...a }
  for (const [server, names] of Object.entries(b)) merged[server] = [...new Set([...(merged[server] ?? []), ...names])]
  return merged
}

/** prompt_async 의 parts (01y 1절) — 글 파트 뒤에 이미지를 `{type:"file", mime, filename, url:"data:<mime>;base64,…"}` 로. 글이 없고 이미지만
 *  있으면 글 파트를 싣지 않는다. url 은 늘 data: 다 — `file://` 는 없는 파일이 끝 신호 없는 거절이 되고, LLM 에 "Called the Read tool…" 머리
 *  줄이 끼며, 폴더 밖 읽기가 권한을 안 거친다. **이미지 밖의 mime 을 file 파트로 보내지 않는다** — `application/json` 등은 그 세션의 모든 턴을
 *  망가뜨린다(12/12) */
export function promptParts(text: string, images: readonly ChatImage[] = []): Record<string, unknown>[] {
  return [
    ...(text || images.length === 0 ? [{ type: 'text', text }] : []),
    ...images.map((image) => ({ type: 'file', mime: image.mime, filename: image.filename, url: `data:${image.mime};base64,${image.data.toString('base64')}` })),
  ]
}
