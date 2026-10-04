import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core'
import { createServer, type ViteDevServer } from 'vite'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import { freePort, isolatedEnv } from './support/opencodeServer.ts'

// 스킬 실물 테스트 (이슈 #7) — 진짜 Electron 창 + 앱이 띄운 진짜 opencode(레거시 경로) + 가짜 LLM.
// 스킬 파일은 앱을 띄우기 전에 둔다 — opencode 는 스킬 목록·본문을 폴더별로 캐시해 재시작 전엔 새 파일을 못 본다(레거시 실측 2026-10-02).
// 네 곳: 앱 전역(userData/opencode/skills), 프로젝트 .opencode/skills, 프로젝트 .claude/skills, HOME/.claude/skills.
// HOME 은 이 테스트의 임시 폴더다 — 사용자 실제 ~/.claude 는 읽지도 쓰지도 않는다. 캐시(XDG_CACHE_HOME)는 사용자 것을 그대로 둔다:
// 레거시 skill 도구가 ripgrep 으로 스킬 폴더 파일을 훑는데, rg 는 거기(opencode 가 받아 둔 것)에만 있다(개발 실행엔 동봉 rg 가 없다).
// 확인은 화면(설정 > 스킬·대화 줄·`/` 메뉴·말풍선)과 가짜 LLM 이 받은 요청 본문(시스템 프롬프트 <available_skills>·tools)으로 한다.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

let vite: ViteDevServer
let devServerUrl: string
let app: ElectronApplication
let page: Page
/** 이 테스트가 만든 임시 폴더 — 끝나면 이 경로만 지운다 */
let tmp: string
let userData: string
let project: string
let home: string
let appSkillFile: string

async function writeSkill(folder: string, name: string, description: string, body: string): Promise<string> {
  const file = path.join(folder, name, 'SKILL.md')
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`)
  return file
}

async function launch(): Promise<void> {
  app = await electron.launch({
    args: ['.', `--user-data-dir=${userData}`, '--use-mock-keychain'],
    cwd: root,
    env: {
      ...isolatedEnv(tmp),
      HOME: home,
      XDG_CACHE_HOME: process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), '.cache'),
      LITECODE_TEST_HIDDEN: '1',
      LITECODE_DEV_SERVER_URL: devServerUrl,
      LITECODE_GATEWAY_URL: `${inject('fakeLlmUrl')}/v1`,
    },
  })
  page = await app.firstWindow()
  await page.locator('.sidebar-toggle:visible').waitFor()
}

beforeAll(async () => {
  execFileSync(path.join(root, 'node_modules/.bin/tsc'), ['-p', 'tsconfig.electron.json'], { cwd: root, stdio: 'inherit' })
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'litecode-skills-')))
  userData = path.join(tmp, 'userData')
  project = path.join(tmp, 'skill-app')
  home = path.join(tmp, 'home')
  await fs.mkdir(project, { recursive: true })
  appSkillFile = await writeSkill(path.join(userData, 'opencode', 'skills'), 'lc-app', 'APP SKILL DESC', 'BODY-LC-APP')
  await writeSkill(path.join(project, '.opencode', 'skills'), 'lc-proj', 'PROJECT SKILL DESC', 'BODY-LC-PROJ')
  await writeSkill(path.join(project, '.claude', 'skills'), 'lc-claude-proj', 'CLAUDE PROJECT DESC', 'BODY-LC-CLAUDE-PROJ')
  await writeSkill(path.join(home, '.claude', 'skills'), 'lc-claude-home', 'CLAUDE HOME DESC', 'BODY-LC-CLAUDE-HOME')

  const port = await freePort()
  vite = await createServer({ configFile: path.join(root, 'vite.config.ts'), server: { port, strictPort: true } })
  await vite.listen()
  devServerUrl = `http://localhost:${port}`
  await launch()
  await app.evaluate(({ dialog }, picked) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [picked] })) as typeof dialog.showOpenDialog
  }, project)
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
const options = () => menu().getByRole('option')
const replies = () => page.locator('.bubble--assistant')
const dialog = () => page.locator('.settings-panel')
const skillItem = (name: string) => dialog().locator(`.skill-item[data-skill="${name}"]`)
const claudeSwitch = () => dialog().getByRole('switch', { name: 'Claude Code 스킬 함께 쓰기', exact: true })
const lastTurn = () => page.locator('.turn').last()
const lastHead = () => lastTurn().locator('.turn__head-label').textContent({ timeout: 1_000 })

type Requests = { count: number; lastChat: { tools: string[] }; lastChatText: string }
const requests = async (): Promise<Requests> => (await (await fetch(`${inject('fakeLlmUrl')}/requests`)).json()) as Requests
/** 시스템 프롬프트 <available_skills> 의 이름들 */
const promptSkills = (text: string) => [...text.matchAll(/<name>([^<]+)<\/name>/g)].map((match) => match[1]).sort()

/** 화면 IPC 로 새 엔진 세션에 한 턴 — 가짜 LLM 이 받은 마지막 요청 */
async function probeTurn(label: string): Promise<Requests> {
  const text = `skills probe ${label} ${Date.now()}`
  const result = await page.evaluate(
    ([dir, prompt]) => new Promise<{ text: string; error?: string }>((resolve) => {
        // 보내기는 바로 돌아온다(ctx.chat, 이슈 #52) — 답은 그 대화의 턴 끝 이벤트로 온다
        const id = `skills-probe-${Date.now()}`
        const off = window.litecode.onTurnEnded((ended) => {
          if (ended.cid !== id) return
          off()
          resolve(ended.message)
        })
        void window.litecode.sendMessage(id, { project: dir, text: prompt, mode: 'build', model: { providerId: 'gateway-local', modelId: 'qwen3.8-27b' } })
      }),
    [project, text] as const,
  )
  expect(result).toMatchObject({ text: `echo: ${text}` })
  expect(result.error).toBeUndefined()
  return requests()
}

/** 입력을 비우고 사람처럼 친다 (fill 은 캐럿 이벤트를 안 낸다) */
async function typeFresh(text: string): Promise<void> {
  await input().fill('')
  await input().focus()
  await page.keyboard.type(text)
}

/** Enter 로 내고 새 답을 기다린다 */
async function enterAndWait(): Promise<void> {
  const before = await replies().count()
  await page.keyboard.press('Enter')
  await expect.poll(() => replies().count(), { timeout: 30_000 }).toBe(before + 1)
}

async function openSkills(): Promise<void> {
  if (!(await dialog().isVisible())) await page.getByRole('button', { name: '설정', exact: true }).click()
  await dialog().getByRole('button', { name: '스킬', exact: true }).click()
  await claudeSwitch().waitFor()
}

async function closeSettings(): Promise<void> {
  await page.keyboard.press('Escape')
  await expect.poll(() => dialog().count(), { timeout: 5_000 }).toBe(0)
}

/** 마지막 턴의 스킬 줄 — 끝난 턴은 접혀 있어 머리를 눌러 편다 */
async function lastSkillRow() {
  const head = lastTurn().locator('button.turn__head')
  if ((await head.getAttribute('aria-expanded')) === 'false') await head.click()
  const row = lastTurn().locator('.turn-row[data-kind="tool"]', { has: page.locator('.turn-row__title', { hasText: /^스킬$/ }) })
  await row.waitFor({ timeout: 5_000 })
  return row
}

describe('스킬 (이슈 #7)', () => {
  it('기본(Claude 꺼짐): LLM 요청에 skill 도구와 앱·프로젝트 스킬만 — 내장 customize-opencode·Claude 스킬은 없다', async () => {
    const { lastChat, lastChatText } = await probeTurn('default')
    expect(lastChat.tools).toContain('skill')
    expect(promptSkills(lastChatText)).toEqual(['lc-app', 'lc-proj'])
    expect(lastChatText).not.toContain('customize-opencode')
    expect(lastChatText).not.toContain('lc-claude')
  })

  it('설정 > 스킬: 이름·설명·출처 배지(앱 없음/프로젝트), 누르면 본문, Claude 스위치는 꺼짐', async () => {
    await openSkills()
    expect(await claudeSwitch().getAttribute('aria-checked')).toBe('false')
    await skillItem('lc-proj').waitFor({ timeout: 15_000 })
    expect(await dialog().locator('.skill-item').evaluateAll((items) => items.map((item) => item.getAttribute('data-skill')))).toEqual(['lc-app', 'lc-proj'])
    expect(await skillItem('lc-app').locator('.skill-item__description').textContent()).toBe('APP SKILL DESC')
    expect(await skillItem('lc-app').locator('.skill-badge').count()).toBe(0)
    expect(await skillItem('lc-proj').locator('.skill-badge').textContent()).toBe('프로젝트')
    await skillItem('lc-app').locator('.skill-item__head').click()
    expect(await skillItem('lc-app').locator('.skill-item__body').textContent()).toContain('BODY-LC-APP')
    await closeSettings()
  })

  it('모델이 skill 을 부르면 대화에 "스킬 · 이름" 줄 + 프로젝트 배지, 펼치면 지침 본문', async () => {
    await typeFresh('[call:skill {"name":"lc-proj"}]')
    await enterAndWait()
    const row = await lastSkillRow()
    expect(await row.locator('.turn-row__summary').textContent()).toBe('lc-proj')
    expect(await row.locator('.skill-badge').textContent()).toBe('프로젝트')
    await row.locator('.turn-row__line').click()
    expect(await row.locator('.turn-row__instructions').textContent()).toContain('BODY-LC-PROJ')
    expect(await row.locator('.turn-row__instructions').textContent()).not.toContain('skill_content')
  })

  it('/ 메뉴에 스킬 그룹 — 고르고 보내면 앱이 SKILL.md 본문을 붙이고 말풍선엔 친 글. 파일을 고치면 재시작 없이 새 본문', async () => {
    await page.getByRole('button', { name: '+ 새 대화' }).click()
    await typeFresh('/lc-a')
    await expect.poll(() => options().allTextContents(), { timeout: 10_000 }).toEqual([expect.stringContaining('/lc-app')])
    expect(await menu().locator('.trigger-menu__group').allTextContents()).toEqual(['스킬'])
    await options().first().hover()
    await page.keyboard.press('Enter')
    expect(await input().inputValue()).toBe('/lc-app ')
    await page.keyboard.type('do it')
    await enterAndWait()
    expect(await page.locator('.bubble--user').last().textContent()).toBe('/lc-app do it')
    let { lastChatText } = await requests()
    expect(lastChatText).toContain('<skill_content name="lc-app">')
    expect(lastChatText).toContain('BODY-LC-APP')
    expect(lastChatText).toContain('do it')

    await fs.writeFile(appSkillFile, '---\nname: lc-app\ndescription: APP SKILL DESC\n---\nBODY-LC-APP-V2\n')
    await typeFresh('/lc-app again')
    await enterAndWait()
    expect(await page.locator('.bubble--user').last().textContent()).toBe('/lc-app again')
    ;({ lastChatText } = await requests())
    expect(lastChatText).toContain('BODY-LC-APP-V2')
  })

  it('"Claude Code 스킬 함께 쓰기" 를 켜면 엔진이 다시 떠(진행 중 턴은 중단됨) Claude 스킬이 목록·LLM 요청·대화 줄에 "Claude" 배지로 — 지시문 바뀜 줄은 없다', async () => {
    const before = (await requests()).count
    await typeFresh('[slow] Claude 스킬 켜기 전')
    await page.keyboard.press('Enter')
    await expect.poll(async () => (await requests()).count, { timeout: 20_000 }).toBe(before + 1)

    await openSkills()
    await claudeSwitch().click()
    await expect.poll(() => claudeSwitch().getAttribute('aria-checked'), { timeout: 5_000 }).toBe('true')
    await skillItem('lc-claude-home').waitFor({ timeout: 30_000 })
    expect(await dialog().locator('.skill-item').evaluateAll((items) => items.map((item) => item.getAttribute('data-skill')))).toEqual([
      'lc-app',
      'lc-claude-home',
      'lc-claude-proj',
      'lc-proj',
    ])
    expect(await skillItem('lc-claude-home').locator('.skill-badge').textContent()).toBe('Claude')
    expect(await skillItem('lc-claude-proj').locator('.skill-badge').textContent()).toBe('Claude')
    await closeSettings()
    await expect.poll(lastHead, { timeout: 30_000 }).toMatch(/^중단됨/)
    expect((JSON.parse(await fs.readFile(path.join(userData, 'settings.json'), 'utf8')) as { claudeSkills?: boolean }).claudeSkills).toBe(true)

    // 같은 대화(옛 세션)에 이어서 — 모델이 Claude 스킬을 부른다
    await typeFresh('[call:skill {"name":"lc-claude-home"}]')
    await enterAndWait()
    const row = await lastSkillRow()
    expect(await row.locator('.skill-badge').textContent()).toBe('Claude')
    expect(promptSkills((await requests()).lastChatText)).toEqual(['lc-app', 'lc-claude-home', 'lc-claude-proj', 'lc-proj'])
    expect(await page.locator('.turn-row[data-kind="context"]').count()).toBe(0)
    // 이 대화(/lc-app 로 시작한 것)는 저장 목록 맨 앞이다 — 가장 최근에 만든 대화
    const sessionId = await page.evaluate(async () => (await window.litecode.listConversations())[0]?.engineSessionId)
    expect(sessionId).toBeTruthy()
    const trajectory = await page.evaluate(([dir, id]) => window.litecode.loadTrajectory(dir, id), [project, sessionId!] as const)
    expect(trajectory.records.length).toBeGreaterThan(0)
    expect(trajectory.records.filter((record) => record.kind === 'context')).toEqual([])
  })

  it('설정 > 기능에서 스킬을 끄면 설정 메뉴·/ 후보·LLM 요청(skill 도구·목록)에서 모두 빠진다', async () => {
    await page.getByRole('button', { name: '설정', exact: true }).click()
    await dialog().getByRole('button', { name: '기능', exact: true }).click()
    const skillsSwitch = dialog().locator('[data-feature="skills"]').getByRole('switch')
    expect(await skillsSwitch.getAttribute('aria-checked')).toBe('true')
    await skillsSwitch.click()
    await expect.poll(() => skillsSwitch.getAttribute('aria-checked'), { timeout: 5_000 }).toBe('false')
    await expect.poll(() => dialog().getByRole('button', { name: '스킬', exact: true }).count(), { timeout: 5_000 }).toBe(0)
    await closeSettings()
    await expect.poll(() => page.evaluate(() => window.litecode.getFeatures()), { timeout: 5_000 }).not.toContain('skills')

    const query = await page.evaluate((dir) => window.litecode.queryTrigger({ directory: dir }, '/lc', 3), project)
    expect(query?.candidates ?? []).toEqual([])
    const { lastChat, lastChatText } = await probeTurn('off')
    expect(lastChat.tools).not.toContain('skill')
    expect(lastChatText).not.toContain('available_skills')
  })
})
