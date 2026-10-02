import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core'
import { createServer, type ViteDevServer } from 'vite'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import { freePort, isolatedEnv } from './support/opencodeServer.ts'

// 답하는 중 보내기 = 화면 큐(대화별, 턴 끝에 합쳐 한 번) + 백그라운드 진행 드러내기("진행 중 N"·전환 카드·팝오버 행 숫자) + 설정 > 일반
// "현재 버전". 진짜 Electron 창·IPC·ctx.notifications·opencode·가짜 LLM 을 관통한다. 턴은 가짜 LLM 의 `[slow]`(30초)로 붙잡는다

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const SLOW_TURN = 100_000

let vite: ViteDevServer
let app: ElectronApplication
let page: Page
/** 이 테스트가 만든 임시 폴더 — 끝나면 이 경로만 지운다 */
let tmp: string
let alpha: string
let beta: string

beforeAll(async () => {
  execFileSync(path.join(root, 'node_modules/.bin/tsc'), ['-p', 'tsconfig.electron.json'], { cwd: root, stdio: 'inherit' })
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'litecode-queue-')))
  alpha = path.join(tmp, 'alpha-app')
  beta = path.join(tmp, 'beta-app')
  await fs.mkdir(alpha)
  await fs.mkdir(beta)

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
  await pickFolderNextTime(alpha)
  await page.locator('.open-guide').getByRole('button', { name: '폴더 열기…' }).click()
  await page.locator('.project-switch__name', { hasText: 'alpha-app' }).waitFor({ timeout: 10_000 })
})

afterAll(async () => {
  await app?.close()
  await vite?.close()
  if (tmp) await fs.rm(tmp, { recursive: true, force: true })
})

async function pickFolderNextTime(dir: string): Promise<void> {
  await app.evaluate(({ dialog }, picked) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [picked] })) as typeof dialog.showOpenDialog
  }, dir)
}

const input = () => page.getByPlaceholder('메시지를 입력하세요…')
async function submit(text: string): Promise<void> {
  await input().fill(text)
  await page.keyboard.press('Enter')
}

type Requests = { count: number; lastChat?: { messages: { role: string; text: string }[] } }
const requests = async () => (await (await fetch(`${inject('fakeLlmUrl')}/requests`)).json()) as Requests
const llmCount = async () => (await requests()).count
/** 가짜 LLM 이 마지막으로 받은 요청의 마지막 user 메시지 */
const lastUserText = async () => (await requests()).lastChat?.messages.filter((message) => message.role === 'user').at(-1)?.text

const runningTurn = () => page.locator('.turn[data-state="running"]')
const queued = () => page.locator('.queue-dock__item')
const userBubbles = () => page.locator('.bubble--user')

/** `[slow]` 턴을 시작하고 그 요청이 가짜 LLM 에 닿을 때까지 — 닿은 뒤의 요청 수를 준다 */
async function startSlow(text: string): Promise<number> {
  const before = await llmCount()
  await submit(`[slow] ${text}`)
  await runningTurn().waitFor({ timeout: 10_000 })
  await expect.poll(llmCount, { timeout: 15_000 }).toBe(before + 1)
  return before + 1
}

describe('답하는 중 보내기 = 큐', () => {
  it('턴 중 두 번 보내면 미리보기 2개(말풍선·LLM 요청 없음) → 되돌리기 → 다시 쌓기 → 턴 끝에 줄바꿈으로 합친 요청 1건', async () => {
    const atStart = await startSlow('first')
    const bubbles = await userBubbles().count()

    await submit('q-a')
    await submit('q-b')
    await expect.poll(() => queued().allTextContents(), { timeout: 5_000 }).toEqual(['q-a', 'q-b'])
    expect(await page.locator('.queue-dock__count').textContent()).toBe('대기 중 2개')
    expect(await userBubbles().count()).toBe(bubbles) // 말풍선은 보낼 때 생긴다
    expect(await llmCount()).toBe(atStart) // 엔진에는 아직 안 갔다

    // 되돌리기 — 합친 것이 입력창으로, 미리보기는 사라진다
    await page.getByRole('button', { name: '입력창으로 되돌리기' }).click()
    expect(await queued().count()).toBe(0)
    expect(await input().inputValue()).toBe('q-a\nq-b')

    // 다시 쌓고 하나 더
    await page.keyboard.press('Enter')
    await submit('q-c')
    await expect.poll(() => queued().allTextContents(), { timeout: 5_000 }).toEqual(['q-a q-b', 'q-c'])

    // 턴이 끝나면 한 번에 — 요청 1건, 본문은 줄바꿈으로 이은 것
    await expect.poll(lastUserText, { timeout: 45_000 }).toBe('q-a\nq-b\nq-c')
    expect(await llmCount()).toBe(atStart + 1)
    await expect.poll(() => queued().count(), { timeout: 5_000 }).toBe(0)
    await expect.poll(() => userBubbles().last().textContent(), { timeout: 10_000 }).toBe('q-a\nq-b\nq-c')
    await expect.poll(() => runningTurn().count(), { timeout: 15_000 }).toBe(0)
    await new Promise((resolve) => setTimeout(resolve, 1_500))
    expect(await llmCount()).toBe(atStart + 1) // 두 번 가지 않는다
  }, SLOW_TURN)
})

describe('백그라운드 진행 드러내기', () => {
  it('"진행 중 N" 을 누르면 도는 대화만, 다른 대화·프로젝트로 가도 그 대화 턴 끝에 큐를 보낸다 — 전환 카드·팝오버 행에 숫자', async () => {
    await page.locator('.new-chat').click()
    const atStart = await startSlow('background job')
    await submit('later one')
    await submit('later two')
    await expect.poll(() => queued().count(), { timeout: 5_000 }).toBe(2)

    // 진행 중 1 — 누르면 그 대화만, 다시 누르면 전부
    const filter = page.locator('.running-filter')
    await expect.poll(() => filter.textContent(), { timeout: 10_000 }).toBe('진행 중 1')
    expect(await page.locator('.session-item').count()).toBe(2)
    const shots = process.env.SEND_QUEUE_SHOTS
    if (shots) {
      await fs.mkdir(shots, { recursive: true })
      await page.screenshot({ path: path.join(shots, 'send-queue-background.png') })
    }
    await filter.click()
    expect(await filter.getAttribute('aria-pressed')).toBe('true')
    expect(await page.locator('.session-item').allTextContents()).toEqual([expect.stringContaining('[slow] background job')])
    await filter.click()
    expect(await page.locator('.session-item').count()).toBe(2)

    // 다른 대화로 — 큐는 대화별이라 여기엔 미리보기가 없다
    await page.locator('.session-item', { hasNotText: 'background job' }).locator('.session-item__main').click()
    expect(await queued().count()).toBe(0)

    // 다른 프로젝트로 — 전환 카드에 다른 프로젝트에서 도는 수, 팝오버의 alpha 행에도
    await pickFolderNextTime(beta)
    await page.locator('.project-switch').click()
    await page.locator('.project-popover__open').click()
    await page.locator('.project-switch__name', { hasText: 'beta-app' }).waitFor({ timeout: 10_000 })
    await expect.poll(() => page.locator('.project-switch__running').textContent(), { timeout: 5_000 }).toBe('1')
    expect(await page.locator('.project-switch__running').getAttribute('aria-label')).toBe('다른 프로젝트에서 진행 중 1')
    expect(await page.locator('.running-filter').count()).toBe(0) // beta 에선 도는 것이 없다
    await page.locator('.project-switch').click()
    expect(await page.locator('.project-item', { hasText: 'alpha-app' }).locator('.running-count').textContent()).toBe('1')
    await page.keyboard.press('Escape')

    // 보지 않는 대화의 턴이 끝나면 그 대화의 큐를 한 번에 보낸다
    await expect.poll(lastUserText, { timeout: 45_000 }).toBe('later one\nlater two')
    expect(await llmCount()).toBe(atStart + 1)
    await expect.poll(() => page.locator('.project-switch__running').count(), { timeout: 15_000 }).toBe(0)

    // 돌아가 보면 그 대화에 합친 말풍선과 답
    await page.locator('.project-switch').click()
    await page.locator('.project-item', { hasText: 'alpha-app' }).locator('.project-item__main').click()
    await page.locator('.project-switch__name', { hasText: 'alpha-app' }).waitFor({ timeout: 10_000 })
    await page.locator('.session-item', { hasText: 'background job' }).locator('.session-item__main').click()
    await expect.poll(() => userBubbles().last().textContent(), { timeout: 10_000 }).toBe('later one\nlater two')
    await expect.poll(() => page.locator('.bubble--assistant').last().textContent(), { timeout: 15_000 }).toContain('later two')
    expect(await llmCount()).toBe(atStart + 1)
  }, SLOW_TURN)
})

describe('설정 > 일반', () => {
  it('맨 아래에 "현재 버전: x.y.z" (package.json version)', async () => {
    const { version } = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')) as { version: string }
    await page.locator('.settings-trigger').click()
    await page.getByRole('dialog').getByRole('button', { name: '일반', exact: true }).click()
    const row = page.locator('.general-page > :last-child')
    await expect.poll(() => row.textContent(), { timeout: 5_000 }).toBe(`현재 버전: ${version}`)
    expect(await row.getAttribute('class')).toBe('settings-version')
  })
})
