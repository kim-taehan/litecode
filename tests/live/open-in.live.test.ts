import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core'
import { createServer, type ViteDevServer } from 'vite'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import { freePort, isolatedEnv } from './support/opencodeServer.ts'
import { detectApps, type Launch } from '../../src/services/openIn.ts'

// "다른 앱에서 열기" 실물 테스트 — 진짜 Electron 창의 대화 머리 분할 버튼을 눌러 렌더러 → preload(openIn:*) → ctx.openIn(허용 목록·
// 등록 폴더 검사) → 실행기까지 관통하는지 본다. **실제로 앱을 열지 않는다**(사용자 화면에 창이 뜬다): 숨김 테스트 모드에서 메인의 실행기는
// 기록기다(globalThis.__litecodeOpenInTest) — `open -a` 인자만 확인한다. 탐지·아이콘은 진짜(이 기계의 /Applications).
// 자기 앱·vite·임시 폴더를 띄우고, 끝나면 그 임시 폴더만 지운다.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

let vite: ViteDevServer
let devServerUrl: string
let app: ElectronApplication
let page: Page
/** 이 테스트가 만든 임시 폴더 — 끝나면 이 경로만 지운다 */
let tmp: string
let userData: string
let project: string

const installed = detectApps() // 앱이 보는 것과 같은 기계·같은 허용 목록
const TERMINAL = installed.find((entry) => entry.id === 'terminal')!

async function launch(): Promise<void> {
  app = await electron.launch({
    args: ['.', `--user-data-dir=${userData}`, '--use-mock-keychain'],
    cwd: root,
    env: { ...isolatedEnv(tmp), LITECODE_TEST_HIDDEN: '1', LITECODE_DEV_SERVER_URL: devServerUrl, LITECODE_GATEWAY_URL: `${inject('fakeLlmUrl')}/v1` },
  })
  page = await app.firstWindow()
  await page.emulateMedia({ colorScheme: null }) // 다크 값을 보려고 — 앱의 nativeTheme 를 그대로 따르게 (settings-general 과 같은 이유)
  await page.locator('.sidebar-toggle:visible').waitFor()
  await app.evaluate(({ dialog }, picked) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [picked] })) as typeof dialog.showOpenDialog
  }, project)
}

beforeAll(async () => {
  execFileSync(path.join(root, 'node_modules/.bin/tsc'), ['-p', 'tsconfig.electron.json'], { cwd: root, stdio: 'inherit' })
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'litecode-openin-')))
  userData = path.join(tmp, 'userData')
  project = path.join(tmp, 'openin-app')
  await fs.mkdir(project)

  const port = await freePort()
  vite = await createServer({ configFile: path.join(root, 'vite.config.ts'), server: { port, strictPort: true } })
  await vite.listen()
  devServerUrl = `http://localhost:${port}`
  await launch()
})

afterAll(async () => {
  await app?.close()
  await vite?.close()
  if (tmp) await fs.rm(tmp, { recursive: true, force: true })
})

const launches = () => app.evaluate(() => (globalThis as unknown as { __litecodeOpenInTest: { launches: Launch[] } }).__litecodeOpenInTest.launches)
const setFailure = (fail: string | undefined) =>
  app.evaluate((_electron, value) => {
    ;(globalThis as unknown as { __litecodeOpenInTest: { fail?: string } }).__litecodeOpenInTest.fail = value
  }, fail)
const split = () => page.locator('.main__header .open-in__split')
const primary = () => page.locator('.open-in__primary')
const menu = () => page.getByRole('menu', { name: '다른 앱에서 열기' })
const items = () => menu().getByRole('menuitem')
const style = (selector: string, ...props: string[]) =>
  page.locator(selector).first().evaluate((el, names) => names.map((name) => getComputedStyle(el).getPropertyValue(name)), props)

async function openMenu(): Promise<void> {
  if (!(await menu().isVisible())) await page.getByRole('button', { name: '다른 앱에서 열기' }).click()
  await menu().waitFor()
}

describe('다른 앱에서 열기', () => {
  it('폴더를 열면 대화 머리 오른쪽 끝에 분할 버튼 — 메뉴는 이 기계에 깔린 허용 목록 앱과 같고, 기본은 첫 앱', async () => {
    expect(installed.map((entry) => entry.id)).toContain('finder') // mac 이면 고정 앱은 늘 있다
    await page.locator('.open-guide').getByRole('button', { name: '폴더 열기…' }).click()
    await split().waitFor({ timeout: 10_000 })

    // 머리 오른쪽 — 오른쪽 패널 버튼(#29, 맨 끝·padding 24 안쪽) 바로 왼쪽
    const header = (await page.locator('.main__header').boundingBox())!
    const box = (await split().boundingBox())!
    const panelButton = (await page.locator('.right-panel-open').boundingBox())!
    expect(Math.round(header.x + header.width - 24 - (panelButton.x + panelButton.width))).toBe(0)
    expect(Math.round(panelButton.x - (box.x + box.width))).toBe(8)
    expect(await primary().getAttribute('aria-label')).toBe(`${installed[0].name}에서 열기`)

    await openMenu()
    expect(await items().allTextContents()).toEqual(installed.map((entry, i) => (i === 0 ? `${entry.name} (기본)` : entry.name)))
    // 아이콘은 설치된 앱에서 뽑는다 — Finder 는 고정 경로라 늘 진짜 아이콘(img)
    expect(await items().first().locator('img').getAttribute('src')).toMatch(/^data:image\/png;base64,/)
  })

  it('치수 — 버튼 24·0.5px·반경 8, 메뉴는 버튼 오른쪽 끝 4px 아래·반경 16·padding 4, 항목 30·반경 12·13/20', async () => {
    await openMenu()
    expect(await style('.open-in__split', 'height', 'border-top-width', 'border-top-left-radius')).toEqual(['24px', '0.5px', '8px'])
    expect(await style('.open-in__primary', 'padding')).toEqual(['3px 5px'])
    expect(await style('.open-in__more', 'padding', 'border-left-width')).toEqual(['3px 4px 3px 3px', '0.5px'])
    expect(await style('.open-in__primary .open-in__icon', 'width')).toEqual(['13px'])
    expect(await style('.open-in__menu', 'border-top-left-radius', 'padding', 'min-width', 'max-width')).toEqual(['16px', '4px', '144px', '360px'])
    expect(await style('.open-in__item', 'min-height', 'border-top-left-radius', 'font-size', 'line-height', 'padding', 'gap')).toEqual([
      '30px',
      '12px',
      '13px',
      '20px',
      '4px 8px',
      '6px',
    ])
    expect((await items().first().boundingBox())!.height).toBe(30)
    const button = (await split().boundingBox())!
    const panel = (await menu().boundingBox())!
    expect(Math.round(panel.x + panel.width)).toBe(Math.round(button.x + button.width))
    expect(Math.round(panel.y - (button.y + button.height))).toBe(4)
    // 라이트 값 (토큰)
    expect(await style('.open-in__split', 'border-top-color')).toEqual(['rgba(0, 0, 0, 0.16)'])
    expect(await style('.open-in__menu', 'background-color')).toEqual(['rgba(248, 249, 250, 0.94)'])
    expect(await style('.open-in__more', 'color')).toEqual(['rgb(97, 102, 107)'])

    await fs.mkdir(path.join(root, 'shots'), { recursive: true })
    await page.screenshot({ path: path.join(root, 'shots', 'open-in-menu.png') })
  })

  it('다크 값 — 테두리 rgba(255,255,255,.2)·메뉴 rgba(48,49,54,.94)·⌄ #cfd3d6', async () => {
    await page.evaluate(() => window.litecode.setSettings({ appearance: 'dark' }))
    await expect.poll(() => style('.open-in__menu', 'background-color'), { timeout: 5_000 }).toEqual(['rgba(48, 49, 54, 0.94)'])
    expect(await style('.open-in__split', 'border-top-color')).toEqual(['rgba(255, 255, 255, 0.2)'])
    expect(await style('.open-in__more', 'color')).toEqual(['rgb(207, 211, 214)'])
    await page.evaluate(() => window.litecode.setSettings({ appearance: 'light' }))
    await page.keyboard.press('Escape')
    await expect.poll(() => menu().count(), { timeout: 5_000 }).toBe(0)
  })

  it('왼쪽 버튼 = 기본 앱으로 프로젝트 폴더를 연다 (Finder 는 OS 열기)', async () => {
    await primary().click()
    await expect.poll(launches, { timeout: 5_000 }).toEqual([{ kind: 'os-open', path: project }])
  })

  it('메뉴에서 고른 앱으로 열고(open -a <번들> <폴더>) 그 앱이 기본이 된다 — settings.json 에 남는다', async () => {
    await openMenu()
    await items().filter({ hasText: /^Terminal$/ }).click()
    await expect.poll(async () => (await launches()).at(-1), { timeout: 5_000 }).toEqual({ kind: 'open-a', args: ['-a', TERMINAL.bundle, project] })
    await expect.poll(() => primary().getAttribute('aria-label'), { timeout: 5_000 }).toBe('Terminal에서 열기')
    expect(JSON.parse(await fs.readFile(path.join(userData, 'settings.json'), 'utf8')).openInApp).toBe('terminal')
    expect(await menu().count()).toBe(0) // 고르면 닫힌다

    await primary().click()
    await expect.poll(async () => (await launches()).length, { timeout: 5_000 }).toBe(3)
    expect((await launches()).at(-1)).toEqual({ kind: 'open-a', args: ['-a', TERMINAL.bundle, project] })
  })

  it('메인이 거른다 — 목록 밖 앱 id·등록 안 된 폴더·상대 경로는 거절하고 실행기를 부르지 않는다', async () => {
    const before = (await launches()).length
    const attempt = (appId: string, directory: string) =>
      page.evaluate(([id, dir]) => window.litecode.openIn(id, dir).then(() => 'opened', (error: Error) => error.message), [appId, directory] as const)
    expect(await attempt('calculator', project)).toContain('열 수 없는 앱입니다')
    expect(await attempt('terminal', tmp)).toContain('목록에 있는 프로젝트 폴더만')
    expect(await attempt('terminal', 'openin-app')).toContain('목록에 있는 프로젝트 폴더만')
    expect(await attempt('terminal', '-n')).toContain('목록에 있는 프로젝트 폴더만')
    expect((await launches()).length).toBe(before)
  })

  it('실행이 실패하면 버튼 아래에 사유를 보인다', async () => {
    await setFailure('LSOpenURLsWithRole() failed')
    await primary().click()
    await expect.poll(() => page.locator('.open-in').getByRole('alert').textContent(), { timeout: 5_000 }).toBe(
      'Terminal에서 열지 못했습니다: LSOpenURLsWithRole() failed',
    )
    await setFailure(undefined)
  })

  it('재시작해도 기본 앱이 남는다', async () => {
    await app.close()
    await launch()
    await split().waitFor({ timeout: 10_000 }) // 마지막 프로젝트가 다시 열린다
    expect(await primary().getAttribute('aria-label')).toBe('Terminal에서 열기')
    await openMenu()
    expect(await items().filter({ hasText: '(기본)' }).allTextContents()).toEqual(['Terminal (기본)'])
    await primary().click()
    await expect.poll(launches, { timeout: 5_000 }).toEqual([{ kind: 'open-a', args: ['-a', TERMINAL.bundle, project] }])
  })
})
