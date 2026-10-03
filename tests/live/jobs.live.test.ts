import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core'
import { createServer, type ViteDevServer } from 'vite'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import { freePort, isolatedEnv } from './support/opencodeServer.ts'

// 도는 작업 목록 (이슈 #32) — 대화 머리의 "작업 N" 버튼과 펼침 목록. 진짜 Electron 창 → preload(chat:progress·chat:stop-subtask) → ctx.llm
// (하위 작업 줄, 자식 세션 하나만 abort) → 진짜 opencode 레거시 task. 가짜는 LLM 하나 — 하위 작업을 띄우는 법은 subagents.live.test.ts 와 같다
// (`[calls:[…]]` 로 한 응답에 task 여럿, 자식은 prompt 안의 `[bash:…]` 로 도는 시간과 남기는 파일을 정한다).

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

let vite: ViteDevServer
let devServerUrl: string
let app: ElectronApplication
let page: Page
/** 이 테스트가 만든 임시 폴더 — 끝나면 이 경로만 지운다 */
let tmp: string
let userData: string
let project: string

beforeAll(async () => {
  execFileSync(path.join(root, 'node_modules/.bin/tsc'), ['-p', 'tsconfig.electron.json'], { cwd: root, stdio: 'inherit' })
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'litecode-jobs-')))
  userData = path.join(tmp, 'userData')
  project = path.join(tmp, 'jobs-app')
  await fs.mkdir(project)

  const port = await freePort()
  vite = await createServer({ configFile: path.join(root, 'vite.config.ts'), server: { port, strictPort: true } })
  await vite.listen()
  devServerUrl = `http://localhost:${port}`
  app = await electron.launch({
    args: ['.', `--user-data-dir=${userData}`, '--use-mock-keychain'],
    cwd: root,
    env: { ...(isolatedEnv(tmp) as Record<string, string>), LITECODE_TEST_HIDDEN: '1', LITECODE_DEV_SERVER_URL: devServerUrl, LITECODE_GATEWAY_URL: `${inject('fakeLlmUrl')}/v1` },
  })
  page = await app.firstWindow()
  await page.locator('.sidebar-toggle:visible').waitFor()
  await app.evaluate(({ dialog }, picked) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [picked] })) as typeof dialog.showOpenDialog
  }, project)
  await page.locator('.open-guide').getByRole('button', { name: '폴더 열기…' }).click()
  await page.locator('.project-switch__name', { hasText: 'jobs-app' }).waitFor({ timeout: 10_000 })
})

afterAll(async () => {
  await app?.close()
  await vite?.close()
  if (tmp) await fs.rm(tmp, { recursive: true, force: true })
})

/** 한 응답에 task 여럿 — [에이전트, 설명, 자식이 받을 글] */
const tasks = (...entries: [string, string, string][]) =>
  `[calls:${JSON.stringify(entries.map(([agent, description, prompt]) => ({ name: 'task', arguments: { subagent_type: agent, description, prompt } })))}]`

const input = () => page.locator('.composer__input')
const runningTurn = () => page.locator('.turn[data-state="running"]')
const button = () => page.locator('.main__header .jobs__button')
const buttonText = () => button().textContent({ timeout: 1_000 }).catch(() => null)
const panel = () => page.locator('.jobs__panel')
const mainRow = () => panel().locator('.jobs__row[data-job="main"]')
const row = (name: string) => panel().locator('.jobs__row[data-job="subtask"]', { hasText: name })
const exists = (file: string) => fs.stat(path.join(project, file)).then(() => true, () => false)

async function submit(text: string): Promise<void> {
  await input().fill(text)
  await input().press('Enter')
}

describe('도는 작업 목록 (이슈 #32)', () => {
  it('턴이 돌지 않을 때, 그리고 하위 작업이 없는 보통 턴이 도는 동안에는 머리에 작업 버튼이 없다', async () => {
    expect(await button().count()).toBe(0)
    await submit('plain [bash:sleep 2]')
    await runningTurn().locator('.turn-row[data-kind="tool"][data-status="running"]').waitFor({ timeout: 20_000 })
    expect(await button().count()).toBe(0)
    await expect.poll(() => runningTurn().count(), { timeout: 30_000 }).toBe(0)
    expect(await button().count()).toBe(0)
  })

  it('하위 작업이 도는 동안 "작업 N" 버튼 → 펼침 목록(경과·종류·하는 일·토큰), 줄 펼침, 끝난 것 접기, Esc·바깥 닫기, ■ 로 하나만 중지, 턴이 끝나면 사라진다', async () => {
    await page.locator('.new-chat').click()
    await submit(
      `jobs ${tasks(
        ['general', 'quick one', '[bash:echo q > quick.txt] q'],
        ['general', 'slow one', '[bash:sleep 14; echo 1 > slow-1.txt] c1'],
        ['general', 'slow two', '[bash:sleep 14; echo 2 > slow-2.txt] c2'],
      )}`,
    )
    // 빠른 것이 끝나면 도는 것은 메인 + 둘 = 3
    await expect.poll(buttonText, { timeout: 30_000 }).toBe('작업 3')
    expect(await button().getAttribute('aria-label')).toBe('도는 작업 3개')
    expect(await button().getAttribute('aria-expanded')).toBe('false')
    expect(await button().locator('svg.jobs__spinner').evaluate((el) => getComputedStyle(el).animationName)).toBe('jobs-spin')
    // 자리: 작업 → 다른 앱에서 열기(있으면) → 오른쪽 패널 버튼(맨 끝). 사이는 8px, 기존 순서는 그대로
    const header = (await page.locator('.main__header').boundingBox())!
    const jobs = (await button().boundingBox())!
    const panelButton = (await page.locator('.right-panel-open').boundingBox())!
    expect(Math.round(header.x + header.width - 24 - (panelButton.x + panelButton.width))).toBe(0)
    const openIn = await page.locator('.main__header .open-in__split').boundingBox()
    if (openIn) expect(Math.round(panelButton.x - (openIn.x + openIn.width))).toBe(8)
    expect(Math.round((openIn ?? panelButton).x - (jobs.x + jobs.width))).toBe(8)

    // 펼침 목록
    await button().click()
    await page.getByRole('region', { name: '도는 작업' }).waitFor({ timeout: 5_000 })
    expect(await button().getAttribute('aria-expanded')).toBe('true')
    expect(await panel().locator('.jobs__heading').textContent()).toBe('진행 중 3')
    expect(await mainRow().locator('.jobs__kind').textContent()).toBe('메인')
    expect(await mainRow().locator('.jobs__activity').textContent()).toBe('하위 작업 기다리는 중')
    expect(await mainRow().locator('.jobs__time').textContent()).toMatch(/^\d+s$/)
    expect(await panel().locator('.jobs__row[data-job="subtask"]').count()).toBe(2) // 끝난 것은 접혀 있다
    expect(await row('slow one').locator('.jobs__kind').textContent()).toBe('general')
    // 지금 하는 일 = 설명 · 마지막 도구. 토큰은 그 자식의 스텝이 하나 끝나야 온다 (bash 가 도는 동안은 없다)
    await expect.poll(() => row('slow one').locator('.jobs__activity').textContent({ timeout: 1_000 }), { timeout: 10_000 }).toBe('slow one · bash fake')
    expect(await row('slow one').locator('.jobs__tokens').count()).toBe(0)
    // 경과 초가 실시간으로 오른다 (메인도, 하위 작업도)
    const time = (name: string) => row(name).locator('.jobs__time').textContent({ timeout: 1_000 })
    const first = await time('slow one')
    expect(first).toMatch(/^\d+s$/)
    await expect.poll(() => time('slow one'), { timeout: 3_000 }).not.toBe(first)
    const mainFirst = await mainRow().locator('.jobs__time').textContent()
    await expect.poll(() => mainRow().locator('.jobs__time').textContent(), { timeout: 3_000 }).not.toBe(mainFirst)

    // 하위 작업 줄을 누르면 그 아래에 최근 진행 줄
    expect(await panel().locator('.jobs__detail').count()).toBe(0)
    await row('slow one').locator('.jobs__cells').click()
    expect(await row('slow one').locator('.jobs__cells').getAttribute('aria-expanded')).toBe('true')
    expect(await panel().locator('.jobs__detail > div').allTextContents()).toEqual(['bash fake …'])
    await row('slow one').locator('.jobs__cells').click()
    expect(await panel().locator('.jobs__detail').count()).toBe(0)

    // 끝난 것은 "끝난 것 N" 아래로 접혀 있고 펼칠 수 있다
    expect(await panel().locator('.jobs__finished-head span').textContent()).toBe('끝난 것 1')
    await panel().getByRole('button', { name: '끝난 것 펼치기' }).click()
    expect(await row('quick one').getAttribute('data-status')).toBe('done')
    expect(await row('quick one').locator('.jobs__activity').textContent()).toBe('quick one · 완료')
    expect(await row('quick one').locator('.jobs__tokens').textContent()).toMatch(/^· ↓ \d+(\.\d)?k?$/) // 토큰은 ↓ 3.1k 모양
    expect(await row('quick one').locator('.jobs__time').textContent()).toMatch(/^\d+s$/)
    expect(await row('quick one').getByRole('button', { name: '이 작업 중지' }).count()).toBe(0)
    await panel().getByRole('button', { name: '끝난 것 접기' }).click()
    expect(await row('quick one').count()).toBe(0)

    // Esc 로 닫힌다 — 그 Esc 는 답변 중지(Esc 두 번)에 세지 않는다. 바깥을 눌러도 닫힌다
    await page.keyboard.press('Escape')
    await expect.poll(() => panel().count(), { timeout: 2_000 }).toBe(0)
    expect(await button().getAttribute('aria-expanded')).toBe('false')
    await button().click()
    await panel().waitFor()
    await page.locator('.main__messages').click({ position: { x: 20, y: 300 } })
    await expect.poll(() => panel().count(), { timeout: 2_000 }).toBe(0)
    expect(await runningTurn().count()).toBe(1)

    // ■ — 그 하위 작업만 멈춘다. 줄은 끝난 것으로, 다른 하위 작업과 턴은 이어 간다
    await button().click()
    await row('slow two').getByRole('button', { name: '이 작업 중지' }).click()
    await expect.poll(buttonText, { timeout: 10_000 }).toBe('작업 2')
    expect(await panel().locator('.jobs__heading').textContent()).toBe('진행 중 2')
    expect(await panel().locator('.jobs__finished-head span').textContent()).toBe('끝난 것 2')
    await panel().getByRole('button', { name: '끝난 것 펼치기' }).click()
    expect(await row('slow two').getAttribute('data-status')).toBe('stopped')
    expect(await row('slow two').locator('.jobs__activity').textContent()).toBe('slow two · 중단됨')
    expect(await row('slow one').getAttribute('data-status')).toBe('running')
    expect(await runningTurn().count()).toBe(1)

    // 턴이 끝나면 버튼과 목록이 사라진다 — 턴은 "완료"(중단됨이 아니다), 멈춘 하위 작업의 파일만 없다
    await expect.poll(() => runningTurn().count(), { timeout: 40_000 }).toBe(0)
    expect(await button().count()).toBe(0)
    expect(await panel().count()).toBe(0)
    expect(await page.locator('.turn').last().locator('.turn__head-label').textContent()).toMatch(/^완료/)
    expect(await exists('quick.txt')).toBe(true)
    expect(await exists('slow-1.txt')).toBe(true)
    expect(await exists('slow-2.txt')).toBe(false)
    await page.locator('.turn').last().locator('.turn__head').click()
    expect(await page.locator('.turn').last().locator('.turn-row[data-kind="subtask"]').evaluateAll((rows) => rows.map((el) => el.getAttribute('data-status')))).toEqual(['done', 'done', 'stopped'])
    // 다음 턴은 정상
    await submit('after jobs')
    await expect.poll(() => page.locator('.bubble--assistant').last().textContent({ timeout: 1_000 }), { timeout: 30_000 }).toBe('echo: after jobs')
  })

  it('영어 문구 — Jobs N · Running N · Main · Waiting for subtasks · Stop this job', async () => {
    await page.evaluate(() => window.litecode.setSettings({ language: 'en' }))
    await page.reload()
    await page.locator('.project-switch__name', { hasText: 'jobs-app' }).waitFor({ timeout: 10_000 })
    await page.locator('.new-chat').click()
    await submit(`english ${tasks(['general', 'en job', '[bash:sleep 4] c'])}`)
    await expect.poll(buttonText, { timeout: 30_000 }).toBe('Jobs 2')
    expect(await button().getAttribute('aria-label')).toBe('2 running jobs')
    await button().click()
    await page.getByRole('region', { name: 'Running jobs' }).waitFor({ timeout: 5_000 })
    expect(await panel().locator('.jobs__heading').textContent()).toBe('Running 2')
    expect(await mainRow().locator('.jobs__kind').textContent()).toBe('Main')
    expect(await mainRow().locator('.jobs__activity').textContent()).toBe('Waiting for subtasks')
    expect(await row('en job').getByRole('button', { name: 'Stop this job' }).count()).toBe(1)
    await expect.poll(() => page.locator('.turn[data-state="running"]').count(), { timeout: 40_000 }).toBe(0)
    expect(await button().count()).toBe(0)
  })
})
