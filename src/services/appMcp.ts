import { Context, Service } from 'cordis'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import type { EngineMcp } from './engine.ts'
import { APP_MCP_NAME, type McpService } from './mcp.ts'
import { handleRpc, type AppMcpTool } from './appMcp/rpc.ts'

// 앱 MCP 서버 (ctx.appMcp, 이슈 #51 — 설계·실측 _workspace/01z_desktop_mcp.md). AI 가 이 앱의 화면을 조작하는 문:
// 메인 프로세스가 작은 MCP 서버를 띄우고, 엔진에 붙이기는 사용자 서버와 같은 길(ctx.mcp — 매 턴 그 폴더에)로 한다.
// **이 서비스는 opencode 를 모른다** — 주소·이벤트는 ctx.llm·ctx.engine 뒤에 있고, 여기는 HTTP·JSON-RPC·도구 등록소·프로젝트 키만 쥔다.
//
// 경계 (01z 3-2):
// - 127.0.0.1 에만 바인딩(포트는 OS 가 고른다), POST 만, 본문 상한
// - 실행마다 새 토큰(Authorization: Bearer). 토큰은 엔진 메모리에만 있다 — 설정 파일·env·API·로그·DB 에 안 남는다(1-1 실측)
// - **프로젝트 신원은 URL 경로의 키**(실행마다 무작위, 폴더 realpath 와 1:1). 요청이 주장하는 값이 아니라 앱이 붙일 때 정한 주소다 —
//   호출 요청에는 "누가 불렀나" 가 없다(1-2). 모든 도구는 그 프로젝트 안에서만 동작한다
// - 호출한 대화를 가리는 일(이벤트 역추적)은 화면 도구에는 필요 없다 — 세션 도구가 한다 (appMcp/tools/sessions.ts, 이슈 #55)
//
// 도구는 등록소에 effect 로 올리고 내린다(appMcp/tools/*). 목록이 바뀌면 ctx.mcp 에 다시 붙이라고 알린다 — 엔진은 붙일 때만 tools/list 를 부른다.
// 화면 도구는 **사용자가 지금 보고 있는 프로젝트에만** 닿는다(오른쪽 패널·터미널 칸은 보고 있는 프로젝트 하나의 것) — 화면이 view() 로 알린다.
// 서버가 못 떠도 대화는 된다: 붙일 정의가 없을 뿐이다(로그만).

declare module 'cordis' {
  interface Context {
    appMcp: AppMcpService
  }
  interface Events {
    /** open(파일) — 화면이 그 프로젝트의 오른쪽 패널에 연다. file 은 프로젝트 기준 상대 경로, line 은 1부터 */
    'appMcp/open-file'(directory: string, file: string, line?: number): void
    /** open(터미널) — 화면이 그 프로젝트의 터미널 칸을 편다 (명령은 메인이 이미 채웠다) */
    'appMcp/open-terminal'(directory: string): void
  }
}

/** 본문 상한 — 도구 인자는 경로·명령 한 줄이다 */
const MAX_BODY_BYTES = 64 * 1024
const PATH_PREFIX = '/mcp/'

export class AppMcpService extends Service {
  static readonly inject = ['mcp']

  private tools = new Map<string, AppMcpTool>()
  private readonly token = randomBytes(32).toString('hex')
  /** 폴더(realpath) ↔ URL 의 프로젝트 키 */
  private keys = new Map<string, string>()
  private directories = new Map<string, string>()
  private port?: number
  private viewed?: string
  private listening: Promise<void>
  /** 내려가는 중엔 ctx.mcp 를 못 꺼낸다 (inactive context) — 올라올 때 쥔다 */
  private mcp: McpService

  constructor(ctx: Context) {
    super(ctx, 'appMcp')
    this.mcp = ctx.mcp
    let opened!: () => void
    this.listening = new Promise((resolve) => (opened = resolve))
    ctx.effect(() => {
      const server = http.createServer((request, response) => {
        this.handle(request, response).catch((error: unknown) => {
          console.error('[appMcp] 요청 처리 실패', (error as Error).message)
          if (!response.headersSent) send(response, 500, { error: 'internal' })
        })
      })
      // 포트를 못 잡아도 앱은 돈다 — 붙일 정의가 없을 뿐이다
      server.on('error', (error) => console.error('[appMcp] 서버 오류', error.message))
      server.listen(0, '127.0.0.1', () => {
        this.port = (server.address() as AddressInfo).port
        this.mcp.reattach(APP_MCP_NAME)
        opened()
      })
      return () =>
        new Promise<void>((resolve) => {
          this.port = undefined
          server.close(() => resolve())
          server.closeAllConnections()
        })
    })
    ctx.effect(() => this.mcp.registerBuiltin(APP_MCP_NAME, (workdir) => this.definition(workdir)))
  }

  /** 서버가 요청을 받기 시작할 때까지 (테스트용 — 제품은 매 턴 붙이기가 그때 정의를 읽는다) */
  ready(): Promise<void> {
    return this.listening
  }

  /** 도구를 올린다 — 돌려준 함수가 내린다 (ctx.effect 로 건다). 다음 붙이기에서 엔진이 목록을 다시 읽는다 */
  register(tool: AppMcpTool): () => void {
    this.tools.set(tool.name, tool)
    this.mcp.reattach(APP_MCP_NAME)
    return () => {
      if (this.tools.get(tool.name) !== tool) return
      this.tools.delete(tool.name)
      this.mcp.reattach(APP_MCP_NAME)
    }
  }

  /** 그 폴더에 붙일 정의 — 주소의 마지막 마디가 그 프로젝트의 키다. 서버가 안 떴으면 없다 */
  definition(workdir: string): EngineMcp | undefined {
    if (this.port === undefined) return undefined
    let key = this.keys.get(workdir)
    if (!key) {
      key = randomBytes(16).toString('hex')
      this.keys.set(workdir, key)
      this.directories.set(key, workdir)
    }
    return { type: 'remote', url: `http://127.0.0.1:${this.port}${PATH_PREFIX}${key}`, headers: { Authorization: `Bearer ${this.token}` } }
  }

  /** 화면이 지금 보여 주는 프로젝트 (없으면 undefined — 창이 없거나 프로젝트를 안 열었다) */
  view(directory: string | undefined): void {
    this.viewed = directory
  }

  /** 화면 도구가 부른다 — 사용자가 그 프로젝트를 보고 있지 않으면 그 사실을 결과 글로 던진다 (뒤에 있는 프로젝트의 패널·터미널 칸은 없다) */
  requireViewed(directory: string): void {
    if (this.viewed === directory) return
    throw new Error(
      this.viewed
        ? `The user is viewing another project (${path.basename(this.viewed)}). Ask them to switch back, then call again.`
        : 'The user is not viewing this project right now. Ask them to open it in litecode, then call again.',
    )
  }

  private async handle(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    if (!this.authorized(request.headers.authorization)) return send(response, 401, { error: 'unauthorized' })
    // 엔진은 붙자마자 SSE 를 얻으려 GET 을 한 번 한다 — 405 여도 connected 다 (01z 1-1). 스트림·세션 종료(DELETE)는 없다
    if (request.method !== 'POST') return send(response, 405, { error: 'method_not_allowed' }, { allow: 'POST' })
    const pathname = (request.url ?? '').split('?')[0]!
    const directory = pathname.startsWith(PATH_PREFIX) ? this.directories.get(pathname.slice(PATH_PREFIX.length)) : undefined
    if (!directory) return send(response, 404, { error: 'not_found' })
    const body = await readBody(request)
    if (body === undefined) return send(response, 413, { error: 'too_large' })
    let message: unknown
    try {
      message = JSON.parse(body)
    } catch {
      return send(response, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })
    }
    const answer = await handleRpc(message, [...this.tools.values()], { directory }, APP_MCP_NAME)
    if (answer === null) {
      response.writeHead(202).end() // 알림 — 받았다는 것만
      return
    }
    send(response, 200, answer)
  }

  private authorized(header: string | undefined): boolean {
    const expected = Buffer.from(`Bearer ${this.token}`)
    const given = Buffer.from(header ?? '')
    return given.length === expected.length && timingSafeEqual(given, expected)
  }
}

function send(response: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = JSON.stringify(body)
  response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text), ...headers })
  response.end(text)
}

/** 본문 — 상한을 넘으면 undefined. 넘친 뒤에는 쌓지 않고 흘려보내기만 한다(끝까지 받아야 응답을 곱게 보낸다) */
async function readBody(request: http.IncomingMessage): Promise<string | undefined> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    size += (chunk as Buffer).length
    if (size <= MAX_BODY_BYTES) chunks.push(chunk as Buffer)
  }
  return size > MAX_BODY_BYTES ? undefined : Buffer.concat(chunks).toString('utf8')
}
