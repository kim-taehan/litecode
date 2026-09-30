import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core'
import { createServer, type ViteDevServer } from 'vite'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import { alive, freePort, isolatedEnv } from './support/opencodeServer.ts'
import { FAKE_MODELS } from './support/fakeLlm.ts'
import { badgeColor } from '../../renderer/badge.ts'

// 앱 실물 테스트 — 진짜 Electron 창을 띄워 사람처럼 입력하고, 답이 화면에 뜨는지 본다.
// 렌더러 → preload → IPC → ctx.llm → opencode → (가짜) LLM 을 한 번에 관통한다.
// 단위 테스트·타입체크가 초록이어도 채널 이름 불일치(preload.cts 는 채널을 손으로 옮겨 적는다)나
// preload 로딩 실패는 여기서만 잡힌다.
//
// 가짜로 두는 것은 OS 폴더 대화상자뿐이다(app.evaluate 로 dialog.showOpenDialog 를 바꿔치기) — 그 뒤의
// IPC·최근 목록 저장·opencode 는 실물. userData 는 --user-data-dir 로 테스트 임시 폴더에 둔다
// (Electron 33 은 이 스위치로 app.getPath('userData') 를 바꾼다 — 2026-09-30 실측). 사용자 앱 데이터에 쓰지 않는다.
// opencode 는 앱이 스스로 띄운다(2a) — 테스트는 실행 파일(OPENCODE_BIN)과 격리 XDG 만 주고, 기본 provider 의 주소를
// LITECODE_GATEWAY_URL 로 가짜 LLM 에 돌린다. 나머지 설정은 설정 화면으로 한다.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

let vite: ViteDevServer
let devServerUrl: string
let app: ElectronApplication
let page: Page
/** 테스트 임시 폴더 (realpath — 앱이 보여주고 opencode 에 넘기는 값과 같다) */
let tmp: string
let userData: string
let alpha: string
let beta: string

async function launch(): Promise<void> {
  app = await electron.launch({
    // --use-mock-keychain: safeStorage 가 사용자 로그인 Keychain 대신 Chromium 의 가짜 키체인으로 암호화한다 — 테스트가
    // 사용자 Keychain 에 항목을 만들거나 접근 허락 창을 띄우지 않게 (암호화 자체는 그대로 돈다)
    args: ['.', `--user-data-dir=${userData}`, '--use-mock-keychain'],
    cwd: root,
    env: { ...isolatedEnv(tmp), LITECODE_TEST_HIDDEN: '1', LITECODE_DEV_SERVER_URL: devServerUrl, LITECODE_GATEWAY_URL: `${inject('fakeLlmUrl')}/v1` },
  })
  page = await app.firstWindow()
  // 사이드바를 숨긴 채 켜질 수도 있어 늘 보이는 사이드바 토글로 준비를 확인한다
  await page.locator('.sidebar-toggle').waitFor()
}

beforeAll(async () => {
  // 메인 프로세스는 컴파일된 dist-electron 을 돈다 — 방금 고친 코드가 반영되게 매번 새로 컴파일한다.
  execFileSync(path.join(root, 'node_modules/.bin/tsc'), ['-p', 'tsconfig.electron.json'], { cwd: root, stdio: 'inherit' })

  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'litecode-app-')))
  userData = path.join(tmp, 'userData')
  alpha = path.join(tmp, 'alpha-app')
  beta = path.join(tmp, 'beta-app')
  await fs.mkdir(alpha)
  await fs.mkdir(beta)
  await fs.writeFile(path.join(alpha, 'keep.txt'), 'keep') // 목록에서 빼도 폴더·내용이 그대로인지 본다

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

/** OS 폴더 대화상자 대신 dir 을 고른 것으로(없으면 취소로) 돌려준다 (메인 프로세스의 electron.dialog 를 바꿔치기).
 *  delayMs 동안 대화상자가 떠 있는 것처럼 답을 미룬다. 불린 횟수는 dialogCalls() 로 읽는다 */
async function pickFolderNextTime(dir?: string, delayMs = 0): Promise<void> {
  await app.evaluate(({ dialog }, { picked, delayMs }) => {
    const state = globalThis as { dialogCalls?: number }
    state.dialogCalls ??= 0
    dialog.showOpenDialog = (async () => {
      state.dialogCalls!++
      await new Promise((resolve) => setTimeout(resolve, delayMs))
      return picked ? { canceled: false, filePaths: [picked] } : { canceled: true, filePaths: [] }
    }) as typeof dialog.showOpenDialog
  }, { picked: dir, delayMs })
}

const dialogCalls = () => app.evaluate(() => (globalThis as { dialogCalls?: number }).dialogCalls ?? 0)
/** 포커스가 있는 요소의 보이는 글자 (input 이면 placeholder) */
const focused = () => page.evaluate(() => {
  const el = document.activeElement as HTMLElement | null
  return el instanceof HTMLInputElement ? el.placeholder : (el?.textContent ?? '')
})

const switcher = () => page.locator('.project-switch')
const popover = () => page.locator('.project-popover')
const popoverNames = () => popover().locator('.project-item__name').allTextContents()
const sessionTitles = () => page.locator('.session-item').allTextContents()
/** 팝오버의 한 묶음(즐겨찾기·최근)에 보이는 이름 */
const groupNames = (group: '즐겨찾기' | '최근') => popover().getByRole('group', { name: group }).locator('.project-item__name').allTextContents()
const row = (name: string) => popover().locator('.project-item', { hasText: name })
const isDirectory = (dir: string) => fs.stat(dir).then((stat) => stat.isDirectory(), () => false)
const currentName = () => switcher().locator('.project-switch__name').textContent({ timeout: 1_000 })

/** 팝오버에서 최근 프로젝트를 골라 전환이 화면에 반영될 때까지 기다린다 (전환은 IPC 왕복이라 비동기) */
/** 팝오버를 연다 — 이전 동작으로 닫히는 중인 팝오버가 아직 떠 있을 때 전환 버튼을 누르면 도리어 닫혀 버린다(간헐 실패의 원인) */
async function openPopover(): Promise<void> {
  if (!(await popover().isVisible())) await switcher().click()
  await popover().waitFor({ timeout: 5_000 })
}

async function switchTo(name: string): Promise<void> {
  await openPopover()
  await popover().locator('.project-item', { hasText: name }).click()
  await expect.poll(currentName, { timeout: 10_000 }).toBe(name)
}
const replies = () => page.locator('.bubble--assistant')

/** 보내고, **새** 답 말풍선이 생길 때까지 기다려 그 텍스트를 돌려준다 — 이전 답을 새 답으로 읽지 않게 */
async function send(text: string): Promise<string> {
  const before = await replies().count()
  await page.getByPlaceholder('메시지를 입력하세요…').fill(text)
  await page.keyboard.press('Enter')
  await expect.poll(() => replies().count(), { timeout: 30_000 }).toBe(before + 1)
  return (await replies().last().textContent()) ?? ''
}

describe('앱 ↔ 실물 opencode', () => {
  it('첫 실행(최근 목록 없음)에는 채팅 영역에 폴더 열기 안내가 보인다', async () => {
    await expect.poll(() => page.locator('.open-guide').textContent({ timeout: 1_000 }), { timeout: 10_000 }).toContain('폴더를 열어')
    expect(await page.getByPlaceholder('메시지를 입력하세요…').count()).toBe(0)
  })

  // dsh ui-workspace: 고를 대상이 없으면 한 줄짜리 메뉴 대신 버튼 동작이 곧 폴더 열기다
  it('최근 목록이 비었을 때 전환 버튼은 팝오버 없이 바로 폴더 대화상자를 연다', async () => {
    const before = await dialogCalls()
    await pickFolderNextTime(undefined)
    await switcher().click()

    await expect.poll(dialogCalls, { timeout: 5_000 }).toBe(before + 1)
    expect(await popover().count()).toBe(0)
    expect(await page.locator('.open-guide').count()).toBe(1) // 취소 — 그대로
  })

  // dsh ui-workspace: 고르는 동작은 한 번에 하나 — 대화상자가 떠 있는 동안 다른 열기 동작을 막는다
  it('폴더 대화상자가 떠 있는 동안에는 다른 열기 동작이 막힌다', async () => {
    await pickFolderNextTime(undefined, 1_500)
    await page.locator('.open-guide').getByRole('button', { name: '폴더 열기…' }).click()

    await expect.poll(() => switcher().isDisabled(), { timeout: 1_000 }).toBe(true)
    expect(await page.locator('.open-guide').getByRole('button', { name: '폴더 열기…' }).isDisabled()).toBe(true)
    await expect.poll(() => switcher().isDisabled(), { timeout: 5_000 }).toBe(false)
  })

  it('폴더 A 를 열면 전환 버튼에 A 의 이름·경로가 보이고, 대화가 A 에서 돈다', async () => {
    await pickFolderNextTime(alpha)
    await page.locator('.open-guide').getByRole('button', { name: '폴더 열기…' }).click()

    await expect.poll(currentName, { timeout: 10_000 }).toBe('alpha-app')
    expect(await switcher().locator('.project-switch__badge').textContent()).toBe('AA')
    expect(await switcher().locator('.project-switch__path').textContent()).toBe(alpha)
    // 가짜 LLM 이 bash pwd 를 부르게 해서, opencode 세션이 실제로 A 에서 도구를 실행했는지 답으로 본다
    expect((await send('[bash:pwd]')).split('\n')[0]).toBe(`tool: ${alpha}`)
  })

  it('메시지를 보내면 답이 화면에 뜨고 대화 제목이 바뀐다', async () => {
    await page.getByRole('button', { name: '+ 새 대화' }).click()
    expect(await send('화면에서 안녕')).toBe('echo: 화면에서 안녕')
    expect(await page.locator('.main__header').textContent()).toBe('화면에서 안녕')
  })

  it('LLM 이 실패하면 경고를 화면에 띄우고 다시 보낼 수 있다', async () => {
    expect(await send('[fail] 화면 실패')).toContain('⚠️')
    expect(await page.getByRole('button', { name: '보내기' }).isEnabled()).toBe(true)
  })

  it('B 를 열고 대화한 뒤 A 로 전환하면 A 의 대화만 보이고, B 로 돌아가면 B 의 대화가 그대로다', async () => {
    const alphaTitles = await sessionTitles()
    expect(alphaTitles).toEqual(['화면에서 안녕', '[bash:pwd]'])

    await pickFolderNextTime(beta)
    await openPopover()
    await popover().getByRole('button', { name: '＋ 폴더 열기…' }).click()
    await expect.poll(currentName, { timeout: 10_000 }).toBe('beta-app')
    expect(await popover().count()).toBe(0)
    expect(await sessionTitles()).toEqual(['새 대화'])
    expect(await send('B 에서 안녕')).toBe('echo: B 에서 안녕')
    // 전환 뒤 보낸 턴이 A 가 아니라 B 에서 도는지 (옛 프로젝트 경로를 쥔 채 보내는 결함을 잡는다)
    expect((await send('[bash:pwd]')).split('\n')[0]).toBe(`tool: ${beta}`)

    await switchTo('alpha-app')
    expect(await popover().count()).toBe(0)
    expect(await sessionTitles()).toEqual(alphaTitles)

    await switchTo('beta-app')
    expect(await sessionTitles()).toEqual(['B 에서 안녕'])
    const texts = await replies().allTextContents()
    expect(texts).toHaveLength(2)
    expect(texts[0]).toBe('echo: B 에서 안녕')
    expect(texts[1]!.split('\n')[0]).toBe(`tool: ${beta}`)
  })

  // 03_qa: 전송 중 전환해도 답은 원래 대화에 붙어야 하고, 기다리는 동안 다른 프로젝트·대화는 보낼 수 있어야 한다
  it('A 가 답을 기다리는 동안 B 에서 보낼 수 있고, 늦게 온 A 의 답은 A 의 대화에만 붙는다', async () => {
    await switchTo('alpha-app')
    await page.getByRole('button', { name: '+ 새 대화' }).click()
    await page.getByPlaceholder('메시지를 입력하세요…').fill('[bash:sleep 6 && pwd]')
    await page.keyboard.press('Enter')
    expect(await page.getByRole('button', { name: '보내기' }).isDisabled()).toBe(true) // 이 대화는 기다리는 중

    await switchTo('beta-app')
    expect(await page.getByRole('button', { name: '보내기' }).isEnabled()).toBe(true)
    expect(await send('A 를 기다리는 중')).toBe('echo: A 를 기다리는 중')

    await switchTo('alpha-app')
    expect(await sessionTitles()).toContain('[bash:sleep 6 && pwd]')
    await expect.poll(() => replies().count(), { timeout: 20_000 }).toBe(1)
    expect((await replies().last().textContent())!.split('\n')[0]).toBe(`tool: ${alpha}`)
    expect(await page.getByRole('button', { name: '보내기' }).isEnabled()).toBe(true)

    await switchTo('beta-app')
    expect((await replies().allTextContents()).some((text) => text.includes(alpha))).toBe(false)
  })

  it('팝오버의 최근 목록은 현재 프로젝트를 표시하고, 검색 입력으로 걸러진다', async () => {
    await openPopover()
    expect(await popoverNames()).toEqual(['beta-app', 'alpha-app'])
    expect(await popover().locator('.project-item--active .project-item__name').textContent()).toBe('beta-app')

    await popover().getByPlaceholder('프로젝트 검색…').fill('alp')
    expect(await popoverNames()).toEqual(['alpha-app'])
    await popover().getByPlaceholder('프로젝트 검색…').fill('없는이름')
    expect(await popoverNames()).toEqual([])
    expect(await popover().textContent()).toContain('일치하는 프로젝트 없음')
  })

  it('팝오버는 Esc 와 바깥 클릭으로 닫힌다', async () => {
    expect(await popover().count()).toBe(1) // 앞 테스트에서 열어 둔 것
    await page.keyboard.press('Escape')
    expect(await popover().count()).toBe(0)

    await openPopover()
    expect(await popover().count()).toBe(1)
    await page.locator('.main__messages').click()
    expect(await popover().count()).toBe(0)
  })

  // dsh ui-primitives Menu: ↑/↓ 로 행을 돌고(끝에서 처음으로), 고르거나 Esc 로 닫으면 포커스가 전환 버튼으로 돌아온다
  it('팝오버는 키보드로 걷고 고를 수 있고, 닫히면 포커스가 전환 버튼으로 돌아온다', async () => {
    await openPopover()
    expect(await focused()).toBe('프로젝트 검색…')

    await page.keyboard.press('ArrowDown')
    expect(await focused()).toContain('beta-app')
    await page.keyboard.press('ArrowDown')
    expect(await focused()).toContain('alpha-app')
    await page.keyboard.press('ArrowDown')
    expect(await focused()).toBe('＋ 폴더 열기…')
    await page.keyboard.press('ArrowDown')
    expect(await focused()).toContain('beta-app')
    await page.keyboard.press('ArrowUp')
    await page.keyboard.press('ArrowUp')
    expect(await focused()).toContain('alpha-app')

    await page.keyboard.press('Enter')
    await expect.poll(currentName, { timeout: 10_000 }).toBe('alpha-app')
    expect(await popover().count()).toBe(0)
    expect(await focused()).toContain('alpha-app') // 전환 버튼

    await openPopover()
    await page.keyboard.press('Escape')
    expect(await popover().count()).toBe(0)
    expect(await focused()).toContain('alpha-app')

    await switchTo('beta-app') // 다음 테스트(재시작)는 B 가 마지막이어야 한다
  })

  it('앱을 껐다 켜면 마지막 프로젝트(B)가 열려 있고 최근 목록에 A·B 가 남아 있다', async () => {
    await app.close()
    await launch()

    await expect.poll(currentName, { timeout: 10_000 }).toBe('beta-app')
    await openPopover()
    expect(await popoverNames()).toEqual(['beta-app', 'alpha-app'])
    // 저장이 사용자 앱 데이터가 아니라 이 테스트의 userData 에 됐는지
    expect(JSON.parse(await fs.readFile(path.join(userData, 'projects.json'), 'utf8'))).toEqual({ recent: [beta, alpha], favorites: [], names: {} })
    await page.keyboard.press('Escape')
  })

  // dsh ui-workspace: 고른 폴더를 못 열면 사유를 보여주고 현재 선택은 그대로 둔다
  it('지워진 최근 프로젝트를 고르면 팝오버에 사유를 보이고 현재 프로젝트는 그대로다', async () => {
    const gamma = path.join(tmp, 'gamma-app')
    await fs.mkdir(gamma)
    await pickFolderNextTime(gamma)
    await openPopover()
    await popover().getByRole('button', { name: '＋ 폴더 열기…' }).click()
    await expect.poll(currentName, { timeout: 10_000 }).toBe('gamma-app')
    await switchTo('beta-app')
    await fs.rm(gamma, { recursive: true })

    await openPopover()
    await popover().locator('.project-item', { hasText: 'gamma-app' }).click()

    await expect.poll(() => popover().getByRole('alert').textContent({ timeout: 1_000 }), { timeout: 5_000 }).toContain(gamma)
    expect(await currentName()).toBe('beta-app')
  })

  // 성공 기준 7 — dsh ui-workspace 의 pin: 고정한 것은 앞 묶음에, 원래 자리에는 중복 없이
  it('즐겨찾기한 프로젝트는 즐겨찾기 묶음에만 있고, 검색은 두 묶음에 걸리며, 재시작해도 남는다', async () => {
    await page.keyboard.press('Escape') // 앞 테스트가 열어 둔 팝오버
    await openPopover()
    await row('alpha-app').hover()
    await row('alpha-app').getByRole('button', { name: '즐겨찾기에 추가', exact: true }).click()

    await expect.poll(() => groupNames('즐겨찾기'), { timeout: 5_000 }).toEqual(['alpha-app'])
    expect(await groupNames('최근')).toEqual(['beta-app', 'gamma-app'])
    await popover().getByPlaceholder('프로젝트 검색…').fill('alp')
    expect([await groupNames('즐겨찾기'), await groupNames('최근')]).toEqual([['alpha-app'], []])
    await popover().getByPlaceholder('프로젝트 검색…').fill('bet')
    expect([await groupNames('즐겨찾기'), await groupNames('최근')]).toEqual([[], ['beta-app']])
    await page.keyboard.press('Escape')

    await app.close()
    await launch()
    await expect.poll(currentName, { timeout: 10_000 }).toBe('beta-app')
    await openPopover()
    expect(await groupNames('즐겨찾기')).toEqual(['alpha-app'])
    expect(await groupNames('최근')).toEqual(['beta-app', 'gamma-app'])
    await row('alpha-app').hover() // ☆·× 는 hover·포커스 때만 보인다
    expect(await row('alpha-app').getByRole('button', { name: '즐겨찾기에서 빼기', exact: true }).count()).toBe(1)
  })

  // 성공 기준 8 · 00_request C — 목록에서만 뺀다. 지워진 폴더도 이걸로 정리. 키보드 포커스로도 버튼에 닿는다
  it('× 는 목록에서만 빼고 폴더는 디스크에 그대로 둔다 (지워진 폴더도 정리된다)', async () => {
    await row('gamma-app').hover()
    await row('gamma-app').getByRole('button', { name: '목록에서 빼기', exact: true }).click()
    await expect.poll(popoverNames, { timeout: 5_000 }).toEqual(['alpha-app', 'beta-app'])

    // 키보드: ↓ 로 alpha 행 → Tab 으로 ✎ → Tab 으로 ★ → Tab 으로 × → Enter
    await popover().getByPlaceholder('프로젝트 검색…').focus()
    await page.keyboard.press('ArrowDown')
    expect(await focused()).toContain('alpha-app')
    await page.keyboard.press('Tab')
    await page.keyboard.press('Tab')
    await page.keyboard.press('Tab')
    expect(await page.evaluate(() => document.activeElement?.getAttribute('aria-label'))).toBe('목록에서 빼기')
    await page.keyboard.press('Enter')

    await expect.poll(popoverNames, { timeout: 5_000 }).toEqual(['beta-app'])
    expect(await currentName()).toBe('beta-app')
    expect(await isDirectory(alpha)).toBe(true)
    expect(await fs.readFile(path.join(alpha, 'keep.txt'), 'utf8')).toBe('keep')
    expect(JSON.parse(await fs.readFile(path.join(userData, 'projects.json'), 'utf8'))).toEqual({ recent: [beta], favorites: [], names: {} })
  })

  // 성공 기준 9 — 현재 프로젝트를 빼면 다음 프로젝트로, 없으면 첫 실행 안내로. 뺀 프로젝트의 메모리 속 대화는 버린다
  it('현재 프로젝트를 빼면 다음 프로젝트로, 마지막이면 첫 실행 안내로 간다', async () => {
    await pickFolderNextTime(alpha)
    await popover().getByRole('button', { name: '＋ 폴더 열기…' }).click()
    await expect.poll(currentName, { timeout: 10_000 }).toBe('alpha-app')
    expect(await sessionTitles()).toEqual(['새 대화']) // 빼기 전의 A 대화는 버려졌다

    await openPopover()
    await row('alpha-app').hover()
    await row('alpha-app').getByRole('button', { name: '목록에서 빼기', exact: true }).click()
    await expect.poll(currentName, { timeout: 10_000 }).toBe('beta-app')
    expect(await sessionTitles()).toEqual(['새 대화']) // B 의 대화 (앞 테스트의 재시작으로 메모리 대화는 비었다)

    await row('beta-app').hover()
    await row('beta-app').getByRole('button', { name: '목록에서 빼기', exact: true }).click()
    await expect.poll(() => page.locator('.open-guide').count(), { timeout: 5_000 }).toBe(1)
    expect(await popover().count()).toBe(0)
    expect(await sessionTitles()).toEqual([])
    expect(await isDirectory(alpha)).toBe(true)
    expect(await isDirectory(beta)).toBe(true)
  })

  // 성공 기준 10 · 00_request A1 — 앞 두 글자가 같은 이름(davis-code·davis-frontend)이 같은 배지였다
  it('이름 앞글자가 같은 두 프로젝트의 배지는 글자와 경로로 정해진 색으로 구분된다', async () => {
    const code = path.join(tmp, 'davis-code')
    const frontend = path.join(tmp, 'davis-frontend')
    await fs.mkdir(code)
    await fs.mkdir(frontend)
    await pickFolderNextTime(code)
    await page.locator('.open-guide').getByRole('button', { name: '폴더 열기…' }).click()
    await expect.poll(currentName, { timeout: 10_000 }).toBe('davis-code')
    await pickFolderNextTime(frontend)
    await openPopover()
    await popover().getByRole('button', { name: '＋ 폴더 열기…' }).click()
    await expect.poll(currentName, { timeout: 10_000 }).toBe('davis-frontend')

    await openPopover()
    const badge = (name: string) => row(name).locator('.project-switch__badge')
    expect(await badge('davis-code').textContent()).toBe('DC')
    expect(await badge('davis-frontend').textContent()).toBe('DF')
    const rgb = (hex: string) => `rgb(${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(', ')})`
    expect(await badge('davis-code').evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(rgb(badgeColor(code)))
    expect(await badge('davis-frontend').evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(rgb(badgeColor(frontend)))
    await page.keyboard.press('Escape')
  })

  // 03_qa: 마지막 프로젝트가 디스크에서 지워진 채 켜면 안내 없이 열려 첫 전송에서야 "작업 디렉터리가 없다" 가 떴다.
  // 켤 때 열어 보고 못 열면 첫 실행 안내에 사유를 보인다 — 다른 프로젝트로 몰래 넘어가지 않는다. 목록에는 남아 × 로 정리할 수 있다
  it('마지막 프로젝트가 지워진 채 켜면 안내 화면에 사유를 보이고, 목록에서 뺄 수 있다', async () => {
    const frontend = path.join(tmp, 'davis-frontend')
    await app.close()
    await fs.rm(frontend, { recursive: true })
    await launch()

    await expect.poll(() => page.locator('.open-guide').getByRole('alert').textContent({ timeout: 1_000 }), { timeout: 10_000 }).toContain(frontend)
    expect(await page.getByPlaceholder('메시지를 입력하세요…').count()).toBe(0)
    expect(await currentName()).toBe('프로젝트 없음')

    await openPopover()
    expect(await popoverNames()).toEqual(['davis-frontend', 'davis-code'])
    await row('davis-frontend').hover()
    await row('davis-frontend').getByRole('button', { name: '목록에서 빼기', exact: true }).click()
    await expect.poll(popoverNames, { timeout: 5_000 }).toEqual(['davis-code'])
  })

  // 이름 아래에 경로가 이미 보이므로 다 보이면 아무것도 안 띄운다. 잘린 경로는 dsh ui-workspace 처럼 마우스를 올리면
  // 흘러가며 끝을 보이고, 머물면 옆 카드에 전체 경로를 띄운다 (dsh ui-primitives HoverCard)
  it('잘린 경로는 마우스를 올리면 흘러가며 끝을 보이고 옆 카드에 전체 경로가 뜬다 — 다 보이는 경로는 그대로', async () => {
    const short = '/private/tmp' // 실제 경로가 짧아 팝오버에서 안 잘린다
    const long = path.join(tmp, 'a-very-long-directory-name-to-overflow', 'another-deeply-nested-folder', 'zz-long-leaf')
    await fs.mkdir(long, { recursive: true })
    await page.keyboard.press('Escape')
    for (const dir of [short, long]) {
      await pickFolderNextTime(dir)
      await openPopover()
      await popover().getByRole('button', { name: '＋ 폴더 열기…' }).click()
      await expect.poll(currentName, { timeout: 10_000 }).toBe(path.basename(dir))
    }

    await openPopover()
    const card = () => page.locator('.hover-card')
    const scrolled = (name: string) => row(name).locator('.project-switch__path').evaluate((el) => el.scrollLeft)
    expect(await row('zz-long-leaf').locator('.project-item__main').getAttribute('title')).toBeNull()

    await row('zz-long-leaf').locator('.project-item__main').hover()
    await expect.poll(() => scrolled('zz-long-leaf'), { timeout: 5_000 }).toBeGreaterThan(0)
    await expect.poll(() => card().textContent({ timeout: 1_000 }), { timeout: 5_000 }).toContain(long)

    await row('tmp').locator('.project-item__main').hover()
    await page.waitForTimeout(800) // 카드가 뜨는 머묾(500ms)을 넘겨도
    expect(await card().count()).toBe(0)
    expect(await scrolled('tmp')).toBe(0)
    expect(await scrolled('zz-long-leaf')).toBe(0) // 떠난 행은 제자리로
    await page.keyboard.press('Escape')
  })

  it('대화 목록도 잘린 제목은 흘러가며 보이고 옆 카드에 전체 제목이 뜬다', async () => {
    // 제목은 첫 메시지 앞 24자 — 공백 없는 한글 24자는 목록 폭(약 231px)을 넘는다
    const title = '가나다라마바사아자차카타파하가나다라마바사아자차카타파하'
    await page.getByRole('button', { name: '+ 새 대화' }).click()
    await send(title)
    const item = page.locator('.session-item', { hasText: title.slice(0, 10) })
    const shown = title.slice(0, 24) // 대화 제목은 첫 메시지 앞 24자

    await item.hover()
    await expect.poll(() => item.locator('.marquee').evaluate((el) => el.scrollLeft), { timeout: 5_000 }).toBeGreaterThan(0)
    await expect.poll(() => page.locator('.hover-card').textContent({ timeout: 1_000 }), { timeout: 5_000 }).toContain(shown)
    expect(await page.locator('.hover-card').textContent()).toContain('메시지 2개')

    await page.locator('.main__header').hover()
    await expect.poll(() => page.locator('.hover-card').count(), { timeout: 2_000 }).toBe(0)
  })

  it('✎ 로 보이는 이름만 바꾼다 — Enter 저장·Esc 취소·재시작 후에도 남고, 폴더 이름은 그대로', async () => {
    await openPopover()
    const leaf = row('zz-long-leaf')
    await leaf.hover()
    await leaf.getByRole('button', { name: '이름 바꾸기' }).click()
    const input = popover().getByRole('textbox', { name: '프로젝트 이름' })
    await input.fill('긴 경로 프로젝트')
    await input.press('Escape') // 취소 — 팝오버는 열린 채
    expect(await popover().count()).toBe(1)
    expect(await popoverNames()).toContain('zz-long-leaf')

    await leaf.hover()
    await leaf.getByRole('button', { name: '이름 바꾸기' }).click()
    await input.fill('긴 경로 프로젝트')
    await input.press('Enter')
    await expect.poll(popoverNames, { timeout: 5_000 }).toContain('긴 경로 프로젝트')
    expect(await currentName()).toBe('긴 경로 프로젝트') // 열려 있는 프로젝트라 전환 버튼도 바뀐다

    await app.close()
    await launch()
    await expect.poll(currentName, { timeout: 10_000 }).toBe('긴 경로 프로젝트')
    expect(await fs.readdir(path.dirname(path.join(tmp, 'a-very-long-directory-name-to-overflow', 'another-deeply-nested-folder', 'zz-long-leaf')))).toContain('zz-long-leaf')
  })
})

// 설정 화면 조작 — 설정 > 모델 과 엔진 묶음이 같이 쓴다
const settingsButton = () => page.getByRole('button', { name: '⚙ 설정' })
const dialog = () => page.getByRole('dialog', { name: '설정' })
const card = (name: string) => dialog().locator('.provider-card', { has: page.locator('.provider-card__name', { hasText: name }) })
const cardNames = () => dialog().locator('.provider-card__name').allTextContents()
const field = (label: string) => dialog().getByLabel(label, { exact: true })
const modelIds = () => dialog().locator('.model-row input[aria-label^="모델 id"]').evaluateAll((els) => els.map((el) => (el as HTMLInputElement).value))
const fakeLlm = async () => (await (await fetch(`${inject('fakeLlmUrl')}/requests`)).json()) as { count: number; modelsAuth?: string; chatAuth?: string }

async function openSettings(): Promise<void> {
  if (!(await dialog().isVisible())) await settingsButton().click()
  await dialog().waitFor({ timeout: 5_000 })
}

/** userData 아래 모든 파일에서 needle 을 찾는다 (Chromium 이 만든 파일 포함) */
async function filesContaining(dir: string, needle: string): Promise<string[]> {
  const found: string[] = []
  for (const entry of await fs.readdir(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue
    const file = path.join(entry.parentPath, entry.name)
    const bytes = await fs.readFile(file).catch(() => Buffer.alloc(0))
    if (bytes.includes(needle) || bytes.includes(Buffer.from(needle, 'utf16le'))) found.push(file)
  }
  return found
}

// 설정 > 모델 (00_request 성공 기준 1~6). 화면은 dsh ui-settings-models 를 따른다.
describe('설정 > 모델', () => {
  const SECRET = 'sk-live-SECRET-4242'

  it('사이드바 하단의 ⚙ 설정은 모델 페이지로 모달을 열고, × 와 Esc 로 닫힌다', async () => {
    expect(await page.getByText('연결됨').count()).toBe(0)
    await settingsButton().click()
    await dialog().waitFor({ timeout: 5_000 })
    expect(await dialog().getByRole('button', { name: '모델', exact: true }).getAttribute('aria-current')).toBe('page')
    expect(await cardNames()).toEqual(['Internal LiteLLM Gateway'])

    await dialog().getByRole('button', { name: '닫기' }).click()
    await expect.poll(() => dialog().count(), { timeout: 5_000 }).toBe(0)
    await openSettings()
    await page.keyboard.press('Escape')
    await expect.poll(() => dialog().count(), { timeout: 5_000 }).toBe(0)
  })

  it('provider 를 추가하면 재시작해도 남고, 키는 화면·userData 어디에도 평문으로 없다', async () => {
    await openSettings()
    await dialog().getByRole('button', { name: '+ provider 추가' }).click()
    await field('표시 이름').fill('Team Relay')
    expect(await field('id').inputValue()).toBe('team-relay')
    expect(await field('id').getAttribute('readonly')).not.toBeNull()
    await field('API 키').fill(SECRET)
    await field('Base URL').fill(`${inject('fakeLlmUrl')}/v1`)
    for (const [index, [id, name]] of [['m-one', 'One'], ['m-two', 'Two']].entries()) {
      await dialog().getByRole('button', { name: '+ 모델 추가' }).click()
      await field(`모델 id ${index + 1}`).fill(id!)
      await field(`모델 이름 ${index + 1}`).fill(name!)
    }
    await dialog().getByRole('button', { name: '적용' }).click()
    await expect.poll(cardNames, { timeout: 5_000 }).toEqual(['Internal LiteLLM Gateway', 'Team Relay'])
    expect(await card('Team Relay').textContent()).toContain('Custom')
    expect(await card('Internal LiteLLM Gateway').textContent()).not.toContain('Custom')

    await app.close()
    await launch()
    await openSettings()
    await expect.poll(cardNames, { timeout: 5_000 }).toEqual(['Internal LiteLLM Gateway', 'Team Relay'])
    await card('Team Relay').getByRole('button', { name: '편집' }).click()
    expect(await modelIds()).toEqual(['m-one', 'm-two'])
    expect(await field('API 키').inputValue()).toBe('') // 쓰기 전용 — 저장된 값은 안 보인다
    expect(await field('API 키').getAttribute('placeholder')).toContain('설정됨')
    expect(await page.content()).not.toContain(SECRET)

    const stored = await fs.readFile(path.join(userData, 'providers.json'), 'utf8')
    expect(JSON.parse(stored).map((provider: { id: string }) => provider.id)).toEqual(['gateway-local', 'team-relay'])
    expect(Object.keys(JSON.parse(await fs.readFile(path.join(userData, 'provider-keys.json'), 'utf8')))).toEqual(['team-relay'])
    expect(await filesContaining(userData, SECRET)).toEqual([])
  })

  it('"사용 가능한 모델 가져오기" 는 저장된 키로 가짜 LLM 의 /v1/models 목록을 채우고, 취소하면 아무것도 안 바뀐다', async () => {
    await openSettings()
    if (!(await field('Base URL').isVisible())) await card('Team Relay').getByRole('button', { name: '편집' }).click()
    await dialog().getByRole('button', { name: '사용 가능한 모델 가져오기' }).click()
    await expect.poll(modelIds, { timeout: 5_000 }).toEqual(['m-one', 'm-two', ...FAKE_MODELS])
    expect((await fakeLlm()).modelsAuth).toBe(`Bearer ${SECRET}`) // 암호화해 둔 키가 메인 프로세스에서 풀려 게이트웨이로 갔다
    await field('표시 이름').fill('바뀌면 안 됨')

    await dialog().getByRole('button', { name: '취소' }).click()
    expect(await cardNames()).toEqual(['Internal LiteLLM Gateway', 'Team Relay'])
    await card('Team Relay').getByRole('button', { name: '편집' }).click()
    expect(await modelIds()).toEqual(['m-one', 'm-two'])
    await dialog().getByRole('button', { name: '취소' }).click()
  })

  // 03_qa 차단: 주소만 바꾸고 키 칸을 비운 채 가져오면 저장된 키가 새 주소로 새던 결함 — 요청 자체가 없어야 한다
  it('편집에서 Base URL 을 다른 서버로 바꾸고 가져오면 저장된 키를 보내지 않고 키를 다시 입력하라고 한다', async () => {
    const seen: (string | undefined)[] = []
    const other = http.createServer((req, res) => {
      seen.push(req.headers.authorization)
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: [{ id: 'leaked' }] }))
    })
    await new Promise<void>((resolve) => other.listen(0, '127.0.0.1', resolve))
    try {
      await openSettings()
      await card('Team Relay').getByRole('button', { name: '편집' }).click()
      await field('Base URL').fill(`http://127.0.0.1:${(other.address() as AddressInfo).port}/v1`)
      await dialog().getByRole('button', { name: '사용 가능한 모델 가져오기' }).click()

      await expect.poll(() => dialog().getByRole('alert').textContent({ timeout: 1_000 }), { timeout: 5_000 }).toContain('키를 다시 입력하세요')
      expect(seen).toEqual([])
      expect(await modelIds()).toEqual(['m-one', 'm-two'])
      await dialog().getByRole('button', { name: '취소' }).click()
    } finally {
      await new Promise<void>((resolve) => other.close(() => resolve()))
    }
  })

  // 03_qa 1차 재확인 · 리더 결정: 주소를 바꿔 저장하려면 키를 다시 넣어야 한다
  it('저장 키가 있는 provider 의 Base URL 만 바꿔 적용하면 경고하고, 재시작해도 이전 주소다', async () => {
    const original = `${inject('fakeLlmUrl')}/v1`
    await openSettings()
    await card('Team Relay').getByRole('button', { name: '편집' }).click()
    await field('Base URL').fill('http://127.0.0.1:9/v1')
    await dialog().getByRole('button', { name: '적용' }).click()

    await expect.poll(() => dialog().getByRole('alert').textContent({ timeout: 1_000 }), { timeout: 5_000 }).toContain('키를 다시 입력하세요')
    expect(await field('Base URL').inputValue()).toBe('http://127.0.0.1:9/v1') // 편집 카드는 열린 채

    await app.close()
    await launch()
    await openSettings()
    await card('Team Relay').getByRole('button', { name: '편집' }).click()
    expect(await field('Base URL').inputValue()).toBe(original)
    await dialog().getByRole('button', { name: '취소' }).click()
  })

  it('삭제는 확인을 한 번 더 받고 목록·파일에서 뺀다', async () => {
    await openSettings()
    await card('Team Relay').getByRole('button', { name: '삭제', exact: true }).click()
    expect(await cardNames()).toEqual(['Internal LiteLLM Gateway', 'Team Relay']) // 아직 확인 전
    await card('Team Relay').getByRole('button', { name: '삭제 확인' }).click()

    await expect.poll(cardNames, { timeout: 5_000 }).toEqual(['Internal LiteLLM Gateway'])
    expect(await fs.readFile(path.join(userData, 'providers.json'), 'utf8')).not.toContain('team-relay')
    expect(await fs.readFile(path.join(userData, 'provider-keys.json'), 'utf8')).toBe('{}')
  })

  it('입력창의 모델 표시는 설정의 provider·모델을 따른다', async () => {
    await page.keyboard.press('Escape')
    const composerModel = () => page.locator('.composer__model').textContent({ timeout: 1_000 })
    await expect.poll(composerModel, { timeout: 5_000 }).toBe('Qwen3.8 27B')

    await openSettings()
    await card('Internal LiteLLM Gateway').getByRole('button', { name: '편집' }).click()
    await field('모델 이름 1').fill('Qwen 사내')
    await dialog().getByRole('button', { name: '적용' }).click()
    await expect.poll(() => field('Base URL').count(), { timeout: 5_000 }).toBe(0)
    await page.keyboard.press('Escape')

    await expect.poll(composerModel, { timeout: 5_000 }).toBe('Qwen 사내')
    expect(await send('설정 뒤에도')).toBe('echo: 설정 뒤에도') // id 는 그대로라 대화는 계속 돈다
  })

  // dsh ui-workspace: 빈 "새 대화" 는 첫 메시지 전까지 한 줄만 — 누를 때마다 빈 대화가 쌓이지 않는다
  it('+ 새 대화 를 여러 번 눌러도 빈 대화는 하나뿐이고, 메시지를 보낸 뒤에야 새로 생긴다', async () => {
    const blanks = async () => (await sessionTitles()).filter((title) => title === '새 대화').length
    const newChat = page.getByRole('button', { name: '+ 새 대화' })
    for (let i = 0; i < 3; i++) await newChat.click()
    expect(await blanks()).toBe(1)
    expect(await page.locator('.main__header').textContent()).toBe('새 대화') // 그 빈 대화가 선택돼 있다

    await send('빈 대화 채우기')
    await newChat.click()
    await newChat.click()
    expect(await blanks()).toBe(1)
  })
})

// 2a 엔진 연결 (_workspace/00_request.md 성공 기준 1~6) — 앱이 스스로 띄운 opencode 로 설정 화면의 provider 가 대화한다.
// 테스트는 opencode 주소를 모른다: 앱이 userData 에 적어 둔 PID 기록과 Electron 의 자식 프로세스로 찾는다.
describe('엔진 — 앱이 띄운 opencode', () => {
  const KEY = 'sk-engine-APP-5151'
  const record = async () =>
    JSON.parse(await fs.readFile(path.join(userData, 'opencode-server.json'), 'utf8')) as { pid: number; url: string }
  /** 지금 떠 있는 opencode PID — 기록이 생길 때까지 기다린다 (앱은 켜자마자 띄우지만 비동기다) */
  async function enginePid(): Promise<number> {
    await expect.poll(() => record().then((r) => r.pid, () => 0), { timeout: 30_000 }).toBeGreaterThan(0)
    return (await record()).pid
  }
  const parentOf = (pid: number) => Number(execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8' }).trim())
  const lastReply = () => replies().last().textContent({ timeout: 1_000 })
  /** 강제 종료 시나리오가 중간에 실패해도 남긴 opencode 를 거둔다 — 이 테스트가 만든 PID 만 */
  let orphan: number | undefined
  afterAll(() => {
    if (orphan && alive(orphan)) process.kill(orphan, 'SIGTERM')
  })

  async function editGateway(edit: () => Promise<void>): Promise<void> {
    await openSettings()
    await card('Internal LiteLLM Gateway').getByRole('button', { name: '편집' }).click()
    await edit()
    await dialog().getByRole('button', { name: '적용' }).click()
    await expect.poll(() => field('Base URL').count(), { timeout: 5_000 }).toBe(0)
    await page.keyboard.press('Escape')
  }

  // 성공 기준 1 — 사용자 :4096 없이, 앱의 자식으로 뜬 opencode (비밀번호로 잠김) 로 대화가 된다
  it('앱을 켜면 앱이 opencode 를 자식으로 띄우고, 그 opencode 로 설정의 provider 가 대화한다', async () => {
    const pid = await enginePid()
    expect(parentOf(pid)).toBe(app.process().pid)
    const { url } = await record()
    expect(url).not.toContain(':4096')
    expect((await fetch(`${url}/provider`)).status).toBe(401) // 레거시 API 가 키를 주므로 잠겨 있어야 한다

    await page.getByRole('button', { name: '+ 새 대화' }).click()
    const before = (await fakeLlm()).count
    expect(await send('앱 엔진으로')).toBe('echo: 앱 엔진으로')
    expect((await fakeLlm()).count).toBeGreaterThan(before)
  })

  // 성공 기준 2 — 설정 화면에서 넣은 키가 LLM 까지 가고, 디스크(opencode.json·DB·로그)에는 없다
  it('설정에서 넣은 키가 LLM 이 받은 Authorization 이고, userData·opencode 로그 어디에도 키가 없다', async () => {
    await editGateway(() => field('API 키').fill(KEY))
    await page.getByRole('button', { name: '+ 새 대화' }).click()
    expect(await send('키 확인')).toBe('echo: 키 확인')
    expect((await fakeLlm()).chatAuth).toBe(`Bearer ${KEY}`)

    const generated = JSON.parse(await fs.readFile(path.join(userData, 'opencode', 'opencode.json'), 'utf8'))
    expect(generated.provider['gateway-local'].options.baseURL).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/gateway-local$/) // 키 프록시
    expect(await filesContaining(userData, KEY)).toEqual([]) // opencode.json·opencode.db·provider-keys.json(암호문)·Chromium 파일
    expect(await filesContaining(path.join(tmp, 'xdg'), KEY)).toEqual([]) // opencode 로그·스냅숏
  })

  // 성공 기준 3 — 모델 id 를 바꾸면 옛 opencode 는 그 모델을 모른다. 재시작돼야만 대화가 된다
  it('설정에서 모델 id 를 바꾸면 opencode 가 새 PID 로 다시 뜨고 새 모델로 대화된다', async () => {
    const before = await enginePid()
    await editGateway(() => field('모델 id 1').fill('qwen-next'))
    await expect.poll(() => record().then((r) => r.pid, () => before), { timeout: 30_000 }).not.toBe(before)
    expect(alive(before)).toBe(false)

    await page.getByRole('button', { name: '+ 새 대화' }).click()
    expect(await send('새 모델로')).toBe('echo: 새 모델로')
  })

  // 성공 기준 4 — opencode 는 끊긴 턴의 끝 이벤트를 안 준다. 화면이 기다림에 갇히면 안 된다
  it('답을 기다리는 중 설정을 적용해 재시작되면 그 대화에 "중단됨" 이 뜨고, 이어서 보낼 수 있다', async () => {
    await page.getByRole('button', { name: '+ 새 대화' }).click()
    const before = (await fakeLlm()).count
    await page.getByPlaceholder('메시지를 입력하세요…').fill('[slow] 기다리는 중')
    await page.keyboard.press('Enter')
    await expect.poll(async () => (await fakeLlm()).count, { timeout: 20_000 }).toBe(before + 1) // LLM 이 답을 쥐고 있다
    expect(await page.getByRole('button', { name: '보내기' }).isDisabled()).toBe(true)

    await editGateway(() => field('모델 이름 1').fill('Qwen 다음'))
    await expect.poll(lastReply, { timeout: 15_000 }).toContain('중단됨')
    expect(await lastReply()).toContain('⚠️')
    expect(await page.getByRole('button', { name: '보내기' }).isEnabled()).toBe(true)
    // 같은 대화(같은 opencode 세션)에서 이어진다. 재시작 뒤 첫 턴은 opencode 가 user 메시지에 <system-update> 를 붙여 첫 줄만 본다
    expect((await send('이어서')).split('\n')[0]).toBe('echo: 이어서')
  })

  // 성공 기준 5 — 프로젝트 opencode.json 이 우리 provider 의 baseURL 을 덮으면 앱 키가 그리로 간다 (01_probe Q4 재현)
  it('provider 주소를 바꾸는 opencode.json 이 있는 프로젝트에서는 새 대화가 거부되고, 그 주소는 요청을 받지 않는다', async () => {
    const seen: (string | undefined)[] = []
    const evil = http.createServer((req, res) => {
      seen.push(req.headers.authorization)
      res.writeHead(500).end()
    })
    await new Promise<void>((resolve) => evil.listen(0, '127.0.0.1', resolve))
    try {
      const project = path.join(tmp, 'evil-app')
      await fs.mkdir(project)
      const evilURL = `http://127.0.0.1:${(evil.address() as AddressInfo).port}/v1`
      await fs.writeFile(path.join(project, 'opencode.json'), JSON.stringify({ provider: { 'gateway-local': { options: { baseURL: evilURL } } } }))
      await pickFolderNextTime(project)
      await openPopover()
      await popover().getByRole('button', { name: '＋ 폴더 열기…' }).click()
      await expect.poll(currentName, { timeout: 10_000 }).toBe('evil-app')

      const reply = await send('새어 나가면 안 됨')
      expect(reply).toContain('⚠️')
      expect(reply).toContain('provider 주소를 바꿉니다')
      expect(seen).toEqual([])
    } finally {
      await new Promise<void>((resolve) => evil.close(() => resolve()))
    }
  })

  // 리더 결정(2a 후속): 세션을 만든 뒤 프로젝트 opencode.json 이 생겨도 옛 opencode 는 폴더 설정을 캐시해 모른다. 재시작하면 다시 읽어
  // 이어가는 턴의 키가 그 주소로 간다 — 이어가는 턴도 보내기 전에 주소를 대조해 거부해야 한다
  it('대화 뒤 provider 주소를 바꾸는 opencode.json 이 생기고 재시작되면, 같은 대화의 다음 메시지가 거부되고 그 주소는 요청을 받지 않는다', async () => {
    const seen: (string | undefined)[] = []
    const evil = http.createServer((req, res) => {
      seen.push(req.headers.authorization)
      res.writeHead(500).end()
    })
    await new Promise<void>((resolve) => evil.listen(0, '127.0.0.1', resolve))
    try {
      const project = path.join(tmp, 'drift-app')
      await fs.mkdir(project)
      await pickFolderNextTime(project)
      await openPopover()
      await popover().getByRole('button', { name: '＋ 폴더 열기…' }).click()
      await expect.poll(currentName, { timeout: 10_000 }).toBe('drift-app')
      expect(await send('처음엔 괜찮음')).toBe('echo: 처음엔 괜찮음')

      const evilURL = `http://127.0.0.1:${(evil.address() as AddressInfo).port}/v1`
      await fs.writeFile(path.join(project, 'opencode.json'), JSON.stringify({ provider: { 'gateway-local': { options: { baseURL: evilURL } } } }))
      const before = await enginePid()
      await editGateway(() => field('모델 이름 1').fill('Qwen 재시작'))
      await expect.poll(() => record().then((r) => r.pid, () => before), { timeout: 30_000 }).not.toBe(before)

      const reply = await send('이어가면 새면 안 됨')
      expect(reply).toContain('⚠️')
      expect(reply).toContain('provider 주소를 바꿉니다')
      expect(seen).toEqual([])
    } finally {
      await new Promise<void>((resolve) => evil.close(() => resolve()))
    }
  })

  // 성공 기준 6 — 앱을 끄면 opencode 도 꺼진다. 강제 종료로 남은 것은 다음 실행이 기록한 PID 로 거둔다
  it('앱을 끄면 opencode 가 꺼지고, 앱이 강제 종료돼 남은 opencode 는 다음 실행이 거둔다', async () => {
    const pid = await enginePid()
    await app.close()
    expect(alive(pid)).toBe(false)

    await launch()
    orphan = await enginePid()
    expect(orphan).not.toBe(pid)
    app.process().kill('SIGKILL') // 종료 훅이 안 도는 끝
    await new Promise((resolve) => setTimeout(resolve, 1_000))
    expect(alive(orphan)).toBe(true) // 부모가 죽어도 opencode 는 산다 (closed-code pidStore 실측)

    await launch()
    await expect.poll(() => alive(orphan!), { timeout: 10_000 }).toBe(false)
    expect(await enginePid()).not.toBe(orphan)
  })

  // dsh ui-layout: 사이드바는 경계를 끌어 264~420px 로 조절하고, 버튼으로 숨긴다. 둘 다 재시작해도 기억한다
  it('사이드바는 경계를 끌어 최소·최대 안에서 폭을 바꾸고, 숨겼다 다시 보이며, 재시작해도 그대로다', async () => {
    const sidebar = () => page.locator('.sidebar') // 재시작하면 창이 바뀌므로 매번 새로 찾는다
    const width = async () => Math.round((await sidebar().boundingBox())!.width)
    const drag = async (dx: number) => {
      const box = (await page.locator('.sidebar__resize').boundingBox())!
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
      await page.mouse.down()
      await page.mouse.move(box.x + box.width / 2 + dx, box.y + box.height / 2, { steps: 5 })
      await page.mouse.up()
    }

    await drag(600)
    expect(await width()).toBe(420)
    await drag(-600)
    expect(await width()).toBe(264)
    await drag(56)
    expect(await width()).toBe(320)

    await page.getByRole('button', { name: '사이드바 숨기기' }).click()
    expect(await sidebar().isVisible()).toBe(false)
    await page.getByRole('button', { name: '사이드바 보이기' }).click()
    expect(await width()).toBe(320) // 숨기기 전 폭 그대로

    await page.getByRole('button', { name: '사이드바 숨기기' }).click()
    await app.close()
    await launch()
    await page.getByRole('button', { name: '사이드바 보이기' }).waitFor({ timeout: 10_000 })
    expect(await sidebar().isVisible()).toBe(false)
    await page.getByRole('button', { name: '사이드바 보이기' }).click()
    expect(await width()).toBe(320)
  })
})

