import http from 'node:http'
import type { AddressInfo } from 'node:net'

// opencode 가 호출할 OpenAI 호환 가짜 LLM. 실물 테스트에서 "진짜" 가 아닌 것은 이것 하나뿐이다 —
// opencode·SSE·IPC·화면은 전부 실물이다. 사내 게이트웨이가 없는 곳에서도 턴을 끝까지 돌리려고 둔다.
//
// 응답 규칙 (테스트가 기대값을 알 수 있게 결정적이다):
// - 마지막 user 메시지에 `[fail]` 이 있으면 HTTP 500 → opencode 는 session.next.step.failed 를 낸다
// - 마지막 user 메시지에 `[slow]` 가 있으면 SLOW_MS 동안 답을 미룬 뒤 echo 한다 — "답을 기다리는 중" 을 만든다.
//   그 사이 opencode 가 끊으면(재시작) 타이머를 버린다
// - 마지막 user 메시지에 `[late]` 가 있으면 답(`[fail]` 의 500 포함)을 LATE_MS 미룬다 — 보낸 뒤 다른 대화·프로젝트로 옮겨 가서
//   "보고 있지 않은 대화가 끝남" 을 실제 턴으로 만든다 (notifications.live.test.ts)
// - 마지막 user 메시지에 `[drip]` 이 있으면 두 조각 사이를 DRIP_MS 벌린다 — 중간(키 프록시)이 스트림을 버퍼링하지 않는지 본다
// - 마지막 메시지가 도구 결과(role: tool)면 `tool: <그 결과>` 를 텍스트로 스트리밍한다
// - 마지막 user 메시지에 `[bash:<cmd>]` 가 있으면 bash 도구 호출(command=<cmd>)을 낸다 — opencode 가 도구를 실행하고
//   결과를 붙여 다시 부르면 위 규칙으로 끝난다. `[bash:pwd]` 로 세션의 작업 디렉터리를 답에서 읽는다 (01_probe 규칙)
// - 마지막 user 메시지에 `[call:<도구 이름> <json 인자>]` 가 있으면 그 도구 호출을 낸다 — bash 밖의 도구(grep 등)를 부른다.
//   예: `[call:grep {"pattern":"needle"}]`. 끝나는 것은 bash 와 같다 (01b_offline 제안)
// - 마지막 user 메시지에 `[lead]` 가 있으면 답을 빈 줄 두 개로 시작한다 — 실제 모델(Qwen)이 그렇게 답한다 (2026-10-01 사용자 캡처)
// - 마지막 user 메시지에 `[md]` 가 있으면 MARKDOWN_REPLY(제목·한글 굵게·목록·표·코드 블록·링크·원격 이미지·원문 HTML·빈 줄 과다)를
//   답한다 — 답 말풍선 마크다운 렌더링을 본다 (markdown.live.test.ts)
// - 마지막 user 메시지에 `[think]` 가 있으면 답(또는 도구 호출) 앞에 생각(`reasoning_content`)을 THINK_REPLY 두 조각으로 THINK_MS 씩
//   벌려 보낸다 — opencode 가 생각으로 인식하는 형식(01g 2d). 진행 중 "생각" 줄이 조각으로 채워지는지 본다 (chat-layout.live.test.ts)
// - 그 밖에는 `echo: <마지막 user 메시지>` 를 두 조각으로 나눠 스트리밍한다
// - `GET /requests` 는 지금까지 받은 chat/completions 요청 수를 JSON 으로 준다 — 테스트 프로세스는
//   globalSetup 과 달라 requestCount() 를 직접 못 부르므로 HTTP 로 연다. 마지막 `/v1/models` 요청의 Authorization
//   헤더(modelsAuth)와 마지막 chat/completions 요청의 Authorization(chatAuth)도 함께 준다 — 설정 화면이 저장한 키가
//   복호화돼 게이트웨이까지 갔는지 본다 (chatAuth 는 opencode 가 보낸 것 — 키가 엔진 env 로 전달됐는지).
//   chatModels 는 받은 chat/completions 요청 본문의 model 을 받은 순서대로 — 입력창에서 고른 모델로 갔는지 본다.
//   lastChat 은 마지막 요청의 model 과 messages 요약(역할·글자 앞 80자) — 모델을 바꾼 뒤에도 앞 턴 맥락이 실렸는지 본다.
//   lastChatText 는 마지막 요청 messages 의 글 전체를 이은 것 — 긴 맥락(`!` 카드 출력)이 실렸는지 본다
// - `GET /v1/models` 는 OpenAI 호환 모델 목록 FAKE_MODELS 를 준다 (설정 > 모델의 "사용 가능한 모델 가져오기")
// - 스트림 답마다 finish 청크 뒤·[DONE] 앞에 `choices: []` + FAKE_USAGE 청크를 보낸다 (opencode 가 stream_options.include_usage
//   를 싣는다). 요청마다 같은 값이라 스텝 수만 알면 합계를 계산할 수 있다. opencode 쪽 값은 01_probe 매핑:
//   input = prompt − cached, cache.read = cached, output = completion (reasoning 없음)

/** `GET /v1/models` 가 주는 모델 id */
export const FAKE_MODELS = ['fake-alpha', 'fake-beta']
/** `[slow]` 답을 미루는 시간 — 테스트가 그 사이에 재시작을 일으킨다 */
export const SLOW_MS = 30_000
/** `[late]` 답을 미루는 시간 */
export const LATE_MS = 3_000
/** `[drip]` 두 조각 사이 간격 */
export const DRIP_MS = 1_500
/** `[think]` 의 생각 두 조각 — 첫 조각이 첫 문단(굵게 포함)이다 */
export const THINK_REPLY = ['**Planning** the answer line one\n\n', 'Second paragraph of thought.']
/** `[think]` 조각 사이 간격 */
export const THINK_MS = 1_500
/** 답마다 돌려주는 usage (OpenAI 모양) */
export const FAKE_USAGE = { prompt_tokens: 1_000, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 300 } }
const USAGE_CHUNK = `data: ${JSON.stringify({ id: 'fake', object: 'chat.completion.chunk', created: 0, model: 'echo', choices: [], usage: FAKE_USAGE })}\n\n`

/** `[md]` 의 답 — 화면 요소로 나와야 하는 것과, 실행·로드되면 안 되는 것(script·onerror·원격 이미지)을 함께 싣는다 */
export const MARKDOWN_REPLY = [
  '## 요약',
  '',
  '**프로젝트명:**라이트코드 입니다. 자세한 건 [문서](https://example.com/doc) 참고.',
  '',
  '',
  '',
  '',
  '빈 줄 네 개 뒤 문단.',
  '',
  '- 첫째',
  '- 둘째',
  '',
  '| 이름 | 값 |',
  '|---|---:|',
  '| alpha | 1 |',
  '',
  '```ts',
  'const answer = 42',
  '```',
  '',
  '---',
  '',
  '<script>window.__mdPwned = "script"</script>',
  '',
  '<img src="x" onerror="window.__mdPwned = \'onerror\'">',
  '',
  '![원격 그림](https://example.com/tracker.png)',
].join('\n')

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
type ChatMessage = { role: string; content: string | ContentPart[] | null }

function contentText(message: ChatMessage): string {
  if (typeof message.content === 'string') return message.content
  return (message.content ?? []).map((part) => part.text ?? '').join('') // 도구를 부른 assistant 메시지는 content 가 null
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
  const chatModels: string[] = []
  let lastChat: { model: string; messages: { role: string; text: string }[] } | undefined
  let lastChatText = ''
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (part) => (raw += part))
    req.on('end', () => {
      if (req.method === 'GET' && req.url === '/requests') {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ count, modelsAuth, chatAuth, chatModels, lastChat, lastChatText }))
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
      const body = JSON.parse(raw) as { model: string; messages: ChatMessage[] }
      chatModels.push(body.model)
      const messages = body.messages
      lastChat = { model: body.model, messages: messages.map((message) => ({ role: message.role, text: contentText(message).slice(0, 80) })) }
      lastChatText = messages.map(contentText).join('\n')
      const text = lastUserText(messages)
      if (text.includes('[fail]')) {
        const fail = (): void => {
          res.writeHead(500, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: { message: 'fake-llm: 요청된 실패' } }))
        }
        if (!text.includes('[late]')) return fail()
        const timer = setTimeout(fail, LATE_MS)
        res.on('close', () => clearTimeout(timer))
        return
      }
      const last = messages[messages.length - 1]
      const command = /\[bash:([^\]]+)\]/.exec(text)?.[1]
      const named = /\[call:(\w+) (\{.*\})\]/.exec(text)
      const tool = named ? { name: named[1]!, arguments: named[2]! } : command && { name: 'bash', arguments: JSON.stringify({ command, description: 'fake' }) }
      // [think]: 첫 요청(도구 결과가 아닌)에만 생각을 먼저 흘리고 then 을 잇는다. 헤더는 여기서 쓴다
      const thinkFirst = (then: () => void): void => {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        if (last?.role === 'tool' || !text.includes('[think]')) return then()
        res.write(chunk({ role: 'assistant', reasoning_content: THINK_REPLY[0] }))
        const timer = setTimeout(() => {
          res.write(chunk({ reasoning_content: THINK_REPLY[1] }))
          timers.push(setTimeout(then, THINK_MS))
        }, THINK_MS)
        const timers = [timer]
        res.on('close', () => timers.forEach(clearTimeout))
      }
      if (last?.role !== 'tool' && tool) {
        const call = { index: 0, id: `call_${++toolCalls}`, type: 'function', function: tool }
        thinkFirst(() => {
          res.write(chunk({ role: 'assistant', tool_calls: [call] }))
          res.write(chunk({}, 'tool_calls'))
          res.write(USAGE_CHUNK)
          res.end('data: [DONE]\n\n')
        })
        return
      }
      const reply = last?.role !== 'tool' && text.includes('[md]')
        ? MARKDOWN_REPLY
        : (last?.role !== 'tool' && text.includes('[lead]') ? '\n\n' : '') + (last?.role === 'tool' ? `tool: ${contentText(last)}` : `echo: ${text}`)
      const half = Math.ceil(reply.length / 2)
      const answer = (): void => thinkFirst(() => {
        res.write(chunk({ role: 'assistant', content: reply.slice(0, half) }))
        const rest = (): void => {
          res.write(chunk({ content: reply.slice(half) }))
          res.write(chunk({}, 'stop'))
          res.write(USAGE_CHUNK)
          res.end('data: [DONE]\n\n')
        }
        if (text.includes('[drip]')) setTimeout(rest, DRIP_MS)
        else rest()
      })
      if (last?.role !== 'tool' && (text.includes('[slow]') || text.includes('[late]'))) {
        const timer = setTimeout(answer, text.includes('[slow]') ? SLOW_MS : LATE_MS)
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
