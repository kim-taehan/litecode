import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core'
import { createServer, type ViteDevServer } from 'vite'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import { freePort } from './support/opencodeServer.ts'
import { badgeColor } from '../../renderer/badge.ts'

// 앱 실물 테스트 — 진짜 Electron 창을 띄워 사람처럼 입력하고, 답이 화면에 뜨는지 본다.
// 렌더러 → preload → IPC → ctx.llm → opencode → (가짜) LLM 을 한 번에 관통한다.
// 단위 테스트·타입체크가 초록이어도 채널 이름 불일치(preload.cts 는 채널을 손으로 옮겨 적는다)나
// preload 로딩 실패는 여기서만 잡힌다.
//
// 가짜로 두는 것은 OS 폴더 대화상자뿐이다(app.evaluate 로 dialog.showOpenDialog 를 바꿔치기) — 그 뒤의
// IPC·최근 목록 저장·opencode 는 실물. userData 는 --user-data-dir 로 테스트 임시 폴더에 둔다
// (Electron 33 은 이 스위치로 app.getPath('userData') 를 바꾼다 — 2026-09-30 실측). 사용자 앱 데이터에 쓰지 않는다.

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
    args: ['.', `--user-data-dir=${userData}`],
    cwd: root,
    env: { ...process.env, LITECODE_DEV_SERVER_URL: devServerUrl, OPENCODE_URL: inject('opencodeUrl') },
  })
  page = await app.firstWindow()
  await page.getByText('연결됨').waitFor()
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
async function switchTo(name: string): Promise<void> {
  await switcher().click()
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
    await switcher().click()
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
    await switcher().click()
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

    await switcher().click()
    expect(await popover().count()).toBe(1)
    await page.locator('.main__messages').click()
    expect(await popover().count()).toBe(0)
  })

  // dsh ui-primitives Menu: ↑/↓ 로 행을 돌고(끝에서 처음으로), 고르거나 Esc 로 닫으면 포커스가 전환 버튼으로 돌아온다
  it('팝오버는 키보드로 걷고 고를 수 있고, 닫히면 포커스가 전환 버튼으로 돌아온다', async () => {
    await switcher().click()
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

    await switcher().click()
    await page.keyboard.press('Escape')
    expect(await popover().count()).toBe(0)
    expect(await focused()).toContain('alpha-app')

    await switchTo('beta-app') // 다음 테스트(재시작)는 B 가 마지막이어야 한다
  })

  it('앱을 껐다 켜면 마지막 프로젝트(B)가 열려 있고 최근 목록에 A·B 가 남아 있다', async () => {
    await app.close()
    await launch()

    await expect.poll(currentName, { timeout: 10_000 }).toBe('beta-app')
    await switcher().click()
    expect(await popoverNames()).toEqual(['beta-app', 'alpha-app'])
    // 저장이 사용자 앱 데이터가 아니라 이 테스트의 userData 에 됐는지
    expect(JSON.parse(await fs.readFile(path.join(userData, 'projects.json'), 'utf8'))).toEqual({ recent: [beta, alpha], favorites: [] })
    await page.keyboard.press('Escape')
  })

  // dsh ui-workspace: 고른 폴더를 못 열면 사유를 보여주고 현재 선택은 그대로 둔다
  it('지워진 최근 프로젝트를 고르면 팝오버에 사유를 보이고 현재 프로젝트는 그대로다', async () => {
    const gamma = path.join(tmp, 'gamma-app')
    await fs.mkdir(gamma)
    await pickFolderNextTime(gamma)
    await switcher().click()
    await popover().getByRole('button', { name: '＋ 폴더 열기…' }).click()
    await expect.poll(currentName, { timeout: 10_000 }).toBe('gamma-app')
    await switchTo('beta-app')
    await fs.rm(gamma, { recursive: true })

    await switcher().click()
    await popover().locator('.project-item', { hasText: 'gamma-app' }).click()

    await expect.poll(() => popover().getByRole('alert').textContent({ timeout: 1_000 }), { timeout: 5_000 }).toContain(gamma)
    expect(await currentName()).toBe('beta-app')
  })

  // 성공 기준 7 — dsh ui-workspace 의 pin: 고정한 것은 앞 묶음에, 원래 자리에는 중복 없이
  it('즐겨찾기한 프로젝트는 즐겨찾기 묶음에만 있고, 검색은 두 묶음에 걸리며, 재시작해도 남는다', async () => {
    await page.keyboard.press('Escape') // 앞 테스트가 열어 둔 팝오버
    await switcher().click()
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
    await switcher().click()
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

    // 키보드: ↓ 로 alpha 행 → Tab 으로 ★ → Tab 으로 × → Enter
    await popover().getByPlaceholder('프로젝트 검색…').focus()
    await page.keyboard.press('ArrowDown')
    expect(await focused()).toContain('alpha-app')
    await page.keyboard.press('Tab')
    await page.keyboard.press('Tab')
    expect(await page.evaluate(() => document.activeElement?.getAttribute('aria-label'))).toBe('목록에서 빼기')
    await page.keyboard.press('Enter')

    await expect.poll(popoverNames, { timeout: 5_000 }).toEqual(['beta-app'])
    expect(await currentName()).toBe('beta-app')
    expect(await isDirectory(alpha)).toBe(true)
    expect(await fs.readFile(path.join(alpha, 'keep.txt'), 'utf8')).toBe('keep')
    expect(JSON.parse(await fs.readFile(path.join(userData, 'projects.json'), 'utf8'))).toEqual({ recent: [beta], favorites: [] })
  })

  // 성공 기준 9 — 현재 프로젝트를 빼면 다음 프로젝트로, 없으면 첫 실행 안내로. 뺀 프로젝트의 메모리 속 대화는 버린다
  it('현재 프로젝트를 빼면 다음 프로젝트로, 마지막이면 첫 실행 안내로 간다', async () => {
    await pickFolderNextTime(alpha)
    await popover().getByRole('button', { name: '＋ 폴더 열기…' }).click()
    await expect.poll(currentName, { timeout: 10_000 }).toBe('alpha-app')
    expect(await sessionTitles()).toEqual(['새 대화']) // 빼기 전의 A 대화는 버려졌다

    await switcher().click()
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
    await switcher().click()
    await popover().getByRole('button', { name: '＋ 폴더 열기…' }).click()
    await expect.poll(currentName, { timeout: 10_000 }).toBe('davis-frontend')

    await switcher().click()
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

    await switcher().click()
    expect(await popoverNames()).toEqual(['davis-frontend', 'davis-code'])
    await row('davis-frontend').hover()
    await row('davis-frontend').getByRole('button', { name: '목록에서 빼기', exact: true }).click()
    await expect.poll(popoverNames, { timeout: 5_000 }).toEqual(['davis-code'])
  })
})
