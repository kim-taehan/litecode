import http from 'node:http'
import type { AddressInfo } from 'node:net'

// opencode 가 호출할 OpenAI 호환 가짜 LLM. 실물 테스트에서 "진짜" 가 아닌 것은 이것 하나뿐이다 —
// opencode·SSE·IPC·화면은 전부 실물이다. 사내 게이트웨이가 없는 곳에서도 턴을 끝까지 돌리려고 둔다.
//
// 응답 규칙 (테스트가 기대값을 알 수 있게 결정적이다):
// - 마지막 user 메시지에 `[fail]` 이 있으면 HTTP 500 → opencode 는 session.next.step.failed 를 낸다
// - 마지막 user 메시지에 `[slow]` 가 있으면 SLOW_MS 동안 답을 미룬 뒤 echo 한다 — "답을 기다리는 중" 을 만든다.
//   그 사이 opencode 가 끊으면(재시작) 타이머를 버린다
// - 마지막 user 메시지에 `[drip]` 이 있으면 두 조각 사이를 DRIP_MS 벌린다 — 중간(키 프록시)이 스트림을 버퍼링하지 않는지 본다
// - 마지막 메시지가 도구 결과(role: tool)면 `tool: <그 결과>` 를 텍스트로 스트리밍한다
// - 마지막 user 메시지에 `[bash:<cmd>]` 가 있으면 bash 도구 호출(command=<cmd>)을 낸다 — opencode 가 도구를 실행하고
//   결과를 붙여 다시 부르면 위 규칙으로 끝난다. `[bash:pwd]` 로 세션의 작업 디렉터리를 답에서 읽는다 (01_probe 규칙)
// - 마지막 user 메시지에 `[call:<도구 이름> <json 인자>]` 가 있으면 그 도구 호출을 낸다 — bash 밖의 도구(grep 등)를 부른다.
//   예: `[call:grep {"pattern":"needle"}]`. 끝나는 것은 bash 와 같다 (01b_offline 제안)
// - 그 밖에는 `echo: <마지막 user 메시지>` 를 두 조각으로 나눠 스트리밍한다
// - `GET /requests` 는 지금까지 받은 chat/completions 요청 수를 JSON 으로 준다 — 테스트 프로세스는
//   globalSetup 과 달라 requestCount() 를 직접 못 부르므로 HTTP 로 연다. 마지막 `/v1/models` 요청의 Authorization
//   헤더(modelsAuth)와 마지막 chat/completions 요청의 Authorization(chatAuth)도 함께 준다 — 설정 화면이 저장한 키가
//   복호화돼 게이트웨이까지 갔는지 본다 (chatAuth 는 opencode 가 보낸 것 — 키가 엔진 env 로 전달됐는지)
// - `GET /v1/models` 는 OpenAI 호환 모델 목록 FAKE_MODELS 를 준다 (설정 > 모델의 "사용 가능한 모델 가져오기")

/** `GET /v1/models` 가 주는 모델 id */
export const FAKE_MODELS = ['fake-alpha', 'fake-beta']
/** `[slow]` 답을 미루는 시간 — 테스트가 그 사이에 재시작을 일으킨다 */
export const SLOW_MS = 30_000
/** `[drip]` 두 조각 사이 간격 */
export const DRIP_MS = 1_500

export interface FakeLlm {
  /** opencode.json 의 provider baseURL 에 넣을 값 (`.../v1`) */
  baseURL: string
  /** `GET ${url}/requests` 로 요청 수를 읽는 주소 (테스트 프로세스용) */
  url: string
  /** 받은 요청 수 — "opencode 가 정말 LLM 까지 갔나" 를 확인할 때 쓴다 */
  requestCount(): number
  stop(): Promise<void>
}

type ContentPart = { type?: string; text?: string }
type ChatMessage = { role: string; content: string | ContentPart[] }

function contentText(message: ChatMessage): string {
  if (typeof message.content === 'string') return message.content
  return message.content.map((part) => part.text ?? '').join('')
}

function lastUserText(messages: ChatMessage[]): string {
  const last = [...messages].reverse().find((message) => message.role === 'user')
  return last ? contentText(last) : ''
}

function chunk(delta: Record<string, unknown>, finish: string | null = null): string {
  const body = { id: 'fake', object: 'chat.completion.chunk', created: 0, model: 'echo', choices: [{ index: 0, delta, finish_reason: finish }] }
  return `data: ${JSON.stringify(body)}\n\n`
}

export async function startFakeLlm(): Promise<FakeLlm> {
  let count = 0
  let toolCalls = 0
  let modelsAuth: string | undefined
  let chatAuth: string | undefined
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (part) => (raw += part))
    req.on('end', () => {
      if (req.method === 'GET' && req.url === '/requests') {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ count, modelsAuth, chatAuth }))
        return
      }
      if (req.method === 'GET' && req.url === '/v1/models') {
        modelsAuth = req.headers.authorization
        const data = FAKE_MODELS.map((id) => ({ id, object: 'model', owned_by: 'fake' }))
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ object: 'list', data }))
        return
      }
      if (!req.url?.endsWith('/chat/completions')) {
        res.writeHead(404).end()
        return
      }
      count++
      chatAuth = req.headers.authorization
      const messages = (JSON.parse(raw) as { messages: ChatMessage[] }).messages
      const text = lastUserText(messages)
      if (text.includes('[fail]')) {
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'fake-llm: 요청된 실패' } }))
        return
      }
      const last = messages[messages.length - 1]
      const command = /\[bash:([^\]]+)\]/.exec(text)?.[1]
      const named = /\[call:(\w+) (\{.*\})\]/.exec(text)
      const tool = named ? { name: named[1]!, arguments: named[2]! } : command && { name: 'bash', arguments: JSON.stringify({ command, description: 'fake' }) }
      if (last?.role !== 'tool' && tool) {
        const call = { index: 0, id: `call_${++toolCalls}`, type: 'function', function: tool }
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.write(chunk({ role: 'assistant', tool_calls: [call] }))
        res.write(chunk({}, 'tool_calls'))
        res.end('data: [DONE]\n\n')
        return
      }
      const reply = last?.role === 'tool' ? `tool: ${contentText(last)}` : `echo: ${text}`
      const half = Math.ceil(reply.length / 2)
      const answer = (): void => {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.write(chunk({ role: 'assistant', content: reply.slice(0, half) }))
        const rest = (): void => {
          res.write(chunk({ content: reply.slice(half) }))
          res.write(chunk({}, 'stop'))
          res.end('data: [DONE]\n\n')
        }
        if (text.includes('[drip]')) setTimeout(rest, DRIP_MS)
        else rest()
      }
      if (last?.role !== 'tool' && text.includes('[slow]')) {
        const timer = setTimeout(answer, SLOW_MS)
        res.on('close', () => clearTimeout(timer))
        return
      }
      answer()
    })
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    baseURL: `http://127.0.0.1:${port}/v1`,
    url: `http://127.0.0.1:${port}`,
    requestCount: () => count,
    stop: () => new Promise((resolve) => server.close(() => resolve())),
  }
}
