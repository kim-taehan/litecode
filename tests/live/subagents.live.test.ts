import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core'
import { createServer, type ViteDevServer } from 'vite'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import { freePort, isolatedEnv } from './support/opencodeServer.ts'

// 하위 작업 (이슈 #31) — AI 가 task 도구로 일을 나눠 자식 세션을 동시에 돌린다. 진짜 Electron 창 → preload(chat:progress·chat:attention) →
// ctx.llm(같은 /event 의 자식 sessionID 이벤트 → 하위 작업 줄, 자식 승인 요청 → 부모 턴 카드, 부모 idle 만 턴 끝) → ctx.engine 이 생성한 opencode.json
// (매번 묻기의 묻는 하위 에이전트 general-ask) → 진짜 opencode 레거시 task. 가짜는 LLM 하나 — `[calls:[…]]` 로 한 응답에 task 여럿, 자식은 task 의
// prompt 를 user 로 받으므로 그 안의 `[bash:…]` 로 자식이 도는 시간과 남기는 파일을 정한다.

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
    env: { ...(isolatedEnv(tmp) as Record<string, string>), LITECODE_TEST_HIDDEN: '1', LITECODE_DEV_SERVER_URL: devServerUrl, LITECODE_GATEWAY_URL: `${inject('fakeLlmUrl')}/v1` },
  })
  page = await app.firstWindow()
  await page.locator('.sidebar-toggle:visible').waitFor()
}

beforeAll(async () => {
  execFileSync(path.join(root, 'node_modules/.bin/tsc'), ['-p', 'tsconfig.electron.json'], { cwd: root, stdio: 'inherit' })
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'litecode-subagents-')))
  userData = path.join(tmp, 'userData')
  project = path.join(tmp, 'subagents-app')
  await fs.mkdir(project)

  const port = await freePort()
  vite = await createServer({ configFile: path.join(root, 'vite.config.ts'), server: { port, strictPort: true } })
  await vite.listen()
  devServerUrl = `http://localhost:${port}`
  await launch()
  await app.evaluate(({ dialog }, picked) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [picked] })) as typeof dialog.showOpenDialog
  }, project)
  await page.locator('.open-guide').getByRole('button', { name: '폴더 열기…' }).click()
  await page.locator('.project-switch__name', { hasText: 'subagents-app' }).waitFor({ timeout: 10_000 })
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
const chip = () => page.locator('.mode-chip')
const runningTurn = () => page.locator('.turn[data-state="running"]')
const lastTurn = () => page.locator('.turn').last()
const lastHead = () => lastTurn().locator('.turn__head-label').textContent({ timeout: 1_000 })
const subtasks = () => lastTurn().locator('.turn-row[data-kind="subtask"]')
const subtask = (name: string) => lastTurn().locator('.turn-row[data-kind="subtask"]', { hasText: name })
const card = () => page.locator('.attention-card[data-kind="permission"]')
const exists = (file: string) => fs.stat(path.join(project, file)).then(() => true, () => false)
const tab = (name: 'Chat' | 'Trajectory') => page.getByRole('tab', { name: name === 'Chat' ? '대화' : '추론 과정' })

async function submit(text: string): Promise<void> {
  await input().fill(text)
  await input().press('Enter')
}

async function pickMode(name: string): Promise<void> {
  await chip().click()
  await page.locator('.mode-menu').getByRole('menuitemradio', { name }).click()
}

async function openChat(title: string): Promise<void> {
  await page.locator('.session-item', { hasText: title }).click()
  await expect.poll(() => page.locator('.session-item--active .session-item__title').textContent({ timeout: 1_000 }), { timeout: 5_000 }).toContain(title)
  await expect.poll(() => page.getByText('불러오는 중…').count(), { timeout: 15_000 }).toBe(0)
}

describe('하위 작업 (이슈 #31)', () => {
  it('task 2개가 동시에 돈다 — 두 줄이 함께 진행 중·각자 초가 오르고, 펼치면 자식 줄, 둘 다 끝난 뒤 부모 답, 턴은 한 번 끝난다', async () => {
    const answersBefore = await page.locator('.bubble--assistant').count()
    await submit(
      `parallel ${tasks(['general', 'alpha job', '[bash:sleep 4; echo A > sub-a.txt] child A'], ['general', 'beta job', '[bash:sleep 4; echo B > sub-b.txt] child B'])}`,
    )
    await runningTurn().waitFor({ timeout: 10_000 })
    // 두 하위 작업이 함께 진행 중 — 줄마다 "하위 작업 · general · 설명"
    await expect.poll(() => runningTurn().locator('.turn-row[data-kind="subtask"][data-status="running"]').count(), { timeout: 20_000 }).toBe(2)
    expect(await subtask('alpha job').locator('.turn-row__title').textContent()).toBe('하위 작업')
    expect(await subtask('alpha job').locator('.turn-row__summary').textContent()).toBe('general · alpha job')
    expect(await subtask('beta job').locator('.turn-row__summary').textContent()).toBe('general · beta job')
    // 각자 초가 오른다
    const status = (name: string) => subtask(name).locator('.turn-subtask__status').textContent({ timeout: 1_000 })
    const firstA = await status('alpha job')
    expect(firstA).toMatch(/^진행 중 · \d+초/)
    await expect.poll(() => status('alpha job'), { timeout: 3_000 }).not.toBe(firstA)
    expect(await status('beta job')).toMatch(/^진행 중 · \d+초/)
    // 펼치면 그 자식의 줄이 실시간으로 — 자식이 부른 bash
    await subtask('alpha job').locator('.turn-row__line').first().click()
    await expect.poll(() => subtask('alpha job').locator('.turn-subtask__body .turn-row[data-kind="tool"]').count(), { timeout: 10_000 }).toBeGreaterThan(0)
    expect(await subtask('alpha job').locator('.turn-subtask__body .turn-row[data-kind="tool"] .turn-row__title').first().textContent()).toBe('Bash')
    expect(await exists('sub-a.txt')).toBe(false) // 자식 bash 가 아직 도는 중 — 자식 idle 이 와도 부모 턴은 안 끝난다

    // 둘 다 끝난 뒤 부모 답 — 턴은 한 번만 끝난다(답 하나)
    await expect.poll(() => runningTurn().count(), { timeout: 40_000 }).toBe(0)
    expect(await page.locator('.bubble--assistant').count()).toBe(answersBefore + 1)
    expect(await lastHead()).toMatch(/^완료/)
    expect(await exists('sub-a.txt')).toBe(true)
    expect(await exists('sub-b.txt')).toBe(true)
    await page.waitForTimeout(1_000)
    expect(await page.locator('.bubble--assistant').count()).toBe(answersBefore + 1)
    // 끝난 턴을 펼치면 두 하위 작업 모두 완료 · N초
    await lastTurn().locator('.turn__head').click()
    expect(await subtasks().evaluateAll((rows) => rows.map((row) => row.getAttribute('data-status')))).toEqual(['done', 'done'])
    expect(await subtask('alpha job').locator('.turn-subtask__status').textContent()).toMatch(/^완료 · \d+초/)
    // 사이드바엔 자식 세션이 따로 뜨지 않는다 — 대화 하나
    expect(await page.locator('.session-item').count()).toBe(1)
  })

  it('매번 묻기: 하위 작업의 bash 도 승인 카드(어느 하위 작업인지)로 묻고, 허용하면 이어 가 턴이 끝난다. 묻지 않는 general 은 막힌다', async () => {
    await page.locator('.new-chat').click()
    await pickMode('매번 묻기')
    await submit(
      `ask chat ${tasks(['general-ask', 'ask job', '[bash:echo hi > ask-sub.txt] child'], ['general', 'sneaky job', '[bash:echo x > sneaky.txt] child'])}`,
    )
    await card().waitFor({ timeout: 30_000 })
    expect(await card().locator('.attention-card__from').textContent()).toBe('하위 작업 · general-ask · ask job')
    expect(await card().locator('.attention-card__command').textContent()).toBe('echo hi > ask-sub.txt')
    expect(await exists('ask-sub.txt')).toBe(false)
    expect(await runningTurn().count()).toBe(1) // 카드를 기다리는 동안 턴은 멈추지 않고 돈다
    await card().getByRole('button', { name: '한 번 허용' }).click()
    await expect.poll(() => exists('ask-sub.txt'), { timeout: 30_000 }).toBe(true)
    await expect.poll(() => runningTurn().count(), { timeout: 30_000 }).toBe(0)
    expect(await lastHead()).toMatch(/^완료/)
    expect(await card().count()).toBe(0)
    // 매번 묻기에서 묻지 않는 하위 에이전트(general)는 엔진 규칙이 막는다 — 그 하위 작업은 실패, 파일 없음
    await lastTurn().locator('.turn__head').click()
    expect(await subtask('sneaky job').getAttribute('data-status')).toBe('error')
    expect(await subtask('ask job').getAttribute('data-status')).toBe('done')
    expect(await exists('sneaky.txt')).toBe(false)
  })

  it('중지하면 부모와 진행 중 하위 작업이 모두 멈춘다 — 턴은 "중단됨", 하위 작업 줄도 중단됨, 자식 bash 의 파일은 안 생긴다', async () => {
    await page.locator('.new-chat').click()
    await submit(`stop chat ${tasks(['general', 'slow one', '[bash:sleep 6; echo 1 > stop-1.txt] c1'], ['general', 'slow two', '[bash:sleep 6; echo 2 > stop-2.txt] c2'])}`)
    await expect.poll(() => runningTurn().locator('.turn-row[data-kind="subtask"][data-status="running"]').count(), { timeout: 20_000 }).toBe(2)
    await page.waitForTimeout(1_000) // 자식 bash 가 시작되게
    await page.locator('.composer__stop').click()
    await expect.poll(() => runningTurn().count(), { timeout: 15_000 }).toBe(0)
    expect(await lastTurn().getAttribute('data-state')).toBe('interrupted')
    expect(await lastHead()).toMatch(/^중단됨/)
    expect(await subtasks().evaluateAll((rows) => rows.map((row) => row.getAttribute('data-status')))).toEqual(['stopped', 'stopped'])
    expect(await subtask('slow one').locator('.turn-subtask__status').textContent()).toBe('중단됨')
    await page.waitForTimeout(7_000) // 자식 bash 가 살아 있었다면 이때쯤 파일을 남긴다
    expect(await exists('stop-1.txt')).toBe(false)
    expect(await exists('stop-2.txt')).toBe(false)
    // 다음 턴은 정상
    await submit('after stop')
    await expect.poll(() => page.locator('.bubble--assistant').last().textContent({ timeout: 1_000 }), { timeout: 30_000 }).toBe('echo: after stop')
  })

  it('다시 열면(앱 재시작) 하위 작업 묶음이 자식 기록과 함께 보이고, 추론 과정 탭에도 하위 작업 줄이 있다', async () => {
    await app.close()
    await launch()
    await openChat('parallel')
    await lastTurn().locator('.turn__head').click()
    await expect.poll(() => subtasks().count(), { timeout: 15_000 }).toBe(2)
    expect(await subtasks().evaluateAll((rows) => rows.map((row) => row.getAttribute('data-status')))).toEqual(['done', 'done'])
    expect(await subtask('beta job').locator('.turn-subtask__status').textContent()).toMatch(/^완료 · \d+초 · 토큰 [\d,]+$/)
    await subtask('beta job').locator('.turn-row__line').first().click()
    await expect.poll(() => subtask('beta job').locator('.turn-subtask__body .turn-row[data-kind="tool"]').count(), { timeout: 5_000 }).toBe(1)
    expect(await subtask('beta job').locator('.turn-subtask__body .turn-row[data-kind="tool"] .turn-row__summary').textContent()).toBe('fake')

    await tab('Trajectory').click()
    await expect.poll(() => page.locator('.trajectory__row--subtask').count(), { timeout: 15_000 }).toBeGreaterThan(0)
    expect(await page.locator('.trajectory__row--subtask[data-kind="tool"]', { hasText: 'sub-b.txt' }).locator('.trajectory__subtask').textContent()).toBe('하위 작업 · general · beta job')
    await tab('Chat').click()
    // 지난 중지 턴도 다시 열면 하위 작업이 중단됨
    await openChat('stop chat')
    await expect.poll(() => page.locator('.turn').nth(0).locator('.turn-row[data-kind="subtask"]').count(), { timeout: 15_000 }).toBe(2)
    expect(await page.locator('.turn').nth(0).locator('.turn-row[data-kind="subtask"]').evaluateAll((rows) => rows.map((row) => row.getAttribute('data-status')))).toEqual(['stopped', 'stopped'])
  })
})
