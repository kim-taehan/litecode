import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core'
import { createServer, type ViteDevServer } from 'vite'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import { freePort, isolatedEnv } from './support/opencodeServer.ts'
import { THINK_MS } from './support/fakeLlm.ts'

// 채팅 답 모양·진행 표시 실물 테스트 — 진짜 Electron 창에서 보내고, 답을 기다리는 동안 메인이 chat:progress 로 미는 진행 줄
// (세션 SSE + 전역 /api/event 조각 → ctx.llm TurnTracker → IPC → 화면)이 실시간으로 쌓이는지, 끝나면 턴 머리 아래로 접히는지,
// 앱을 다시 켜면 opencode 기록(/message)에서 같은 줄이 다시 그려지는지 본다. 자기 앱·vite·임시 폴더를 띄운다.
// 가짜 LLM 규칙: [think] 는 생각 두 조각을 THINK_MS 간격으로, [bash:<cmd>] 는 bash 도구(설명 "fake")

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

let vite: ViteDevServer
let devServerUrl: string
let app: ElectronApplication
let page: Page
/** 이 테스트가 만든 임시 폴더 — 끝나면 이 경로만 지운다 */
let tmp: string
let userData: string
let project: string

async function launch(): Promise<void> {
  app = await electron.launch({
    args: ['.', `--user-data-dir=${userData}`, '--use-mock-keychain'],
    cwd: root,
    env: { ...isolatedEnv(tmp), LITECODE_TEST_HIDDEN: '1', LITECODE_DEV_SERVER_URL: devServerUrl, LITECODE_GATEWAY_URL: `${inject('fakeLlmUrl')}/v1` },
  })
  page = await app.firstWindow()
  await page.locator('.sidebar-toggle:visible').waitFor()
  // 파일 칩을 누르면 Finder 를 띄우는 대신 기록, 복사는 클립보드 대신 기록
  await app.evaluate(({ dialog, shell }, picked) => {
    const state = globalThis as { revealed?: string[] }
    state.revealed = []
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [picked] })) as typeof dialog.showOpenDialog
    shell.showItemInFolder = (file: string) => void state.revealed!.push(file)
  }, project)
  await page.evaluate(() => {
    const state = window as unknown as { copied: string[] }
    state.copied = []
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (text: string) => void state.copied.push(text) } })
  })
}

beforeAll(async () => {
  execFileSync(path.join(root, 'node_modules/.bin/tsc'), ['-p', 'tsconfig.electron.json'], { cwd: root, stdio: 'inherit' })
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'litecode-chat-layout-')))
  userData = path.join(tmp, 'userData')
  project = path.join(tmp, 'layout-app')
  await fs.mkdir(path.join(project, 'src'), { recursive: true })
  await fs.writeFile(path.join(project, 'src', 'hello.ts'), 'export {}\n')

  const port = await freePort()
  vite = await createServer({ configFile: path.join(root, 'vite.config.ts'), server: { port, strictPort: true } })
  await vite.listen()
  devServerUrl = `http://localhost:${port}`
  await launch()
  await page.locator('.open-guide').getByRole('button', { name: '폴더 열기…' }).click()
  await page.getByPlaceholder('메시지를 입력하세요…').waitFor({ timeout: 10_000 })
})

afterAll(async () => {
  await app?.close()
  await vite?.close()
  if (tmp) await fs.rm(tmp, { recursive: true, force: true })
})

const replies = () => page.locator('.bubble--assistant')
const running = () => page.locator('.turn[data-state="running"]')
const lastTurn = () => page.locator('.turn').last()
const seconds = async () => Number(/(\d+)초/.exec((await page.locator('.turn-running__text').textContent()) ?? '')?.[1] ?? NaN)

async function type(text: string): Promise<void> {
  await page.getByPlaceholder('메시지를 입력하세요…').fill(text)
  await page.keyboard.press('Enter')
}

/** 보낸 뒤 답이 올 때까지 */
async function waitReply(before: number): Promise<void> {
  await expect.poll(() => replies().count(), { timeout: 30_000 }).toBe(before + 1)
}

describe('채팅 답 모양·진행 표시', () => {
  it('[think]: 진행 중에 생각 줄이 조각으로 채워지고(생각이 끝나기 전) 파란 진행 줄이 돈다 → 끝나면 "완료 · N초" 머리 아래로 접힌다', async () => {
    await type('[think] 생각 테스트')
    // 생각 첫 조각은 전역 스트림(reasoning.delta)에만 온다 — 세션 SSE 만이면 생각이 끝날 때(THINK_MS×2 뒤)에야 글이 생긴다
    const think = running().locator('.turn-row[data-kind="think"]')
    await expect.poll(() => think.getAttribute('data-done').catch(() => null), { timeout: 15_000 }).toBe('false')
    await expect.poll(() => think.locator('.turn-row__summary').textContent().catch(() => ''), { timeout: THINK_MS }).toBe('Planning the answer line one')
    expect(await think.getAttribute('data-done')).toBe('false') // 아직 생각 중
    expect(await think.locator('.turn-row__title').textContent()).toBe('생각')
    expect(await page.locator('.turn-running__text').textContent()).toMatch(/^작업 중 · \d+초$/)
    expect(await replies().count()).toBe(0) // 답은 끝난 뒤에야 답 자리에

    await waitReply(0)
    expect(await replies().last().textContent()).toBe('echo: [think] 생각 테스트')
    expect(await running().count()).toBe(0)
    const head = lastTurn().locator('.turn__head')
    expect(await head.textContent()).toMatch(/^완료 · \d+초$/)
    expect(Number(/(\d+)초/.exec((await head.textContent())!)![1])).toBeGreaterThanOrEqual(Math.floor((THINK_MS * 2) / 1000))
    expect(await head.getAttribute('aria-expanded')).toBe('false')
    expect(await lastTurn().locator('.turn-row').count()).toBe(0) // 접혀 있다

    await head.click()
    const done = lastTurn().locator('.turn-row[data-kind="think"]')
    expect(await done.getAttribute('data-done')).toBe('true')
    expect(await done.locator('.turn-row__summary').textContent()).toBe('Planning the answer line one')
    await done.locator('.turn-row__line').click() // 펼치면 생각 전체
    expect(await done.locator('.turn-row__body').textContent()).toContain('Second paragraph of thought.')
  })

  it('[bash:sleep 2]: 진행 중 "Bash · fake" 줄이 실행 중으로 보이고 진행 줄의 초가 올라간다 → 끝나면 접히고 펼치면 완료 표시', async () => {
    const before = await replies().count()
    await type('[bash:sleep 2]')
    const tool = running().locator('.turn-row[data-kind="tool"]')
    await expect.poll(() => tool.getAttribute('data-status').catch(() => null), { timeout: 15_000 }).toBe('running')
    expect(await tool.locator('.turn-row__line').textContent()).toBe('Bashfake')
    expect(await tool.locator('.turn-row__title').textContent()).toBe('Bash')
    const first = await seconds()
    await expect.poll(seconds, { timeout: 3_000 }).toBeGreaterThan(first)

    await waitReply(before)
    expect(await replies().last().textContent()).toMatch(/^tool: /)
    const head = lastTurn().locator('.turn__head')
    expect(await head.getAttribute('aria-expanded')).toBe('false')
    await head.click()
    expect(await lastTurn().locator('.turn-row[data-kind="tool"]').getAttribute('data-status')).toBe('done')
  })

  it('파일 칩: 답의 인라인 코드 중 프로젝트에 있는 파일만 파일 아이콘 + 파란 이름, 누르면 파일 관리자에서 그 파일', async () => {
    const before = await replies().count()
    await type('칩 `src/hello.ts` 와 `src/nope.ts`')
    await waitReply(before)
    const chips = replies().last().locator('.md-file')
    await expect.poll(() => chips.count(), { timeout: 5_000 }).toBe(1)
    expect(await chips.textContent()).toBe('src/hello.ts')
    expect(await replies().last().locator('code').allTextContents()).toEqual(['src/nope.ts']) // 없는 파일은 그냥 코드
    expect(await chips.evaluate((element) => getComputedStyle(element).color)).toBe('rgb(65, 118, 230)') // --accent
    await chips.click()
    await expect.poll(() => app.evaluate(() => (globalThis as { revealed?: string[] }).revealed ?? [])).toEqual([path.join(project, 'src', 'hello.ts')])
  })

  it('내 말 아래 시각(HH:MM)과 복사 — 답은 말풍선이 아니다(바탕·테두리 없음)', async () => {
    const meta = page.locator('.user-turn').last().locator('.user-turn__meta')
    expect(await meta.locator('time').textContent()).toMatch(/^\d{2}:\d{2}$/)
    await meta.getByRole('button', { name: '메시지 복사' }).click()
    expect(await page.evaluate(() => (window as unknown as { copied: string[] }).copied)).toEqual(['칩 `src/hello.ts` 와 `src/nope.ts`'])
    const style = await replies().last().evaluate((element) => {
      const css = getComputedStyle(element)
      return { background: css.backgroundColor, border: css.borderTopWidth }
    })
    expect(style).toEqual({ background: 'rgba(0, 0, 0, 0)', border: '0px' })
  })

  it('코드 블록: 머리 오른쪽 줄바꿈 토글(켠 채로 시작)과 복사 아이콘', async () => {
    const before = await replies().count()
    await type('[md] 코드')
    await waitReply(before)
    const block = replies().last().locator('.md-code')
    expect(await block.getAttribute('data-wrap')).toBe('true')
    await block.getByRole('button', { name: '줄바꿈 끄기' }).click()
    expect(await block.getAttribute('data-wrap')).toBe('false')
    expect(await block.locator('pre').evaluate((element) => getComputedStyle(element).whiteSpace)).toBe('pre')
    await block.getByRole('button', { name: '복사' }).click()
    expect(await page.evaluate(() => (window as unknown as { copied: string[] }).copied.at(-1))).toBe('const answer = 42')
  })

  it('미니맵: 턴마다 가로줄, 누르면 그 턴으로 가고 그 줄이 진해진다', async () => {
    const marks = page.locator('.minimap__mark')
    expect(await marks.count()).toBe(4)
    const scroller = page.locator('.main__messages')
    expect(await scroller.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true)
    await expect.poll(() => marks.last().getAttribute('aria-current')).toBe('true') // 맨 아래에 있다

    await marks.first().click()
    await expect.poll(() => marks.first().getAttribute('aria-current')).toBe('true')
    expect(await scroller.evaluate((element) => element.scrollTop)).toBeLessThan(50)
    expect(await marks.last().getAttribute('aria-current')).toBeNull()
    await marks.last().click()
    await expect.poll(() => marks.last().getAttribute('aria-current')).toBe('true')
  })

  it('상단: 제목 밑 Chat/Trajectory 탭 — 고른 탭은 파란 밑줄', async () => {
    const chat = page.getByRole('tab', { name: 'Chat' })
    expect(await chat.getAttribute('aria-selected')).toBe('true')
    expect(await chat.evaluate((element) => getComputedStyle(element).borderBottomColor)).toBe('rgb(65, 118, 230)')
  })

  it('넓은 창(1600px): 스크롤 칸은 본문 전체 폭, 답·내 말의 열은 dsh 축(clamp(680, 본문×0.64, 920)) — 입력 카드는 열 + 32px 이고 가운데가 같다', async () => {
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1600, 900))
    await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(1600)
    const box = async (selector: string) => (await page.locator(selector).last().boundingBox())!
    const [main, scroller, column, answer, composer] = await Promise.all(['.main', '.main__messages', '.chat-column', '.bubble--assistant', '.composer__box'].map(box))
    expect(Math.abs(scroller.width - main.width)).toBeLessThanOrEqual(2) // 스크롤바가 창 오른쪽 끝
    expect(Math.abs(column.width - Math.min(920, Math.max(680, main.width * 0.64)))).toBeLessThanOrEqual(2)
    expect(column.width).toBeGreaterThan(720) // 예전 고정 폭보다 넓다
    expect(Math.abs(answer.width - column.width)).toBeLessThanOrEqual(2)
    expect(Math.abs(composer.width - (column.width + 32))).toBeLessThanOrEqual(2)
    expect(Math.abs(composer.x + composer.width / 2 - (column.x + column.width / 2))).toBeLessThanOrEqual(2)
    // 카드 안쪽 글 시작(입력칸 왼쪽 + padding)이 열 왼쪽 끝과 한 줄 (dsh: 카드 여백으로 글 끝을 맞춘다)
    const textStart = await page.locator('.composer__input').evaluate((input) => input.getBoundingClientRect().left + parseFloat(getComputedStyle(input).paddingLeft))
    expect(Math.abs(textStart - column.x)).toBeLessThanOrEqual(2)
    const user = await box('.bubble--user')
    expect(Math.abs(user.x + user.width - (column.x + column.width))).toBeLessThanOrEqual(2) // 내 말 오른쪽 끝이 열 끝
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1280, 800))
  })

  it('진행 중 다른 대화로 갔다 돌아와도 진행 줄이 그대로 이어지고 끝난다', async () => {
    const conversation = page.locator('.session-item', { hasText: '[think] 생각 테스트' }).locator('.session-item__main')
    const before = await replies().count()
    await type('[think] 오가기')
    await expect.poll(() => running().locator('.turn-row[data-kind="think"]').count(), { timeout: 15_000 }).toBe(1)
    await page.getByRole('button', { name: '+ 새 대화' }).click()
    expect(await running().count()).toBe(0)
    await conversation.click()
    expect(await running().locator('.turn-row[data-kind="think"]').count()).toBe(1)
    await waitReply(before)
    expect(await replies().last().textContent()).toBe('echo: [think] 오가기')
  })

  it('앱을 다시 켜고 그 대화를 열면 opencode 기록에서 턴 머리·생각·도구 줄을 다시 그린다', async () => {
    await app.close()
    await launch()
    await page.locator('.session-item', { hasText: '[think] 생각 테스트' }).click()
    await expect.poll(() => replies().count(), { timeout: 15_000 }).toBe(5)

    const heads = page.locator('.turn__head')
    expect(await heads.first().textContent()).toMatch(/^완료 · \d+초$/)
    await heads.first().click()
    const think = page.locator('.turn').first().locator('.turn-row[data-kind="think"]')
    expect(await think.locator('.turn-row__summary').textContent()).toBe('Planning the answer line one')
    await heads.nth(1).click()
    const tool = page.locator('.turn').nth(1).locator('.turn-row[data-kind="tool"]')
    expect(await tool.getAttribute('data-status')).toBe('done')
    expect(await tool.locator('.turn-row__line').textContent()).toBe('Bashfake')
    expect(await page.locator('.user-turn time').first().textContent()).toMatch(/^\d{2}:\d{2}$/)
  })

  it('답을 기다리는 중 앱이 꺼졌다 켜지면 그 턴 머리는 "실패" 가 아니라 "중단됨"', async () => {
    await page.getByRole('button', { name: '+ 새 대화' }).click()
    const requests = async () => ((await (await fetch(`${inject('fakeLlmUrl')}/requests`)).json()) as { count: number }).count
    const before = await requests()
    await type('[slow] 끊길 턴')
    // 진행 중 턴은 보내자마자 보인다 — 엔진 세션이 생겨 LLM 까지 간 뒤에 끈다 (그 전에 끄면 다시 열 기록이 없다)
    await expect.poll(requests, { timeout: 20_000 }).toBeGreaterThan(before)
    await app.close()
    await launch()
    await page.locator('.session-item', { hasText: '[slow] 끊길 턴' }).click()
    const head = page.locator('.turn').last().locator('.turn__head')
    await expect.poll(() => head.textContent().catch(() => ''), { timeout: 15_000 }).toMatch(/^중단됨/)
    expect(await page.locator('.turn').last().getAttribute('data-state')).toBe('interrupted')
  })
})
