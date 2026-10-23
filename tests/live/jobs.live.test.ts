import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core'
import { createServer, type ViteDevServer } from 'vite'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import { freePort, isolatedEnv } from './support/opencodeServer.ts'

// 도는 작업 — 대화 머리의 "작업 N 진행 중" 트리거 + 드롭다운 (이슈 #610, dsh ui-jobs 모양).
// 진짜 Electron 창 → preload(chat:tasks·chat:stop-subtask) → BackgroundTasks(#319):
// `litecode_task_start` 로 띄운 작업은 별도 세션에서 돈다 — 메인 턴은 대기하지 않고 번호를 받는 대로 끝나고,
// 끝나면 결과 턴(origin 'task')이 새 턴으로 들어온다. 가짜는 LLM 하나 — 작업을 띄우는 법은
// `[calls:…]`(한 응답에 `litecode_task_start` 호출 여러 번), 작업 본체는 prompt 안의 `[bash:…]` 으로
// 도는 시간과 남기는 파일을 정한다.
// 백그라운드는 메인 턴을 대기하지 않으므로 "메인" 줄은 없는 게 정상 — 메인 턴이 내장 하위 작업을 기다릴 때만 보인다.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

let vite: ViteDevServer
let app: ElectronApplication
let page: Page
/** 이 테스트가 만든 임시 폴더 — 끝나면 이 경로만 지운다 */
let tmp: string
let project: string

beforeAll(async () => {
  execFileSync(path.join(root, 'node_modules/.bin/tsc'), ['-p', 'tsconfig.electron.json'], { cwd: root, stdio: 'inherit' })
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'litecode-jobs-')))
  const userData = path.join(tmp, 'userData')
  project = path.join(tmp, 'jobs-app')
  await fs.mkdir(project)

  const port = await freePort()
  vite = await createServer({ configFile: path.join(root, 'vite.config.ts'), server: { port, strictPort: true } })
  await vite.listen()
  app = await electron.launch({
    args: ['.', `--user-data-dir=${userData}`, '--use-mock-keychain'],
    cwd: root,
    env: {
      ...(isolatedEnv(tmp) as Record<string, string>),
      LITECODE_TEST_HIDDEN: '1',
      LITECODE_DEV_SERVER_URL: `http://localhost:${port}`,
      LITECODE_GATEWAY_URL: `${inject('fakeLlmUrl')}/v1`,
    },
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

/** 한 응답에 `litecode_task_start` 여러 번 — [설명, 작업이 받을 글] */
const bgTasks = (...entries: [string, string][]) =>
  `[calls:${JSON.stringify(entries.map(([description, prompt]) => ({ name: 'litecode_task_start', arguments: { agent: 'general', description, prompt } })))}]`

const input = () => page.locator('.composer__input')
const runningTurn = () => page.locator('.turn[data-state="running"]')
const trigger = () => page.locator('.main__header .jobs-trigger')
const label = () => trigger().locator('.jobs-trigger__label').textContent({ timeout: 1_000 }).catch(() => null)
const menu = () => page.locator('.jobs-menu')
const mainRow = () => menu().locator('.jobs__row[data-job="main"]')
const row = (name: string) => menu().locator('.jobs__row[data-job="subtask"]', { hasText: name })
const exists = (file: string) => fs.stat(path.join(project, file)).then(() => true, () => false)
/** 메뉴를 닫은 상태로 열어 둔다 (열려 있으면 그대로) */
const openMenu = async () => {
  if ((await trigger().getAttribute('aria-expanded')) !== 'true') await trigger().click()
  await menu().waitFor({ timeout: 5_000 })
}

async function submit(text: string): Promise<void> {
  await input().fill(text)
  await input().press('Enter')
}

describe('대화 머리의 작업 (이슈 #610)', () => {
  it('작업이 없는 보통 턴이 도는 동안에는 머리에 작업 트리거가 없다', async () => {
    expect(await trigger().count()).toBe(0)
    await submit('plain [bash:sleep 2]')
    // 도는 턴은 채팅에 한 줄 (이슈 #416·#605) — 도구가 도는 동안 "bash 실행 중 · N초"
    await expect.poll(() => runningTurn().locator('.turn-running__summary').textContent().catch(() => ''), { timeout: 20_000 }).toMatch(
      /^bash 실행 중 · \d+(분 \d+)?초$/,
    )
    expect(await trigger().count()).toBe(0)
    await expect.poll(() => runningTurn().count(), { timeout: 30_000 }).toBe(0)
    expect(await trigger().count()).toBe(0)
  })

  it('"작업 3 진행 중" → 드롭다운(진행 중 섹션·경과·줄 펼침·› 전체 기록), ■ 두 단계로 하나만 중지, "끝난 작업 3"이 새 턴 이후에도 남고 "지우기"로 사라진다', async () => {
    await page.evaluate(() => window.litecode.setSettings({ maxRunningTasks: 3 }))
    await page.locator('.new-chat').click()
    await submit(
      `jobs ${bgTasks(
        ['quick one', '[bash:sleep 8; echo q > quick.txt] q'],
        ['slow one', '[bash:sleep 14; echo 1 > slow-1.txt] c1'],
        ['slow two', '[bash:sleep 14; echo 2 > slow-2.txt] c2'],
      )}`,
    )
    // 메인 턴은 이미 끝났을 수 있고 세 작업은 별도 세션에서 여전히 돈다 — 스피너와 함께 "작업 3 진행 중"
    await expect.poll(label, { timeout: 30_000 }).toBe('작업 3 진행 중')
    expect(await trigger().getAttribute('aria-label')).toBe('작업 3 진행 중')
    expect(await trigger().getAttribute('aria-expanded')).toBe('false')
    expect(await trigger().locator('svg.jobs__spinner').evaluate((el) => getComputedStyle(el).animationName)).toBe('jobs-spin')
    // 자리: 대화 제목 뒤, "다른 앱에서 열기"(있으면)·"오른쪽 패널" 버튼 앞 — 머리 오른쪽 끝은 ⋯(대화 메뉴) 버튼
    const header = (await page.locator('.main__header').boundingBox())!
    const jobs = (await trigger().boundingBox())!
    const panelButton = (await page.locator('.right-panel-open').boundingBox())!
    const chatMore = (await page.locator('.chat-more-wrap').boundingBox())!
    expect(Math.round(header.x + header.width - 24 - (chatMore.x + chatMore.width))).toBe(0)
    const openIn = await page.locator('.main__header .open-in__split').boundingBox()
    expect(jobs.x).toBeGreaterThanOrEqual(header.x + 24)
    expect(jobs.x + jobs.width).toBeLessThanOrEqual((openIn ?? panelButton)!.x)

    // 드롭다운 — "진행 중" 섹션. "메인" 줄은 없다(메인 턴은 백그라운드를 기다리지 않는다)
    await openMenu()
    expect(await trigger().getAttribute('aria-expanded')).toBe('true')
    expect(await menu().locator('.jobs-menu__section').first().textContent()).toBe('진행 중')
    expect(await mainRow().count()).toBe(0)
    expect(await row('slow one').getAttribute('data-status')).toBe('running')
    expect(await row('slow two').getAttribute('data-status')).toBe('running')
    expect(await row('slow one').locator('.jobs__kind').textContent()).toBe('general')
    // 번호는 시작 순서(엔진이 보내는 순서)라 호출 순서와 다를 수 있다
    expect(await row('slow one').locator('.jobs__title').textContent()).toMatch(/^#\d+ slow one$/)
    // 백그라운드 작업은 토큰을 기록하지 않는다 — meta 는 시간뿐
    expect(await row('slow one').locator('.jobs__meta').textContent()).toMatch(/^\d+s$/)
    // 경과 초가 실시간으로 오른다
    const time = (name: string) => row(name).locator('.jobs__meta').textContent({ timeout: 1_000 })
    const first = await time('slow one')
    expect(first).toMatch(/^\d+s$/)
    await expect.poll(() => time('slow one'), { timeout: 3_000 }).not.toBe(first)

    // 줄을 누르면 아래에 지금 하는 일 한 줄(peek)이 펴지고, 다시 누르면 접힌다
    expect(await menu().locator('.jobs__peek').count()).toBe(0)
    await row('slow one').locator('.jobs__cells').click()
    expect(await row('slow one').locator('.jobs__cells').getAttribute('aria-expanded')).toBe('true')
    await expect.poll(() => menu().locator('.jobs__peek').textContent().catch(() => ''), { timeout: 10_000 }).toContain('bash')
    await row('slow one').locator('.jobs__cells').click()
    expect(await menu().locator('.jobs__peek').count()).toBe(0)

    // 줄 끝 › 는 오른쪽 패널의 "작업 N" 탭(전체 기록)을 연다
    await row('slow two').locator('.jobs__open').click()
    await page.locator('.task-tab').waitFor({ timeout: 5_000 })
    expect(await page.locator('.task-tab__title').first().textContent()).toContain('slow two')

    // Esc 로 닫힌다 — 그 Esc 는 답변 중지(Esc 두 번)에 세지 않는다. 바깥을 눌러도 닫힌다
    await page.keyboard.press('Escape')
    await expect.poll(() => menu().count(), { timeout: 2_000 }).toBe(0)
    expect(await trigger().getAttribute('aria-expanded')).toBe('false')
    await openMenu()
    await page.locator('.main__messages').click({ position: { x: 20, y: 300 } })
    await expect.poll(() => menu().count(), { timeout: 2_000 }).toBe(0)

    // ■ — 첫 클릭은 붉게 "중지" 준비, 두 번째가 실제. 그 백그라운드 작업만 멈춘다
    await openMenu()
    const stopTwo = row('slow two').getByRole('button', { name: '이 작업 중지' })
    await stopTwo.click()
    await expect.poll(() => stopTwo.getAttribute('data-kill-state'), { timeout: 2_000 }).toBe('armed')
    expect(await stopTwo.textContent()).toContain('중지')
    await stopTwo.click()
    // pending 으로 바뀐 뒤 멈춘 줄은 "끝난 작업"(접힌 섹션)으로 옮긴다
    await expect.poll(() => stopTwo.getAttribute('data-kill-state').catch(() => null), { timeout: 2_000 }).not.toBe('armed')
    await expect.poll(() => menu().getByRole('button', { name: '끝난 작업 펼치기' }).count(), { timeout: 20_000 }).toBe(1)
    await menu().getByRole('button', { name: '끝난 작업 펼치기' }).click()
    expect(await row('slow two').getAttribute('data-status')).toBe('stopped')
    expect(await row('slow two').locator('.jobs__meta').textContent()).toMatch(/중단됨$/)
    expect(await row('slow one').getAttribute('data-status')).toBe('running')

    // 다 끝나면 "끝난 작업 3"(체크)이 남는다 — 멈춘 작업의 파일만 없다
    await expect.poll(label, { timeout: 60_000 }).toBe('끝난 작업 3')
    expect(await trigger().locator('.jobs-trigger__done').count()).toBe(1)
    expect(await trigger().locator('svg.jobs__spinner').count()).toBe(0)
    await openMenu()
    // 도는 것이 없으면 끝난 작업 섹션은 펼친 채로
    expect(await menu().getByRole('button', { name: '끝난 작업 접기' }).count()).toBe(1)
    expect(await mainRow().count()).toBe(0)
    expect(await menu().locator('.jobs__row[data-job="subtask"]').count()).toBe(3)
    expect(await row('quick one').getAttribute('data-status')).toBe('done')
    expect(await row('slow one').getAttribute('data-status')).toBe('done')
    expect(await row('slow two').getAttribute('data-status')).toBe('stopped')
    expect(await row('quick one').locator('.jobs__meta').textContent()).toMatch(/^(?:\d+s|\d+m\d+s) · 완료$/)
    expect(await row('slow two').locator('.jobs__meta').textContent()).toMatch(/^(?:\d+s|\d+m\d+s) · 중단됨$/)
    expect(await menu().getByRole('button', { name: '지우기' }).count()).toBe(1)
    expect(await exists('quick.txt')).toBe(true)
    expect(await exists('slow-1.txt')).toBe(true)
    expect(await exists('slow-2.txt')).toBe(false)

    // 끝난 목록은 새 턴을 보내도 남아 있다 — "지우기" 를 누르면 사라진다
    await submit('after jobs')
    await expect.poll(label, { timeout: 10_000 }).toBe('끝난 작업 3')
    await expect.poll(() => page.locator('.bubble--assistant').last().textContent({ timeout: 1_000 }), { timeout: 60_000 })    .toBe('echo: after jobs')
    await openMenu()
    await menu().getByRole('button', { name: '지우기' }).click()
    await expect.poll(() => trigger().count(), { timeout: 5_000 }).toBe(0)
  })

  it('영어 문구 — 1 job(s) running · Running · Finished jobs 1 · Stop this job', async () => {
    await page.evaluate(() => window.litecode.setSettings({ language: 'en' }))
    await page.reload()
    await page.locator('.project-switch__name', { hasText: 'jobs-app' }).waitFor({ timeout: 10_000 })
    await page.locator('.new-chat').click()
    await submit(`english ${bgTasks(['en job', '[bash:sleep 4] c'])}`)
    await expect.poll(label, { timeout: 30_000 }).toBe('1 job(s) running')
    expect(await trigger().getAttribute('aria-label')).toBe('1 job(s) running')
    await openMenu()
    expect(await menu().locator('.jobs-menu__section').first().textContent()).toBe('Running')
    expect(await mainRow().count()).toBe(0)
    expect(await row('en job').getAttribute('data-status')).toBe('running')
    expect(await row('en job').locator('.jobs__title').textContent()).toBe('#1 en job')
    expect(await row('en job').getByRole('button', { name: 'Stop this job' }).count()).toBe(1)
    await expect.poll(label, { timeout: 30_000 }).toBe('Finished jobs 1')
    expect(await trigger().locator('.jobs-trigger__done').count()).toBe(1)
    await openMenu()
    expect(await row('en job').getAttribute('data-status')).toBe('done')
    expect(await row('en job').locator('.jobs__meta').textContent()).toMatch(/^\d+s · Done$/)
    await menu().getByRole('button', { name: 'Clear' }).click()
    await expect.poll(() => trigger().count(), { timeout: 5_000 }).toBe(0)
  })
})
