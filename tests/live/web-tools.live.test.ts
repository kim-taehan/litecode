import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core'
import { createServer, type ViteDevServer } from 'vite'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import type { Mode } from '../../shared/modes.ts'
import { freePort, isolatedEnv } from './support/opencodeServer.ts'

// 웹 도구 켜기/끄기 실물 테스트 (이슈 #14) — 설치본에서 모델이 opencode 내장 webfetch·websearch 를 묻지 않고 썼다. 기본 꺼짐이면
// 모든 모드(계획·기본·매번 묻기·전체 권한)에서 그 도구가 LLM 요청 tools 에 없어야 하고, 설정 > 기능의 스위치를 켜면 엔진이 다시 떠
// (진행 중 턴은 "중단됨") 모드 규칙대로 실린다. 확인은 가짜 LLM 이 받은 요청 본문의 tools 로 한다 — 앱이 생성한 opencode.json 이
// 아니라 opencode 가 실제로 모델에 내민 도구 목록이다.
// 턴은 화면 IPC(sendMessage)로 모드마다 새 엔진 세션을 만들어 보낸다 (대화 id 는 저장 안 된 것 — attach 는 아무것도 안 한다).

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

let vite: ViteDevServer
let devServerUrl: string
let app: ElectronApplication
let page: Page
/** 이 테스트가 만든 임시 폴더 — 끝나면 이 경로만 지운다 */
let tmp: string
let userData: string
let project: string

const MODES: Mode[] = ['plan', 'build', 'ask', 'full']
const WEB = ['webfetch', 'websearch']
/** 켜졌을 때 실리는 웹 도구 — 레거시 경로엔 websearch 가 없다(신규 세대 전용, 01x). 꺼짐 확인은 둘 다 본다 */
const WEB_ON = ['webfetch']

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
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'litecode-webtools-')))
  userData = path.join(tmp, 'userData')
  project = path.join(tmp, 'web-app')
  await fs.mkdir(project, { recursive: true })

  const port = await freePort()
  vite = await createServer({ configFile: path.join(root, 'vite.config.ts'), server: { port, strictPort: true } })
  await vite.listen()
  devServerUrl = `http://localhost:${port}`
  await launch()
  await app.evaluate(({ dialog }, picked) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [picked] })) as typeof dialog.showOpenDialog
  }, project)
  await page.locator('.open-guide').getByRole('button', { name: '폴더 열기…' }).click()
  await input().waitFor({ timeout: 10_000 })
})

afterAll(async () => {
  await app?.close()
  await vite?.close()
  if (tmp) await fs.rm(tmp, { recursive: true, force: true })
})

const input = () => page.getByPlaceholder('메시지를 입력하세요…')
const dialog = () => page.locator('.settings-panel')
const webSwitch = () => dialog().locator('[data-feature="web"]').getByRole('switch')
const lastHead = () => page.locator('.turn').last().locator('.turn__head-label').textContent({ timeout: 1_000 })

type Requests = { count: number; lastChat: { tools: string[]; messages: { text: string }[] } }
const requests = async (): Promise<Requests> => (await (await fetch(`${inject('fakeLlmUrl')}/requests`)).json()) as Requests

/** 그 모드로 새 엔진 세션에 한 턴 — 가짜 LLM 이 받은 요청의 tools 를 돌려준다 */
async function toolsIn(mode: Mode): Promise<string[]> {
  const text = `web tools ${mode} ${Date.now()}`
  const result = await page.evaluate(
    ([dir, prompt, chosen]) => new Promise<{ text: string; error?: string }>((resolve) => {
        // 보내기는 바로 돌아온다(ctx.chat, 이슈 #52) — 답은 그 대화의 턴 끝 이벤트로 온다
        const id = `web-probe-${chosen}-${Date.now()}`
        const off = window.litecode.onTurnEnded((ended) => {
          if (ended.cid !== id) return
          off()
          resolve(ended.message)
        })
        void window.litecode.sendMessage(id, { project: dir, text: prompt, mode: chosen as Mode, model: { providerId: 'gateway-local', modelId: 'qwen3.8-27b' } })
      }),
    [project, text, mode] as const,
  )
  expect(result, mode).toMatchObject({ text: `echo: ${text}` })
  expect(result.error, mode).toBeUndefined()
  const { lastChat } = await requests()
  // 이 턴의 요청이다 — 레거시는 계획 모드 턴의 user 글 뒤에 <system-reminder> 를 붙인다
  expect(lastChat.messages.at(-1)!.text.startsWith(text), mode).toBe(true)
  return lastChat.tools
}

async function openFeatures(): Promise<void> {
  if (!(await dialog().isVisible())) await page.getByRole('button', { name: '설정', exact: true }).click()
  await dialog().getByRole('button', { name: '기능', exact: true }).click()
  await webSwitch().waitFor()
}

async function closeSettings(): Promise<void> {
  await page.keyboard.press('Escape')
  await expect.poll(() => dialog().count(), { timeout: 5_000 }).toBe(0)
}

const storedFeatures = async () => (JSON.parse(await fs.readFile(path.join(userData, 'settings.json'), 'utf8')) as { features?: Record<string, boolean> }).features

describe('웹 도구 켜기/끄기 (이슈 #14)', () => {
  it('기본은 꺼짐 — 4 모드 모두 LLM 요청 tools 에 webfetch·websearch 가 없다 (전체 권한의 "*":allow 도 못 되살린다)', async () => {
    expect(await page.evaluate(() => window.litecode.getFeatures())).not.toContain('web')
    for (const mode of MODES) {
      const tools = await toolsIn(mode)
      expect(tools, mode).toContain('read')
      expect(tools.filter((tool) => WEB.includes(tool)), mode).toEqual([])
    }
  })

  it('설정 > 기능의 "웹 도구" 카드는 꺼진 스위치로 보인다', async () => {
    await openFeatures()
    const card = dialog().locator('[data-feature="web"]')
    expect(await card.locator('.feature-card__title').textContent()).toBe('웹 도구')
    expect(await card.locator('.feature-card__description').textContent()).toContain('웹 검색')
    expect(await webSwitch().getAttribute('aria-checked')).toBe('false')
    await closeSettings()
  })

  it('켜면 엔진이 다시 떠 진행 중 턴은 "중단됨", 켠 값은 settings.json 에 web: true 로 남는다', async () => {
    const before = (await requests()).count
    await input().fill('[slow] 웹 도구 바꾸기 전')
    await page.keyboard.press('Enter')
    await expect.poll(async () => (await requests()).count, { timeout: 20_000 }).toBe(before + 1) // LLM 이 답을 쥐고 있다
    expect(await page.locator('.turn[data-state="running"]').count()).toBe(1)

    await openFeatures()
    await webSwitch().click()
    await expect.poll(() => webSwitch().getAttribute('aria-checked'), { timeout: 5_000 }).toBe('true')
    await closeSettings()
    await expect.poll(lastHead, { timeout: 30_000 }).toMatch(/^중단됨/)
    expect(await storedFeatures()).toEqual({ web: true })
    await expect.poll(() => page.evaluate(() => window.litecode.getFeatures()), { timeout: 5_000 }).toContain('web')
  })

  it('켜짐 — 계획은 없고(deny), 기본·매번 묻기(ask)·전체 권한은 webfetch 가 실린다 (레거시엔 websearch 가 없다)', async () => {
    for (const mode of MODES) {
      const tools = await toolsIn(mode)
      expect(tools.filter((tool) => WEB.includes(tool)), mode).toEqual(mode === 'plan' ? [] : WEB_ON)
    }
  })

  // 기동 때는 이벤트가 아니라 ctx.features 의 지금 값을 읽는다 — 켠 채로 다시 띄워도 켜진 opencode.json 으로 뜬다
  it('켠 채로 앱을 다시 띄워도 켜져 있다', async () => {
    await app.close()
    await launch()
    await input().waitFor({ timeout: 10_000 })
    expect(await toolsIn('build')).toEqual(expect.arrayContaining(WEB_ON))
  })

  it('다시 끄면 기본값이라 settings.json 에서 키가 빠지고, 전체 권한에서도 다시 없다', async () => {
    await openFeatures()
    await webSwitch().click()
    await expect.poll(() => webSwitch().getAttribute('aria-checked'), { timeout: 5_000 }).toBe('false')
    await closeSettings()
    await expect.poll(storedFeatures, { timeout: 5_000 }).toEqual({})
    await expect.poll(() => page.evaluate(() => window.litecode.getFeatures()), { timeout: 5_000 }).not.toContain('web') // 엔진이 재시작을 시작한 뒤
    for (const mode of ['build', 'full'] as Mode[]) {
      const tools = await toolsIn(mode)
      expect(tools.filter((tool) => WEB.includes(tool)), mode).toEqual([])
    }
  })
})
