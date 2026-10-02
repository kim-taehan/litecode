import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core'
import { createServer, type ViteDevServer } from 'vite'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import { freePort, isolatedEnv } from './support/opencodeServer.ts'

// 답 말풍선 마크다운 실물 테스트 — 가짜 LLM 의 `[md]` 답(MARKDOWN_REPLY)이 진짜 opencode·IPC 를 지나 화면에 요소로 그려지는지,
// 원문 HTML 이 실행되지 않는지, 링크가 앱 밖(shell.openExternal)으로 가고 앱 창은 그대로인지 본다.
// 자기 앱을 따로 띄운다 — app.live.test.ts 의 순서에 기대지 않는다. 가짜로 두는 것: 폴더 대화상자, shell.openExternal(사용자 브라우저를
// 열지 않게), navigator.clipboard(사용자 클립보드를 덮지 않게) — 셋 다 "불렸는가·무엇으로" 만 기록한다.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

let vite: ViteDevServer
let app: ElectronApplication
let page: Page
/** 이 파일이 만든 임시 폴더 — 이것만 지운다 */
let tmp: string
/** 렌더러가 낸 요청 중 example.com 으로 간 것 (원격 이미지가 불러와지면 여기에 남는다) */
const outbound: string[] = []

beforeAll(async () => {
  execFileSync(path.join(root, 'node_modules/.bin/tsc'), ['-p', 'tsconfig.electron.json'], { cwd: root, stdio: 'inherit' })
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'litecode-md-')))
  const project = path.join(tmp, 'md-app')
  await fs.mkdir(project)

  const port = await freePort()
  vite = await createServer({ configFile: path.join(root, 'vite.config.ts'), server: { port, strictPort: true } })
  await vite.listen()

  app = await electron.launch({
    args: ['.', `--user-data-dir=${path.join(tmp, 'userData')}`, '--use-mock-keychain'],
    cwd: root,
    env: { ...isolatedEnv(tmp), LITECODE_TEST_HIDDEN: '1', LITECODE_DEV_SERVER_URL: `http://localhost:${port}`, LITECODE_GATEWAY_URL: `${inject('fakeLlmUrl')}/v1` },
  })
  page = await app.firstWindow()
  page.on('request', (request) => {
    if (request.url().includes('example.com')) outbound.push(request.url())
  })
  await page.locator('.sidebar-toggle:visible').waitFor()

  // 폴더 열기 (대화상자만 가짜) + 링크·클립보드 기록기
  await app.evaluate(({ dialog, shell }, picked) => {
    const state = globalThis as { opened?: string[] }
    state.opened = []
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [picked] })) as typeof dialog.showOpenDialog
    shell.openExternal = (async (url: string) => {
      state.opened!.push(url)
    }) as typeof shell.openExternal
  }, project)
  await page.locator('.open-guide').getByRole('button', { name: '폴더 열기…' }).click()
  await page.getByPlaceholder('메시지를 입력하세요…').waitFor({ timeout: 10_000 })
  await page.evaluate(() => {
    const state = window as unknown as { copied: string[] }
    state.copied = []
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: async (text: string) => void state.copied.push(text) },
    })
  })

  await page.getByPlaceholder('메시지를 입력하세요…').fill('[md] 마크다운으로 답해 줘')
  await page.keyboard.press('Enter')
  await page.locator('.bubble--assistant').waitFor({ timeout: 30_000 })
})

afterAll(async () => {
  await app?.close()
  await vite?.close()
  if (tmp) await fs.rm(tmp, { recursive: true, force: true })
})

const reply = () => page.locator('.bubble--assistant').last()
const opened = () => app.evaluate(() => (globalThis as { opened?: string[] }).opened ?? [])

describe('답 말풍선 마크다운', () => {
  it('제목·한글 굵게·목록·표·코드 블록이 화면 요소로 나온다', async () => {
    expect(await reply().locator('h2').textContent()).toBe('요약')
    expect(await reply().locator('strong').first().textContent()).toBe('프로젝트명:')
    expect(await reply().locator('ul > li').allTextContents()).toEqual(['첫째', '둘째'])
    expect(await reply().locator('th').allTextContents()).toEqual(['이름', '값'])
    expect(await reply().locator('td').allTextContents()).toEqual(['alpha', '1'])
    expect(await reply().locator('hr').count()).toBe(1)
    expect(await reply().locator('.md-code__lang').textContent()).toBe('ts')
    expect(await reply().locator('.md-code pre code').textContent()).toBe('const answer = 42')
    // 마크다운 기호가 글자로 남지 않는다
    expect(await reply().textContent()).not.toMatch(/##|\*\*|```|\|---/)
  })

  it('내 말풍선은 평문 그대로다', async () => {
    expect(await page.locator('.bubble--user').last().textContent()).toBe('[md] 마크다운으로 답해 줘')
    expect(await page.locator('.bubble--user .md').count()).toBe(0)
  })

  it('빈 줄이 여러 개여도 문단 사이는 한 칸이다', async () => {
    const first = (await reply().locator('.md > p', { hasText: '프로젝트명' }).boundingBox())!
    const second = (await reply().locator('.md > p', { hasText: '빈 줄 네 개 뒤 문단' }).boundingBox())!
    const gap = second.y - (first.y + first.height)
    expect(gap).toBeGreaterThan(0)
    expect(gap).toBeLessThan(24) // pre-wrap 이던 때는 빈 줄 네 개(약 88px)
  })

  it('원문 HTML(<script>·onerror)은 실행되지 않고 글자로 보인다', async () => {
    expect(await page.evaluate(() => (window as { __mdPwned?: string }).__mdPwned)).toBeUndefined()
    expect(await reply().locator('script').count()).toBe(0)
    expect(await reply().textContent()).toContain('<script>window.__mdPwned = "script"</script>')
    expect(await reply().textContent()).toContain('onerror=')
  })

  it('이미지는 불러오지 않고 대체 글자만 보인다', async () => {
    expect(await reply().locator('img').count()).toBe(0)
    expect(await reply().locator('.md-image').textContent()).toBe('원격 그림')
    expect(outbound).toEqual([])
  })

  it('코드 블록의 복사 버튼은 코드를 클립보드에 넣고 잠깐 복사됨을 보인다', async () => {
    const button = reply().getByRole('button', { name: '복사' })
    await button.click()
    expect(await page.evaluate(() => (window as unknown as { copied: string[] }).copied)).toEqual(['const answer = 42'])
    await expect.poll(() => reply().locator('.md-code__copy').getAttribute('aria-label'), { timeout: 1_000 }).toBe('복사됨')
    await expect.poll(() => reply().locator('.md-code__copy').getAttribute('aria-label'), { timeout: 5_000 }).toBe('복사')
  })

  it('링크를 누르면 앱 밖 브라우저로 열고 앱 창은 그 자리에 있다', async () => {
    const before = page.url()
    await reply().getByRole('link', { name: '문서' }).click()
    await expect.poll(opened, { timeout: 5_000 }).toEqual(['https://example.com/doc'])
    expect(page.url()).toBe(before)
    expect(outbound).toEqual([])
  })

  it('메인은 http(s) 가 아닌 주소를 열지 않는다 (렌더러를 거치지 않고 IPC 를 직접 불러도)', async () => {
    const results = await page.evaluate(async () => [
      await window.litecode.openExternal('file:///etc/passwd'),
      await window.litecode.openExternal('javascript:alert(1)'),
    ])
    expect(results).toEqual([false, false])
    expect(await opened()).toEqual(['https://example.com/doc'])
  })
})
