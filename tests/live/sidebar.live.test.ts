import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron, type ElectronApplication, type Locator, type Page } from 'playwright-core'
import { createServer, type ViteDevServer } from 'vite'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import { freePort, isolatedEnv } from './support/opencodeServer.ts'

// 사이드바 디자인 실물 테스트 — dsh 사이드바 값(_workspace/01j_sidebar.md)과 사용자 결정(제목 13px·굵기 400·줄 20·행 32·선택 바탕
// --fill-hover, 2026-10-02)을 진짜 Electron 창의 계산값으로 고정한다. 라이트·다크 둘 다 (다크는 설정 → nativeTheme → prefers-color-scheme).
// 자기 앱·vite·임시 폴더를 띄운다. 가짜로 두는 것: 폴더 대화상자.
// SIDEBAR_SHOTS=<폴더> 를 주면 라이트·다크 사이드바 캡처를 그 폴더에 남긴다 (사용자에게 보이는 용도 — 평소엔 안 찍는다).

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

let vite: ViteDevServer
let app: ElectronApplication
let page: Page
/** 이 테스트가 만든 임시 폴더 — 끝나면 이 경로만 지운다 */
let tmp: string

beforeAll(async () => {
  execFileSync(path.join(root, 'node_modules/.bin/tsc'), ['-p', 'tsconfig.electron.json'], { cwd: root, stdio: 'inherit' })
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'litecode-sidebar-')))
  const project = path.join(tmp, 'sidebar-app')
  await fs.mkdir(project)

  const port = await freePort()
  vite = await createServer({ configFile: path.join(root, 'vite.config.ts'), server: { port, strictPort: true } })
  await vite.listen()
  app = await electron.launch({
    args: ['.', `--user-data-dir=${path.join(tmp, 'userData')}`, '--use-mock-keychain'],
    cwd: root,
    env: { ...isolatedEnv(tmp), LITECODE_TEST_HIDDEN: '1', LITECODE_DEV_SERVER_URL: `http://localhost:${port}`, LITECODE_GATEWAY_URL: `${inject('fakeLlmUrl')}/v1` },
  })
  page = await app.firstWindow()
  // playwright 의 light 에뮬레이션을 끈다 — 앱이 nativeTheme 로 바꾼 테마를 CSS 가 그대로 보게 (settings-general 과 같은 이유)
  await page.emulateMedia({ colorScheme: null })
  await page.locator('.sidebar-toggle:visible').waitFor()
  await app.evaluate(({ dialog }, picked) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [picked] })) as typeof dialog.showOpenDialog
  }, project)
  await page.locator('.open-guide').getByRole('button', { name: '폴더 열기…' }).click()

  // 대화 셋 — 마지막 것이 선택된 채로 남는다
  for (const text of ['첫째 대화', '둘째 대화는 제목이 길어서 목록 폭을 넘어간다', '셋째 대화']) {
    if ((await page.locator('.session-item').count()) > 0) await page.getByRole('button', { name: '+ 새 대화' }).click()
    const before = await page.locator('.bubble--assistant').count()
    await page.getByPlaceholder('메시지를 입력하세요…').fill(text)
    await page.keyboard.press('Enter')
    await page.locator('.bubble--assistant').nth(before).waitFor({ timeout: 30_000 }) // beforeAll 에선 expect.poll 을 못 쓴다
  }
})

afterAll(async () => {
  await app?.close()
  await vite?.close()
  if (tmp) await fs.rm(tmp, { recursive: true, force: true })
})

type Css = Record<string, string>
const css = (locator: Locator, ...props: string[]): Promise<Css> =>
  locator.evaluate((el, names) => {
    const style = getComputedStyle(el)
    return Object.fromEntries(names.map((name) => [name, style.getPropertyValue(name)]))
  }, props)
const height = async (locator: Locator) => (await locator.boundingBox())!.height

const sidebar = () => page.locator('.sidebar')
const row = (title: string) => page.locator('.session-item', { hasText: title })
const activeRow = () => page.locator('.session-item--active')
const idleRow = () => row('첫째 대화')
/** 마우스를 사이드바 밖(본문 머리)으로 — hover 바탕·카드를 지운다 */
const away = () => page.locator('.main__header').hover()

async function setTheme(appearance: 'light' | 'dark'): Promise<void> {
  await page.evaluate((value) => window.litecode.setSettings({ appearance: value }), appearance)
  const want = appearance === 'dark' ? 'rgb(21, 21, 23)' : 'rgb(255, 255, 255)'
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.body).backgroundColor), { timeout: 5_000 }).toBe(want)
}

/** 테마마다 달라지는 사이드바 값 — dsh design-platform 의 라이트·다크 */
const THEMES = {
  light: {
    sidebar: 'rgb(249, 250, 251)', // specific-sidebar-fill (bluish-50)
    border: 'rgba(0, 0, 0, 0.12)', // border-l3
    selected: 'rgba(38, 49, 72, 0.06)', // interactive-bg-hover
    tertiary: 'rgb(129, 133, 140)', // label-tertiary
    title: 'rgb(15, 17, 21)', // label-primary
    elevated: 'rgb(255, 255, 255)', // button-elevated-fill
  },
  dark: {
    sidebar: 'rgb(27, 27, 28)',
    border: 'rgba(255, 255, 255, 0.16)',
    selected: 'rgba(255, 255, 255, 0.08)',
    tertiary: 'rgb(173, 178, 184)',
    title: 'rgb(249, 250, 251)',
    elevated: 'rgb(67, 69, 74)',
  },
} as const

describe('사이드바 — dsh 값', () => {
  it('대화 행은 32px, 제목은 13px·400·줄 20 — 선택 행도 굵어지지 않는다', async () => {
    await away()
    for (const target of [activeRow(), idleRow()]) {
      expect(await height(target)).toBe(32)
      expect(await css(target, 'border-radius')).toEqual({ 'border-radius': '12px' })
      expect(await css(target.locator('.session-item__title'), 'font-size', 'font-weight', 'line-height')).toEqual({
        'font-size': '13px',
        'font-weight': '400',
        'line-height': '20px',
      })
    }
    expect(await activeRow().locator('.session-item__title').textContent()).toBe('셋째 대화')
  })

  it('시각은 10px·줄 16·tertiary, 상태 점 자리(16×20)는 제목 앞에 늘 있다', async () => {
    await away()
    expect(await css(idleRow().locator('.session-item__time'), 'font-size', 'line-height', 'color')).toEqual({
      'font-size': '10px',
      'line-height': '16px',
      color: THEMES.light.tertiary,
    })
    const slot = (await idleRow().locator('.session-item__slot').boundingBox())!
    const title = (await idleRow().locator('.session-item__title').boundingBox())!
    expect([slot.width, slot.height]).toEqual([16, 20])
    expect(slot.x + slot.width).toBeLessThanOrEqual(title.x)
  })

  it('섹션 머리는 36px 줄·14px·400·tertiary, 사이드바 오른쪽 선은 0.5px', async () => {
    const label = page.locator('.sidebar__label')
    expect(await height(label)).toBe(36)
    expect(await css(label, 'font-size', 'font-weight', 'line-height', 'color')).toEqual({
      'font-size': '14px',
      'font-weight': '400',
      'line-height': '20px',
      color: THEMES.light.tertiary,
    })
    expect(await css(sidebar(), 'border-right-width', 'border-right-style')).toEqual({ 'border-right-width': '0.5px', 'border-right-style': 'solid' })
  })

  it('새 대화 버튼 38px·반경 12·14px/500·0.5px 선, 설정 줄 42px·톱니 16', async () => {
    const button = page.locator('.new-chat')
    expect(await height(button)).toBe(38)
    expect(await css(button, 'border-radius', 'font-size', 'font-weight', 'border-top-width')).toEqual({
      'border-radius': '12px',
      'font-size': '14px',
      'font-weight': '500',
      'border-top-width': '0.5px',
    })
    const trigger = page.locator('.settings-trigger')
    expect(await height(trigger)).toBe(42)
    const icon = (await trigger.locator('svg').boundingBox())!
    expect([icon.width, icon.height]).toEqual([16, 16])
  })

  for (const theme of ['light', 'dark'] as const) {
    it(`${theme} — 사이드바 바탕·경계선·선택 바탕(=hover 바탕)·글자색`, async () => {
      await setTheme(theme)
      const want = THEMES[theme]
      await away()
      expect(await css(sidebar(), 'background-color', 'border-right-color')).toEqual({ 'background-color': want.sidebar, 'border-right-color': want.border })
      expect(await css(activeRow(), 'background-color')).toEqual({ 'background-color': want.selected })
      expect(await css(idleRow(), 'background-color')).toEqual({ 'background-color': 'rgba(0, 0, 0, 0)' })
      expect(await css(idleRow().locator('.session-item__title'), 'color')).toEqual({ color: want.title })
      expect(await css(idleRow().locator('.session-item__time'), 'color')).toEqual({ color: want.tertiary })
      expect(await css(page.locator('.sidebar__label'), 'color')).toEqual({ color: want.tertiary })
      expect(await css(page.locator('.new-chat'), 'background-color')).toEqual({ 'background-color': want.elevated })
      await idleRow().hover()
      await expect.poll(() => css(idleRow(), 'background-color')).toEqual({ 'background-color': want.selected })
      // hover 카드는 두 테마 모두 #2c2c2e 판·반경 16
      await expect.poll(() => page.locator('.hover-card').count(), { timeout: 3_000 }).toBe(1)
      expect(await css(page.locator('.hover-card'), 'background-color', 'border-radius')).toEqual({ 'background-color': 'rgb(44, 44, 46)', 'border-radius': '16px' })
      await away()

      const shots = process.env.SIDEBAR_SHOTS
      if (shots) {
        await fs.mkdir(shots, { recursive: true })
        await sidebar().screenshot({ path: path.join(shots, `sidebar-${theme}.png`) })
      }
    })
  }

  it('hover 카드는 800ms 머문 뒤에 뜬다 — 500ms 에는 아직 없다', async () => {
    await setTheme('light')
    await away()
    await expect.poll(() => page.locator('.hover-card').count()).toBe(0)
    const started = Date.now()
    await idleRow().locator('.session-item__main').hover()
    await page.waitForTimeout(500)
    expect(await page.locator('.hover-card').count()).toBe(0)
    await expect.poll(() => page.locator('.hover-card').count(), { timeout: 3_000, interval: 25 }).toBe(1)
    expect(Date.now() - started).toBeGreaterThanOrEqual(800)
    expect(await css(page.locator('.hover-card__name'), 'font-size', 'font-weight', 'line-height')).toEqual({
      'font-size': '14px',
      'font-weight': '400',
      'line-height': '20px',
    })
    await away()
  })

  it('프로젝트 팝오버는 dsh 메뉴 재질 — 반경 16·검색칸 포커스 외곽선 없음', async () => {
    await page.locator('.project-switch').click()
    const popover = page.locator('.project-popover')
    await popover.waitFor()
    expect(await css(popover, 'border-radius', 'padding-top')).toEqual({ 'border-radius': '16px', 'padding-top': '4px' })
    const search = popover.locator('.project-popover__search')
    await search.focus()
    expect(await css(search, 'outline-style', 'border-radius')).toEqual({ 'outline-style': 'none', 'border-radius': '12px' })
    expect(await height(search)).toBe(30)
    await page.keyboard.press('Escape')
    await popover.waitFor({ state: 'detached' })
  })
})
