import { Context } from 'cordis'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core'
import { createServer, type ViteDevServer } from 'vite'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import { ProviderRegistry } from '../../src/services/providers.ts'
import { EngineService } from '../../src/services/engine.ts'
import { engineOptions, freePort, isolatedEnv } from './support/opencodeServer.ts'

// 레거시 전환 전에 쌓인 대화 이어 쓰기 실물 테스트 (이슈 #21, 01w 2절).
// 앱과 같은 opencode DB 에 **신규 세대**(`/api/session/*`)로 두 턴 돈 대화를 테스트가 직접 만들어 두고(전환 전 앱이 남긴 기록과 같다),
// 앱의 sessions.json 에 그 대화를 적은 뒤 앱을 띄운다. 신규 기록과 레거시 기록은 같은 세션 id 여도 서로 안 보이므로(01w) —
// 열면 옛 말풍선이 보이고, 이어 보내면 첫 레거시 턴에 옛 글이 한 번 실리고(가짜 LLM 요청으로 확인), 화면엔 그 주입 글이 없다.
// 재시작 뒤에도 순서·한 번이 그대로인지 본다. opencode 는 준비 때는 ctx.engine(이 프로세스), 앱에서는 앱 자신이 띄운다 — 같은 DB 파일이다.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const PROVIDER = 'gateway-local' // 앱의 첫 실행 기본 provider (electron/main.ts) — 같은 id 라야 옛 대화의 모델로 이어 보낸다
const MODEL = 'qwen3.8-27b'
const OLD = ['my name is ZED-MARKER', 'remember BLUE-MARKER']
const MARK = '<previous-conversation>'

let vite: ViteDevServer
let devServerUrl: string
let app: ElectronApplication
let page: Page
/** 이 파일이 만든 임시 폴더 — 이것만 지운다 */
let tmp: string
let userData: string
let project: string

/** 앱과 같은 userData 배치로 엔진을 띄워 신규 세대로 두 턴 돈 세션을 만든다. 끝나면 엔진을 끈다 (DB 파일은 남는다) */
async function seedPreviousConversation(): Promise<string> {
  const ctx = new Context()
  const fibers = [
    ctx.plugin(ProviderRegistry, {
      defaults: [{ id: PROVIDER, displayName: 'Gateway', baseURL: `${inject('fakeLlmUrl')}/v1`, protocol: 'openai-chat-completions', models: [{ id: MODEL, displayName: 'Qwen' }] }],
    }),
    ctx.plugin(EngineService, engineOptions(userData)),
  ]
  try {
    const ready = await new Promise<Context>((resolve) => ctx.inject(['engine'], (inner) => resolve(inner)))
    const conn = await ready.engine.connection()
    const call = async (method: string, route: string, body?: unknown): Promise<{ data: unknown }> => {
      const res = await fetch(`${conn.url}${route}`, {
        method,
        headers: { ...conn.headers, 'content-type': 'application/json' },
        ...(body !== undefined && { body: JSON.stringify(body) }),
      })
      if (!res.ok) throw new Error(`${method} ${route} → ${res.status}`)
      return res.status === 204 ? { data: undefined } : ((await res.json()) as { data: unknown })
    }
    // 카탈로그는 지연 로드다 — 모델이 나올 때까지 (CLAUDE.md "모델 카탈로그는 지연 로드된다")
    const catalog = `/api/model?${new URLSearchParams({ 'location[directory]': project })}`
    await until(async () => ((await call('GET', catalog)).data as { id: string; providerID: string }[]).some((m) => m.providerID === PROVIDER && m.id === MODEL), 10_000)
    const session = (await call('POST', '/api/session', { model: { providerID: PROVIDER, id: MODEL }, location: { directory: project } })).data as { id: string }
    for (const text of OLD) {
      await call('POST', `/api/session/${session.id}/prompt`, { prompt: { text } })
      // 돌고 있는 세션 표 (sessionID → 상태)
      await until(async () => !(session.id in ((await call('GET', '/api/session/active')).data as Record<string, unknown>)), 20_000)
    }
    const messages = (await call('GET', `/api/session/${session.id}/message?order=asc`)).data as { type: string; content?: { type: string; text?: string }[] }[]
    const replies = messages.filter((m) => m.type === 'assistant').map((m) => (m.content ?? []).map((part) => part.text ?? '').join(''))
    // 전제: 신규 세대로 두 턴이 끝까지 돌았다
    if (JSON.stringify(replies) !== JSON.stringify(OLD.map((text) => `echo: ${text}`))) throw new Error(`seed replies: ${JSON.stringify(replies)}`)
    // 전제: 레거시 기록엔 아무것도 없다 (두 기록은 서로 안 보인다 — 01w)
    const legacy = await fetch(`${conn.url}/session/${session.id}/message?directory=${encodeURIComponent(project)}`, { headers: conn.headers })
    const legacyMessages = (await legacy.json()) as unknown[]
    if (legacyMessages.length !== 0) throw new Error(`seed legacy messages: ${legacyMessages.length}`)
    return session.id
  } finally {
    for (const fiber of fibers.reverse()) await fiber.dispose()
  }
}

/** 조건이 참이 될 때까지 (beforeAll 안이라 expect.poll 을 못 쓴다) */
async function until(check: () => Promise<boolean>, timeout: number): Promise<void> {
  const deadline = Date.now() + timeout
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error('timed out')
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
}

async function launch(): Promise<void> {
  app = await electron.launch({
    args: ['.', `--user-data-dir=${userData}`, '--use-mock-keychain'],
    cwd: root,
    env: { ...isolatedEnv(tmp), LITECODE_TEST_HIDDEN: '1', LITECODE_DEV_SERVER_URL: devServerUrl, LITECODE_GATEWAY_URL: `${inject('fakeLlmUrl')}/v1` },
  })
  page = await app.firstWindow()
  await page.locator('.sidebar-toggle:visible').waitFor()
}

beforeAll(async () => {
  execFileSync(path.join(root, 'node_modules/.bin/tsc'), ['-p', 'tsconfig.electron.json'], { cwd: root, stdio: 'inherit' })
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'litecode-migrate-')))
  userData = path.join(tmp, 'userData')
  project = path.join(tmp, 'old-app')
  await fs.mkdir(project)
  await fs.mkdir(userData)

  const sessionId = await seedPreviousConversation()
  // 전환 전 앱이 남긴 목록 정보 그대로 — 대화 하나, 프로젝트 하나 (sessions.ts·projects.ts 의 파일 모양)
  await fs.writeFile(
    path.join(userData, 'sessions.json'),
    JSON.stringify({
      conversations: [{ id: 'conv-old', project, engineSessionId: sessionId, title: 'old chat', updatedAt: Date.now(), model: { providerId: PROVIDER, modelId: MODEL } }],
      orphans: [],
    }),
  )

  const port = await freePort()
  devServerUrl = `http://localhost:${port}`
  vite = await createServer({ configFile: path.join(root, 'vite.config.ts'), server: { port, strictPort: true } })
  await vite.listen()
  await launch()
  await app.evaluate(({ dialog }, picked) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [picked] })) as typeof dialog.showOpenDialog
  }, project)
  await page.locator('.open-guide').getByRole('button', { name: '폴더 열기…' }).click()
  await page.getByPlaceholder('메시지를 입력하세요…').waitFor({ timeout: 10_000 })
})

afterAll(async () => {
  await app?.close()
  await vite?.close()
  if (tmp) await fs.rm(tmp, { recursive: true, force: true })
})

const userBubbles = () => page.locator('.bubble--user').allTextContents()
const replyBubbles = () => page.locator('.bubble--assistant').allTextContents()
type Requests = { count: number; lastChatText: string }
const requests = async (): Promise<Requests> => (await (await fetch(`${inject('fakeLlmUrl')}/requests`)).json()) as Requests
/** 마지막 LLM 요청에 실린 옛 글 수 */
const marks = async () => (await requests()).lastChatText.split(MARK).length - 1

async function openOld(): Promise<void> {
  await page.locator('.session-item', { hasText: 'old chat' }).locator('.session-item__main').click()
  await expect.poll(userBubbles, { timeout: 15_000 }).toEqual(expect.arrayContaining(OLD))
}

async function send(text: string): Promise<void> {
  const before = (await replyBubbles()).length
  await page.getByPlaceholder('메시지를 입력하세요…').fill(text)
  await page.keyboard.press('Enter')
  await expect.poll(async () => (await replyBubbles()).length, { timeout: 30_000 }).toBe(before + 1)
  await expect.poll(async () => (await replyBubbles()).at(-1), { timeout: 30_000 }).toContain(`echo: ${text}`)
}

describe('옛 대화(신규 세대 기록) 이어 쓰기', () => {
  it('열면 옛 말풍선(내 말·답)이 차례로 보인다', async () => {
    await openOld()
    expect(await userBubbles()).toEqual(OLD)
    expect((await replyBubbles()).map((text) => text.includes('echo: my name is ZED-MARKER') || text.includes('echo: remember BLUE-MARKER'))).toEqual([true, true])
    expect(await page.locator('[data-state="interrupted"]').count()).toBe(0) // 끝난 옛 턴은 "중단됨" 이 아니다
  })

  it('이어 보내면 첫 레거시 턴의 LLM 요청에 옛 글이 실리고, 화면엔 그 주입 글이 없다', async () => {
    await send('what is my name')
    const { lastChatText } = await requests()
    expect(lastChatText).toContain(MARK)
    expect(lastChatText).toContain('user: my name is ZED-MARKER')
    expect(lastChatText).toContain('assistant: echo: remember BLUE-MARKER')
    expect(await marks()).toBe(1)
    expect(await userBubbles()).toEqual([...OLD, 'what is my name'])
    expect(await page.locator('.chat-column').first().textContent()).not.toContain(MARK)
  })

  it('두 번째 턴엔 다시 넣지 않는다 — 앞서 넣은 옛 글 하나만 맥락에 있다', async () => {
    await send('second turn')
    expect(await marks()).toBe(1)
    expect(await userBubbles()).toEqual([...OLD, 'what is my name', 'second turn'])
  })

  it('앱을 다시 켜도 옛·새 말풍선 순서가 그대로이고, 이어 보내도 옛 글은 하나다', async () => {
    await app.close()
    await launch()
    await openOld()
    expect(await userBubbles()).toEqual([...OLD, 'what is my name', 'second turn'])
    expect(await page.locator('body').textContent()).not.toContain(MARK)
    await send('after restart')
    expect(await marks()).toBe(1)
    expect(await userBubbles()).toEqual([...OLD, 'what is my name', 'second turn', 'after restart'])
  })
})
