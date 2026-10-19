import { randomBytes } from 'node:crypto'
import http from 'node:http'
import https from 'node:https'
import type { AddressInfo } from 'node:net'
import { KEY_STORE_CODE, normalizeBaseURL } from './providers.ts'
import { tr } from '../i18n.ts'
import { sameSecret } from './httpUtil.ts'

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
// 답이 한 번에 몰려 온다(요청 본문은 예외 하나 — 사고 끄기·실제 모델 이름이 있는 provider 의 chat/completions JSON 본문만 모아 고친다, 이슈 #477·#491). 진짜 키는 나가는 Authorization 헤더에만 있고 로그·예외·응답에는 싣지 않는다.

export interface ProxyTarget {
  baseURL: string
  apiKey?: string
  /** 본문의 model id → `POST …/chat/completions` JSON 본문에 병합할 값 (이슈 #477 사고 끄기). 객체 값은 본문에 이미 있는 같은 키의 객체와 합친다.
   *  undefined 를 돌려주면 더할 것이 없다. addToBody·renameModel 이 둘 다 없으면 본문을 읽지 않고 흘린다 */
  addToBody?(model: string): Record<string, unknown> | undefined
  /** 본문의 model id → 게이트웨이에 보낼 실제 모델 이름 (이슈 #485·#491, 사고 끄기와 무관한 일반 별칭). 바꿀 것이 없으면 받은 id 그대로.
   *  addToBody 와 독립 — 둘 다 있으면 값 병합 + model 교체 */
  renameModel?(model: string): string
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
  return sameSecret(given ?? '', `Bearer ${expected}`)
}

function fail(res: http.ServerResponse, status: number, message: string): void {
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: tr('error.proxy', { message }) } }))
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 본문 model 에 더할 값을 병합하고 model 을 실제 이름으로 바꾼 본문 (순서: id 로 값 찾기 → model 교체 → 병합).
 *  JSON 이 아니거나 깨졌거나 고칠 것이 없으면 받은 바이트 그대로 — 요청을 실패시키지 않는다 */
function withAdded(raw: Buffer, { addToBody, renameModel }: Pick<ProxyTarget, 'addToBody' | 'renameModel'>): Buffer {
  let body: unknown
  try {
    body = JSON.parse(raw.toString('utf8'))
  } catch {
    return raw
  }
  if (!isObject(body) || typeof body.model !== 'string') return raw
  // addToBody 는 바꾸기 전의 id 로 찾는다 — 사고 끄기 목록은 설정의 (유일한) id 기준이고, 실제 이름은 사고 켬·끔 항목이 겹칠 수 있다
  const added = addToBody?.(body.model)
  let changed = false
  if (renameModel) {
    const renamed = renameModel(body.model)
    if (renamed !== body.model) {
      body.model = renamed
      changed = true
    }
  }
  if (added) {
    for (const [key, value] of Object.entries(added)) body[key] = isObject(value) && isObject(body[key]) ? { ...body[key], ...value } : value
    changed = true
  }
  return changed ? Buffer.from(JSON.stringify(body)) : raw
}

/** targetOf 는 요청마다 부른다 — 저장된 설정이 정본이다 */
export async function startKeyProxy(targetOf: (providerId: string) => ProxyTarget | undefined): Promise<KeyProxy> {
  const token = randomBytes(24).toString('base64url')
  const server = http.createServer((req, res) => {
    // 처리기의 동기 예외(예: 예전에 저장된 키에 헤더로 못 쓰는 문자 — http.request 가 ERR_INVALID_CHAR 를 던진다)는 메인 프로세스의
    // uncaughtException 이 되고 요청은 응답 없이 매달린다 (03_qa 2차) — 오류 코드만 실어 502 로 끝낸다.
    // 키 저장소가 키를 안 풀어 주면(이슈 #231) ctx.providers 의 안내 문구(키 값 없음)를 그대로 싣는다. 앱 로그에는 코드·provider 경로만
    try {
      forward(req, res)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? 'ERR_PROXY'
      console.error(`[keyProxy] ${req.method} /${(req.url ?? '').split(/[/?]/)[1] ?? ''} failed (${code})`)
      if (!res.headersSent) fail(res, 502, code === KEY_STORE_CODE ? (error as Error).message : tr('error.proxyRequest', { code }))
      else res.destroy()
    }
  })
  const forward = (req: http.IncomingMessage, res: http.ServerResponse): void => {
    // 토큰부터 본다 — 토큰 없는 요청에는 어떤 provider 가 있는지도 알려 주지 않는다
    if (!sameToken(req.headers.authorization, token)) return fail(res, 401, tr('error.proxyToken'))
    const incoming = new URL(req.url ?? '/', 'http://proxy')
    const [, first = '', ...rest] = incoming.pathname.split('/')
    const target = targetOf(decodeURIComponent(first))
    if (!target) return fail(res, 404, tr('error.proxyUnknown', { id: first }))

    const upstreamURL = new URL(`${normalizeBaseURL(target.baseURL)}${rest.length ? `/${rest.join('/')}` : ''}${incoming.search}`)
    // 사고 끄기(이슈 #477)·실제 모델 이름(#491) — chat/completions JSON 본문만 모아 고친다. 모으는 요청은 expect 를 넘기지 않는다: Node 가 expect 가 있으면 요청을
    // 만들 때 헤더를 확정해 버려서, 본문을 다 받은 뒤 content-length 를 고치는 setHeader 가 던진다 (03_qa 경고)
    const collects = !!(target.addToBody || target.renameModel) && req.method === 'POST' && rest.join('/') === 'chat/completions' && /json/i.test(req.headers['content-type'] ?? '')
    const headers = forwardable(req.headers, collects ? ['host', 'authorization', 'expect'] : ['host', 'authorization'])
    if (target.apiKey) headers['authorization'] = `Bearer ${target.apiKey}`
    const upstream = (upstreamURL.protocol === 'https:' ? https : http).request(upstreamURL, { method: req.method, headers }, (answer) => {
      res.writeHead(answer.statusCode ?? 502, forwardable(answer.headers))
      answer.pipe(res)
    })
    upstream.on('error', (error: NodeJS.ErrnoException) => {
      if (!res.headersSent) fail(res, 502, tr('error.proxyGateway', { code: error.code ?? error.message }))
      else res.destroy()
    })
    // opencode 가 끊으면(재시작·중단) 게이트웨이 요청도 끊는다
    res.on('close', () => {
      if (!res.writableFinished) upstream.destroy()
    })
    // 헤더는 첫 write/end 전까지 안 나가므로 content-length 를 여기서 고친다
    if (collects) {
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => chunks.push(chunk))
      req.on('end', () => {
        const body = withAdded(Buffer.concat(chunks), target)
        upstream.setHeader('content-length', body.length)
        upstream.end(body)
      })
      return
    }
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
