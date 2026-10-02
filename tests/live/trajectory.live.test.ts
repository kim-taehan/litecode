import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core'
import { createServer, type ViteDevServer } from 'vite'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import { freePort, isolatedEnv } from './support/opencodeServer.ts'

// Trajectory 탭 실물 테스트 — 진짜 Electron 창에서 대화한 뒤 Trajectory 탭이 opencode 레거시 기록(/session/{id}/message?directory=)을
// 스텝·도구 줄과 3레인 시간축으로 보이는지 본다. 렌더러 → preload(trajectory:load) → ctx.trajectory → ctx.llm.readMessages →
// opencode 를 관통한다. 자기 앱·vite·임시 폴더를 띄우고 다른 실물 테스트의 순서에 기대지 않는다.
// 가짜 LLM 규칙: [bash:<cmd>] 는 bash 도구, [call:read {"path":…}] 는 레거시에서 인자 키가 틀려(filePath) 반드시 실패하는 도구,
// [drip] 은 두 조각 사이 1.5초 — 생성이 긴 스텝을 만든다 (01e).

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

let vite: ViteDevServer
let devServerUrl: string
let app: ElectronApplication
let page: Page
/** 이 테스트가 만든 임시 폴더 — 끝나면 이 경로만 지운다 */
let tmp: string
let userData: string
let project: string

async function launch(): Promise<void> {
  app = await electron.launch({
    args: ['.', `--user-data-dir=${userData}`, '--use-mock-keychain'],
    cwd: root,
    env: { ...isolatedEnv(tmp), LITECODE_TEST_HIDDEN: '1', LITECODE_DEV_SERVER_URL: devServerUrl, LITECODE_GATEWAY_URL: `${inject('fakeLlmUrl')}/v1` },
  })
  page = await app.firstWindow()
  await page.locator('.sidebar-toggle:visible').waitFor()
}

beforeAll(async () => {
  execFileSync(path.join(root, 'node_modules/.bin/tsc'), ['-p', 'tsconfig.electron.json'], { cwd: root, stdio: 'inherit' })
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'litecode-trajectory-')))
  userData = path.join(tmp, 'userData')
  project = path.join(tmp, 'traj-app')
  await fs.mkdir(project)
  await fs.writeFile(path.join(project, 'AGENTS.md'), '# 규칙 1\n')

  const port = await freePort()
  vite = await createServer({ configFile: path.join(root, 'vite.config.ts'), server: { port, strictPort: true } })
  await vite.listen()
  devServerUrl = `http://localhost:${port}`
  await launch()

  // OS 폴더 대화상자 대신 project 를 고른 것으로
  await app.evaluate(({ dialog }, picked) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [picked] })) as typeof dialog.showOpenDialog
  }, project)
  await page.locator('.open-guide').getByRole('button', { name: '폴더 열기…' }).click()
  await page.getByPlaceholder('메시지를 입력하세요…').waitFor({ timeout: 10_000 })
})

afterAll(async () => {
  await app?.close()
  await vite?.close()
  if (tmp) await fs.rm(tmp, { recursive: true, force: true })
})

const replies = () => page.locator('.bubble--assistant')
// 탭 이름은 한국어 화면에서 '대화'·'추론 과정' (사용자 결정 2026-10-02) — 테스트 앱은 한국어로 뜬다
const tab = (name: 'Chat' | 'Trajectory') => page.getByRole('tab', { name: name === 'Chat' ? '대화' : '추론 과정' })
const rows = () => page.locator('.trajectory__row')
const tags = () => page.locator('.trajectory__row .trajectory__tag').allTextContents()
const rowTexts = () => page.locator('.trajectory__row').allInnerTexts()
const turnHeads = () => page.locator('.trajectory__turn-head')
const bars = (lane: number) => page.locator('.trajectory__lane').nth(lane).locator('.trajectory__bar')
const barWidths = (lane: number) => bars(lane).evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().width))
const toolbar = (name: 'Duration' | 'Turns' | 'Calls') => page.getByRole('toolbar').getByRole('button', { name })

/** 입력창에 넣고 Enter */
async function type(text: string): Promise<void> {
  await page.getByPlaceholder('메시지를 입력하세요…').fill(text)
  await page.keyboard.press('Enter')
}

/** Chat 탭에서 보내고 새 답 말풍선을 기다린다 */
async function send(text: string): Promise<string> {
  await tab('Chat').click()
  const before = await replies().count()
  await type(text)
  await expect.poll(() => replies().count(), { timeout: 30_000 }).toBe(before + 1)
  return (await replies().last().textContent()) ?? ''
}

describe('Trajectory 탭', () => {
  it('도구 턴: USER → ASSISTANT —(도구만 부른 스텝) → TOOL bash {인자} → 결과 → ASSISTANT 답, 시간축 3레인에 막대가 놓인다', async () => {
    expect((await send('[bash:echo traj-ok]')).split('\n')[0]).toBe('tool: traj-ok') // bash 결과엔 "Command exited with code 0." 이 붙는다
    await tab('Trajectory').click()
    expect(await tab('Trajectory').getAttribute('aria-selected')).toBe('true')

    await expect.poll(tags, { timeout: 10_000 }).toEqual(['USER', 'ASSISTANT', 'TOOL', 'ASSISTANT'])
    const [user, step, tool, answer] = await rowTexts()
    expect(user).toContain('[bash:echo traj-ok]')
    expect(step).toContain('—')
    expect(tool).toContain('bash {"command":"echo traj-ok"')
    expect(tool).toContain('→ traj-ok')
    expect(answer).toContain('tool: traj-ok')
    expect([await bars(0).count(), await bars(1).count(), await bars(2).count()]).toEqual([1, 2, 1])
    expect(await page.locator('.trajectory__lane-name').allTextContents()).toEqual(['Input', 'Model', 'Tools'])
  })

  it('Trajectory 탭을 연 채로 보내면 턴이 끝난 뒤 다시 읽어 새 줄이 생긴다 — 실패한 도구는 빨간 줄과 빨간 막대', async () => {
    await type('읽기 실패 [call:read {"path":"/nope-litecode"}]')
    await expect.poll(() => turnHeads().count(), { timeout: 30_000 }).toBe(2)

    const failed = page.locator('.trajectory__row--error[data-kind="tool"]')
    await expect.poll(() => failed.count(), { timeout: 10_000 }).toBe(1)
    expect(await failed.innerText()).toContain('read {"path":"/nope-litecode"}')
    expect(await failed.innerText()).toContain('invalid arguments')
    expect(await bars(2).and(page.locator('.trajectory__bar--error')).count()).toBe(1)
  })

  it('Chat 탭으로 돌아가면 말풍선이 그대로다', async () => {
    await tab('Chat').click()
    expect(await replies().count()).toBe(2)
    expect(await replies().first().textContent()).toContain('tool: traj-ok')
  })

  it('대화 중 AGENTS.md 를 바꾸면 그다음 턴에 CONTEXT 줄(지시문 바뀜)이 생긴다', async () => {
    await fs.writeFile(path.join(project, 'AGENTS.md'), '# 규칙 2 — 바뀜\n')
    // 앱이 매 턴 AGENTS.md 를 prompt system 으로 싣고(instructions.ts) 그 값이 user 기록에 남는다 — 앞 턴과 달라진 턴에 CONTEXT 줄 (이슈 #20)
    expect(await send('지시문 확인')).toContain('echo: 지시문 확인')
    const { lastChatText } = (await (await fetch(`${inject('fakeLlmUrl')}/requests`)).json()) as { lastChatText: string }
    expect(lastChatText).toContain('# 규칙 2 — 바뀜') // 바뀐 지시문이 그 턴 LLM 요청에 실렸다
    await tab('Trajectory').click()

    const context = page.locator('.trajectory__row[data-kind="context"]')
    await expect.poll(() => context.count(), { timeout: 10_000 }).toBe(1)
    expect(await context.innerText()).toContain('CONTEXT')
    expect(await context.innerText()).toContain('AGENTS.md')
  })

  it('Duration: 꺼져 있으면 Model 막대가 모두 같은 너비, 켜면 실제 시간 — 1.5초 걸린 [drip] 스텝이 가장 넓다', async () => {
    expect(await send('[drip] 느린 답')).toBe('echo: [drip] 느린 답')
    await tab('Trajectory').click()
    await expect.poll(() => turnHeads().count(), { timeout: 10_000 }).toBe(4)

    expect(await toolbar('Duration').getAttribute('aria-pressed')).toBe('false')
    const equal = await barWidths(1)
    expect(equal).toHaveLength(6) // 도구 턴 2스텝 × 2 + 일반 턴 1스텝 × 2
    expect(Math.max(...equal) - Math.min(...equal)).toBeLessThan(1)

    await toolbar('Duration').click()
    expect(await toolbar('Duration').getAttribute('aria-pressed')).toBe('true')
    expect(await page.locator('.trajectory__timeline').getAttribute('data-mode')).toBe('duration')
    const actual = await barWidths(1)
    const drip = actual.at(-1)!
    for (const width of actual.slice(0, -1)) expect(drip).toBeGreaterThan(width * 2)
    await toolbar('Duration').click() // 다음 테스트는 같은 너비에서
  })

  it('검색: 단어를 모두 포함한 줄만 남고, 없으면 "일치하는 기록이 없습니다"', async () => {
    const search = page.getByRole('searchbox', { name: '기록 검색' })
    await search.fill('traj-ok')
    await expect.poll(tags, { timeout: 5_000 }).toEqual(['USER', 'TOOL', 'ASSISTANT'])
    expect(await turnHeads().count()).toBe(1)

    await search.fill('traj-ok bash')
    await expect.poll(tags, { timeout: 5_000 }).toEqual(['USER', 'TOOL'])

    await search.fill('없는-단어-zz')
    await expect.poll(() => rows().count(), { timeout: 5_000 }).toBe(0)
    expect(await page.locator('.trajectory').innerText()).toContain('일치하는 기록이 없습니다')
    await search.fill('')
    await expect.poll(() => turnHeads().count(), { timeout: 5_000 }).toBe(4)
  })

  it('Calls 는 모든 도구 줄을, Turns 는 모든 턴을 접고 편다', async () => {
    const all = await rows().count()
    await toolbar('Calls').click()
    expect(await toolbar('Calls').getAttribute('aria-pressed')).toBe('true')
    expect(await page.locator('.trajectory__row[data-kind="tool"]').count()).toBe(0)
    expect(await rows().count()).toBe(all - 2)
    await toolbar('Calls').click()
    expect(await rows().count()).toBe(all)

    await toolbar('Turns').click()
    expect(await toolbar('Turns').getAttribute('aria-pressed')).toBe('true')
    expect(await rows().count()).toBe(0)
    expect(await turnHeads().count()).toBe(4)
    await turnHeads().first().click() // 턴 하나만 펴기
    expect(await tags()).toEqual(['USER', 'ASSISTANT', 'TOOL', 'ASSISTANT'])
    await toolbar('Turns').click() // 다 접힌 게 아니므로 → 모두 접기
    expect(await rows().count()).toBe(0)
    await toolbar('Turns').click()
    expect(await rows().count()).toBe(all)
  })

  it('앱을 다시 켜고 그 대화를 열면 Trajectory 줄이 그대로다 (opencode 기록에서 다시 읽는다)', async () => {
    const before = await rowTexts()
    await app.close()
    await launch()
    await page.locator('.session-item', { hasText: '[bash:echo traj-ok]' }).click()
    await tab('Trajectory').click()
    await expect.poll(rowTexts, { timeout: 15_000 }).toEqual(before)
  })
})
