import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron, type ElectronApplication, type Locator, type Page } from 'playwright-core'
import { createServer, type ViteDevServer } from 'vite'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import { freePort, isolatedEnv } from './support/opencodeServer.ts'

// 제목 표시줄 없는 창 실물 테스트 (이슈 #25) — 진짜 Electron 창에서 제목 표시줄이 없고(내용이 창 맨 위까지), 창 버튼 자리(macOS
// trafficLightPosition)와 사이드바·대화 머리 요소가 겹치지 않고, 맨 위 줄들의 계산된 -webkit-app-region 이 drag·그 안 버튼이 no-drag
// 인지 본다. 전체 화면은 창을 실제로 키우지 않고(숨긴 창) 메인의 isFullScreen 을 바꿔 이벤트를 내 본다. 끌기 자체(창이 움직이나)는
// OS 입력이라 여기서 못 본다. 자기 앱·vite·임시 폴더를 띄운다. 가짜로 두는 것: 폴더 대화상자.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const mac = process.platform === 'darwin'

let vite: ViteDevServer
let app: ElectronApplication
let page: Page
/** 이 테스트가 만든 임시 폴더 — 끝나면 이 경로만 지운다 */
let tmp: string

beforeAll(async () => {
  execFileSync(path.join(root, 'node_modules/.bin/tsc'), ['-p', 'tsconfig.electron.json'], { cwd: root, stdio: 'inherit' })
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'litecode-titlebar-')))
  const project = path.join(tmp, 'titlebar-app')
  await fs.mkdir(project)
  await fs.writeFile(path.join(project, 'hello.ts'), 'export {}\n')

  const port = await freePort()
  vite = await createServer({ configFile: path.join(root, 'vite.config.ts'), server: { port, strictPort: true } })
  await vite.listen()
  app = await electron.launch({
    args: ['.', `--user-data-dir=${path.join(tmp, 'userData')}`, '--use-mock-keychain'],
    cwd: root,
    env: { ...isolatedEnv(tmp), LITECODE_TEST_HIDDEN: '1', LITECODE_DEV_SERVER_URL: `http://localhost:${port}`, LITECODE_GATEWAY_URL: `${inject('fakeLlmUrl')}/v1` },
  })
  page = await app.firstWindow()
  await page.locator('.sidebar-toggle:visible').waitFor()
  await app.evaluate(({ dialog }, picked) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [picked] })) as typeof dialog.showOpenDialog
  }, project)
  await page.locator('.open-guide').getByRole('button', { name: '폴더 열기…' }).click()
  // 가짜 LLM 은 "echo: <보낸 글>" — 인라인 코드가 파일 칩이 되어 미리보기 패널을 열 수 있다
  await page.getByPlaceholder('메시지를 입력하세요…').fill('파일 `hello.ts`')
  await page.keyboard.press('Enter')
  await page.locator('.bubble--assistant .md-file').first().waitFor({ timeout: 30_000 })
})

afterAll(async () => {
  await app?.close()
  await vite?.close()
  if (tmp) await fs.rm(tmp, { recursive: true, force: true })
})

type Box = { x: number; y: number; width: number; height: number }
const region = (locator: Locator) => locator.evaluate((el) => getComputedStyle(el).getPropertyValue('-webkit-app-region'))
const overlaps = (a: Box, b: Box) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
const box = async (locator: Locator) => (await locator.boundingBox())!

/** 창 버튼 자리 — 메인이 준 위치에서 세 버튼(14px, 20px 간격 ≈ 54px)보다 넉넉히 60 × 14 */
async function trafficLights(): Promise<Box> {
  const at = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getWindowButtonPosition())
  return { x: at!.x, y: at!.y, width: 60, height: 14 }
}

/** 메인의 전체 화면 여부를 바꿔 그 이벤트를 낸다 — 창을 실제로 키우지 않는다 (숨긴 테스트 창) */
async function fakeFullScreen(on: boolean): Promise<void> {
  await app.evaluate(({ BrowserWindow }, value) => {
    const win = BrowserWindow.getAllWindows()[0]
    win.isFullScreen = () => value
    win.emit(value ? 'enter-full-screen' : 'leave-full-screen')
  }, on)
  await expect.poll(() => page.evaluate(() => document.documentElement.hasAttribute('data-fullscreen'))).toBe(on)
}

const logoRow = () => page.locator('.sidebar__logo')
const header = () => page.locator('.main__header')
const hideButton = () => page.getByRole('button', { name: '사이드바 숨기기' })
const showButton = () => page.getByRole('button', { name: '사이드바 보이기' })

describe('제목 표시줄 없는 창', () => {
  it('제목 표시줄이 없다 — 내용이 창 맨 위부터, macOS 는 hiddenInset 창 버튼 {16, 18}', async () => {
    const win = await app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0]
      return { bounds: w.getBounds(), content: w.getContentBounds() }
    })
    expect(win.content.y).toBe(win.bounds.y)
    expect(win.content.height).toBe(win.bounds.height)
    expect(await page.evaluate(() => document.documentElement.dataset.platform)).toBe(process.platform)
    if (mac) expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getWindowButtonPosition())).toEqual({ x: 16, y: 18 })
  })

  it('사이드바 맨 위 줄·대화 머리는 끌기 영역, 그 안의 버튼은 누를 수 있다(no-drag)', async () => {
    expect(await region(logoRow())).toBe('drag')
    expect(await region(header())).toBe('drag')
    expect(await region(hideButton())).toBe('no-drag')
    const headerButtons = header().locator('button')
    expect(await headerButtons.count()).toBeGreaterThan(0) // 다른 앱에서 열기
    for (const button of await headerButtons.all()) expect(await region(button)).toBe('no-drag')
    // 끌기 줄 밖은 끌기가 아니다 — 대화·입력은 그대로
    expect(await region(page.locator('.main__messages'))).not.toBe('drag')
    expect(await region(page.getByPlaceholder('메시지를 입력하세요…'))).toBe('no-drag')
    // 실제로 누를 수 있다 — 숨기기·보이기
    await hideButton().click()
    await showButton().click()
    await logoRow().waitFor()
  })

  it.runIf(mac)('창 버튼이 사이드바 맨 위 줄 안 왼쪽에 세로 가운데로 있고, 로고·숨기기 버튼은 그 오른쪽으로 비켜 겹치지 않는다', async () => {
    const lights = await trafficLights()
    const row = await box(logoRow())
    expect(row.y).toBe(0)
    expect(lights.y).toBeGreaterThanOrEqual(row.y)
    expect(lights.y + lights.height).toBeLessThanOrEqual(row.y + row.height)
    const toggle = await box(hideButton())
    // 창 버튼 가운데(18 + 7)와 숨기기 버튼 가운데가 같은 높이
    expect(Math.abs(toggle.y + toggle.height / 2 - (lights.y + lights.height / 2))).toBeLessThanOrEqual(1)
    // 같은 줄의 로고·이름·숨기기 버튼은 창 버튼 오른쪽에
    for (const part of [logoRow().locator('.sidebar__mark'), logoRow().locator('.sidebar__brand'), hideButton()]) {
      const partBox = await box(part)
      expect(overlaps(lights, partBox), await part.evaluate((el) => el.className.toString())).toBe(false)
      expect(partBox.x).toBeGreaterThanOrEqual(lights.x + lights.width)
    }
    // 그 아래 프로젝트 전환은 줄 밖 — 창 버튼과 겹치지 않는다
    const switcher = await box(page.locator('.project-switch'))
    expect(overlaps(lights, switcher)).toBe(false)
    expect(switcher.y).toBeGreaterThanOrEqual(row.y + row.height)
  })

  it.runIf(mac)('사이드바를 숨기면 다시 열기 버튼이 창 버튼 오른쪽 같은 줄에, 대화 머리 글은 그 뒤에서 — 전체 화면이면 여백을 거둔다', async () => {
    await hideButton().click()
    try {
      const lights = await trafficLights()
      const show = await box(showButton())
      expect(overlaps(lights, show)).toBe(false)
      expect(show.x).toBeGreaterThanOrEqual(lights.x + lights.width)
      expect(Math.abs(show.y + show.height / 2 - (lights.y + lights.height / 2))).toBeLessThanOrEqual(1)
      expect(await region(showButton())).toBe('no-drag')
      const padding = async () => parseFloat(await header().evaluate((el) => getComputedStyle(el).paddingLeft))
      expect(await padding()).toBeGreaterThanOrEqual(show.x + show.width)

      // 전체 화면 — 창 버튼이 없으니 버튼은 왼쪽 끝으로, 머리 여백도 원래대로
      await fakeFullScreen(true)
      const full = await box(showButton())
      expect(full.x).toBeLessThan(lights.x + lights.width)
      expect(await padding()).toBe(52)
      await fakeFullScreen(false)
      expect((await box(showButton())).x).toBe(show.x)
    } finally {
      await showButton().click()
    }
  })

  it.runIf(mac)('전체 화면이면 사이드바 맨 위 줄도 창 버튼 자리를 비우지 않는다', async () => {
    const before = await box(logoRow().locator('.sidebar__mark'))
    await fakeFullScreen(true)
    try {
      const after = await box(logoRow().locator('.sidebar__mark'))
      expect(after.x).toBeLessThan(before.x)
      expect(after.x).toBeLessThan(40)
    } finally {
      await fakeFullScreen(false)
    }
    expect((await box(logoRow().locator('.sidebar__mark'))).x).toBe(before.x)
  })

  it('파일 미리보기 패널 머리도 끌기 영역, 그 안 버튼은 no-drag', async () => {
    await page.locator('.bubble--assistant .md-file', { hasText: 'hello.ts' }).first().click()
    const head = page.locator('.file-preview__head')
    await head.waitFor()
    expect(await region(head)).toBe('drag')
    const buttons = head.locator('button')
    expect(await buttons.count()).toBeGreaterThan(0)
    for (const button of await buttons.all()) expect(await region(button)).toBe('no-drag')
    expect(await region(page.locator('.file-preview__resize'))).toBe('no-drag')
  })

  it('설정 모달의 가림막은 끌기 줄 위에서도 누를 수 있다(no-drag)', async () => {
    await page.locator('.sidebar__foot').getByRole('button', { name: '설정' }).click()
    const overlay = page.locator('.settings-overlay')
    await overlay.waitFor()
    expect(await region(overlay)).toBe('no-drag')
    expect(await region(page.getByRole('dialog'))).toBe('no-drag')
    await page.keyboard.press('Escape')
    await overlay.waitFor({ state: 'detached' })
  })
})
