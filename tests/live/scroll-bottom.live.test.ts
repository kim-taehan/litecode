import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core'
import { createServer, type ViteDevServer } from 'vite'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import { freePort, isolatedEnv } from './support/opencodeServer.ts'

// "맨 아래로" 버튼 실물 테스트 (dsh ui-chat ChatView 의 toBottom 참조) — 긴 대화에서 위로 올리면 입력 카드 오른쪽 위에 34px 둥근
// 버튼이 뜨고, 누르면 맨 아래로 가며 사라진다. 맨 아래에선 없다. 라이트·다크 값. 자기 앱·vite·임시 폴더를 띄운다.
// SCROLL_BOTTOM_SHOTS=<폴더> 를 주면 버튼이 보이는 화면을 그 폴더에 남긴다 (평소엔 안 찍는다)

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

let vite: ViteDevServer
let devServerUrl: string
let app: ElectronApplication
let page: Page
/** 이 테스트가 만든 임시 폴더 — 끝나면 이 경로만 지운다 */
let tmp: string
let userData: string
let project: string

beforeAll(async () => {
  execFileSync(path.join(root, 'node_modules/.bin/tsc'), ['-p', 'tsconfig.electron.json'], { cwd: root, stdio: 'inherit' })
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'litecode-scroll-bottom-')))
  userData = path.join(tmp, 'userData')
  project = path.join(tmp, 'scroll-app')
  await fs.mkdir(project, { recursive: true })

  const port = await freePort()
  vite = await createServer({ configFile: path.join(root, 'vite.config.ts'), server: { port, strictPort: true } })
  await vite.listen()
  devServerUrl = `http://localhost:${port}`
  app = await electron.launch({
    args: ['.', `--user-data-dir=${userData}`, '--use-mock-keychain'],
    cwd: root,
    env: { ...isolatedEnv(tmp), LITECODE_TEST_HIDDEN: '1', LITECODE_DEV_SERVER_URL: devServerUrl, LITECODE_GATEWAY_URL: `${inject('fakeLlmUrl')}/v1` },
  })
  page = await app.firstWindow()
  // playwright 의 prefers-color-scheme 에뮬레이션을 끈다 — 끄지 않으면 다크로 바꿔도 CSS 가 라이트로 남는다 (settings-general 실측)
  await page.emulateMedia({ colorScheme: null })
  await page.locator('.sidebar-toggle:visible').waitFor()
  await app.evaluate(({ dialog }, picked) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [picked] })) as typeof dialog.showOpenDialog
  }, project)
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1280, 700))
  await page.locator('.open-guide').getByRole('button', { name: '폴더 열기…' }).click()
  await page.getByPlaceholder('메시지를 입력하세요…').waitFor({ timeout: 10_000 })
  // 긴 대화 — [md] 답은 제목·목록·표·코드 블록이라 길다
  for (let turn = 1; turn <= 3; turn++) {
    await type(`[md] 긴 답 ${turn}`)
    await replies().nth(turn - 1).waitFor({ timeout: 30_000 })
  }
})

afterAll(async () => {
  await app?.close()
  await vite?.close()
  if (tmp) await fs.rm(tmp, { recursive: true, force: true })
})

const replies = () => page.locator('.bubble--assistant')
const button = () => page.getByRole('button', { name: '맨 아래로' })
const scroller = () => page.locator('.main__messages')
/** 맨 아래까지 남은 거리 */
const gap = () => scroller().evaluate((element) => element.scrollHeight - element.scrollTop - element.clientHeight)

async function type(text: string): Promise<void> {
  await page.getByPlaceholder('메시지를 입력하세요…').fill(text)
  await page.keyboard.press('Enter')
}

async function scrollUp(): Promise<void> {
  await scroller().evaluate((element) => element.scrollTo({ top: 0 }))
  await expect.poll(() => button().count(), { timeout: 3_000 }).toBe(1)
}

async function setTheme(appearance: 'light' | 'dark'): Promise<void> {
  await page.evaluate((value) => window.litecode.setSettings({ appearance: value }), appearance)
  const want = appearance === 'dark' ? 'rgb(21, 21, 23)' : 'rgb(255, 255, 255)'
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.body).backgroundColor), { timeout: 5_000 }).toBe(want)
}

const css = (property: string) => button().evaluate((element, name) => getComputedStyle(element).getPropertyValue(name), property)

describe('맨 아래로 버튼', () => {
  it('긴 대화의 맨 아래(보낸 직후)에선 버튼이 없다', async () => {
    expect(await scroller().evaluate((element) => element.scrollHeight > element.clientHeight * 2)).toBe(true)
    await expect.poll(gap, { timeout: 3_000 }).toBeLessThan(2)
    expect(await button().count()).toBe(0)
  })

  it('위로 올리면 뜬다 — 입력 카드 오른쪽 위(열 오른쪽 끝·카드 위 16px), 34×34 원, 14px 아래 화살표', async () => {
    await scrollUp()
    const [box, card, column] = await Promise.all([button().boundingBox(), page.locator('.composer__box').boundingBox(), page.locator('.chat-column').boundingBox()])
    expect(box!.width).toBe(34)
    expect(box!.height).toBe(34)
    expect(Math.abs(box!.x + box!.width - (column!.x + column!.width))).toBeLessThanOrEqual(1) // 오른쪽 끝 = 대화 열 오른쪽 끝
    expect(Math.abs(card!.x + card!.width - (box!.x + box!.width) - 16)).toBeLessThanOrEqual(1) // 카드 오른쪽 끝에서 16 안쪽
    expect(Math.abs(card!.y - (box!.y + box!.height) - 16)).toBeLessThanOrEqual(1) // 카드 위 16
    expect(await css('border-radius')).toBe('100px')
    const icon = await button().locator('svg').boundingBox()
    expect([icon!.width, icon!.height]).toEqual([14, 14])
    // 대화 글 위에 떠서 눌린다 — 버튼 가운데 점의 맨 위 요소가 버튼(안쪽)이다
    expect(await button().evaluate((element) => {
      const rect = element.getBoundingClientRect()
      return element.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2))
    })).toBe(true)
  })

  it('라이트 — 흰 바탕·label-primary 화살표·0.5px border-l3 선 + 패널 그림자, hover 는 floating-hover', async () => {
    await setTheme('light')
    expect(await css('background-color')).toBe('rgb(255, 255, 255)')
    expect(await css('color')).toBe('rgb(15, 17, 21)')
    expect(await css('box-shadow')).toBe('rgba(0, 0, 0, 0.12) 0px 0px 0px 0.5px, rgba(0, 0, 0, 0.03) 0px 3px 8px 0px, rgba(0, 0, 0, 0.02) 0px 0px 16px 0px')
    await button().hover()
    await expect.poll(() => css('background-color')).toBe('rgb(241, 243, 245)')

    const shots = process.env.SCROLL_BOTTOM_SHOTS
    if (shots) {
      await fs.mkdir(shots, { recursive: true })
      await page.mouse.move(0, 0)
      await page.screenshot({ path: path.join(shots, 'scroll-bottom-light.png') })
    }
  })

  it('다크 — bluish-850 바탕·밝은 화살표·흰 0.16 선, hover 는 bluish-800', async () => {
    await page.mouse.move(0, 0)
    await setTheme('dark')
    expect(await css('background-color')).toBe('rgb(44, 44, 46)')
    expect(await css('color')).toBe('rgb(249, 250, 251)')
    expect(await css('box-shadow')).toBe('rgba(255, 255, 255, 0.16) 0px 0px 0px 0.5px, rgba(0, 0, 0, 0.03) 0px 3px 8px 0px, rgba(0, 0, 0, 0.02) 0px 0px 16px 0px')
    await button().hover()
    await expect.poll(() => css('background-color')).toBe('rgb(53, 54, 56)')
    await page.mouse.move(0, 0)
    await setTheme('light')
  })

  it('누르면 맨 아래로 가고 버튼이 사라진다', async () => {
    await button().click()
    expect(await button().count()).toBe(0) // 누르자마자 (부드러운 이동 중에도) 감춘다
    await expect.poll(gap, { timeout: 3_000 }).toBeLessThan(2)
    expect(await button().count()).toBe(0)
  })

  it('누른 뒤엔 다시 따라 내려간다 — 답이 늘어도 맨 아래에 붙어 있다', async () => {
    const before = await replies().count()
    await type('[think] 따라가기')
    await scrollUp()
    await button().click()
    await expect.poll(() => replies().count(), { timeout: 30_000 }).toBe(before + 1)
    await expect.poll(gap, { timeout: 3_000 }).toBeLessThan(2)
    expect(await button().count()).toBe(0)
  })
})
