import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core'
import { createServer, type ViteDevServer } from 'vite'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import { freePort, isolatedEnv } from './support/opencodeServer.ts'

// 답변 중지 (이슈 #3) — 입력창 ■ · 사이드바 행 ■ · Esc 두 번. 진짜 Electron 창·IPC·ctx.llm·opencode·가짜 LLM 을 관통한다.
// 턴은 가짜 LLM 의 `[slow]`(30초 뒤 답)로 붙잡고, 멈추면 opencode 가 LLM 요청을 끊었는지(가짜 LLM 의 cut) 본다 — 30초보다 훨씬 먼저.
// 멈춘 뒤 같은 대화의 다음 질문이 자기 답을 받는지(답 밀림 없음 — 01q), 쌓인 큐가 보내지지 않고 입력창으로 돌아오는지 본다

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
/** 멈춘 뒤 LLM 요청이 끊기기까지의 한도 — `[slow]` 30초보다 한참 짧다 */
const CUT_WITHIN = 10_000

let vite: ViteDevServer
let app: ElectronApplication
let page: Page
/** 이 테스트가 만든 임시 폴더 — 끝나면 이 경로만 지운다 */
let tmp: string

beforeAll(async () => {
  execFileSync(path.join(root, 'node_modules/.bin/tsc'), ['-p', 'tsconfig.electron.json'], { cwd: root, stdio: 'inherit' })
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'litecode-stop-')))
  const project = path.join(tmp, 'stop-app')
  await fs.mkdir(project)

  const port = await freePort()
  vite = await createServer({ configFile: path.join(root, 'vite.config.ts'), server: { port, strictPort: true } })
  await vite.listen()

  app = await electron.launch({
    args: ['.', `--user-data-dir=${path.join(tmp, 'userData')}`, '--use-mock-keychain'],
    cwd: root,
    env: {
      ...(isolatedEnv(tmp) as Record<string, string>),
      LITECODE_TEST_HIDDEN: '1',
      LITECODE_DEV_SERVER_URL: `http://localhost:${port}`,
      LITECODE_GATEWAY_URL: `${inject('fakeLlmUrl')}/v1`,
    },
  })
  page = await app.firstWindow()
  await app.evaluate(({ dialog }, picked) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [picked] })) as typeof dialog.showOpenDialog
  }, project)
  await page.locator('.open-guide').getByRole('button', { name: '폴더 열기…' }).click()
  await page.locator('.project-switch__name', { hasText: 'stop-app' }).waitFor({ timeout: 10_000 })
})

afterAll(async () => {
  await app?.close()
  await vite?.close()
  if (tmp) await fs.rm(tmp, { recursive: true, force: true })
})

type Requests = { count: number; cut: string[]; chatModels: string[]; lastChat?: { messages: { role: string; text: string }[] } }
const requests = async () => (await (await fetch(`${inject('fakeLlmUrl')}/requests`)).json()) as Requests
const llmCount = async () => (await requests()).count
/** 가짜 LLM 이 받은 모든 요청의 마지막 user 글은 못 보므로, 마지막 요청의 것만 */
const lastUserText = async () => (await requests()).lastChat?.messages.filter((message) => message.role === 'user').at(-1)?.text

const input = () => page.locator('.composer__input')
const stopButton = () => page.locator('.composer__stop')
const runningTurn = () => page.locator('.turn[data-state="running"]')
const lastTurn = () => page.locator('.turn').last()
const lastHead = () => lastTurn().locator('.turn__head-label').textContent({ timeout: 1_000 })
const lastAnswer = () => page.locator('.bubble--assistant').last().textContent({ timeout: 1_000 })
const queued = () => page.locator('.queue-dock__item')
const card = () => page.locator('.attention-card[data-kind="permission"]')

async function submit(text: string): Promise<void> {
  await input().fill(text)
  await input().press('Enter')
}

/** `[slow]` 턴을 시작하고 그 요청이 가짜 LLM 에 닿을 때까지 */
async function startSlow(text: string): Promise<void> {
  const before = await llmCount()
  await submit(`[slow] ${text}`)
  await runningTurn().waitFor({ timeout: 10_000 })
  await expect.poll(llmCount, { timeout: 15_000 }).toBe(before + 1)
}

/** 멈춘 턴이 "중단됨" 으로 끝났고, 가짜 LLM 이 그 요청을 답하기 전에 끊겼다 */
async function expectStopped(text: string): Promise<void> {
  await expect.poll(() => runningTurn().count(), { timeout: CUT_WITHIN }).toBe(0)
  expect(await lastTurn().getAttribute('data-state')).toBe('interrupted')
  expect(await lastHead()).toMatch(/^중단됨/)
  await expect.poll(async () => (await requests()).cut, { timeout: CUT_WITHIN }).toContain(`[slow] ${text}`)
}

/** 보내고 그 답이 자기 질문의 echo 인지 (앞 턴의 답이 밀려 붙지 않는다) */
async function expectOwnAnswer(text: string): Promise<void> {
  await submit(text)
  await expect.poll(lastAnswer, { timeout: 30_000 }).toBe(`echo: ${text}`)
}

async function newChat(): Promise<void> {
  await page.locator('.new-chat').click()
  await expect.poll(() => input().inputValue()).toBe('')
}

describe('답변 중지 (이슈 #3)', () => {
  it('[slow] 중 입력창 ■ → "중단됨", LLM 스트림이 끊기고, 다음 질문은 자기 답을 받는다', async () => {
    await startSlow('stop-me')
    // 입력이 비면 보내기 자리가 ■ (dsh) — 글을 쓰면 보내기로 돌아온다
    expect(await stopButton().getAttribute('aria-label')).toBe('답변 중지')
    await input().fill('draft')
    expect(await stopButton().count()).toBe(0)
    await input().fill('')
    await stopButton().click()
    await expectStopped('stop-me')
    expect(await stopButton().count()).toBe(0)
    expect(await page.locator('.composer__send').getAttribute('aria-label')).toBe('보내기')
    await expectOwnAnswer('다음 질문')
  })

  it('Esc 두 번으로 멈춘다 — 한 번은 멈추지 않는다', async () => {
    await newChat()
    await startSlow('escape-me')
    await input().focus()
    await page.keyboard.press('Escape')
    await new Promise((resolve) => setTimeout(resolve, 1_000)) // 간격(500ms)을 넘긴다
    await page.keyboard.press('Escape')
    await new Promise((resolve) => setTimeout(resolve, 1_000))
    expect(await runningTurn().count()).toBe(1)
    await page.keyboard.press('Escape')
    await page.keyboard.press('Escape')
    await expectStopped('escape-me')
    await expectOwnAnswer('Esc 뒤 질문')
  })

  it('승인 대기 중에도 멈춘다 — 카드가 사라지고 다음 질문은 자기 답을 받는다', async () => {
    await newChat()
    await page.locator('.mode-chip').click()
    await page.locator('.mode-menu').getByRole('menuitemradio', { name: '매번 묻기' }).click()
    await submit('[bash:pwd] 승인 대기')
    await card().waitFor({ timeout: 30_000 })
    await stopButton().click()
    await expect.poll(() => card().count(), { timeout: CUT_WITHIN }).toBe(0)
    await expect.poll(() => runningTurn().count(), { timeout: CUT_WITHIN }).toBe(0)
    expect(await lastTurn().getAttribute('data-state')).toBe('interrupted')
    await expectOwnAnswer('승인 대기 뒤 질문')
  })

  it('쌓인 큐는 멈춘 뒤 보내지 않고 입력창으로 되돌린다', async () => {
    await newChat()
    await startSlow('queue-stop')
    await submit('q-1')
    await submit('q-2')
    await expect.poll(() => queued().count(), { timeout: 5_000 }).toBe(2)
    const atStop = await llmCount()
    await stopButton().click()
    await expectStopped('queue-stop')
    await expect.poll(() => input().inputValue(), { timeout: 5_000 }).toBe('q-1\nq-2')
    expect(await queued().count()).toBe(0)
    await new Promise((resolve) => setTimeout(resolve, 2_000))
    expect(await llmCount()).toBe(atStop) // 큐가 보내지지 않았다
    await input().fill('')
  })

  it('사이드바 행 ■ — 보고 있지 않은 대화를 멈추고, 그 대화의 큐는 그 대화를 열 때 입력창으로', async () => {
    await newChat()
    await startSlow('row-stop')
    await submit('later-a')
    await expect.poll(() => queued().count(), { timeout: 5_000 }).toBe(1)
    await newChat() // 다른 대화를 보는 중
    await expect.poll(() => page.locator('.running-filter').textContent(), { timeout: 10_000 }).toBe('진행 중 1')
    const atStop = await llmCount()

    const row = page.locator('.session-item', { hasText: 'row-stop' })
    await row.hover()
    await row.locator('.session-item__stop').click()
    await expect.poll(() => page.locator('.running-filter').count(), { timeout: CUT_WITHIN }).toBe(0)
    await expect.poll(async () => (await requests()).cut, { timeout: CUT_WITHIN }).toContain('[slow] row-stop')
    expect(await input().inputValue()).toBe('') // 보고 있는 대화의 입력창엔 안 넣는다
    await new Promise((resolve) => setTimeout(resolve, 2_000))
    expect(await llmCount()).toBe(atStop) // 큐가 보내지지 않았다
    expect(await lastUserText()).not.toBe('later-a')

    await row.locator('.session-item__main').click()
    await expect.poll(() => input().inputValue(), { timeout: 5_000 }).toBe('later-a')
    expect(await lastTurn().getAttribute('data-state')).toBe('interrupted')
    expect(await queued().count()).toBe(0)
  })
})
