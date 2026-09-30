import { randomBytes, timingSafeEqual } from 'node:crypto'
import http from 'node:http'
import https from 'node:https'
import type { AddressInfo } from 'node:net'
import { normalizeBaseURL } from './providers.ts'

// 키 프록시 — 진짜 API 키를 opencode 프로세스에 두지 않으려고 메인 프로세스가 LLM 요청을 중계한다 (QA 1차 차단, 리더 결정 a).
// opencode 는 자기 env 를 프로젝트 플러그인(.opencode/plugin, opencode.json plugin)과 bash 도구에 그대로 넘기고 --pure 로도
// 못 막는다 (03_qa 재현). 그래서 opencode 에는 이 프록시 주소와 실행마다 바뀌는 토큰만 준다 — 토큰은 비밀이 아니다
// (새어도 이 기계의 127.0.0.1 에서 이 앱이 떠 있는 동안 LLM 을 **쓸** 수 있을 뿐, 키는 못 빼 간다).
//
// **받아들인 잔여 위험 (리더 결정 2026-09-30):** opencode 서버 비밀번호는 opencode env 에 남는다(서버 인증에 필요) — 플러그인·bash 가
// 그걸로 /config 를 부르거나 생성한 opencode.json 을 읽어 이 프록시 주소·토큰을 얻고, 앱이 떠 있는 동안 프록시를 통해 키를 **쓸** 수 있다.
// 받아들인 이유: opencode 는 원래 그 폴더에서 AI 가 코드를 실행하는 도구이고, 키 값은 빼 갈 수 없으며, 프록시는 저장된 주소로만 보낸다.
//
// 경로: `/<providerId>/<나머지>` → `<저장된 baseURL>/<나머지>` (쿼리 그대로). 본문·응답은 스트림 그대로 흘린다 — SSE 를 버퍼링하면
// 답이 한 번에 몰려 온다. 진짜 키는 나가는 Authorization 헤더에만 있고 로그·예외·응답에는 싣지 않는다.

export interface ProxyTarget {
  baseURL: string
  apiKey?: string
}

export interface KeyProxy {
  /** `http://127.0.0.1:<port>` */
  url: string
  /** opencode 가 Bearer 로 실어 보내는 값 */
  token: string
  /** opencode.json 의 provider baseURL 로 쓸 주소 */
  baseURLFor(providerId: string): string
  close(): Promise<void>
}

/** 요청·응답 어느 쪽에서도 넘기지 않는 연결 단위 헤더 (+ 우리가 바꾸는 authorization·host) */
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade'])

function forwardable(headers: http.IncomingHttpHeaders, drop: string[] = []): http.OutgoingHttpHeaders {
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !HOP_BY_HOP.has(name) && !drop.includes(name)))
}

function sameToken(given: string | undefined, expected: string): boolean {
  const a = Buffer.from(given ?? '')
  const b = Buffer.from(`Bearer ${expected}`)
  return a.length === b.length && timingSafeEqual(a, b)
}

function fail(res: http.ServerResponse, status: number, message: string): void {
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: `litecode 키 프록시: ${message}` } }))
}

/** targetOf 는 요청마다 부른다 — 저장된 설정이 정본이다 */
export async function startKeyProxy(targetOf: (providerId: string) => ProxyTarget | undefined): Promise<KeyProxy> {
  const token = randomBytes(24).toString('base64url')
  const server = http.createServer((req, res) => {
    // 처리기의 동기 예외(예: 예전에 저장된 키에 헤더로 못 쓰는 문자 — http.request 가 ERR_INVALID_CHAR 를 던진다)는 메인 프로세스의
    // uncaughtException 이 되고 요청은 응답 없이 매달린다 (03_qa 2차) — 오류 코드만 실어 502 로 끝낸다
    try {
      forward(req, res)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? 'ERR_PROXY'
      if (!res.headersSent) fail(res, 502, `요청을 만들지 못했습니다 (${code})`)
      else res.destroy()
    }
  })
  const forward = (req: http.IncomingMessage, res: http.ServerResponse): void => {
    // 토큰부터 본다 — 토큰 없는 요청에는 어떤 provider 가 있는지도 알려 주지 않는다
    if (!sameToken(req.headers.authorization, token)) return fail(res, 401, '토큰이 맞지 않습니다')
    const incoming = new URL(req.url ?? '/', 'http://proxy')
    const [, first = '', ...rest] = incoming.pathname.split('/')
    const target = targetOf(decodeURIComponent(first))
    if (!target) return fail(res, 404, `모르는 provider: ${first}`)

    const upstreamURL = new URL(`${normalizeBaseURL(target.baseURL)}${rest.length ? `/${rest.join('/')}` : ''}${incoming.search}`)
    const headers = forwardable(req.headers, ['host', 'authorization'])
    if (target.apiKey) headers['authorization'] = `Bearer ${target.apiKey}`
    const upstream = (upstreamURL.protocol === 'https:' ? https : http).request(upstreamURL, { method: req.method, headers }, (answer) => {
      res.writeHead(answer.statusCode ?? 502, forwardable(answer.headers))
      answer.pipe(res)
    })
    upstream.on('error', (error: NodeJS.ErrnoException) => {
      if (!res.headersSent) fail(res, 502, `게이트웨이에 연결하지 못했습니다 (${error.code ?? error.message})`)
      else res.destroy()
    })
    // opencode 가 끊으면(재시작·중단) 게이트웨이 요청도 끊는다
    res.on('close', () => {
      if (!res.writableFinished) upstream.destroy()
    })
    req.pipe(upstream)
  }

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return {
    url,
    token,
    baseURLFor: (providerId) => `${url}/${encodeURIComponent(providerId)}`,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}
