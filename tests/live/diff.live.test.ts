import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core'
import { createServer, type ViteDevServer } from 'vite'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import { freePort, isolatedEnv } from './support/opencodeServer.ts'

// 파일 변경(diff) 실물 테스트 (이슈 #4 → 레거시 경로 #20 L2) — 가짜 LLM 이 edit·apply_patch·write 를 부르게 해서 진짜 opencode 가 파일을 바꾸고,
// 그 도구 결과(레거시 state.metadata → chat:progress, 기록 /session/{id}/message → 다시 열기·추론 과정 탭)가 도구 줄 끝 `+A −D` 와 펼친 카드의 줄로
// 보이는지 본다. 레거시 도구 인자는 `filePath` 다. 레거시는 모델 id 에 `gpt-` 가 있을 때만 apply_patch 를 주고(그때는 edit·write 가 없다) —
// 그래서 gateway provider 에 GPT 이름의 모델을 하나 더 두고 apply_patch 턴만 그 모델로 보낸다. 기본 모드(build)라 프로젝트 안 편집은 묻지 않는다.
// 자기 앱·vite·임시 폴더를 띄우고 다른 실물 테스트에 기대지 않는다.

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
  // playwright 는 prefers-color-scheme 을 light 로 흉내 낸다 — 다크 값을 보려면 끈다 (settings-general.live.test.ts 와 같은 이유)
  await page.emulateMedia({ colorScheme: null })
  await page.locator('.sidebar-toggle:visible').waitFor()
}

beforeAll(async () => {
  execFileSync(path.join(root, 'node_modules/.bin/tsc'), ['-p', 'tsconfig.electron.json'], { cwd: root, stdio: 'inherit' })
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'litecode-diff-')))
  userData = path.join(tmp, 'userData')
  project = path.join(tmp, 'diff-app')
  await fs.mkdir(project)
  await fs.writeFile(path.join(project, 'a.txt'), 'line1\nline2\nline3\nline4\nline5\n')
  await fs.writeFile(path.join(project, 'c.txt'), 'gone\n')
  await fs.writeFile(path.join(project, 'w.txt'), 'old content\n')
  // 첫 실행 기본값 대신 — 같은 gateway 에 apply_patch 를 받는 GPT 이름 모델을 더한다 (providers.json 이 정본)
  await fs.mkdir(userData, { recursive: true })
  await fs.writeFile(
    path.join(userData, 'providers.json'),
    JSON.stringify([
      {
        id: 'gateway-local',
        displayName: 'Internal LiteLLM Gateway',
        baseURL: `${inject('fakeLlmUrl')}/v1`,
        protocol: 'openai-chat-completions',
        models: [
          { id: 'qwen3.8-27b', displayName: 'Qwen3.8 27B' },
          { id: 'gpt-5-fake', displayName: 'GPT-5 Fake' },
        ],
      },
    ]),
  )

  const port = await freePort()
  vite = await createServer({ configFile: path.join(root, 'vite.config.ts'), server: { port, strictPort: true } })
  await vite.listen()
  devServerUrl = `http://localhost:${port}`
  await launch()

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
const turn = (index: number) => page.locator('.turn').nth(index)
const tab = (name: '대화' | '추론 과정') => page.getByRole('tab', { name })
/** 그 턴의 도구 줄 (턴 머리를 펼쳐야 보인다) */
const toolRow = (index: number) => turn(index).locator('.turn-row[data-kind="tool"]')
const cardLines = (scope: ReturnType<Page['locator']>) =>
  scope.locator('.diff-line').evaluateAll((elements) => elements.map((element) => `${element.getAttribute('data-kind')}:${(element as HTMLElement).innerText}`))

/** 입력창의 모델을 고른다 (메뉴 이름 = 모델 이름) */
async function chooseModel(name: string): Promise<void> {
  const menu = page.getByRole('menu', { name: '모델' })
  await page.locator('.model-select__trigger').click()
  await menu.getByRole('menuitemradio', { name, exact: true }).click()
  await expect.poll(() => page.locator('.composer__model').textContent(), { timeout: 5_000 }).toBe(name)
}

async function send(text: string): Promise<void> {
  const before = await replies().count()
  await page.getByPlaceholder('메시지를 입력하세요…').fill(text)
  await page.keyboard.press('Enter')
  await expect.poll(() => replies().count(), { timeout: 30_000 }).toBe(before + 1)
}

/** 턴 머리를 펼치고 도구 줄을 펼친다 → 그 줄의 카드 */
async function openTool(index: number) {
  if ((await turn(index).locator('.turn__head').getAttribute('aria-expanded')) === 'false') await turn(index).locator('.turn__head').click()
  await toolRow(index).locator('.turn-row__line').click()
  return toolRow(index).locator('.diff-card')
}

const PATCH = ['*** Begin Patch', '*** Update File: a.txt', '@@', '-LINE3', '+Line3', '*** Add File: b.txt', '+hello', '+world', '*** Delete File: c.txt', '*** End Patch'].join('\n')

const EDIT_LINES = ['file:a.txt', 'context:line1', 'context:line2', 'del:line3', 'add:LINE3', 'context:line4', 'context:line5']

describe('도구 줄 안 diff', () => {
  it('edit: 도구 줄 끝 +1 −1, 펼치면 경로·문맥·삭제·추가 줄 (파일도 실제로 바뀌었다)', async () => {
    await send(`diff-edit [call:edit {"filePath":"${project}/a.txt","oldString":"line3","newString":"LINE3"}]`)
    expect(await fs.readFile(path.join(project, 'a.txt'), 'utf8')).toBe('line1\nline2\nLINE3\nline4\nline5\n')
    await turn(0).locator('.turn__head').click()
    expect(await toolRow(0).locator('.diff-stat').innerText()).toBe('+1 −1')
    const card = await openTool(0)
    expect(await cardLines(card)).toEqual(EDIT_LINES)
    // 접두는 CSS — 줄 글에는 없고 화면에는 있다
    expect(await card.locator('.diff-line[data-kind="del"]').evaluate((element) => getComputedStyle(element, '::before').content)).toBe('"- "')
  })

  it('apply_patch(GPT 모델): 파일 셋(수정·추가·삭제) — 경로 머리 셋, 새 파일·삭제됨 표시. 9줄 넘으면 접고 "N줄 더 보기"', async () => {
    await chooseModel('GPT-5 Fake')
    await send(`diff-patch [call:apply_patch ${JSON.stringify({ patchText: PATCH })}]`)
    await chooseModel('Qwen3.8 27B')
    expect(await fs.readFile(path.join(project, 'b.txt'), 'utf8')).toBe('hello\nworld\n')
    await expect(fs.access(path.join(project, 'c.txt'))).rejects.toThrow()
    await turn(1).locator('.turn__head').click()
    expect(await toolRow(1).locator('.diff-stat').innerText()).toBe('+3 −2')
    const card = await openTool(1)
    const more = card.locator('.diff-card__more')
    expect(await more.innerText()).toMatch(/^\d+줄 더 보기$/)
    expect(await card.locator('.diff-line').count()).toBe(9)
    await more.click()
    expect(await more.count()).toBe(0)
    const lines = await cardLines(card)
    expect(lines.filter((line) => line.startsWith('file:'))).toEqual(['file:a.txt', 'file:b.txt새 파일', 'file:c.txt삭제됨'])
    expect(lines).toContain('del:LINE3')
    expect(lines).toContain('add:Line3')
    expect(lines).toContain('add:hello')
    expect(lines).toContain('del:gone')
  })

  it('write: 새 파일은 전부 추가(+2 −0), 덮어쓰기는 이전 내용을 모른다(+1 −?)', async () => {
    await send(`diff-write [call:write ${JSON.stringify({ filePath: `${project}/n.txt`, content: 'x\ny\n' })}]`)
    await turn(2).locator('.turn__head').click()
    expect(await toolRow(2).locator('.diff-stat').innerText()).toBe('+2 −0')
    expect(await cardLines(await openTool(2))).toEqual(['file:n.txt새 파일', 'add:x', 'add:y'])

    await send(`diff-over [call:write ${JSON.stringify({ filePath: `${project}/w.txt`, content: 'new content\n' })}]`)
    expect(await fs.readFile(path.join(project, 'w.txt'), 'utf8')).toBe('new content\n')
    await turn(3).locator('.turn__head').click()
    expect(await toolRow(3).locator('.diff-stat').innerText()).toBe('+1 −?')
    expect(await cardLines(await openTool(3))).toEqual(['file:w.txt이전 내용 모름 · 전체를 씀', 'add:new content'])
  })

  it('다크 테마: 삭제 줄이 다크 토큰(red-400, 바탕 12%)으로, 라이트로 돌아오면 red-600', async () => {
    const del = toolRow(0).locator('.diff-line[data-kind="del"]')
    const look = () => del.evaluate((element) => [getComputedStyle(element).color, getComputedStyle(element).backgroundColor])
    expect(await look()).toEqual(['rgb(236, 19, 19)', 'rgba(236, 19, 19, 0.08)'])
    await page.evaluate(() => window.litecode.setSettings({ appearance: 'dark' }))
    await expect.poll(look, { timeout: 5_000 }).toEqual(['rgb(242, 90, 90)', 'rgba(242, 90, 90, 0.12)'])
    await fs.mkdir(path.join(root, 'shots'), { recursive: true })
    await toolRow(1).screenshot({ path: path.join(root, 'shots', 'diff-card.png') })
    await page.evaluate(() => window.litecode.setSettings({ appearance: 'light' }))
    await expect.poll(look, { timeout: 5_000 }).toEqual(['rgb(236, 19, 19)', 'rgba(236, 19, 19, 0.08)'])
  })

  it('추론 과정 탭: 도구 줄 끝 +A −D 를 누르면 같은 카드', async () => {
    await tab('추론 과정').click()
    const toggles = page.locator('.trajectory__diff-toggle')
    await expect.poll(() => toggles.allInnerTexts(), { timeout: 10_000 }).toEqual(['+1 −1', '+3 −2', '+2 −0', '+1 −?'])
    await toggles.first().click()
    expect(await toggles.first().getAttribute('aria-expanded')).toBe('true')
    expect(await cardLines(page.locator('.trajectory__diff'))).toEqual(EDIT_LINES)
    await tab('대화').click()
  })

  it('앱을 다시 켜고 그 대화를 열면 같은 +A −D 와 같은 줄 (opencode 기록에서 다시 그린다)', async () => {
    await app.close()
    await launch()
    await page.locator('.session-item', { hasText: 'diff-edit' }).click()
    await expect.poll(() => replies().count(), { timeout: 15_000 }).toBe(4)
    for (const index of [0, 1, 2, 3]) await turn(index).locator('.turn__head').click()
    expect(await page.locator('.turn-row[data-kind="tool"] .diff-stat').allInnerTexts()).toEqual(['+1 −1', '+3 −2', '+2 −0', '+1 −?'])
    expect(await cardLines(await openTool(0))).toEqual(EDIT_LINES)
    expect(await cardLines(await openTool(3))).toEqual(['file:w.txt이전 내용 모름 · 전체를 씀', 'add:new content'])
  })
})
