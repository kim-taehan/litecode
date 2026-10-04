// 앱 MCP 서버의 JSON-RPC (이슈 #51) — 요청 하나를 응답 하나로. HTTP(소켓·토큰·프로젝트 키)는 appMcp.ts 가 보고 여기는 객체만 다룬다.
// 손으로 쓴다 — opencode 가 부르는 것은 initialize·notifications/initialized·tools/list·tools/call 뿐이다 (실측 2026-10-04, 1.18.18,
// _workspace/01z_desktop_mcp.md 1-1). prompts/*·resources/* 는 안 온다.
// - initialize: 부른 protocolVersion(1.18.18 은 `2025-11-25`)을 그대로 돌려준다 — 우리가 쓰는 것은 도구 목록·호출뿐이라 버전 차이가 없다
// - 알림(id 없음)에는 답이 없다(HTTP 202). **호출이 끝날 때마다 `notifications/cancelled` 가 온다**(정상 완료 4~9ms 뒤, 54/54) — 이미 답한
//   요청의 취소라 무시한다
// - 도구 실패는 JSON-RPC 오류가 아니라 `isError` + 글로 낸다 — 그 글이 그대로 모델에 가서 고쳐 부를 수 있다 (1-5). JSON-RPC 오류로 내면
//   모델은 "MCP error -32000: …" 만 받는다

/** 도구 하나. run 이 던진 Error 의 message 가 `isError` 글로 모델에 간다 */
export interface AppMcpTool {
  name: string
  /** 모델이 읽는 글 — 화면 언어와 무관하게 영어 (01z 3-3) */
  description: string
  inputSchema: Record<string, unknown>
  run(args: Record<string, unknown>, call: ToolCall): Promise<string>
}

/** 호출의 신원 — 요청이 주장한 값이 아니라 서버가 URL 의 프로젝트 키로 정한 폴더 */
export interface ToolCall {
  directory: string
}

export interface RpcResponse {
  jsonrpc: '2.0'
  id: string | number | null
  result?: unknown
  error?: { code: number; message: string }
}

const PROTOCOL_VERSION = '2025-06-18'

/** 요청 하나를 처리한다. 알림이면 null (돌려줄 것이 없다) */
export async function handleRpc(message: unknown, tools: readonly AppMcpTool[], call: ToolCall, serverName: string): Promise<RpcResponse | null> {
  if (!isObject(message)) return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid request' } }
  const id = message['id']
  // null 은 "id 가 null 인 요청" 이라 알림이 아니다
  if (typeof id !== 'string' && typeof id !== 'number' && id !== null) return null
  const params = isObject(message['params']) ? message['params'] : {}
  switch (message['method']) {
    case 'initialize':
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: typeof params['protocolVersion'] === 'string' ? params['protocolVersion'] : PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: serverName, version: '1' },
        },
      }
    case 'ping':
      return { jsonrpc: '2.0', id, result: {} }
    case 'tools/list':
      return { jsonrpc: '2.0', id, result: { tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) } }
    case 'tools/call':
      return { jsonrpc: '2.0', id, result: await callTool(params, tools, call) }
    default:
      return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${String(message['method'])}` } }
  }
}

async function callTool(params: Record<string, unknown>, tools: readonly AppMcpTool[], call: ToolCall): Promise<unknown> {
  const tool = tools.find((candidate) => candidate.name === params['name'])
  if (!tool) return failed(`Unknown tool: ${String(params['name'])}`)
  try {
    return { content: [{ type: 'text', text: await tool.run(isObject(params['arguments']) ? params['arguments'] : {}, call) }] }
  } catch (error) {
    return failed((error as Error).message)
  }
}

function failed(text: string): unknown {
  return { content: [{ type: 'text', text }], isError: true }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
