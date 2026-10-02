import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core'
import { createServer, type ViteDevServer } from 'vite'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import { freePort, isolatedEnv } from './support/opencodeServer.ts'

// 라운드 A 실물 테스트 — 승인·질문 카드와 모드 칩. 진짜 Electron 창 → preload(chat:attention·chat:reply-attention·chat:send 의 mode) →
// ctx.llm(전역 /api/event + 대기 목록, reply, 거절 턴 끝, 에이전트 맞추기) → ctx.engine 이 생성한 opencode.json 의 모드 에이전트 → 진짜 opencode.
// 가짜는 LLM 하나(`[call:<도구> <json>]`·`[bash:…]` 로 도구를 부른다 — 받은 요청의 도구 목록·system 앞부분을 GET /requests 로 본다)와 폴더 대화상자.
// 대화 셋: 하나(기본 → 매번 묻기), 둘(계획 → "이 계획대로 실행" → 기본), 셋(전체 권한). 재시작 뒤 각 대화의 모드가 남는지 본다.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

let vite: ViteDevServer
let devServerUrl: string
let app: ElectronApplication
let page: Page
/** 이 테스트가 만든 임시 폴더 — 끝나면 이 경로만 지운다 */
let tmp: string
let userData: string
let project: string
/** 프로젝트 밖 파일 — 기본 모드에서 읽으려면 external_directory 승인이 필요하다 */
let outside: string

const OUTSIDE_TEXT = 'OUTSIDE-CONTENT-42'
const QUESTION = '[call:question {"questions":[{"question":"Which DB?","header":"DB","options":[{"label":"Postgres","description":"pg"},{"label":"SQLite","description":"file"}]}]}]'
const EDIT_TOOLS = ['apply_patch', 'bash', 'edit', 'webfetch', 'write']

async function launch(): Promise<void> {
  app = await electron.launch({
    args: ['.', `--user-data-dir=${userData}`, '--use-mock-keychain'],
    cwd: root,
    env: { ...(isolatedEnv(tmp) as Record<string, string>), LITECODE_TEST_HIDDEN: '1', LITECODE_DEV_SERVER_URL: devServerUrl, LITECODE_GATEWAY_URL: `${inject('fakeLlmUrl')}/v1` },
  })
  page = await app.firstWindow()
  await page.locator('.sidebar-toggle:visible').waitFor()
}

beforeAll(async () => {
  execFileSync(path.join(root, 'node_modules/.bin/tsc'), ['-p', 'tsconfig.electron.json'], { cwd: root, stdio: 'inherit' })
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'litecode-approval-')))
  userData = path.join(tmp, 'userData')
  project = path.join(tmp, 'approval-app')
  outside = path.join(tmp, 'outside', 'secret.txt')
  await fs.mkdir(project)
  await fs.mkdir(path.dirname(outside))
  await fs.writeFile(outside, `${OUTSIDE_TEXT}\n`)

  const port = await freePort()
  vite = await createServer({ configFile: path.join(root, 'vite.config.ts'), server: { port, strictPort: true } })
  await vite.listen()
  devServerUrl = `http://localhost:${port}`
  await launch()
  await app.evaluate(({ dialog }, picked) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [picked] })) as typeof dialog.showOpenDialog
  }, project)
  await page.locator('.open-guide').getByRole('button', { name: '폴더 열기…' }).click()
  await page.locator('.project-switch__name', { hasText: 'approval-app' }).waitFor({ timeout: 10_000 })
})

afterAll(async () => {
  await app?.close()
  await vite?.close()
  if (tmp) await fs.rm(tmp, { recursive: true, force: true })
})

const input = () => page.locator('.composer__input')
const chip = () => page.locator('.mode-chip')
const card = (kind: 'permission' | 'question') => page.locator(`.attention-card[data-kind="${kind}"]`)
const lastTurn = () => page.locator('.turn').last()
const lastHead = () => lastTurn().locator('.turn__head-label').textContent({ timeout: 1_000 })
const lastAnswer = () => page.locator('.bubble--assistant').last().textContent({ timeout: 1_000 })
const lastChat = async () =>
  ((await (await fetch(`${inject('fakeLlmUrl')}/requests`)).json()) as { lastChat: { tools: string[]; messages: { role: string; text: string }[] } }).lastChat
const exists = (file: string) => fs.stat(path.join(project, file)).then(() => true, () => false)

/** 보내기만 — 카드를 누르거나 잠금을 볼 수 있게 답을 기다리지 않는다 */
async function submit(text: string): Promise<void> {
  await input().fill(text)
  await input().press('Enter')
}

/** 보내고 다음 답이 붙을 때까지 */
async function send(text: string): Promise<void> {
  const before = await page.locator('.bubble--assistant').count()
  await submit(text)
  await expect.poll(() => page.locator('.bubble--assistant').count(), { timeout: 30_000 }).toBe(before + 1)
}

async function pickMode(name: string): Promise<void> {
  await chip().click()
  await page.locator('.mode-menu').getByRole('menuitemradio', { name }).click()
}

/** 그 대화를 열고 내용을 다 불러올 때까지 — 불러오는 중엔 보내기가 막힌다 */
async function openChat(title: string): Promise<void> {
  await page.locator('.session-item', { hasText: title }).click()
  await expect.poll(() => page.locator('.session-item--active .session-item__title').textContent({ timeout: 1_000 }), { timeout: 5_000 }).toContain(title)
  await expect.poll(() => page.getByText('불러오는 중…').count(), { timeout: 15_000 }).toBe(0)
}

describe('승인·질문 카드와 모드 칩 (라운드 A)', () => {
  it('기본 모드: 폴더 밖 파일 읽기 → 승인 카드 → 한 번 허용 → 그 내용으로 턴이 끝난다', async () => {
    await send('first chat')
    expect(await chip().textContent()).toBe('기본')
    await submit(`[call:read {"path":"${outside}"}]`)
    await card('permission').waitFor({ timeout: 30_000 })
    expect(await card('permission').locator('.attention-card__headline').textContent()).toBe('프로젝트 폴더 밖에 접근하려고 합니다')
    expect(await card('permission').locator('.attention-card__command').textContent()).toContain(path.dirname(outside))
    expect(await card('permission').getByRole('button').allTextContents()).toEqual(['거절', '한 번 허용']) // "항상 허용" 없음
    await card('permission').getByRole('button', { name: '한 번 허용' }).click()
    await expect.poll(lastAnswer, { timeout: 30_000 }).toContain(OUTSIDE_TEXT)
    expect(await card('permission').count()).toBe(0)
    expect(await lastHead()).toMatch(/^완료/)
  })

  it('거절하면 실패가 아니라 "거절함" 으로 끝나고 다음 질문이 된다', async () => {
    await submit(`[call:read {"path":"${outside}"}]`)
    await card('permission').waitFor({ timeout: 30_000 })
    await card('permission').getByRole('button', { name: '거절' }).click()
    await expect.poll(lastHead, { timeout: 30_000 }).toMatch(/^거절함/)
    expect(await lastTurn().getAttribute('data-state')).toBe('done')
    expect(await lastAnswer()).not.toContain('⚠️')
    await send('next question')
    expect(await lastAnswer()).toBe('echo: next question')
  })

  it('질문 도구 → 질문 카드: 보기를 골라 보내면 이어서 끝나고, 직접 입력도 되며, 거절도 끝난다', async () => {
    await submit(QUESTION)
    await card('question').waitFor({ timeout: 30_000 })
    expect(await card('question').locator('legend').textContent()).toBe('DBWhich DB?')
    const sendAnswer = card('question').getByRole('button', { name: '답 보내기' })
    expect(await sendAnswer.isDisabled()).toBe(true) // 빈 답은 못 보낸다
    await card('question').locator('.attention-question__option', { hasText: 'SQLite' }).click()
    await sendAnswer.click()
    await expect.poll(lastAnswer, { timeout: 30_000 }).toContain('"Which DB?"="SQLite"')

    await submit(QUESTION)
    await card('question').waitFor({ timeout: 30_000 })
    await card('question').getByPlaceholder('직접 입력').fill('MariaDB please')
    await card('question').getByPlaceholder('직접 입력').press('Enter')
    await expect.poll(lastAnswer, { timeout: 30_000 }).toContain('"Which DB?"="MariaDB please"')

    await submit(QUESTION)
    await card('question').waitFor({ timeout: 30_000 })
    await card('question').getByRole('button', { name: '거절' }).click()
    await expect.poll(lastHead, { timeout: 30_000 }).toMatch(/^거절함/)
  })

  it('매번 묻기: 파일 편집·명령 실행마다 카드가 뜨고, 허용하면 실행된다. 모드가 바뀐 자리에 구분선', async () => {
    await pickMode('매번 묻기')
    expect(await chip().textContent()).toBe('매번 묻기')
    expect(await page.locator('.mode-divider').count()).toBe(0) // 아직 안 보냈다 — 바꾼 모드는 보낼 때 엔진에 간다
    await submit('[call:write {"path":"made-by-edit.txt","content":"hello"}]')
    await card('permission').waitFor({ timeout: 30_000 })
    expect(await card('permission').locator('.attention-card__headline').textContent()).toBe('파일을 고치려고 합니다')
    expect(await exists('made-by-edit.txt')).toBe(false)
    await card('permission').getByRole('button', { name: '한 번 허용' }).click()
    await expect.poll(() => exists('made-by-edit.txt'), { timeout: 30_000 }).toBe(true)
    expect(await page.locator('.mode-divider').allTextContents()).toEqual(['매번 묻기 모드로 바꿈'])

    await expect.poll(() => card('permission').count(), { timeout: 30_000 }).toBe(0)
    await expect.poll(() => chip().isDisabled(), { timeout: 30_000 }).toBe(false)
    await submit('[bash:echo hi > made-by-bash.txt]')
    await card('permission').waitFor({ timeout: 30_000 })
    expect(await card('permission').locator('.attention-card__headline').textContent()).toBe('명령을 실행하려고 합니다')
    expect(await card('permission').locator('.attention-card__command').textContent()).toBe('echo hi > made-by-bash.txt')
    await card('permission').getByRole('button', { name: '한 번 허용' }).click()
    await expect.poll(() => exists('made-by-bash.txt'), { timeout: 30_000 }).toBe(true)
    await expect.poll(lastHead, { timeout: 30_000 }).toMatch(/^완료/)
  })

  it('Shift+Tab 으로 기본 → 매번 묻기 → 계획 순환. 계획: 편집·명령 도구가 LLM 요청에 없고 .opencode/plans 도 안 생긴다', async () => {
    await page.locator('.new-chat').click()
    expect(await chip().textContent()).toBe('기본')
    await input().focus()
    await page.keyboard.press('Shift+Tab')
    expect(await chip().textContent()).toBe('매번 묻기')
    await page.keyboard.press('Shift+Tab')
    expect(await chip().textContent()).toBe('계획')
    expect(await chip().getAttribute('data-mode')).toBe('plan')
    expect(await input().getAttribute('placeholder')).toBe('계획을 세울 작업을 설명하세요…')

    await send('plan chat [call:write {"path":".opencode/plans/p.md","content":"x"}]')
    const request = await lastChat()
    expect(request.tools).toContain('read')
    expect(request.tools.filter((tool) => EDIT_TOOLS.includes(tool))).toEqual([])
    expect(request.messages[0]!.text).toMatch(/^You are an AI coding agent in plan mode/)
    expect(await exists('.opencode/plans/p.md')).toBe(false)
    expect(await lastHead()).toMatch(/^완료/)

    await send('[bash:echo x > plan-bash.txt]')
    expect(await exists('plan-bash.txt')).toBe(false)
  })

  it('계획 턴이 끝나면 "이 계획대로 실행" — 누르면 기본 모드로 바꾸고 이어 실행, 대화에 구분선', async () => {
    const run = page.getByRole('button', { name: '이 계획대로 실행' })
    await run.waitFor({ timeout: 5_000 })
    const before = await page.locator('.bubble--assistant').count()
    await run.click()
    await expect.poll(() => page.locator('.bubble--assistant').count(), { timeout: 30_000 }).toBe(before + 1)
    expect(await lastAnswer()).toBe('echo: 위 계획대로 진행해 주세요.')
    expect(await chip().textContent()).toBe('기본')
    expect(await page.locator('.mode-divider').allTextContents()).toEqual(['기본 모드로 바꿈'])
    const request = await lastChat()
    expect(request.tools).toContain('bash')
    expect(request.messages[0]!.text).toMatch(/^You are an AI coding agent\. Help/)
    expect(request.messages.some((message) => message.text.startsWith('plan chat'))).toBe(true) // 앞 맥락이 이어진다
    expect(await run.count()).toBe(0)
  })

  it('답을 기다리는 동안 칩이 잠기고 Shift+Tab 도 안 먹는다', async () => {
    await submit('[late] lock')
    await expect.poll(() => chip().isDisabled(), { timeout: 5_000 }).toBe(true)
    await input().focus()
    await page.keyboard.press('Shift+Tab')
    expect(await chip().textContent()).toBe('기본')
    await expect.poll(lastAnswer, { timeout: 30_000 }).toBe('echo: [late] lock')
    expect(await chip().isDisabled()).toBe(false)
  })

  it('전체 권한은 고를 때 확인 대화상자 — 취소하면 그대로, 체크하고 켜면 폴더 밖도 묻지 않고 읽는다', async () => {
    await page.locator('.new-chat').click()
    await pickMode('전체 권한')
    const confirm = page.getByRole('alertdialog')
    await confirm.waitFor()
    expect(await confirm.getByRole('button', { name: '전체 권한 켜기' }).isDisabled()).toBe(true)
    await confirm.getByRole('button', { name: '취소' }).click()
    expect(await confirm.count()).toBe(0)
    expect(await chip().textContent()).toBe('기본')

    await pickMode('전체 권한')
    await confirm.getByRole('checkbox').check()
    await confirm.getByRole('button', { name: '전체 권한 켜기' }).click()
    expect(await chip().getAttribute('data-mode')).toBe('full')
    expect(await chip().textContent()).toBe('전체 권한')
    await send(`full chat [call:read {"path":"${outside}"}]`)
    expect(await lastAnswer()).toContain(OUTSIDE_TEXT)
    expect(await card('permission').count()).toBe(0)
  })

  it('설정 > 일반 "새 대화 기본 모드" 가 새 대화에 적용된다 — 이미 있는 대화는 그대로, 전체 권한은 확인', async () => {
    await page.getByRole('button', { name: '설정', exact: true }).click()
    const settings = page.locator('.settings-panel')
    await settings.getByRole('button', { name: '일반', exact: true }).click()
    const row = settings.locator('.settings-row', { hasText: '새 대화 기본 모드' })
    expect(await row.locator('.settings-select__trigger').textContent()).toBe('기본')
    await row.locator('.settings-select__trigger').click()
    await row.getByRole('menuitemradio', { name: '전체 권한' }).click()
    await page.getByRole('alertdialog').getByRole('button', { name: '취소' }).click()
    expect(await row.locator('.settings-select__trigger').textContent()).toBe('기본')
    await row.locator('.settings-select__trigger').click()
    await row.getByRole('menuitemradio', { name: '계획' }).click()
    await expect.poll(() => row.locator('.settings-select__trigger').textContent(), { timeout: 5_000 }).toBe('계획')
    expect(JSON.parse(await fs.readFile(path.join(userData, 'settings.json'), 'utf8')).defaultMode).toBe('plan')
    await page.keyboard.press('Escape')

    await page.locator('.new-chat').click()
    expect(await chip().textContent()).toBe('계획')
    await openChat('first chat')
    expect(await chip().textContent()).toBe('매번 묻기')
    await openChat('full chat')
    expect(await chip().textContent()).toBe('전체 권한')
  })

  it('재시작해도 대화마다 모드가 남고, 기록에서 모드가 바뀐 자리의 구분선이 다시 그려진다', async () => {
    await app.close()
    await launch()
    expect(await chip().textContent()).toBe('계획') // 켜면 새 대화 — 기본 모드 설정을 따른다
    await openChat('first chat')
    await expect.poll(() => page.locator('.mode-divider').allTextContents(), { timeout: 15_000 }).toEqual(['매번 묻기 모드로 바꿈'])
    expect(await chip().textContent()).toBe('매번 묻기')
    // 거절로 끝난 두 턴(권한·질문)은 기록에서도 "거절함" — "중단됨"·"완료" 가 아니다
    expect((await page.locator('.turn__head-label').allTextContents()).filter((head) => head.startsWith('거절함'))).toHaveLength(2)
    await openChat('plan chat')
    await expect.poll(() => page.locator('.mode-divider').allTextContents(), { timeout: 15_000 }).toEqual(['기본 모드로 바꿈'])
    expect(await chip().textContent()).toBe('기본')
    await openChat('full chat')
    expect(await chip().textContent()).toBe('전체 권한')
  })

  it('질문을 기다리는 중 엔진이 재시작되면 카드가 사라지고 "중단됨" 으로 끝난다', async () => {
    await openChat('plan chat')
    await submit(QUESTION)
    await card('question').waitFor({ timeout: 30_000 })
    const engine = async () => (JSON.parse(await fs.readFile(path.join(userData, 'opencode-server.json'), 'utf8')) as { pid: number }).pid
    const pid = await engine()
    await page.evaluate(async () => {
      const [provider] = await window.litecode.listProviders()
      await window.litecode.saveProvider({ id: provider!.id, displayName: provider!.displayName, baseURL: provider!.baseURL, protocol: provider!.protocol, models: provider!.models })
    })
    await expect.poll(() => engine().catch(() => pid), { timeout: 30_000 }).not.toBe(pid)
    await expect.poll(lastHead, { timeout: 30_000 }).toMatch(/^중단됨/)
    expect(await card('question').count()).toBe(0)
    await send('after restart')
    expect(await lastAnswer()).toBe('echo: after restart')
  })
})
