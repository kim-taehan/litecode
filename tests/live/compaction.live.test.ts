import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core'
import { createServer, type ViteDevServer } from 'vite'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import { freePort, isolatedEnv } from './support/opencodeServer.ts'

// 긴 대화 자동 요약(이슈 #5 → 레거시 경로 #20 L2, 근거 _workspace/01o_compaction.md·01w). 진짜 Electron·IPC·ctx.engine 이 띄운 opencode 1.18.18·가짜 LLM.
// 레거시 opencode 는 ① 보고된 토큰이 문턱(한도 − 출력 한도)을 넘은 스텝 뒤 ② 게이트웨이가 한도 초과로 거절했을 때 앞 대화를 요약하고, 합성
// "Continue…" 로 스스로 이어 답한다 — 그 답이 이 턴 답이다. 가짜 LLM 은 요약 요청(도구 없음 + <conversation>)에 COMPACT_MS 뒤 요약을 답하고,
// `[tokens:N]` 으로 보고 토큰을 정하고, `[overflow]` 가 낀 대화엔 400 context_length_exceeded(요약 요청은 빼고), `[huge]` 면 요약 요청까지 400 을 준다.
// 출력 한도(이슈 #27): 앱이 opencode limit.output 에 최대 출력(비우면 컨텍스트의 1/4, 최대 32000)을 넣는다 — 요청 max_tokens 이자 문턱의 몫.
// 순서: 한도 초과 → 요약으로 이어 감(한도 비움) → 요약도 못 하면 "새 대화로" → 설정 안내·경고 → 작은 한도(24000·출력 4000)로 요약 한 번
// → 한도 60000·출력 비움으로 요약 → 다시 열기

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

type Requests = { count: number; compactions: number; lastChat?: { messages: { role: string; text: string }[]; maxTokens?: number } }
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
  it('게이트웨이가 한도 초과로 거절하면 앞 대화를 요약해 이어 답한다 — 턴 안에 "앞 대화 요약 중" → 구분선, 턴은 완료 (한도를 비워도)', async () => {
    await page.getByRole('button', { name: '+ 새 대화' }).click()
    const before = (await requests()).compactions
    const { reply, sawCompacting } = await send('[overflow] 첫 질문')
    expect(sawCompacting).toBe(true)
    expect(reply.startsWith('echo: ')).toBe(true) // opencode 가 스스로 보낸 "Continue…"(이음)에 대한 답 — 요약 글이 아니다
    expect(reply).not.toContain('fake summary')
    expect(await page.locator('.turn').last().getAttribute('data-state')).toBe('done')
    expect(await dividers().count()).toBe(1)
    expect((await requests()).compactions).toBe(before + 1)
    expect((await send('다시 보냄')).reply).toBe('echo: 다시 보냄') // 요약으로 줄었다 — 다음 턴은 평소대로
    expect(await page.locator('.user-turn').count()).toBe(2) // 이음 user(합성 Continue)는 내 말이 아니다
    expect((await requests()).lastChat?.maxTokens).toBe(32_000) // 한도·최대 출력을 다 비우면 limit 이 없다 — opencode 기본 출력 한도
  }, LONG)

  it('요약으로도 못 줄이면 "새 대화로" 안내 — 같은 대화에 다시 보내도 같은 안내', async () => {
    await page.getByRole('button', { name: '+ 새 대화' }).click()
    const notice = '대화가 모델 한도를 넘었습니다 — 새 대화로 시작해 주세요'
    expect((await send('[huge] 첫 질문')).reply).toBe(`⚠️ ${notice}`)
    expect(await page.locator('.turn').last().getAttribute('data-state')).toBe('failed')
    expect((await send('다시 보냄')).reply).toBe(`⚠️ ${notice}`)
    expect(await dividers().count()).toBe(0) // 실패한 요약은 구분선을 남기지 않는다
  }, LONG)

  it('설정 > 모델: 컨텍스트 길이·최대 출력은 비어 있고 안내가 있다. 최대 출력 빈 칸은 "자동 · 한도/4", 문턱(한도 − 출력)이 16000 미만이면 경고', async () => {
    await openGatewayEditor()
    expect(await field('컨텍스트 길이 1').inputValue()).toBe('')
    expect(await field('최대 출력 1').inputValue()).toBe('')
    expect(await field('최대 출력 1').getAttribute('placeholder')).toBe('최대 출력')
    const hints = await dialog().locator('.context-length-hint:not(.context-length-hint--warn)').allTextContents()
    expect(hints[0]).toContain('비우면 미리 요약하지 않고, 모델이 한도 초과로 거절할 때만 요약합니다')
    expect(hints[1]).toContain('비우면 컨텍스트 길이의 1/4(최대 32000)입니다')
    const warning = () => dialog().locator('.context-length-hint--warn')
    expect(await warning().count()).toBe(0)

    await field('컨텍스트 길이 1').fill('20000') // 자동 5000 → 문턱 15000
    expect(await warning().textContent()).toBe('qwen3.8-27b: 컨텍스트 길이 − 최대 출력이 16000 미만이면 자동 요약이 제대로 동작하지 않습니다.')
    await field('컨텍스트 길이 1').fill('24000') // 자동 6000 → 문턱 18000
    expect(await warning().count()).toBe(0)
    expect(await field('최대 출력 1').getAttribute('placeholder')).toBe('자동 · 6000')
    await field('최대 출력 1').fill('9000') // 문턱 15000
    expect(await warning().count()).toBe(1)
    await field('최대 출력 1').fill('24000') // 한도 이상 — 저장 거부
    await dialog().getByRole('button', { name: '적용' }).click()
    expect(await dialog().getByRole('alert').textContent()).toBe('최대 출력은 1 이상의 정수이고 컨텍스트 길이보다 작아야 합니다')
    await field('최대 출력 1').fill('4000') // 문턱 20000
    expect(await warning().count()).toBe(0)

    await dialog().getByRole('button', { name: '적용' }).click()
    await expect.poll(() => field('Base URL').count(), { timeout: 10_000 }).toBe(0)
    await page.keyboard.press('Escape')
  }, LONG)

  it('작은 한도(24000·최대 출력 4000): 요청 max_tokens 4000, 문턱 20000 을 넘은 턴에 요약이 한 번만 돌고 턴은 완료 (3번 상한에 안 닿음). 눈금 83%', async () => {
    await page.getByRole('button', { name: '+ 새 대화' }).click()
    expect((await send('small t1')).sawCompacting).toBe(false)
    expect((await requests()).lastChat?.maxTokens).toBe(4_000)
    const before = (await requests()).compactions
    const { reply, sawCompacting } = await send('[tokens:21000] small t2')
    expect(sawCompacting).toBe(true)
    expect(reply.startsWith('echo: [tokens:21000] small t2')).toBe(true)
    // 이음 답이 왔으면 턴은 끝났다 — 그 뒤 더 돌지 않았는지 잠깐 더 본다 (출력 한도 0 이면 같은 대화가 한 턴에 19번 요약했다)
    await new Promise((resolve) => setTimeout(resolve, 3_000))
    expect((await requests()).compactions).toBe(before + 1)
    expect(await page.locator('.turn').last().getAttribute('data-state')).toBe('done')
    expect(await dividers().count()).toBe(1)
    expect((await requests()).lastChat?.maxTokens).toBe(4_000) // 요약 요청·이음 요청도 같은 출력 한도

    expect((await send('small after')).reply).toBe('echo: small after')
    expect((await requests()).compactions).toBe(before + 1)

    const pill = page.locator('.composer-stats .stats-pill').nth(2)
    await pill.hover()
    const popup = page.getByRole('dialog', { name: '컨텍스트 사용' })
    await popup.waitFor({ timeout: 2_000 })
    expect(await popup.locator('.stats-bar__tick').evaluate((el) => (el as HTMLElement).style.left)).toBe('83%')
    const row = await popup.evaluate((el) => [...el.querySelectorAll('dt')].find((dt) => dt.textContent === '자동 요약 기준')?.nextElementSibling?.textContent)
    expect(row).toBe('~20K · 83%')
    await page.locator('.main__header').hover()

    // 다음 테스트를 위해 한도 60000·최대 출력 비움으로
    await openGatewayEditor()
    await field('컨텍스트 길이 1').fill('60000')
    await field('최대 출력 1').fill('')
    expect(await field('최대 출력 1').getAttribute('placeholder')).toBe('자동 · 15000')
    await dialog().getByRole('button', { name: '적용' }).click()
    await expect.poll(() => field('Base URL').count(), { timeout: 10_000 }).toBe(0)
    await page.keyboard.press('Escape')
  }, LONG)

  it('긴 대화: 문턱을 넘은 턴 안에 "앞 대화 요약 중" → 끝나면 "앞 대화를 요약했습니다" 구분선, 다음 요청은 요약본으로. 통계 % 에 문턱 눈금', async () => {
    await page.getByRole('button', { name: '+ 새 대화' }).click()
    const before = (await requests()).compactions
    expect((await send('long-talk t1')).sawCompacting).toBe(false)
    expect(await dividers().count()).toBe(0)
    expect((await requests()).lastChat?.maxTokens).toBe(15_000) // 최대 출력을 비우면 한도의 1/4
    // 보고 토큰 46000 ≥ 문턱 60000 − 15000 — 그 스텝 뒤에 요약이 돈다
    const { reply, sawCompacting } = await send('[tokens:46000] t2')
    expect(sawCompacting).toBe(true)
    expect(reply.startsWith('echo: [tokens:46000] t2')).toBe(true) // 이 턴의 답 + 요약 뒤 이음 답
    expect((await requests()).compactions).toBe(before + 1)
    // 요약 뒤 요청: 앞 대화 대신 요약 (레거시는 요약 user 를 "What did we do so far?" 로, 요약 답을 assistant 로 싣는다)
    const lastUser = (await requests()).lastChat?.messages.filter((message) => message.role === 'user')
    expect(lastUser?.[0]?.text).toBe('What did we do so far?')
    expect(lastUser?.some((message) => message.text.includes('long-talk t1'))).toBe(false)
    expect(await dividers().count()).toBe(1)
    expect(await dividers().textContent()).toBe('앞 대화를 요약했습니다')
    expect(await page.locator('.compaction-running').count()).toBe(0)
    // 구분선은 요약이 돈 턴(마지막 턴)의 머리 위
    expect(await dividerTurns()).toEqual([(await page.locator('.turn').count()) - 1])

    // 다음 턴은 평소대로 끝난다
    expect((await send('after')).reply.startsWith('echo:')).toBe(true)

    // 통계 줄 컨텍스트 팝업 — 한도 60000 의 문턱 (60000 − 15000) / 60000 = 75%
    const pill = page.locator('.composer-stats .stats-pill').nth(2)
    await pill.hover()
    const popup = page.getByRole('dialog', { name: '컨텍스트 사용' })
    await popup.waitFor({ timeout: 2_000 })
    expect(await popup.locator('.stats-bar__tick').evaluate((el) => (el as HTMLElement).style.left)).toBe('75%')
    const row = await popup.evaluate((el) => [...el.querySelectorAll('dt')].find((dt) => dt.textContent === '자동 요약 기준')?.nextElementSibling?.textContent)
    expect(row).toBe('~45K · 75%')
    await page.locator('.main__header').hover()
  }, LONG)

  it('앱을 다시 켜고 그 대화를 열어도 구분선이 같은 턴에 있다', async () => {
    const live = await dividerTurns()
    expect(live).toEqual([1]) // 둘째 턴

    const turns = await page.locator('.turn').count()
    await app.close()
    await launch()
    await page.locator('.session-item', { hasText: 'long-talk t1' }).click()
    await expect.poll(() => page.locator('.turn').count(), { timeout: 15_000 }).toBe(turns)
    expect(await dividerTurns()).toEqual(live)
    expect(await dividers().first().textContent()).toBe('앞 대화를 요약했습니다')
  }, LONG)
})
