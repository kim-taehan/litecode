import { timingSafeEqual } from 'node:crypto'
import type http from 'node:http'

// 앱 안 HTTP 서버(앱 MCP·원격 운반·키 프록시)가 같이 쓰는 도우미 (이슈 #197). 셋 다 보안 경계(본문 상한·토큰 비교)라 한 곳에 둔다.

/** JSON 답 하나 — content-type·content-length 를 붙이고 headers 를 그 뒤에 덮는다 */
export function sendJson(response: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = JSON.stringify(body)
  response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text), ...headers })
  response.end(text)
}

/** 본문 — 상한을 넘으면 undefined. 넘친 뒤에는 쌓지 않고 흘려보내기만 한다(끝까지 받아야 응답을 곱게 보낸다) */
export async function readBody(request: http.IncomingMessage, maxBytes: number): Promise<string | undefined> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    size += (chunk as Buffer).length
    if (size <= maxBytes) chunks.push(chunk as Buffer)
  }
  return size > maxBytes ? undefined : Buffer.concat(chunks).toString('utf8')
}

/** 비밀 비교 — 길이가 다르면 바로 false, 같으면 상수 시간 비교 */
export function sameSecret(given: string, expected: string): boolean {
  const a = Buffer.from(given)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}
