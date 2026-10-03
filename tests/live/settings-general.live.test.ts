import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core'
import { createServer, type ViteDevServer } from 'vite'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import { freePort, isolatedEnv } from './support/opencodeServer.ts'

// 설정 > 일반 실물 테스트 — 진짜 Electron 창에서 언어·테마·글자 크기·코딩 뷰·설정 파일 열기를 조작하고, 렌더러 → preload(settings:*) →
// ctx.settings(userData/settings.json) → nativeTheme·메인 오류 문구까지 관통하는지 본다. 자기 앱·vite·임시 폴더를 띄운다.
// 다른 실물 테스트와 달리 첫 실행 언어를 고정하지 않는다(LITECODE_TEST_LANGUAGE 를 뺀다) — 제품 기본값(영어·라이트)부터 본다.
// 가짜로 두는 것: 폴더 대화상자, shell.openPath(사용자 편집기를 열지 않게 — 불린 경로만 기록한다).

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

let vite: ViteDevServer
let devServerUrl: string
let app: ElectronApplication
let page: Page
/** 이 테스트가 만든 임시 폴더 — 끝나면 이 경로만 지운다 */
let tmp: string
let userData: string
let project: string

const DARK_BG = 'rgb(21, 21, 23)' // --bg 다크 #151517
const LIGHT_BG = 'rgb(255, 255, 255)'

async function launch(): Promise<void> {
  const { LITECODE_TEST_LANGUAGE: _pinned, ...isolated } = isolatedEnv(tmp)
  app = await electron.launch({
    args: ['.', `--user-data-dir=${userData}`, '--use-mock-keychain'],
    cwd: root,
    env: { ...isolated, LITECODE_TEST_HIDDEN: '1', LITECODE_DEV_SERVER_URL: devServerUrl, LITECODE_GATEWAY_URL: `${inject('fakeLlmUrl')}/v1` },
  })
  page = await app.firstWindow()
  // playwright 는 페이지의 prefers-color-scheme 을 light 로 에뮬레이션한다 — 끄지 않으면 nativeTheme 를 dark 로 바꿔도 CSS 가
  // 라이트로 남는다 (실측 2026-10-02: 에뮬레이션 중 matches=false, 끈 뒤 true·바탕 #151517). 앱이 보는 값을 그대로 보게 끈다
  await page.emulateMedia({ colorScheme: null })
  await page.locator('.sidebar-toggle:visible').waitFor()
  // 폴더 대화상자는 project 를 고른 것으로, openPath 는 기록만 (fail 이 있으면 그 사유를 돌려준다 — 실패 경로)
  await app.evaluate(({ dialog, shell }, picked) => {
    const state = globalThis as { openedPaths?: string[]; openPathFailure?: string }
    state.openedPaths = []
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [picked] })) as typeof dialog.showOpenDialog
    shell.openPath = (async (file: string) => {
      state.openedPaths!.push(file)
      return state.openPathFailure ?? ''
    }) as typeof shell.openPath
  }, project)
}

beforeAll(async () => {
  execFileSync(path.join(root, 'node_modules/.bin/tsc'), ['-p', 'tsconfig.electron.json'], { cwd: root, stdio: 'inherit' })
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'litecode-settings-')))
  userData = path.join(tmp, 'userData')
  project = path.join(tmp, 'settings-app')
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

// 입력창 통계 칸의 팝업도 role=dialog 라 판 클래스로 찾는다
const dialog = () => page.locator('.settings-panel')
const bodyBackground = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor)
const theme = () => app.evaluate(({ nativeTheme }) => ({ source: nativeTheme.themeSource, dark: nativeTheme.shouldUseDarkColors }))
const openedPaths = () => app.evaluate(() => (globalThis as { openedPaths?: string[] }).openedPaths ?? [])

/** 설정을 열고 일반 페이지로 (name: 지금 언어의 "설정"·"일반") */
async function openGeneral(names: { settings: string; general: string }): Promise<void> {
  if (!(await dialog().isVisible())) await page.getByRole('button', { name: names.settings, exact: true }).click()
  await dialog().getByRole('button', { name: names.general, exact: true }).click()
  await dialog().locator('.settings-row').first().waitFor()
}

/** 메인 프로세스가 던지는 provider 검증 문구 — 메인이 지금 언어로 번역해서 던지는지 본다 */
const mainError = () =>
  page.evaluate(() =>
    window.litecode
      .saveProvider({ displayName: ' ', baseURL: 'http://x/v1', protocol: 'openai-chat-completions', models: [{ id: 'm', displayName: 'm' }] })
      .then(
        () => 'saved',
        (error: Error) => error.message,
      ),
  )

describe('설정 > 일반', () => {
  it('첫 실행은 영어·라이트 — 화면·메인 문구가 영어, 창 바탕은 흰색', async () => {
    expect(await page.getByRole('button', { name: 'Settings', exact: true }).textContent()).toBe('Settings')
    expect(await page.evaluate(() => document.documentElement.lang)).toBe('en')
    expect(await bodyBackground()).toBe(LIGHT_BG)
    expect(await theme()).toEqual({ source: 'light', dark: false })
    expect(await mainError()).toContain('Enter a display name')

    // 폴더를 열고 마크다운 답 하나 — 글자 크기 시험에 쓴다
    await page.locator('.open-guide').getByRole('button', { name: 'Open folder…' }).click()
    await page.getByPlaceholder('Type a message…').fill('[md] settings')
    await page.keyboard.press('Enter')
    await page.locator('.bubble--assistant h2').waitFor({ timeout: 30_000 })
    expect(await page.getByRole('tab').allTextContents()).toEqual(['Chat', 'Trajectory'])
  })

  it('일반 페이지는 dsh 틀 — 왼쪽 메뉴(일반·모델·기능·스킬·MCP)·머리줄의 설정 파일 열기와 닫기, 800px 판·28px 모서리', async () => {
    await openGeneral({ settings: 'Settings', general: 'General' })
    expect(await dialog().locator('.settings-nav__item').allTextContents()).toEqual(['General', 'Models', 'Features', 'Skills', 'MCP'])
    expect(await dialog().getByRole('button', { name: 'General', exact: true }).getAttribute('aria-current')).toBe('page')
    expect(await dialog().locator('.settings-row__title').allTextContents()).toEqual(['Default mode for new chats', 'Language', 'Appearance', 'Font size', 'Show coding view', 'Notifications'])
    const panel = page.locator('.settings-panel')
    expect(await panel.evaluate((el) => [getComputedStyle(el).borderRadius, el.getBoundingClientRect().width])).toEqual(['28px', 800])
    expect(await dialog().getByRole('button', { name: 'Open configuration file' }).isVisible()).toBe(true)
    expect(await dialog().getByRole('button', { name: 'Close' }).isVisible()).toBe(true)
  })

  it('언어를 한국어로 바꾸면 사이드바·설정·입력창·메인 오류 문구가 곧바로 바뀌고, 재시작해도 남는다', async () => {
    await openGeneral({ settings: 'Settings', general: 'General' })
    await dialog().getByRole('button', { name: 'English' }).click()
    await dialog().getByRole('menuitemradio', { name: '한국어' }).click()

    await expect.poll(() => dialog().locator('.settings-nav__item').allTextContents(), { timeout: 5_000 }).toEqual(['일반', '모델', '기능', '스킬', 'MCP'])
    expect(await page.getByRole('dialog', { name: '설정' }).count()).toBe(1)
    expect(await dialog().locator('.settings-row__title').allTextContents()).toEqual(['새 대화 기본 모드', '언어', '테마', '글자 크기', '코딩 뷰 보기', '알림'])
    expect(await dialog().getByRole('button', { name: '설정 파일 열기' }).isVisible()).toBe(true)
    expect(await page.locator('.settings-trigger').textContent()).toBe('설정')
    expect(await page.locator('.new-chat').textContent()).toBe('+ 새 대화')
    expect(await page.locator('.sidebar__label').textContent()).toBe('대화 목록')
    expect(await page.getByPlaceholder('메시지를 입력하세요…').count()).toBe(1)
    expect(await page.getByRole('tab').allTextContents()).toEqual(['대화', '추론 과정'])
    expect(await page.evaluate(() => document.documentElement.lang)).toBe('ko')
    expect(await mainError()).toContain('표시 이름을 입력하세요')
    expect(JSON.parse(await fs.readFile(path.join(userData, 'settings.json'), 'utf8')).language).toBe('ko')

    await app.close()
    await launch()
    expect(await page.locator('.settings-trigger').textContent()).toBe('설정')
    expect(await mainError()).toContain('표시 이름을 입력하세요')
  })

  it('다크를 고르면 nativeTheme 가 dark 가 되고 바탕이 다크 토큰이다. 재시작하면 창이 다크 바탕으로 뜬다', async () => {
    await openGeneral({ settings: '설정', general: '일반' })
    await dialog().getByRole('button', { name: '다크' }).click()
    await expect.poll(theme, { timeout: 5_000 }).toEqual({ source: 'dark', dark: true })
    await expect.poll(bodyBackground, { timeout: 5_000 }).toBe(DARK_BG)
    expect(await dialog().getByRole('button', { name: '다크' }).getAttribute('aria-pressed')).toBe('true')
    // 설정 판도 다크 (bg-layer-2 #2c2c2e)
    expect(await page.locator('.settings-panel').evaluate((el) => getComputedStyle(el).backgroundColor)).toBe('rgb(44, 44, 46)')

    await app.close()
    await launch()
    expect(await theme()).toEqual({ source: 'dark', dark: true })
    expect((await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.getBackgroundColor())).toLowerCase()).toBe('#151517')
    expect(await bodyBackground()).toBe(DARK_BG)
  })

  it('시스템을 고르면 nativeTheme 가 system 이고 바탕은 OS 값을 따른다', async () => {
    await openGeneral({ settings: '설정', general: '일반' })
    await dialog().getByRole('button', { name: '시스템' }).click()
    await expect.poll(async () => (await theme()).source, { timeout: 5_000 }).toBe('system')
    const { dark } = await theme()
    await expect.poll(bodyBackground, { timeout: 5_000 }).toBe(dark ? DARK_BG : LIGHT_BG)

    await dialog().getByRole('button', { name: '라이트' }).click()
    await expect.poll(theme, { timeout: 5_000 }).toEqual({ source: 'light', dark: false })
    await expect.poll(bodyBackground, { timeout: 5_000 }).toBe(LIGHT_BG)
  })

  it('글자 크기를 바꾸면 답 글자·제목·표가 따라 커지고, 한계에서 버튼이 막힌다', async () => {
    // 재시작 뒤라 새 대화가 열려 있다 — 설정을 닫고 앞서 답을 받은 대화로 간다
    if (await dialog().isVisible()) await page.keyboard.press('Escape')
    await page.locator('.session-item__main', { hasText: '[md] settings' }).click()
    await page.locator('.bubble--assistant h2').waitFor({ timeout: 30_000 })
    await openGeneral({ settings: '설정', general: '일반' })
    const up = dialog().getByRole('button', { name: '글자 크기 키우기' })
    const down = dialog().getByRole('button', { name: '글자 크기 줄이기' })
    expect(await dialog().locator('.font-size__value').textContent()).toBe('14')
    for (let step = 0; step < 3; step += 1) await up.click()
    await expect.poll(() => dialog().locator('.font-size__value').textContent(), { timeout: 5_000 }).toBe('17')
    expect(await up.isDisabled()).toBe(true)

    const reply = page.locator('.bubble--assistant').last()
    expect(await reply.evaluate((el) => getComputedStyle(el).fontSize)).toBe('17px')
    expect(await reply.locator('h2').evaluate((el) => getComputedStyle(el).fontSize)).toBe('20px') // 17 + (17 − 14)
    expect(await reply.locator('table').evaluate((el) => getComputedStyle(el).fontSize)).toBe('15px') // 14 넘으면 −2
    expect(await reply.locator('.md-code pre').evaluate((el) => getComputedStyle(el).fontSize)).toBe('12.5px') // 코드는 고정
    expect(await page.locator('.composer__input').evaluate((el) => getComputedStyle(el).fontSize)).not.toBe('17px') // 입력창은 안 따라간다

    for (let step = 0; step < 5; step += 1) await down.click()
    await expect.poll(() => dialog().locator('.font-size__value').textContent(), { timeout: 5_000 }).toBe('12')
    expect(await down.isDisabled()).toBe(true)
    expect(await reply.evaluate((el) => getComputedStyle(el).fontSize)).toBe('12px')
    await up.click()
    await up.click()
    await expect.poll(() => reply.evaluate((el) => getComputedStyle(el).fontSize), { timeout: 5_000 }).toBe('14px')
  })

  it('코딩 뷰를 끄면 추론 과정 탭이 사라지고, 켜면 돌아온다', async () => {
    await openGeneral({ settings: '설정', general: '일반' })
    const toggle = dialog().getByRole('switch', { name: '코딩 뷰 보기' })
    expect(await toggle.getAttribute('aria-checked')).toBe('true')
    await toggle.click()
    await expect.poll(() => toggle.getAttribute('aria-checked'), { timeout: 5_000 }).toBe('false')
    expect(await page.getByRole('tab', { name: '추론 과정' }).count()).toBe(0)
    expect(await page.locator('.bubble--assistant').count()).toBeGreaterThan(0) // 대화는 그대로 보인다

    await toggle.click()
    await expect.poll(() => page.getByRole('tab', { name: '추론 과정' }).count(), { timeout: 5_000 }).toBe(1)
  })

  it('설정 파일 열기는 userData/settings.json 을 shell.openPath 로 열고, 못 열면 버튼 옆에 사유를 보인다', async () => {
    await openGeneral({ settings: '설정', general: '일반' })
    await dialog().getByRole('button', { name: '설정 파일 열기' }).click()
    await expect.poll(openedPaths, { timeout: 5_000 }).toEqual([path.join(userData, 'settings.json')])
    expect(JSON.parse(await fs.readFile(path.join(userData, 'settings.json'), 'utf8'))).toMatchObject({ language: 'ko', appearance: 'light', fontSize: 14, codingView: true })

    await app.evaluate(() => {
      ;(globalThis as { openPathFailure?: string }).openPathFailure = 'no application'
    })
    await dialog().getByRole('button', { name: '설정 파일 열기' }).click()
    await expect.poll(() => dialog().getByRole('alert').textContent(), { timeout: 5_000 }).toBe('설정 파일을 열 수 없습니다')
    expect(await openedPaths()).toHaveLength(2)
  })

  it('모델 페이지도 같은 판 안에서 dsh 치수로 보인다', async () => {
    await openGeneral({ settings: '설정', general: '일반' })
    await dialog().getByRole('button', { name: '모델', exact: true }).click()
    const card = dialog().locator('.provider-card').first()
    expect(await card.evaluate((el) => [getComputedStyle(el).borderRadius, getComputedStyle(el).borderTopWidth])).toEqual(['20px', '0.5px'])
    expect(await dialog().locator('.models-page__title').evaluate((el) => [getComputedStyle(el).fontSize, getComputedStyle(el).fontWeight])).toEqual(['16px', '500'])
    expect((await page.locator('.settings-panel').boundingBox())!.width).toBe(800)
  })
})
