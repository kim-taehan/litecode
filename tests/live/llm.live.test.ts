import { Context } from 'cordis'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import { ProviderRegistry, type ProviderConfig } from '../../src/services/providers.ts'
import { LlmService, MODEL_CATALOG_TIMEOUT_MS } from '../../src/services/llm.ts'
import { EngineService } from '../../src/services/engine.ts'
import { engineOptions } from './support/opencodeServer.ts'

// 서비스 계층 실물 테스트 — ctx.llm 이 진짜 opencode 와 세션 생성 → SSE → 프롬프트 → 턴 종료를
// 끝까지 도는지 본다. opencode 이벤트 모양이 바뀌면 여기서 먼저 깨진다.
// opencode 는 ctx.engine 이 띄운다 (제품과 같은 길 — 생성한 opencode.json·비밀번호·키 env).

let services: Context
const fibers: { dispose(): Promise<void> }[] = []
/** 세션 작업 디렉터리의 부모 — realpath 한 값 (macOS 의 /var 는 /private/var 링크) */
let root: string
/** 폴더 자체가 관심사가 아닌 테스트가 쓰는 작업 디렉터리 */
let work: string

/** 가짜 LLM 에 닿는 provider — ctx.engine 이 이것으로 opencode.json 을 만든다 */
const fakeProvider = (): ProviderConfig => ({
  id: 'fake',
  displayName: 'Fake',
  baseURL: `${inject('fakeLlmUrl')}/v1`,
  protocol: 'openai-chat-completions',
  models: [{ id: 'echo', displayName: 'Echo' }, { id: 'echo-b', displayName: 'Echo B' }],
})

/** 새 컨텍스트에 providers·engine·llm 을 올린다. state 아래에 엔진 상태(설정 폴더·DB·PID)와 격리 XDG 를 둔다 */
async function startServices(state: string, providers: ProviderConfig[], fibersOut: { dispose(): Promise<void> }[]): Promise<Context> {
  const ctx = new Context()
  fibersOut.push(ctx.plugin(ProviderRegistry, { defaults: providers }))
  fibersOut.push(ctx.plugin(EngineService, engineOptions(state)))
  fibersOut.push(ctx.plugin(LlmService))
  return new Promise<Context>((resolve) => ctx.inject(['providers', 'engine', 'llm'], (ready) => resolve(ready)))
}

beforeAll(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'litecode-llm-')))
  work = path.join(root, 'work')
  await fs.mkdir(work)
  services = await startServices(path.join(root, 'state'), [fakeProvider()], fibers)
})

/** 앱이 띄운 opencode 에 직접 묻는다 (인증 포함) — 결과 확인용 */
async function opencodeGet(pathAndQuery: string): Promise<Response> {
  const conn = await services.engine.connection()
  return fetch(`${conn.url}${pathAndQuery}`, { headers: conn.headers })
}

type LastChat = { model: string; messages: { role: string; text: string }[] }
/** 가짜 LLM 이 마지막으로 받은 chat 요청 — model 과 messages 요약 */
async function lastChat(): Promise<LastChat> {
  const res = await fetch(`${inject('fakeLlmUrl')}/requests`)
  return ((await res.json()) as { lastChat: LastChat }).lastChat
}

async function fakeLlmRequests(): Promise<number> {
  const res = await fetch(`${inject('fakeLlmUrl')}/requests`)
  return ((await res.json()) as { count: number }).count
}

afterAll(async () => {
  for (const fiber of fibers.reverse()) await fiber.dispose()
  if (root) await fs.rm(root, { recursive: true, force: true })
})

describe('ctx.llm ↔ 실물 opencode', () => {
  it('새 세션에서 한 턴을 끝까지 돌고 텍스트를 돌려준다', async () => {
    const result = await services.llm.chat('fake', 'echo', work, '안녕')

    expect(result).toMatchObject({ ok: true, text: 'echo: 안녕' })
    expect(result.sessionId).toMatch(/^ses_/)
  })

  // 세션을 {} 로 만들면 opencode 가 기본 모델을 비결정적으로 골라 외부 provider 로 나갔다 (2026-09-30 실측).
  // 한 번으로는 못 잡을 수 있어 새 세션을 여러 번 만들고, 매 턴이 가짜 LLM 에 닿았는지 요청 수로 확인한다.
  it('새 세션은 넘긴 provider/모델로 만들어져 매 턴이 가짜 LLM 에 닿는다', async () => {
    const before = await fakeLlmRequests()
    for (let i = 1; i <= 3; i++) {
      expect(await services.llm.chat('fake', 'echo', work, `모델 확인 ${i}`)).toMatchObject({ ok: true, text: `echo: 모델 확인 ${i}` })
    }
    expect(await fakeLlmRequests()).toBe(before + 3)
  })

  it('sessionId 를 넘기면 같은 세션에서 이어서 대화한다', async () => {
    const first = await services.llm.chat('fake', 'echo', work, '첫 번째')
    const second = await services.llm.chat('fake', 'echo', work, '두 번째', first.sessionId)

    expect(second).toMatchObject({ ok: true, sessionId: first.sessionId, text: 'echo: 두 번째' })
  })

  // 없는 providerID/모델로도 opencode 는 세션을 200 으로 만들고, 프롬프트는 SSE 에 아무 이벤트 없이 멈춘다
  // (로그에만 ModelUnavailableError — 2026-09-30 실측). 멈추지 말고 카탈로그 대기 기한 안에 사유를 돌려줘야 한다.
  it('opencode 에 없는 모델이면 세션을 만들지 않고 기한 안에 ok:false 와 사유를 돌려준다', async () => {
    const result = await services.llm.chat('fake', 'no-such-model', work, '안녕')

    expect(result.ok).toBe(false)
    expect(result.error).toContain('fake/no-such-model')
    expect(result.sessionId).toBeUndefined()
  }, MODEL_CATALOG_TIMEOUT_MS + 5_000)

  // opencode 는 세션을 만들 때 모델이 정해지고 prompt 본문엔 model 이 없다 — 이어가는 대화에서 다른 모델을 넘기면
  // ctx.llm 이 POST /api/session/{id}/model 로 바꾼 뒤 보낸다. 앞 턴 맥락은 그대로 실린다 (_workspace/01_probe.md)
  it('이어가는 대화에서 다른 모델을 넘기면 그 세션의 모델을 바꿔 보내고, 앞 턴 맥락이 실린다', async () => {
    const first = await services.llm.chat('fake', 'echo-b', work, '첫 턴 알파')
    expect(first).toMatchObject({ ok: true, text: 'echo: 첫 턴 알파' })
    expect((await lastChat()).model).toBe('echo-b')

    const second = await services.llm.chat('fake', 'echo', work, '둘째 턴 베타', first.sessionId)
    expect(second).toMatchObject({ ok: true, sessionId: first.sessionId, text: 'echo: 둘째 턴 베타' })
    const sent = await lastChat()
    expect(sent.model).toBe('echo')
    expect(sent.messages.filter((message) => message.role !== 'system')).toEqual([
      { role: 'user', text: '첫 턴 알파' },
      { role: 'assistant', text: 'echo: 첫 턴 알파' },
      { role: 'user', text: '둘째 턴 베타' },
    ])
  })

  // 함정(01_probe): opencode 는 없는 모델로 바꿔도 204 를 주고 다음 턴이 조용히 매달린다 — 바꾸기 전에 확인해야 한다
  it('이어가는 대화를 없는 모델로 바꾸려 하면 바꾸지 않고 ok:false 이고, 그 세션은 이전 모델로 계속 쓸 수 있다', async () => {
    const first = await services.llm.chat('fake', 'echo-b', work, '바꾸기 전')
    expect(first.ok).toBe(true)
    const before = await fakeLlmRequests()

    const refused = await services.llm.chat('fake', 'no-such-model', work, '없는 모델로', first.sessionId)
    expect(refused).toMatchObject({ ok: false, sessionId: first.sessionId })
    expect(refused.error).toContain('fake/no-such-model')
    expect(await fakeLlmRequests()).toBe(before)
    const session = (await (await opencodeGet(`/api/session/${first.sessionId}`)).json()) as { data: { model: { id: string } } }
    expect(session.data.model.id).toBe('echo-b')

    expect(await services.llm.chat('fake', 'echo-b', work, '이어서', first.sessionId)).toMatchObject({ ok: true, text: 'echo: 이어서' })
    expect((await lastChat()).model).toBe('echo-b')
  }, MODEL_CATALOG_TIMEOUT_MS + 30_000)

  it('LLM 이 실패하면 step.failed 를 잡아 ok:false 와 사유를 돌려준다', async () => {
    const result = await services.llm.chat('fake', 'echo', work, '[fail] 일부러')

    expect(result.ok).toBe(false)
    expect(result.error).toBeTruthy()
  })
})

// 대화는 프로젝트 폴더에서 돈다 — 한 opencode 서버에서 세션마다 location.directory 를 준다 (01_probe 결론).
describe('ctx.llm ↔ 실물 opencode (작업 디렉터리)', () => {
  async function folder(name: string): Promise<string> {
    const dir = path.join(root, name)
    await fs.mkdir(dir)
    return dir
  }

  async function opencodeSession(id: string): Promise<{ location: { directory: string } }> {
    const res = await opencodeGet(`/api/session/${id}`)
    expect(res.status).toBe(200)
    return ((await res.json()) as { data: { location: { directory: string } } }).data
  }

  // 도구 cwd 까지 본다 — location 이 저장만 되고 실행에 안 쓰이는 경우도 잡는다. 동시에 돌려 섞임도 본다.
  it('두 폴더에서 동시에 돌린 턴은 각자 그 폴더에서 도구를 실행한다', async () => {
    const a = await folder('alpha')
    const b = await folder('beta')

    const [ra, rb] = await Promise.all([
      services.llm.chat('fake', 'echo', a, '[bash:pwd]'),
      services.llm.chat('fake', 'echo', b, '[bash:pwd]'),
    ])

    expect(ra.ok).toBe(true)
    expect(rb.ok).toBe(true)
    expect(ra.text?.split('\n')[0]).toBe(`tool: ${a}`)
    expect(rb.text?.split('\n')[0]).toBe(`tool: ${b}`)
  })

  // opencode 는 경로를 문자열 그대로 저장·비교한다(01_probe Q3) — 최근 목록 키와 같은 realpath 로 넘겨야 한다.
  it('심볼릭 링크로 넘겨도 세션의 location.directory 는 realpath 다', async () => {
    const real = await folder('real')
    const link = path.join(root, 'link')
    await fs.symlink(real, link)

    const result = await services.llm.chat('fake', 'echo', link, '링크')

    expect(result).toMatchObject({ ok: true, text: 'echo: 링크' })
    expect((await opencodeSession(result.sessionId!)).location.directory).toBe(real)
  })

  // 없는 경로로 세션을 만들면 opencode 는 200 을 주지만 그 세션·경로는 서버 재시작 전까지 500 이 된다(01_probe Q3) —
  // 사용자 opencode 를 오염시키므로 opencode 에 닿기 전에 거절해야 한다.
  it('없는 폴더면 opencode 에 세션을 만들지 않고 ok:false 와 사유를 돌려준다', async () => {
    const missing = path.join(root, 'missing')

    const result = await services.llm.chat('fake', 'echo', missing, '안녕')

    expect(result.ok).toBe(false)
    expect(result.error).toContain(missing)
    expect(result.sessionId).toBeUndefined()
    const listed = await opencodeGet(`/api/session?directory=${encodeURIComponent(missing)}&limit=10`)
    expect(((await listed.json()) as { data: unknown[] }).data).toHaveLength(0)
  })

  // 카탈로그는 디렉터리별이다(01_probe Q2). 쿼리 이름이 틀리면 opencode 는 200 에 서버 cwd 카탈로그를 준다 —
  // 그 카탈로그에는 이 폴더에만 있는 모델이 없으므로 "모델 없음" 으로 실패해 헛초록이 안 난다.
  // 폴더 설정은 우리 provider 에 모델만 더한다 — 주소는 그대로 키 프록시라 주소 대조를 통과한다 (폴더가 자기 provider 를 정의해
  // 우리 id 로 쓰면 주소가 달라 거부된다 — 그건 engine.live.test.ts 의 덮어쓰기 시나리오)
  it('그 폴더의 opencode.json 에만 있는 모델로 턴이 돈다 (카탈로그를 세션 폴더 기준으로 본다)', async () => {
    const dir = await folder('folder-provider')
    await fs.writeFile(
      path.join(dir, 'opencode.json'),
      JSON.stringify({ $schema: 'https://opencode.ai/config.json', provider: { fake: { models: { 'folder-echo': { name: 'Folder echo' } } } } }),
    )

    expect(await services.llm.chat('fake', 'folder-echo', dir, '폴더 모델')).toMatchObject({ ok: true, text: 'echo: 폴더 모델' })
  }, MODEL_CATALOG_TIMEOUT_MS + 10_000)
})

// 새로 뜬 opencode 의 /api/model 은 빈 목록 → models.dev 원본(설정 provider 없음, 8306개) → 설정 반영 목록 순으로 바뀐다
// (2026-09-30 실측, 5회 기동 모두: 첫 빈 응답 ~330ms 직후의 요청이 가운데 목록을 받고, ~0.7~1.1초에 설정 반영).
// 다른 호출자(TUI·다른 앱)가 먼저 /api/model 을 부르면 우리 첫 조회가 가운데 목록에 떨어진다 — 거기서 "없음" 으로
// 판단하면 있는 모델을 거절한다. 공유 스택은 이미 로드가 끝났으므로 이 테스트 전용 opencode 를 새로 띄운다.
// 이 테스트는 가운데 목록을 **확률적으로만** 거친다 — QA 실측에서 "빈 → 빈 → 설정 반영" 으로 건너뛴 경우가 있었고,
// "비어 있지 않으면 멈춤" 으로 되돌린 코드를 3회 돌리면 빨강 2회였다. 초록 한 번이 회귀 없음의 증명은 아니다.
describe('ctx.llm ↔ 막 뜬 opencode (카탈로그 로드 중)', () => {
  let freshServices: Context
  const freshFibers: { dispose(): Promise<void> }[] = []

  beforeAll(async () => {
    freshServices = await startServices(path.join(root, 'fresh-state'), [fakeProvider()], freshFibers)
  })

  afterAll(async () => {
    for (const fiber of freshFibers.reverse()) await fiber.dispose()
  })

  it('다른 호출자가 카탈로그 로드를 먼저 일으켜도 설정의 모델이 나올 때까지 기다려 턴을 돈다', async (context) => {
    const fresh = await freshServices.engine.connection()
    const first = (await (await fetch(`${fresh.url}/api/model`, { headers: fresh.headers })).json()) as { data: unknown[] }
    // 로드를 일으킨 첫 조회는 보통 빈 목록이고, 이 직후가 가운데 목록 구간이다. 그런데 opencode 가 이미 채웠으면(이 머신 실측 8353개)
    // 이 시나리오를 재현하지 못한 것이다 — 실패가 아니라 건너뛴다 (확률적 테스트, 2026-10-01)
    if (first.data.length !== 0) return context.skip(`첫 조회가 이미 ${first.data.length}개 — 가운데 목록 구간을 못 만들었다`)

    expect(await freshServices.llm.chat('fake', 'echo', work, '로드 중')).toMatchObject({ ok: true, text: 'echo: 로드 중' })
  })
})

// 통계 줄의 원천 — 턴 결과에 중립 모양의 사용량을 싣는다 (_workspace/01_probe.md, 2026-10-01).
// 가짜 LLM 은 요청마다 FAKE_USAGE 를 돌려준다: opencode 매핑으로 input 700(1000−300)·cache.read 300·output 50
describe('ctx.llm 턴 사용량', () => {
  it('도구 턴은 스텝 2개이고, 토큰은 가짜 LLM usage 를 스텝마다 더한 값이다', async () => {
    const result = await services.llm.chat('fake', 'echo', work, '[bash:echo 사용량]')
    expect(result).toMatchObject({ ok: true, text: expect.stringContaining('tool: 사용량') })
    const usage = result.usage!
    expect(usage.steps).toBe(2)
    expect(usage.tokens).toEqual({ input: 1_400, output: 100, reasoning: 0, cacheRead: 600, cacheWrite: 0 })
    expect(usage.lastContextTokens).toBe(1_050)
    expect(usage.ttftSteps).toBe(2)
    expect(usage.llmMs).toBeGreaterThanOrEqual(0)
    expect(usage.messageTokens).toBeGreaterThan(0)
    expect(usage.messageTokens).toBeLessThan(1_050)
  })

  it('이어가는 턴의 사용량은 그 턴 것만이다 (이전 턴 재생분을 더하지 않는다)', async () => {
    const first = await services.llm.chat('fake', 'echo', work, '[bash:echo 하나]')
    const second = await services.llm.chat('fake', 'echo', work, '둘', first.sessionId)
    expect(second.usage).toMatchObject({ steps: 1, tokens: { input: 700, output: 50, cacheRead: 300 } })
  })
})

// 대화 영속화 (00_request 2026-10-01): 지난 대화는 opencode 의 조립된 메시지 목록에서 다시 그린다 (01c Q2)
describe('ctx.llm 지난 대화·세션 삭제', () => {
  async function folder(name: string): Promise<string> {
    const dir = path.join(root, name)
    await fs.mkdir(dir)
    return dir
  }

  it('지난 대화를 중립 모양 말풍선으로 돌려준다 — 도구 턴은 한 답, 실패 턴은 사유', async () => {
    const dir = await folder('history')
    let attached: string | undefined
    const first = await services.llm.chat('fake', 'echo', dir, '[bash:echo 기록]', undefined, async (id) => void (attached = id))
    expect(attached).toBe(first.sessionId) // 새 세션은 프롬프트 전에 알린다
    await services.llm.chat('fake', 'echo', dir, '[fail] 실패', first.sessionId)
    await services.llm.chat('fake', 'echo', dir, '셋째', first.sessionId)

    const history = await services.llm.history(dir, first.sessionId!)
    expect(history.error).toBeUndefined()
    expect(history.messages.map(({ role, text }) => [role, text.split('\n')[0]])).toEqual([
      ['user', '[bash:echo 기록]'],
      ['assistant', 'tool: 기록'],
      ['user', '[fail] 실패'],
      ['assistant', ''],
      ['user', '셋째'],
      ['assistant', 'echo: 셋째'],
    ])
    expect(history.messages[3]!.error).toContain('500')
  })

  // 세션 삭제는 레거시 DELETE 뿐 (01c Q3). 이미 없는 세션을 다시 지워도 실패로 보지 않는다
  it('세션을 지우면 opencode 에서 사라지고, 다시 지워도 오류가 아니다', async () => {
    const result = await services.llm.chat('fake', 'echo', work, '지울 것')
    await services.llm.deleteSession(result.sessionId!)
    expect((await opencodeGet(`/api/session/${result.sessionId}`)).status).toBe(404)
    await services.llm.deleteSession(result.sessionId!)
  })

  // 폴더가 없어진 세션의 내용 요청은 500 이고, 한 번 실패한 경로는 폴더를 되살려도 opencode 를 재시작할 때까지 500 이다 (01c Q5).
  // 서버가 그 경로를 캐시하고 있으면 200 이 나므로 재시작으로 캐시를 비운다. 폴더를 되살린 뒤 내용이 오면 없을 때 묻지 않은 것이다
  it('작업 폴더가 없으면 opencode 에 묻지 않고 missingFolder — 폴더를 되살리면 그대로 불러진다', async () => {
    const dir = await folder('vanishing')
    const result = await services.llm.chat('fake', 'echo', dir, '사라질 폴더')
    await fs.rm(dir, { recursive: true })
    await services.engine.restart()

    expect(await services.llm.history(dir, result.sessionId!)).toEqual({ messages: [], missingFolder: true })

    await fs.mkdir(dir)
    const revived = await services.llm.history(dir, result.sessionId!)
    expect(revived.error).toBeUndefined()
    expect(revived.messages.map((message) => message.text)).toEqual(['사라질 폴더', 'echo: 사라질 폴더'])
  })

  // /message 의 limit 상한은 200 이고 기본은 50 이다(2026-10-01 실측) — cursor 로 끝까지 넘기지 않으면 긴 대화의 앞이 잘린다
  it('긴 대화(메시지 120개)도 엔진 재시작 뒤 첫 메시지부터 다 불러온다', async () => {
    const dir = await folder('long')
    let id: string | undefined
    for (let turn = 1; turn <= 60; turn++) id = (await services.llm.chat('fake', 'echo', dir, `긴 ${turn}`, id)).sessionId
    await services.engine.restart()

    const history = await services.llm.history(dir, id!)
    expect(history.error).toBeUndefined()
    expect(history.messages).toHaveLength(120)
    expect(history.messages[0]).toMatchObject({ role: 'user', text: '긴 1' }) // user 말풍선은 엔진 메시지 id 도 싣는다 (ctx.sessions label)
    expect(history.messages.at(-1)!.text.split('\n')[0]).toBe('echo: 긴 60')
  }, 240_000)

  // 지운 본문은 DB 파일(WAL·빈 페이지)에 남는다(01_probe). 정리 전에 앱이 꺼졌어도 다음에 opencode 를 띄우기 직전에 걷힌다.
  // 정리는 opencode 실행 파일을 BUN_BE_BUN=1 로 쓴다(문서화 안 된 bun 동작, 1.18.18 에서 확인) — 안 먹으면 여기가 깨진다
  it('엔진을 띄우기 직전에 지운 대화의 본문을 DB·-wal·-shm 에서 걷어낸다', async () => {
    const mark = `ZQXSTART${Date.now()}`
    const result = await services.llm.chat('fake', 'echo', work, mark)
    await services.llm.deleteSession(result.sessionId!) // 지우기만 — 정리는 안 부른다
    const db = path.join(root, 'state', 'opencode.db')
    expect(await occurrences(db, mark)).toBeGreaterThan(0)

    await services.engine.restart()
    expect(await occurrences(db, mark)).toBe(0)
    expect((await services.llm.chat('fake', 'echo', work, '정리 뒤')).text).toBe('echo: 정리 뒤')
  })
})

/** DB 와 -wal·-shm 에서 표식이 나온 횟수 */
async function occurrences(db: string, mark: string): Promise<number> {
  let count = 0
  for (const file of [db, `${db}-wal`, `${db}-shm`]) {
    const bytes = await fs.readFile(file).catch(() => Buffer.alloc(0))
    for (let at = bytes.indexOf(mark); at !== -1; at = bytes.indexOf(mark, at + 1)) count++
  }
  return count
}
