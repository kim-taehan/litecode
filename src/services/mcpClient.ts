import { spawn } from 'node:child_process'
import type { EngineMcp } from './engineConfig.ts'
import { hiddenEnvNames } from './engineConfig.ts'
import { tr } from '../i18n.ts'
import { keepTail, streamText } from './outputBuffer.ts'
import { estimateToolTokens } from '../../shared/mcpTools.ts'

// 앱이 MCP 서버에 직접 붙어 도구 목록만 묻는 최소 클라이언트 (이슈 #28). opencode 에는 MCP 도구 목록 API 가 없다 — /experimental/tool 에도
// MCP 도구는 안 나온다(#28 실측, 1.18.18). 그래서 `+` 메뉴 MCP 팝업(#43)의 "도구 N"·도구 이름·설명과 "연결 테스트"(저장 없이)는 앱이 잠깐 붙어 본다:
// initialize → notifications/initialized → tools/list(커서 끝까지) → 끊는다. 대화에서 실제로 부르는 것은 opencode 다.
// - 로컬(stdio): 줄 단위 JSON-RPC. env 는 dsh 식으로 걸러 낸다 — OPENCODE_*·LITECODE_*·KEY/PASSWORD/SECRET/TOKEN 이름을 지우고 정의의 env 를 얹는다
// - 원격(streamable HTTP): POST 하나에 JSON 또는 SSE 로 답이 온다. Accept 에 둘 다 있어야 하고 세션 id 는 mcp-session-id 헤더 (closed-code
//   remoteMcpTools.ts 실측). 옛 SSE 전송(GET /sse + endpoint 이벤트)은 하지 않는다 — opencode 는 그쪽으로도 물러나 붙을 수 있다(남은 공백)
// SDK(@modelcontextprotocol/sdk)를 안 쓰는 이유: 의존성을 늘리지 않고, 필요한 것은 목록 읽기뿐이다

export interface McpTool {
  name: string
  description?: string
  /** 이 도구 정의(이름·설명·입력 스키마)가 모델 요청에 싣는 토큰 어림 (이슈 #164 — 스키마는 화면에 보내지 않고 이 값만) */
  tokens: number
}

const PROTOCOL_VERSION = '2025-06-18'
const CLIENT_INFO = { name: 'litecode', version: '0' }
export const MCP_LIST_TIMEOUT_MS = 15_000

interface RpcMessage {
  jsonrpc?: string
  id?: number
  result?: { tools?: { name?: unknown; description?: unknown; inputSchema?: unknown }[]; nextCursor?: string }
  error?: { message?: string }
}

/** 서버의 도구 목록. 실패하면 사유를 담아 던진다 (사유에 env·헤더 값은 넣지 않는다) */
export async function listMcpTools(def: EngineMcp, opts: { cwd: string; env?: NodeJS.ProcessEnv; timeoutMs?: number }): Promise<McpTool[]> {
  const timeout = opts.timeoutMs ?? MCP_LIST_TIMEOUT_MS
  return def.type === 'local' ? listLocal(def, opts.cwd, opts.env ?? process.env, timeout) : listRemote(def, timeout)
}

/** 로컬 서버 자식 env — 앱 env 에서 비밀 이름을 지우고 정의의 env 를 얹는다 */
export function mcpChildEnv(base: NodeJS.ProcessEnv, environment: Record<string, string> = {}): NodeJS.ProcessEnv {
  const hidden = new Set(hiddenEnvNames(base))
  return { ...Object.fromEntries(Object.entries(base).filter(([name]) => !hidden.has(name))), ...environment }
}

function toolsOf(result: RpcMessage['result']): McpTool[] {
  return (result?.tools ?? [])
    .filter((tool): tool is { name: string; description?: unknown; inputSchema?: unknown } => typeof tool.name === 'string')
    .map((tool) => ({
      name: tool.name,
      ...(typeof tool.description === 'string' && tool.description && { description: tool.description }),
      tokens: estimateToolTokens({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema }),
    }))
}

const initialize = (id: number) => ({ jsonrpc: '2.0', id, method: 'initialize', params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO } })
const initialized = { jsonrpc: '2.0', method: 'notifications/initialized' }
const toolsList = (id: number, cursor?: string) => ({ jsonrpc: '2.0', id, method: 'tools/list', params: cursor ? { cursor } : {} })

function listLocal(def: Extract<EngineMcp, { type: 'local' }>, cwd: string, base: NodeJS.ProcessEnv, timeout: number): Promise<McpTool[]> {
  return new Promise<McpTool[]>((resolve, reject) => {
    const [command, ...args] = def.command
    if (!command) return reject(new Error(tr('mcp.error.noCommand')))
    // 프로세스 그룹으로 띄운다 — `npx` 처럼 감싼 서버는 감싼 쪽만 끄면 진짜 서버(손자)가 남는다 (이슈 #178). Windows 는 그룹이 없어 taskkill /T
    // (exec.ts 와 같은 규칙. Windows 쪽 실제 실행은 미검증)
    const child = spawn(command, args, { cwd, env: mcpChildEnv(base, def.environment), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32' })
    const signal = (name: NodeJS.Signals): void => {
      try {
        if (child.pid && process.platform !== 'win32') process.kill(-child.pid, name)
        else if (child.pid && process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).on('error', () => child.kill())
        else child.kill(name)
      } catch {
        // 이미 끝났다 (그룹에 남은 프로세스가 없다)
      }
    }
    // 조각 경계에 걸린 여러 바이트 글자가 깨지지 않게 스트림마다 디코더를 둔다. stderr 는 끝을 남긴다 — 사유는 마지막 줄이다
    const stderr = keepTail(4_000)
    const stderrText = streamText()
    const stdoutText = streamText()
    let buffer = ''
    let nextId = 1
    const tools: McpTool[] = []
    let settled = false
    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.stdin?.end()
      // 감싼 쪽이 이미 끝났어도 그룹에는 손자가 남아 있을 수 있다 — 그래서 끝남 여부와 상관없이 그룹에 보낸다
      signal('SIGTERM')
      if (process.platform !== 'win32') setTimeout(() => signal('SIGKILL'), 2_000).unref()
      if (error) reject(error)
      else resolve(tools)
    }
    const timer = setTimeout(() => finish(new Error(tr('mcp.error.timeout', { seconds: timeout / 1000 }))), timeout)
    const send = (message: unknown): void => void child.stdin?.write(`${JSON.stringify(message)}\n`)
    child.on('error', (error) => finish(new Error(error.message)))
    child.on('exit', (code) => finish(new Error(tr('mcp.error.exited', { code: String(code), detail: stderr.text().trim().split('\n').at(-1) ?? '' }).trim())))
    child.stderr?.on('data', (part: Buffer) => stderr.push(stderrText.push(part)))
    child.stdin?.on('error', () => {}) // 서버가 먼저 끝나면 EPIPE — exit 이 사유를 준다
    child.stdout?.on('data', (part: Buffer) => {
      buffer += stdoutText.push(part)
      let end: number
      while ((end = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, end).trim()
        buffer = buffer.slice(end + 1)
        if (!line) continue
        let message: RpcMessage
        try {
          message = JSON.parse(line) as RpcMessage
        } catch {
          continue // 서버가 stdout 에 찍은 다른 글
        }
        if (message.id === undefined) continue
        if (message.error) return finish(new Error(message.error.message ?? 'error'))
        if (message.id === 1) {
          send(initialized)
          send(toolsList(++nextId))
          continue
        }
        tools.push(...toolsOf(message.result))
        if (message.result?.nextCursor) send(toolsList(++nextId, message.result.nextCursor))
        else finish()
      }
    })
    send(initialize(1))
  })
}

async function listRemote(def: Extract<EngineMcp, { type: 'remote' }>, timeout: number): Promise<McpTool[]> {
  const signal = AbortSignal.timeout(timeout)
  let session: string | undefined
  const post = async (message: { id?: number } & Record<string, unknown>): Promise<RpcMessage | undefined> => {
    const res = await fetch(def.url, {
      method: 'POST',
      headers: {
        ...def.headers,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...(session && { 'mcp-session-id': session, 'mcp-protocol-version': PROTOCOL_VERSION }),
      },
      body: JSON.stringify(message),
      signal,
      redirect: 'manual', // 헤더에 비밀이 실린다 — 서버가 다른 주소로 넘겨도 따라가지 않는다
    }).catch((error: unknown) => {
      throw new Error(signal.aborted ? tr('mcp.error.timeout', { seconds: timeout / 1000 }) : String((error as Error).cause ?? (error as Error).message))
    })
    if (res.status >= 300 && res.status < 400) {
      await res.body?.cancel()
      throw new Error(tr('error.redirected', { status: res.status }))
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    session = res.headers.get('mcp-session-id') ?? session
    if (message.id === undefined) {
      await res.body?.cancel()
      return undefined
    }
    if ((res.headers.get('content-type') ?? '').includes('text/event-stream')) return readSse(res, message.id)
    return (await res.json()) as RpcMessage
  }
  const checked = (message: RpcMessage | undefined): RpcMessage => {
    if (!message) throw new Error(tr('mcp.error.noReply'))
    if (message.error) throw new Error(message.error.message ?? 'error')
    return message
  }
  try {
    checked(await post(initialize(1)))
    await post(initialized)
    const tools: McpTool[] = []
    let cursor: string | undefined
    let id = 2
    do {
      const reply = checked(await post(toolsList(id++, cursor)))
      tools.push(...toolsOf(reply.result))
      cursor = reply.result?.nextCursor
    } while (cursor)
    return tools
  } finally {
    // 세션을 닫는다 — 못 닫아도 그만이다
    if (session) void fetch(def.url, { method: 'DELETE', headers: { ...def.headers, 'mcp-session-id': session }, signal: AbortSignal.timeout(3_000), redirect: 'manual' }).catch(() => {})
  }
}

/** SSE 답에서 그 id 의 JSON-RPC 메시지를 찾는다 */
async function readSse(res: Response, id: number): Promise<RpcMessage | undefined> {
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) return undefined
      buffer += decoder.decode(next.value, { stream: true }).replace(/\r\n/g, '\n')
      let end: number
      while ((end = buffer.indexOf('\n\n')) !== -1) {
        const data = buffer
          .slice(0, end)
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trim())
          .join('\n')
        buffer = buffer.slice(end + 2)
        if (!data) continue
        try {
          const message = JSON.parse(data) as RpcMessage
          if (message.id === id) return message
        } catch {
          // 다른 이벤트
        }
      }
    }
  } finally {
    void reader.cancel().catch(() => {})
  }
}
