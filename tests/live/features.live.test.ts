import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core'
import { createServer, type ViteDevServer } from 'vite'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import { freePort, isolatedEnv } from './support/opencodeServer.ts'

// 기능 켜기/끄기 실물 테스트 (이슈 #8) — 진짜 Electron 창의 설정 > 기능 스위치로 기능을 끄고 켠다. 렌더러 → preload(settings:set) →
// ctx.settings → ctx.features 가 묶음을 재시작 없이 내리고(서비스·IPC 핸들러가 걷힌다) → features:changed → 화면이 그 기능의 버튼·탭·
// 팝업·단축키를 그리지 않는지, 나머지는 정상인지(대화 한 턴), 다시 켜면 돌아오는지, 재시작 뒤에도 남는지 본다.
// 자기 앱·userData·프로젝트를 띄운다. 가짜로 두는 것: 폴더 대화상자, LLM, OS 알림(기록 host — __litecodeNotifyTest), 다른 앱 실행(기록).

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

let vite: ViteDevServer
let devServerUrl: string
let app: ElectronApplication
let page: Page
/** 이 테스트가 만든 임시 폴더 — 끝나면 이 경로만 지운다 */
let tmp: string
let userData: string
let project: string

const ALL = ['at', 'slash', 'bang', 'shell', 'terminal', 'trajectory', 'notifications', 'openIn']

async function launch(): Promise<void> {
  app = await electron.launch({
    args: ['.', `--user-data-dir=${userData}`, '--use-mock-keychain'],
    cwd: root,
    env: { ...isolatedEnv(tmp), LITECODE_TEST_HIDDEN: '1', LITECODE_DEV_SERVER_URL: devServerUrl, LITECODE_GATEWAY_URL: `${inject('fakeLlmUrl')}/v1` },
  })
  page = await app.firstWindow()
  await page.locator('.sidebar-toggle:visible').waitFor()
  await app.evaluate(({ dialog }, picked) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [picked] })) as typeof dialog.showOpenDialog
  }, project)
}

beforeAll(async () => {
  execFileSync(path.join(root, 'node_modules/.bin/tsc'), ['-p', 'tsconfig.electron.json'], { cwd: root, stdio: 'inherit' })
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'litecode-features-')))
  userData = path.join(tmp, 'userData')
  project = path.join(tmp, 'feat-app')
  await fs.mkdir(path.join(project, 'src'), { recursive: true })
  await fs.mkdir(path.join(project, '.opencode', 'command'), { recursive: true })
  await fs.writeFile(path.join(project, 'src', 'alpha.ts'), 'export const alpha = 1\n')
  // 명령 파일은 앱을 띄우기 전에 — opencode 는 명령 목록을 폴더별로 캐시한다 (01d)
  await fs.writeFile(path.join(project, '.opencode', 'command', 'hi.md'), '---\ndescription: say hi\n---\nSay $ARGUMENTS\n')

  const port = await freePort()
  vite = await createServer({ configFile: path.join(root, 'vite.config.ts'), server: { port, strictPort: true } })
  await vite.listen()
  devServerUrl = `http://localhost:${port}`
  await launch()
  await page.locator('.open-guide').getByRole('button', { name: '폴더 열기…' }).click()
  await input().waitFor({ timeout: 10_000 })
})

afterAll(async () => {
  await app?.close()
  await vite?.close()
  if (tmp) await fs.rm(tmp, { recursive: true, force: true })
})

const input = () => page.getByPlaceholder('메시지를 입력하세요…')
const menu = () => page.getByRole('listbox', { name: '입력 후보' })
const replies = () => page.locator('.bubble--assistant')
const tabs = () => page.getByRole('tab')
const openIn = () => page.locator('.main__header .open-in__split')
const drawer = () => page.locator('.shell-drawer')
const cards = () => page.locator('.shell-card')
const dialog = () => page.locator('.settings-panel')
const enabled = () => page.evaluate(() => window.litecode.getFeatures())

type NotifyGlobal = { __litecodeNotifyTest: { record: { shown: unknown[]; badge: number[] } } }
const shownCount = () => app.evaluate(() => (globalThis as unknown as NotifyGlobal).__litecodeNotifyTest.record.shown.length)
const lastBadge = () => app.evaluate(() => (globalThis as unknown as NotifyGlobal).__litecodeNotifyTest.record.badge.at(-1))

/** 그 IPC 채널을 불러 본다 — 핸들러가 없으면 Electron 의 "No handler registered" */
async function call(name: 'loadTrajectory' | 'openInApps' | 'openTerminal' | 'getNotifications' | 'stopShell' | 'queryTrigger'): Promise<string> {
  return page.evaluate(async ([method, dir]) => {
    const bridge = window.litecode as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>
    const args: Record<string, unknown[]> = {
      loadTrajectory: [dir, 'ses_none'],
      openInApps: [],
      openTerminal: [dir],
      getNotifications: [],
      stopShell: ['none'],
      queryTrigger: [{ directory: dir }, '@', 1],
    }
    return bridge[method]!(...args[method]!).then(
      () => 'ok',
      (error: Error) => (error.message.includes('No handler registered') ? 'no handler' : `error: ${error.message}`),
    )
  }, [name, project] as const)
}

/** 입력을 비우고 사람처럼 친다 (fill 은 캐럿 이벤트를 안 낸다) */
async function typeFresh(text: string): Promise<void> {
  await input().fill('')
  await input().focus()
  await page.keyboard.type(text)
}

/** 대화 한 턴 — 새 답 말풍선이 생긴다 */
async function chatTurn(text: string): Promise<void> {
  const before = await replies().count()
  await input().fill(text)
  await page.keyboard.press('Enter')
  await expect.poll(() => replies().count(), { timeout: 30_000 }).toBe(before + 1)
}

async function openFeatures(): Promise<void> {
  if (!(await dialog().isVisible())) await page.getByRole('button', { name: '설정', exact: true }).click()
  await dialog().getByRole('button', { name: '기능', exact: true }).click()
  await dialog().locator('.feature-card').first().waitFor()
}

const featureSwitch = (name: string) => dialog().getByRole('switch', { name, exact: true })

/** 설정 > 기능에서 스위치를 눌러 그 값으로 만들고, 메인이 묶음을 다 올리고 내려 목록을 밀어 줄 때까지 기다린다 */
async function setFeature(name: string, on: boolean): Promise<void> {
  await openFeatures()
  if ((await featureSwitch(name).getAttribute('aria-checked')) !== String(on)) await featureSwitch(name).click()
  await expect.poll(() => featureSwitch(name).getAttribute('aria-checked'), { timeout: 5_000 }).toBe(String(on))
}

async function closeSettings(): Promise<void> {
  await page.keyboard.press('Escape')
  await expect.poll(() => dialog().count()).toBe(0)
}

describe('기능 켜기/끄기', () => {
  it('기본은 모두 켜짐 — 탭·다른 앱에서 열기·@ 팝업·터미널 칸이 다 있다', async () => {
    await chatTurn('hello features')
    expect(await enabled()).toEqual(ALL)
    expect(await tabs().allTextContents()).toEqual(['대화', '추론 과정'])
    await expect.poll(() => openIn().count(), { timeout: 5_000 }).toBe(1)
    await typeFresh('@')
    await expect.poll(() => menu().count(), { timeout: 10_000 }).toBe(1)
    await input().fill('')
    await page.keyboard.press('Meta+ArrowDown')
    await expect.poll(() => drawer().count(), { timeout: 5_000 }).toBe(1)
    await page.keyboard.press('Meta+ArrowUp')
    await expect.poll(() => drawer().count(), { timeout: 5_000 }).toBe(0)
  })

  it('설정 > 기능 — 기능마다 카드(이름·스위치·한 줄 설명), 웹 도구만 꺼짐(이슈 #14). dsh 카드 치수', async () => {
    await openFeatures()
    expect(await dialog().locator('.settings-nav__item').allTextContents()).toEqual(['일반', '모델', '기능'])
    expect(await dialog().locator('.feature-card__title').allTextContents()).toEqual([
      '@ 파일 언급',
      '/ 명령',
      '! 셸 입력',
      '!명령 실행',
      '터미널 칸',
      '추론 과정',
      '알림',
      '다른 앱에서 열기',
      '웹 도구',
    ])
    expect(await dialog().locator('.feature-card__description').count()).toBe(9)
    expect(await dialog().getByRole('switch').evaluateAll((list) => list.map((el) => el.getAttribute('aria-checked')))).toEqual([...Array(8).fill('true'), 'false'])
    const card = dialog().locator('.feature-card').first()
    expect(await card.evaluate((el) => [getComputedStyle(el).padding, getComputedStyle(el).borderTopWidth])).toEqual(['12px 14px', '0.5px'])
    await fs.mkdir(path.join(root, 'shots'), { recursive: true })
    await page.screenshot({ path: path.join(root, 'shots', 'features-settings.png') })
  })

  it('추론 과정을 끄면 탭이 사라지고 그 IPC 핸들러가 걷힌다 (재시작 없이)', async () => {
    expect(await call('loadTrajectory')).not.toBe('no handler')
    await setFeature('추론 과정', false)
    await closeSettings()
    await expect.poll(() => tabs().count(), { timeout: 5_000 }).toBe(0)
    expect(await call('loadTrajectory')).toBe('no handler')
    expect(await enabled()).not.toContain('trajectory')
  })

  it('다른 앱에서 열기를 끄면 대화 머리 버튼이 사라진다', async () => {
    await setFeature('다른 앱에서 열기', false)
    await closeSettings()
    await expect.poll(() => openIn().count(), { timeout: 5_000 }).toBe(0)
    expect(await call('openInApps')).toBe('no handler')
  })

  it('터미널 칸을 끄면 ⌘↓ 가 칸을 열지 않는다', async () => {
    await setFeature('터미널 칸', false)
    await closeSettings()
    await input().focus()
    await page.keyboard.press('Meta+ArrowDown')
    await page.waitForTimeout(500)
    expect(await drawer().count()).toBe(0)
    expect(await call('openTerminal')).toBe('no handler')
  })

  it('@·/ 를 끄면 팝업이 뜨지 않고 평범한 글자가 된다', async () => {
    await setFeature('@ 파일 언급', false)
    await setFeature('/ 명령', false)
    await closeSettings()
    await typeFresh('@')
    await page.waitForTimeout(800)
    expect(await menu().count()).toBe(0)
    await typeFresh('/')
    await page.waitForTimeout(800)
    expect(await menu().count()).toBe(0)
    await input().fill('')
  })

  it('!명령 실행을 끄면 `!` 입력도 같이 막히고(스위치 잠김), `!…` 는 평범한 프롬프트로 간다 — 카드 없음', async () => {
    await setFeature('!명령 실행', false)
    expect(await featureSwitch('! 셸 입력').isDisabled()).toBe(true)
    expect(await featureSwitch('! 셸 입력').getAttribute('aria-checked')).toBe('false')
    expect(await dialog().locator('[data-feature="bang"] .feature-card__requires').textContent()).toBe('"!명령 실행" 을(를) 켜야 쓸 수 있습니다')
    await closeSettings()
    expect(await enabled()).not.toContain('bang')
    expect(await call('stopShell')).toBe('no handler')
    await chatTurn('!echo plain')
    expect(await cards().count()).toBe(0)
    expect(await page.locator('.composer__box--danger').count()).toBe(0)
  })

  it('알림을 끄면 뒤에서 끝난 턴에 PC 알림·점이 없고 dock 배지도 지워진다', async () => {
    // 켜진 상태에서는 뒤(기록 host 의 기본)에서 끝난 턴이 PC 알림을 남긴다 — 비교 기준
    const before = await shownCount()
    await chatTurn('notify on')
    await expect.poll(shownCount, { timeout: 5_000 }).toBe(before + 1)

    await setFeature('알림', false)
    await closeSettings()
    expect(await lastBadge()).toBe(0)
    expect(await call('getNotifications')).toBe('no handler')
    await chatTurn('notify off')
    await page.waitForTimeout(500)
    expect(await shownCount()).toBe(before + 1)
    expect(await page.locator('.notice-dot').count()).toBe(0)
  })

  it('다 꺼도 대화는 된다 — 남은 바탕(대화·저장)은 그대로', async () => {
    expect(await enabled()).toEqual([])
    await chatTurn('core still works')
    expect((await page.evaluate(() => window.litecode.listConversations())).length).toBeGreaterThan(0)
  })

  it('다시 켜면 탭·버튼·팝업·터미널 칸·알림이 돌아온다', async () => {
    for (const name of ['@ 파일 언급', '/ 명령', '!명령 실행', '터미널 칸', '추론 과정', '알림', '다른 앱에서 열기']) await setFeature(name, true)
    expect(await featureSwitch('! 셸 입력').getAttribute('aria-checked')).toBe('true')
    await closeSettings()
    await expect.poll(enabled, { timeout: 5_000 }).toEqual(ALL)
    await expect.poll(() => tabs().count(), { timeout: 5_000 }).toBe(2)
    await expect.poll(() => openIn().count(), { timeout: 5_000 }).toBe(1)
    expect(await call('loadTrajectory')).not.toBe('no handler')
    await typeFresh('@')
    await expect.poll(() => menu().count(), { timeout: 10_000 }).toBe(1)
    await typeFresh('/')
    await expect.poll(() => menu().count(), { timeout: 10_000 }).toBe(1)
    await input().fill('')
    await page.keyboard.press('Meta+ArrowDown')
    await expect.poll(() => drawer().count(), { timeout: 5_000 }).toBe(1)
    await page.keyboard.press('Meta+ArrowUp')
    await expect.poll(() => drawer().count(), { timeout: 5_000 }).toBe(0)
    // `!명령` 이 다시 카드로
    await typeFresh('!echo FEAT-$((2*3))')
    await page.keyboard.press('Enter')
    await expect.poll(() => cards().locator('.shell-card__output').textContent(), { timeout: 20_000 }).toContain('FEAT-6')
    // 알림이 다시 PC 알림을 남긴다
    const before = await shownCount()
    await chatTurn('notify again')
    await expect.poll(shownCount, { timeout: 5_000 }).toBe(before + 1)
  })

  it('끈 기능은 재시작 뒤에도 꺼진 채로 뜬다', async () => {
    await setFeature('추론 과정', false)
    await setFeature('다른 앱에서 열기', false)
    await closeSettings()
    expect(JSON.parse(await fs.readFile(path.join(userData, 'settings.json'), 'utf8')).features).toEqual({ trajectory: false, openIn: false })

    await app.close()
    await launch()
    expect(await enabled()).toEqual(ALL.filter((feature) => feature !== 'trajectory' && feature !== 'openIn'))
    await page.locator('.session-item').first().waitFor({ timeout: 10_000 })
    expect(await tabs().count()).toBe(0)
    expect(await openIn().count()).toBe(0)
    expect(await call('loadTrajectory')).toBe('no handler')
    await openFeatures()
    expect(await featureSwitch('추론 과정').getAttribute('aria-checked')).toBe('false')
    expect(await featureSwitch('@ 파일 언급').getAttribute('aria-checked')).toBe('true')
    await closeSettings()
    await chatTurn('after restart')
  })
})
