import { Context } from 'cordis'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import { ProviderRegistry } from '../../src/services/providers.ts'
import { LlmService, MODEL_CATALOG_TIMEOUT_MS } from '../../src/services/llm.ts'
import { startOpencode, type OpencodeServer } from './support/opencodeServer.ts'

// 서비스 계층 실물 테스트 — ctx.llm 이 진짜 opencode 와 세션 생성 → SSE → 프롬프트 → 턴 종료를
// 끝까지 도는지 본다. opencode 이벤트 모양이 바뀌면 여기서 먼저 깨진다.

let services: Context
const fibers: { dispose(): Promise<void> }[] = []
/** 세션 작업 디렉터리의 부모 — realpath 한 값 (macOS 의 /var 는 /private/var 링크) */
let root: string
/** 폴더 자체가 관심사가 아닌 테스트가 쓰는 작업 디렉터리 */
let work: string

beforeAll(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'litecode-llm-')))
  work = path.join(root, 'work')
  await fs.mkdir(work)
  const ctx = new Context()
  fibers.push(ctx.plugin(ProviderRegistry))
  fibers.push(ctx.plugin(LlmService, { opencodeUrl: inject('opencodeUrl') }))
  services = await new Promise<Context>((resolve) => ctx.inject(['providers', 'llm'], (ready) => resolve(ready)))
  // id 는 opencode.json(support/opencodeServer.ts) 의 providerID/모델 id 와 같아야 한다 —
  // ctx.llm 이 그대로 opencode 에 넘긴다.
  services.providers.register({
    id: 'fake',
    displayName: 'Fake',
    baseURL: 'unused',
    protocol: 'openai-chat-completions',
    models: [{ id: 'echo', displayName: 'Echo' }],
  })
})

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
    const res = await fetch(`${inject('opencodeUrl')}/api/session/${id}`)
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
    const listed = await fetch(`${inject('opencodeUrl')}/api/session?directory=${encodeURIComponent(missing)}&limit=10`)
    expect(((await listed.json()) as { data: unknown[] }).data).toHaveLength(0)
  })

  // 카탈로그는 디렉터리별이다(01_probe Q2). 쿼리 이름이 틀리면 opencode 는 200 에 서버 cwd 카탈로그를 준다 —
  // 그 카탈로그에는 이 폴더에만 있는 provider 가 없으므로 "모델 없음" 으로 실패해 헛초록이 안 난다.
  it('그 폴더의 opencode.json 에만 있는 모델로 턴이 돈다 (카탈로그를 세션 폴더 기준으로 본다)', async () => {
    const dir = await folder('folder-provider')
    await fs.writeFile(
      path.join(dir, 'opencode.json'),
      JSON.stringify({
        $schema: 'https://opencode.ai/config.json',
        provider: {
          'folder-only': {
            npm: '@ai-sdk/openai-compatible',
            name: 'Folder only',
            options: { baseURL: `${inject('fakeLlmUrl')}/v1`, apiKey: 'fake' },
            models: { echo: { name: 'Echo' } },
          },
        },
        enabled_providers: ['fake', 'gateway-local', 'folder-only'],
      }),
    )
    const unregister = services.providers.register({
      id: 'folder-only',
      displayName: 'Folder only',
      baseURL: 'unused',
      protocol: 'openai-chat-completions',
      models: [{ id: 'echo', displayName: 'Echo' }],
    })

    try {
      expect(await services.llm.chat('folder-only', 'echo', dir, '폴더 모델')).toMatchObject({ ok: true, text: 'echo: 폴더 모델' })
    } finally {
      unregister()
    }
  }, MODEL_CATALOG_TIMEOUT_MS + 10_000)
})

// 새로 뜬 opencode 의 /api/model 은 빈 목록 → models.dev 원본(설정 provider 없음, 8306개) → 설정 반영 목록 순으로 바뀐다
// (2026-09-30 실측, 5회 기동 모두: 첫 빈 응답 ~330ms 직후의 요청이 가운데 목록을 받고, ~0.7~1.1초에 설정 반영).
// 다른 호출자(TUI·다른 앱)가 먼저 /api/model 을 부르면 우리 첫 조회가 가운데 목록에 떨어진다 — 거기서 "없음" 으로
// 판단하면 있는 모델을 거절한다. 공유 스택은 이미 로드가 끝났으므로 이 테스트 전용 opencode 를 새로 띄운다.
// 이 테스트는 가운데 목록을 **확률적으로만** 거친다 — QA 실측에서 "빈 → 빈 → 설정 반영" 으로 건너뛴 경우가 있었고,
// "비어 있지 않으면 멈춤" 으로 되돌린 코드를 3회 돌리면 빨강 2회였다. 초록 한 번이 회귀 없음의 증명은 아니다.
describe('ctx.llm ↔ 막 뜬 opencode (카탈로그 로드 중)', () => {
  let fresh: OpencodeServer
  let freshServices: Context
  const freshFibers: { dispose(): Promise<void> }[] = []

  beforeAll(async () => {
    fresh = await startOpencode(`${inject('fakeLlmUrl')}/v1`)
    const ctx = new Context()
    freshFibers.push(ctx.plugin(ProviderRegistry))
    freshFibers.push(ctx.plugin(LlmService, { opencodeUrl: fresh.url }))
    freshServices = await new Promise<Context>((resolve) => ctx.inject(['providers', 'llm'], (ready) => resolve(ready)))
    freshServices.providers.register({
      id: 'fake',
      displayName: 'Fake',
      baseURL: 'unused',
      protocol: 'openai-chat-completions',
      models: [{ id: 'echo', displayName: 'Echo' }],
    })
  })

  afterAll(async () => {
    for (const fiber of freshFibers.reverse()) await fiber.dispose()
    await fresh?.stop()
  })

  it('다른 호출자가 카탈로그 로드를 먼저 일으켜도 설정의 모델이 나올 때까지 기다려 턴을 돈다', async () => {
    const first = (await (await fetch(`${fresh.url}/api/model`)).json()) as { data: unknown[] }
    expect(first.data).toHaveLength(0) // 로드를 일으킨 첫 조회 — 이 직후가 가운데 목록 구간이다

    expect(await freshServices.llm.chat('fake', 'echo', work, '로드 중')).toMatchObject({ ok: true, text: 'echo: 로드 중' })
  })
})
