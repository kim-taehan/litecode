import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core'
import { createServer, type ViteDevServer } from 'vite'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import { freePort, isolatedEnv } from './support/opencodeServer.ts'

// 긴 대화 자동 요약(이슈 #5, 근거 _workspace/01o_compaction.md). 진짜 Electron·IPC·ctx.engine 이 띄운 opencode 1.18.18·가짜 LLM.
// 가짜 LLM 은 압축 요청(도구 없음 + <conversation>)에 COMPACT_MS 뒤 요약을 답하고, `[pad:N]` 으로 답을 키우고, `[overflow]` 가 낀 대화엔
// 400 context_length_exceeded 를 준다. 순서: 한도 초과(한도 비움) → 설정 안내·경고 → 한도 32000 으로 요약 → 다시 열기

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const LONG = 180_000

let vite: ViteDevServer
let app: ElectronApplication
let page: Page
let devServerUrl: string
/** 이 테스트가 만든 임시 폴더 — 끝나면 이 경로만 지운다 */
let tmp: string
let alpha: string

async function launch(): Promise<void> {
  app = await electron.launch({
    args: ['.', `--user-data-dir=${path.join(tmp, 'userData')}`, '--use-mock-keychain'],
    cwd: root,
    env: {
      ...(isolatedEnv(tmp) as Record<string, string>),
      LITECODE_TEST_HIDDEN: '1',
      LITECODE_TEST_LANGUAGE: 'ko',
      LITECODE_DEV_SERVER_URL: devServerUrl,
      LITECODE_GATEWAY_URL: `${inject('fakeLlmUrl')}/v1`,
    },
  })
  page = await app.firstWindow()
  await page.locator('.sidebar-toggle:visible').waitFor()
}

beforeAll(async () => {
  execFileSync(path.join(root, 'node_modules/.bin/tsc'), ['-p', 'tsconfig.electron.json'], { cwd: root, stdio: 'inherit' })
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'litecode-compaction-')))
  alpha = path.join(tmp, 'alpha-app')
  await fs.mkdir(alpha)
  const port = await freePort()
  devServerUrl = `http://localhost:${port}`
  vite = await createServer({ configFile: path.join(root, 'vite.config.ts'), server: { port, strictPort: true } })
  await vite.listen()
  await launch()
  await app.evaluate(({ dialog }, picked) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [picked] })) as typeof dialog.showOpenDialog
  }, alpha)
  await page.locator('.open-guide').getByRole('button', { name: '폴더 열기…' }).click()
  await page.locator('.project-switch__name', { hasText: 'alpha-app' }).waitFor({ timeout: 10_000 })
})

afterAll(async () => {
  await app?.close()
  await vite?.close()
  if (tmp) await fs.rm(tmp, { recursive: true, force: true })
})

type Requests = { count: number; compactions: number; lastChat?: { messages: { role: string; text: string }[] } }
const requests = async () => (await (await fetch(`${inject('fakeLlmUrl')}/requests`)).json()) as Requests

const input = () => page.getByPlaceholder('메시지를 입력하세요…')
const replies = () => page.locator('.bubble--assistant')
const runningTurn = () => page.locator('.turn[data-state="running"]')
const dividers = () => page.locator('.turn .compaction-divider')
/** 구분선이 붙은 턴들이 대화의 몇 번째 턴인가 */
const dividerTurns = () =>
  page.locator('.turn').evaluateAll((turns) => turns.flatMap((turn, index) => (turn.querySelector('.compaction-divider') ? [index] : [])))

/** 보내고 새 답이 생길 때까지. 도는 동안 "요약 중" 줄이 보였는지도 준다 */
async function send(text: string): Promise<{ reply: string; sawCompacting: boolean }> {
  const before = await replies().count()
  await input().fill(text)
  await page.keyboard.press('Enter')
  let sawCompacting = false
  const deadline = Date.now() + 60_000
  while ((await replies().count()) === before) {
    if (Date.now() > deadline) throw new Error(`답이 안 왔다: ${text}`)
    if ((await runningTurn().locator('.compaction-running', { hasText: '앞 대화 요약 중' }).count()) > 0) sawCompacting = true
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  return { reply: (await replies().last().textContent()) ?? '', sawCompacting }
}

const dialog = () => page.getByRole('dialog', { name: '설정' })
const field = (label: string) => dialog().getByLabel(label, { exact: true })
async function openGatewayEditor(): Promise<void> {
  await page.getByRole('button', { name: '설정', exact: true }).click()
  await dialog().waitFor({ timeout: 5_000 })
  await dialog().getByRole('button', { name: '모델', exact: true }).click()
  await dialog().locator('.provider-card', { has: page.locator('.provider-card__name', { hasText: 'Internal LiteLLM Gateway' }) }).getByRole('button', { name: '편집' }).click()
}

describe('긴 대화 자동 요약', () => {
  it('한도를 넘은 실패는 "새 대화로" 안내 — 같은 대화에 다시 보내도 같은 안내', async () => {
    await page.getByRole('button', { name: '+ 새 대화' }).click()
    const notice = '대화가 모델 한도를 넘었습니다 — 새 대화로 시작해 주세요'
    expect((await send('[overflow] 첫 질문')).reply).toBe(`⚠️ ${notice}`)
    expect(await page.locator('.turn').last().getAttribute('data-state')).toBe('failed')
    expect((await send('다시 보냄')).reply).toBe(`⚠️ ${notice}`)
  }, LONG)

  it('설정 > 모델: 컨텍스트 길이는 기본값 없이 비어 있고 "비우면 자동 요약이 꺼집니다" 안내, 24000 미만이면 경고', async () => {
    await openGatewayEditor()
    expect(await field('컨텍스트 길이 1').inputValue()).toBe('')
    expect(await dialog().locator('.context-length-hint').first().textContent()).toContain('비우면 자동 요약이 꺼집니다')
    const warning = () => dialog().locator('.context-length-hint--warn')
    expect(await warning().count()).toBe(0)

    await field('컨텍스트 길이 1').fill('8000')
    expect(await warning().textContent()).toBe('qwen3.8-27b: 컨텍스트 길이가 24000 미만이면 자동 요약이 제대로 동작하지 않습니다.')
    await field('컨텍스트 길이 1').fill('32000')
    expect(await warning().count()).toBe(0)

    await dialog().getByRole('button', { name: '적용' }).click()
    await expect.poll(() => field('Base URL').count(), { timeout: 10_000 }).toBe(0)
    await page.keyboard.press('Escape')
  }, LONG)

  it('긴 대화: 턴 안에 "앞 대화 요약 중" → 끝나면 "앞 대화를 요약했습니다" 구분선, 다음 요청은 요약본으로. 통계 % 에 문턱 눈금', async () => {
    await page.getByRole('button', { name: '+ 새 대화' }).click()
    const before = (await requests()).compactions
    let compactedAt = -1
    for (let n = 1; n <= 8 && compactedAt === -1; n++) {
      const { reply, sawCompacting } = await send(`[pad:12000] t${n}`)
      expect(reply.startsWith('echo:')).toBe(true)
      if ((await dividers().count()) > 0) {
        expect(sawCompacting).toBe(true)
        compactedAt = n
      }
    }
    expect(compactedAt, '8턴 안에 요약이 돌아야 한다').toBeGreaterThan(1)
    expect((await requests()).compactions).toBeGreaterThan(before)
    expect((await requests()).lastChat?.messages.find((message) => message.role === 'user')?.text.startsWith('<conversation-checkpoint>')).toBe(true)
    expect(await dividers().count()).toBe(1)
    expect(await dividers().textContent()).toBe('앞 대화를 요약했습니다')
    expect(await page.locator('.compaction-running').count()).toBe(0)
    // 구분선은 요약이 돈 턴(마지막 턴)의 머리 위
    expect(await dividerTurns()).toEqual([(await page.locator('.turn').count()) - 1])

    // 다음 턴은 평소대로 끝난다
    expect((await send('after')).reply.startsWith('echo:')).toBe(true)

    // 통계 줄 컨텍스트 팝업 — 한도 32000 의 문턱 (32000 − 20000) / 32000 = 38%
    const pill = page.locator('.composer-stats .stats-pill').nth(2)
    await pill.hover()
    const popup = page.getByRole('dialog', { name: '컨텍스트 사용' })
    await popup.waitFor({ timeout: 2_000 })
    expect(await popup.locator('.stats-bar__tick').evaluate((el) => (el as HTMLElement).style.left)).toBe('38%')
    const row = await popup.evaluate((el) => [...el.querySelectorAll('dt')].find((dt) => dt.textContent === '자동 요약 기준')?.nextElementSibling?.textContent)
    expect(row).toBe('~12K · 38%')
    await page.locator('.main__header').hover()
  }, LONG)

  it('앱을 다시 켜고 그 대화를 열어도 구분선이 같은 턴에 있다', async () => {
    const live = await dividerTurns() // 요약본 뒤 큰 답으로 'after' 턴에서 한 번 더 돌 수 있다 — 개수가 아니라 자리를 비교한다
    expect(live.length).toBeGreaterThan(0)
    const turns = await page.locator('.turn').count()
    await app.close()
    await launch()
    await page.locator('.session-item', { hasText: '[pad:12000] t1' }).click()
    await expect.poll(() => page.locator('.turn').count(), { timeout: 15_000 }).toBe(turns)
    expect(await dividerTurns()).toEqual(live)
    expect(await dividers().first().textContent()).toBe('앞 대화를 요약했습니다')
  }, LONG)
})
