import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core'
import { createServer, type ViteDevServer } from 'vite'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import { alive, freePort, isolatedEnv } from './support/opencodeServer.ts'

// 알림 실물 테스트 — 진짜 Electron 창·IPC·ctx.notifications 를 관통한다: 메인 판정 → PC 알림(기록) / 토스트·점(화면) → 누르면 그 프로젝트·대화.
// 테스트 모드(LITECODE_TEST_HIDDEN=1)는 OS 알림·배지·창 앞으로 부르기를 기록으로 바꾸고(사용자 화면에 알림 0), 앞/뒤 판정을 주입받는다
// (globalThis.__litecodeNotifyTest — electron/main.ts). 끝남·실패·중단·실행 중·질문 대기는 실제 턴(가짜 LLM 의 `[late]`·`[fail]`·`[slow]`·
// `[call:question …]`)으로 만든다. 알림 설정·거두기 시나리오의 끝남만 ctx.llm 이벤트를 흉내 내 쏜다 (판정만 본다).

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

let vite: ViteDevServer
let devServerUrl: string
let app: ElectronApplication
let page: Page
/** 이 테스트가 만든 임시 폴더 — 끝나면 이 경로만 지운다 */
let tmp: string
let userData: string
let alpha: string
let beta: string
/** 대화 제목 → { id, engineSessionId } */
const conv: Record<string, { id: string; session: string; project: string }> = {}

function appEnv(): Record<string, string> {
  return { ...(isolatedEnv(tmp) as Record<string, string>), LITECODE_TEST_HIDDEN: '1', LITECODE_DEV_SERVER_URL: devServerUrl, LITECODE_GATEWAY_URL: `${inject('fakeLlmUrl')}/v1` }
}

beforeAll(async () => {
  execFileSync(path.join(root, 'node_modules/.bin/tsc'), ['-p', 'tsconfig.electron.json'], { cwd: root, stdio: 'inherit' })
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'litecode-notify-')))
  userData = path.join(tmp, 'userData')
  alpha = path.join(tmp, 'alpha-app')
  beta = path.join(tmp, 'beta-app')
  await fs.mkdir(alpha)
  await fs.mkdir(beta)

  const port = await freePort()
  vite = await createServer({ configFile: path.join(root, 'vite.config.ts'), server: { port, strictPort: true } })
  await vite.listen()
  devServerUrl = `http://localhost:${port}`

  app = await electron.launch({ args: ['.', `--user-data-dir=${userData}`, '--use-mock-keychain'], cwd: root, env: appEnv() })
  page = await app.firstWindow()
  await page.locator('.sidebar-toggle:visible').waitFor()

  // 대화 셋을 실제 턴으로 만든다 (alpha 둘, beta 하나). 만드는 동안은 "앞 + 그 대화를 봄" 으로 쳐서 — 실제 턴이 이벤트를 내는
  // 채팅 라운드를 합친 뒤에도 — 준비 턴이 알림을 남기지 않게 한다
  await setForeground(true)
  await pickFolderNextTime(alpha)
  await page.locator('.open-guide').getByRole('button', { name: '폴더 열기…' }).click()
  await send('hello one')
  await page.locator('.new-chat').click()
  await send('hello two')
  await pickFolderNextTime(beta)
  await page.locator('.project-switch').click()
  await page.locator('.project-popover__open').click()
  await page.locator('.project-switch__name', { hasText: 'beta-app' }).waitFor({ timeout: 10_000 })
  await send('hello three')
  for (const entry of await page.evaluate(() => window.litecode.listConversations())) {
    conv[entry.title] = { id: entry.id, session: entry.engineSessionId!, project: entry.project }
  }
  expect(Object.keys(conv).sort()).toEqual(['hello one', 'hello three', 'hello two'])
})

afterAll(async () => {
  await app?.close()
  await vite?.close()
  if (tmp) await fs.rm(tmp, { recursive: true, force: true })
})

async function pickFolderNextTime(dir: string): Promise<void> {
  await app.evaluate(({ dialog }, picked) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [picked] })) as typeof dialog.showOpenDialog
  }, dir)
}

async function send(text: string): Promise<void> {
  const before = await page.locator('.bubble--assistant').count()
  await submit(text)
  await page.locator('.bubble--assistant').nth(before).waitFor({ timeout: 30_000 }) // beforeAll 에서도 쓴다 — expect.poll 은 테스트 안에서만
}

/** 보내기만 하고 답을 기다리지 않는다 — 턴이 도는 동안 다른 대화·프로젝트로 옮겨 간다 */
async function submit(text: string): Promise<void> {
  await page.getByPlaceholder('메시지를 입력하세요…').fill(text)
  await page.keyboard.press('Enter')
}

/** 지금 프로젝트의 그 대화를 연다 */
async function openChat(title: string): Promise<void> {
  await page.locator('.session-item', { hasText: title }).click()
  await expect.poll(activeTitle, { timeout: 5_000 }).toBe(title)
}

const fakeLlmCount = async () => ((await (await fetch(`${inject('fakeLlmUrl')}/requests`)).json()) as { count: number }).count

const currentName = () => page.locator('.project-switch__name').textContent({ timeout: 1_000 })
const activeTitle = () => page.locator('.session-item--active .session-item__title').textContent({ timeout: 1_000 })

interface Recorded {
  title: string
  body: string
  closed: boolean
}
type TestGlobal = { __litecodeNotifyTest: { record: { foreground: boolean; shown: (Recorded & { click(): void })[]; badge: number[]; reveals: number }; emit(name: string, payload: unknown): void } }

const shown = () => app.evaluate(() => (globalThis as unknown as TestGlobal).__litecodeNotifyTest.record.shown.map(({ title, body, closed }) => ({ title, body, closed })))
const reveals = () => app.evaluate(() => (globalThis as unknown as TestGlobal).__litecodeNotifyTest.record.reveals)
const lastBadge = () => app.evaluate(() => (globalThis as unknown as TestGlobal).__litecodeNotifyTest.record.badge.at(-1))
const setForeground = (foreground: boolean) =>
  app.evaluate((_electron, value) => void ((globalThis as unknown as TestGlobal).__litecodeNotifyTest.record.foreground = value), foreground)
/** 기록을 비운다 — 시나리오마다 자기 것만 본다 */
const resetRecord = () =>
  app.evaluate(() => {
    const record = (globalThis as unknown as TestGlobal).__litecodeNotifyTest.record
    record.shown.length = 0
    record.badge.length = 0
    record.reveals = 0
  })
/** 기록된 PC 알림을 누른다 (닫힌 것도 — 알림 센터에 남은 옛 알림을 흉내) */
const clickShown = (index: number) => app.evaluate((_electron, at) => (globalThis as unknown as TestGlobal).__litecodeNotifyTest.record.shown[at]!.click(), index)
/** ctx.llm 의 이벤트를 흉내 낸다 */
const emit = (name: string, payload: unknown) => app.evaluate((_electron, [event, body]) => (globalThis as unknown as TestGlobal).__litecodeNotifyTest.emit(event as string, body), [name, payload] as const)
const ended = (title: string, outcome: 'done' | 'failed' | 'interrupted') => emit('llm/turn-ended', { sessionId: conv[title]!.session, directory: conv[title]!.project, outcome })
const state = () => page.evaluate(() => window.litecode.getNotifications())
const rowDot = (title: string) => page.locator('.session-item', { hasText: title }).locator('.notice-dot')
const switchDot = () => page.locator('.project-switch .notice-dot')
const popover = () => page.locator('.project-popover')

async function switchTo(name: string): Promise<void> {
  if (!(await popover().isVisible())) await page.locator('.project-switch').click()
  await popover().locator('.project-item', { hasText: name }).locator('.project-item__main').click()
  await expect.poll(currentName, { timeout: 10_000 }).toBe(name)
}

describe('알림', () => {
  it('뒤(포커스 없음)에서 끝나면 PC 알림 — 제목은 대화 제목, 본문은 "프로젝트 · 상태"(답 없음). 다른 프로젝트라 전환 버튼·팝오버 행에 점, 배지 1', async () => {
    await setForeground(false)
    await switchTo('alpha-app')
    await openChat('hello one')
    await resetRecord()
    await submit('[late] one again') // 답이 3초 늦다 — 그 사이 다른 프로젝트로
    await switchTo('beta-app')
    await page.keyboard.press('Escape')
    await expect.poll(shown, { timeout: 15_000 }).toEqual([{ title: 'hello one', body: 'alpha-app · 끝났습니다', closed: false }])
    expect(JSON.stringify(await shown())).not.toContain('echo')
    await expect.poll(() => switchDot().getAttribute('data-status'), { timeout: 5_000 }).toBe('done')
    expect(await lastBadge()).toBe(1)
    await page.locator('.project-switch').click()
    expect(await popover().locator('.project-item', { hasText: 'alpha-app' }).locator('.notice-dot').getAttribute('data-status')).toBe('done')
    expect(await popover().locator('.project-item', { hasText: 'beta-app' }).locator('.notice-dot').count()).toBe(0)
    await page.keyboard.press('Escape')
  })

  it('PC 알림을 누르면 창을 앞으로 부르고 그 프로젝트·대화가 열린다 — 그 알림은 닫히고 점·배지가 사라진다', async () => {
    await clickShown(0)
    expect(await reveals()).toBe(1)
    await expect.poll(currentName, { timeout: 10_000 }).toBe('alpha-app')
    await expect.poll(activeTitle, { timeout: 10_000 }).toBe('hello one')
    await expect.poll(state, { timeout: 5_000 }).toEqual({})
    expect((await shown())[0]!.closed).toBe(true)
    expect(await lastBadge()).toBe(0)
    expect(await switchDot().count()).toBe(0)
  })

  it('앞에서 같은 프로젝트의 다른 대화가 끝나면 PC 알림 없이 토스트 + 행 점. 토스트를 누르면 그 대화로', async () => {
    await setForeground(true)
    await resetRecord()
    await openChat('hello two')
    await submit('[late] two again')
    await openChat('hello one')
    const toast = page.locator('.toast', { hasText: 'hello two' })
    await toast.waitFor({ timeout: 15_000 })
    expect(await toast.textContent()).toContain('alpha-app · 끝났습니다')
    await expect.poll(() => rowDot('hello two').getAttribute('data-status'), { timeout: 5_000 }).toBe('done')
    expect(await rowDot('hello one').count()).toBe(0)
    expect(await shown()).toEqual([])
    await toast.click()
    await expect.poll(activeTitle, { timeout: 5_000 }).toBe('hello two')
    await expect.poll(() => rowDot('hello two').count(), { timeout: 5_000 }).toBe(0)
  })

  it('앞에서 다른 프로젝트 대화가 실패하면 토스트 — 누르면 그 프로젝트로 넘어가 그 대화가 열린다. 실패 사유는 싣지 않는다', async () => {
    await switchTo('beta-app')
    await page.keyboard.press('Escape')
    await openChat('hello three')
    await submit('[late][fail] three fails') // 가짜 LLM 이 3초 뒤 400 (사유 "fake-llm: 요청된 실패")
    await switchTo('alpha-app')
    await page.keyboard.press('Escape')
    const toast = page.locator('.toast', { hasText: 'hello three' })
    await toast.waitFor({ timeout: 15_000 })
    expect(await toast.textContent()).toContain('beta-app · 실패했습니다')
    expect(await toast.textContent()).not.toContain('fake-llm')
    await expect.poll(() => switchDot().getAttribute('data-status'), { timeout: 5_000 }).toBe('failed')
    await toast.click()
    await expect.poll(currentName, { timeout: 10_000 }).toBe('beta-app')
    await expect.poll(activeTitle, { timeout: 5_000 }).toBe('hello three')
    await expect.poll(state, { timeout: 5_000 }).toEqual({})
    expect(await shown()).toEqual([])
  })

  it('앞에서 보고 있는 그 대화는 실행 중 점만 — 끝나도 토스트·PC 알림·점이 없다', async () => {
    await page.locator('.toast').first().waitFor({ state: 'detached', timeout: 10_000 }).catch(() => {})
    const toastsBefore = await page.locator('.toast').count()
    await submit('[late] three again')
    await expect.poll(() => rowDot('hello three').getAttribute('data-status'), { timeout: 10_000 }).toBe('running')
    await page.locator('.bubble--assistant', { hasText: 'echo: [late] three again' }).waitFor({ timeout: 15_000 })
    await expect.poll(() => rowDot('hello three').count(), { timeout: 5_000 }).toBe(0)
    expect(await page.locator('.toast').count()).toBe(toastsBefore)
    expect(await shown()).toEqual([])
    expect(await state()).toEqual({})
  })

  it('질문 대기(실제 question 턴)는 "답 필요" 점과 PC 알림(질문 내용 없음) — 카드로 답하면 그 알림이 닫힌다', async () => {
    await setForeground(false)
    await resetRecord()
    // 지금 보는 beta 의 hello three — 뒤(포커스 없음)라 보고 있어도 PC 알림이다
    await submit('[call:question {"questions":[{"question":"Which DB?","header":"DB","options":[{"label":"Postgres","description":"pg"},{"label":"SQLite","description":"file"}]}]}]')
    await expect.poll(shown, { timeout: 30_000 }).toEqual([{ title: 'hello three', body: 'beta-app · 질문에 답을 기다립니다', closed: false }])
    expect(JSON.stringify(await shown())).not.toContain('Which DB')
    await expect.poll(() => rowDot('hello three').getAttribute('data-status'), { timeout: 5_000 }).toBe('attention')
    expect(await lastBadge()).toBe(1)
    const card = page.locator('.attention-card[data-kind="question"]')
    await card.locator('.attention-question__option', { hasText: 'SQLite' }).click()
    await card.getByRole('button', { name: '답 보내기' }).click()
    await expect.poll(async () => (await shown())[0]!.closed, { timeout: 10_000 }).toBe(true)
    await page.locator('.bubble--assistant', { hasText: '"Which DB?"="SQLite"' }).waitFor({ timeout: 30_000 })
    // 뒤에서 끝났으니 끝남 점이 남는다 — 다음 시나리오가 다른 프로젝트 점을 보므로 앞으로 와서 그 대화를 읽음으로
    await expect.poll(() => rowDot('hello three').getAttribute('data-status'), { timeout: 5_000 }).toBe('done')
    await setForeground(true)
    await page.evaluate((id) => window.litecode.viewConversation(id), conv['hello three']!.id)
    await expect.poll(() => rowDot('hello three').count(), { timeout: 5_000 }).toBe(0)
    await setForeground(false)
  })

  // 새 대화의 첫 턴 — 엔진 세션이 그 턴 안에서 생긴다. 화면은 답이 온 뒤에야 그 세션 id 를 알므로, 메인이 미리 대화에 붙여야 알림이 간다
  it('새 대화의 첫 턴: 앞에서 다른 대화를 보고 있으면 토스트 + 행 점', async () => {
    await setForeground(true)
    await resetRecord()
    await page.locator('.new-chat').click()
    await submit('[late] fresh front')
    await openChat('hello three')
    const toast = page.locator('.toast', { hasText: '[late] fresh front' })
    await toast.waitFor({ timeout: 15_000 })
    expect(await toast.textContent()).toContain('beta-app · 끝났습니다')
    await expect.poll(() => rowDot('[late] fresh front').getAttribute('data-status'), { timeout: 5_000 }).toBe('done')
    expect(await shown()).toEqual([])
    await openChat('[late] fresh front') // 읽음으로 — 다음 시나리오에 점을 남기지 않는다
    await expect.poll(state, { timeout: 5_000 }).toEqual({})
  })

  it('새 대화의 첫 턴: 뒤에서 끝나면 PC 알림', async () => {
    await setForeground(false)
    await resetRecord()
    await page.locator('.new-chat').click()
    await submit('[late] fresh back')
    await expect.poll(shown, { timeout: 15_000 }).toEqual([{ title: '[late] fresh back', body: 'beta-app · 끝났습니다', closed: false }])
    await setForeground(true)
    await openChat('hello three')
    await openChat('[late] fresh back')
    await expect.poll(state, { timeout: 5_000 }).toEqual({})
  })

  it('새 대화의 첫 턴: 질문 대기는 "답 필요" 점과 PC 알림', async () => {
    await setForeground(false)
    await resetRecord()
    await page.locator('.new-chat').click()
    const prompt = '[call:question {"questions":[{"question":"Which OS?","header":"OS","options":[{"label":"mac","description":"m"},{"label":"linux","description":"l"}]}]}]'
    await submit(prompt)
    const title = prompt.slice(0, 80) // 제목은 첫 줄 80자까지
    await expect.poll(shown, { timeout: 30_000 }).toEqual([{ title, body: 'beta-app · 질문에 답을 기다립니다', closed: false }])
    await expect.poll(() => rowDot(title).getAttribute('data-status'), { timeout: 5_000 }).toBe('attention')
    const card = page.locator('.attention-card[data-kind="question"]')
    await card.locator('.attention-question__option', { hasText: 'linux' }).click()
    await card.getByRole('button', { name: '답 보내기' }).click()
    await page.locator('.bubble--assistant', { hasText: '"Which OS?"="linux"' }).waitFor({ timeout: 30_000 })
    await setForeground(true)
    const id = (await page.evaluate(() => window.litecode.listConversations())).find((entry) => entry.title === title)!.id
    await page.evaluate((conversationId) => window.litecode.viewConversation(conversationId), id)
    await expect.poll(state, { timeout: 5_000 }).toEqual({})
    await setForeground(false)
  })

  it('중단(답을 기다리는 중 provider 저장으로 엔진 재시작)은 PC 알림 없이 앱 안 점만', async () => {
    await resetRecord()
    await switchTo('alpha-app')
    await page.keyboard.press('Escape')
    await openChat('hello two')
    const before = await fakeLlmCount()
    await submit('[slow] two slow')
    await expect.poll(fakeLlmCount, { timeout: 20_000 }).toBe(before + 1) // LLM 이 답을 쥐고 있다
    await switchTo('beta-app')
    await page.keyboard.press('Escape')
    const engine = async () => (JSON.parse(await fs.readFile(path.join(userData, 'opencode-server.json'), 'utf8')) as { pid: number }).pid
    const pid = await engine()
    await page.evaluate(async () => {
      const [provider] = await window.litecode.listProviders()
      await window.litecode.saveProvider({ id: provider!.id, displayName: provider!.displayName, baseURL: provider!.baseURL, protocol: provider!.protocol, models: provider!.models })
    })
    await expect.poll(() => engine().catch(() => pid), { timeout: 30_000 }).not.toBe(pid)
    await expect.poll(() => switchDot().getAttribute('data-status'), { timeout: 15_000 }).toBe('interrupted')
    expect(await shown()).toEqual([])
    await switchTo('alpha-app')
    await expect.poll(() => rowDot('hello two').getAttribute('data-status'), { timeout: 5_000 }).toBe('interrupted')
  })

  it('설정 > 일반 "알림" 을 끄면 PC 알림만 없다 — 점은 그대로. 다시 켜면 돌아온다', async () => {
    await page.getByRole('button', { name: '설정', exact: true }).click()
    const dialog = page.locator('.settings-panel')
    await dialog.getByRole('button', { name: '일반', exact: true }).click()
    const toggle = dialog.getByRole('switch', { name: '알림' })
    expect(await toggle.getAttribute('aria-checked')).toBe('true')
    await toggle.click()
    await expect.poll(() => toggle.getAttribute('aria-checked'), { timeout: 5_000 }).toBe('false')
    await page.keyboard.press('Escape')
    expect(JSON.parse(await fs.readFile(path.join(userData, 'settings.json'), 'utf8')).notifications).toBe(false)

    await resetRecord()
    await ended('hello three', 'done')
    await expect.poll(() => switchDot().getAttribute('data-status'), { timeout: 5_000 }).toBe('done')
    expect(await shown()).toEqual([])

    await page.getByRole('button', { name: '설정', exact: true }).click()
    await dialog.getByRole('button', { name: '일반', exact: true }).click()
    await toggle.click()
    await expect.poll(() => toggle.getAttribute('aria-checked'), { timeout: 5_000 }).toBe('true')
    await page.keyboard.press('Escape')
    await ended('hello three', 'done')
    await expect.poll(shown, { timeout: 5_000 }).toEqual([{ title: 'hello three', body: 'beta-app · 끝났습니다', closed: false }])
  })

  it('대화를 지우면 그 알림을 거두고, 그래도 눌린 옛 알림은 프로젝트만 열고 "대화가 지워졌습니다" (Q8)', async () => {
    await resetRecord()
    await ended('hello two', 'done')
    await expect.poll(shown, { timeout: 5_000 }).toEqual([{ title: 'hello two', body: 'alpha-app · 끝났습니다', closed: false }])
    const row = page.locator('.session-item', { hasText: 'hello two' })
    await row.hover()
    await row.getByRole('button', { name: '대화 삭제' }).click()
    await row.getByRole('button', { name: '삭제 확인' }).click()
    await expect.poll(async () => (await shown())[0]!.closed, { timeout: 5_000 }).toBe(true)
    expect((await state())[conv['hello two']!.id]).toBeUndefined()

    await switchTo('beta-app')
    await clickShown(0)
    await expect.poll(currentName, { timeout: 10_000 }).toBe('alpha-app')
    await page.locator('.toast', { hasText: '대화가 지워졌습니다' }).waitFor({ timeout: 5_000 })
  })

  it('목록에서 뺀 프로젝트는 그 알림을 거두고, 눌린 옛 알림은 프로젝트를 다시 넣고 그 대화를 연다 (Q8)', async () => {
    await setForeground(false)
    await resetRecord()
    await ended('hello three', 'done')
    await expect.poll(shown, { timeout: 5_000 }).toHaveLength(1)
    await page.locator('.project-switch').click()
    const betaRow = popover().locator('.project-item', { hasText: 'beta-app' })
    await betaRow.hover()
    await betaRow.getByRole('button', { name: '목록에서 빼기' }).click()
    await expect.poll(() => popover().locator('.project-item', { hasText: 'beta-app' }).count(), { timeout: 5_000 }).toBe(0)
    await expect.poll(async () => (await shown())[0]!.closed, { timeout: 5_000 }).toBe(true)
    await page.keyboard.press('Escape')

    await clickShown(0)
    await expect.poll(currentName, { timeout: 10_000 }).toBe('beta-app')
    await expect.poll(activeTitle, { timeout: 5_000 }).toBe('hello three')
    expect((await page.evaluate(() => window.litecode.listProjects())).map((project) => project.name)).toContain('beta-app')
  })

  it('폴더가 사라진 프로젝트의 알림을 누르면 기존 "폴더를 열 수 없습니다" 사유가 팝오버에 — 앱은 그대로', async () => {
    await setForeground(false)
    await resetRecord()
    await ended('hello one', 'done')
    await expect.poll(shown, { timeout: 5_000 }).toHaveLength(1)
    await fs.rm(alpha, { recursive: true }) // 이 테스트가 만든 폴더
    await clickShown(0)
    await expect.poll(() => popover().getByRole('alert').textContent(), { timeout: 10_000 }).toBe(`폴더를 열 수 없습니다: ${alpha}`)
    expect(await currentName()).toBe('beta-app')
    await page.keyboard.press('Escape')
  })

  it('앱을 한 번 더 켜면 새로 뜨지 않고 끝나며 기존 창을 앞으로 부른다 — 기존 opencode 는 그대로', async () => {
    const before = JSON.parse(await fs.readFile(path.join(userData, 'opencode-server.json'), 'utf8')) as { pid: number }
    expect(alive(before.pid)).toBe(true)
    await resetRecord()
    const electronBin = createRequire(import.meta.url)('electron') as unknown as string
    const second = spawn(electronBin, ['.', `--user-data-dir=${userData}`, '--use-mock-keychain'], { cwd: root, env: appEnv(), stdio: 'ignore' })
    const code = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        second.kill()
        reject(new Error('두 번째 실행이 20초 안에 끝나지 않았다'))
      }, 20_000)
      second.on('exit', (exitCode) => {
        clearTimeout(timer)
        resolve(exitCode)
      })
    })
    expect(code).toBe(0)
    await expect.poll(reveals, { timeout: 5_000 }).toBe(1)
    expect(app.windows()).toHaveLength(1)
    const after = JSON.parse(await fs.readFile(path.join(userData, 'opencode-server.json'), 'utf8')) as { pid: number }
    expect(after.pid).toBe(before.pid)
    expect(alive(before.pid)).toBe(true)
    await send('hello again') // 첫 실행은 멀쩡하다
  })
})
