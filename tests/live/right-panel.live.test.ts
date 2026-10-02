import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core'
import { createServer, type ViteDevServer } from 'vite'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import { freePort, isolatedEnv } from './support/opencodeServer.ts'

// 오른쪽 패널 실물 테스트 (이슈 #29) — 진짜 Electron 창에서 파일 탭·Files 탭(폴더 나무)·HTML 실행 미리보기를 관통한다.
// 렌더러 → preload(chat:list-directory·chat:preview-assets·chat:preview-file) → 메인 검사(등록 프로젝트·realpath·밖 링크) → 패널,
// 그리고 HTML iframe 의 격리(앱·preload·부모 DOM 접근 0, 127.0.0.1 기록 서버로 가는 요청 0 — fetch·img·script·css·이동·팝업·폼).
// 자기 앱·vite·기록 서버·임시 폴더만 띄우고, 끝나면 그 임시 폴더만 지운다.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

let vite: ViteDevServer
let app: ElectronApplication
let page: Page
let recorder: http.Server
/** 기록 서버가 받은 요청 경로 — iframe 이 밖으로 낸 요청이면 여기 남는다 */
const hits: string[] = []
/** 이 테스트가 만든 임시 폴더 — 끝나면 이 경로만 지운다 */
let tmp: string
let userData: string
let project: string
let outside: string

const HELLO = 'export const a = 1\n'
// 상대 경로 스크립트·스타일·이미지를 쓰는 한 쪽짜리 "게임" — 버튼을 누르면 글이 바뀐다
const GAME = (title: string) => `<!doctype html>
<html><head><link rel="stylesheet" href="style.css"><script src="game.js"></script></head>
<body><h1 id="title">${title}</h1><p id="state">ready</p><button id="go" type="button">go</button><img id="dot" src="dot.png" alt="dot">
<script>document.getElementById('go').addEventListener('click', () => { document.getElementById('state').textContent = 'clicked ' + window.fromGameJs })</script>
</body></html>
`
// 1x1 투명 PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64')

/** 밖으로 나가려는 모든 길을 시도하고 결과를 #out 에 적는 문서 */
function escapeHtml(rec: string): string {
  return `<!doctype html>
<html><head>
<link rel="stylesheet" href="${rec}/css"><script src="${rec}/script"></script>
<link rel="prefetch" href="${rec}/prefetch">
</head><body>
<img src="${rec}/img"><iframe src="${rec}/frame"></iframe>
<form id="f" action="${rec}/form" method="get"><input name="q" value="1"></form>
<a id="link" href="${rec}/link">link</a><a id="blank" href="${rec}/blank" target="_blank">blank</a>
<pre id="out">pending</pre>
<script>
const r = {}
r.litecode = typeof window.litecode
try { r.parent = String(parent.document.title) } catch (e) { r.parent = 'blocked' }
try { r.top = String(top.location.href) } catch (e) { r.top = 'blocked' }
try { localStorage.setItem('x', '1'); r.storage = 'ok' } catch (e) { r.storage = 'blocked' }
try { document.cookie = 'a=1'; r.cookie = document.cookie } catch (e) { r.cookie = 'blocked' }
r.popup = String(window.open('${rec}/popup'))
try { document.getElementById('f').submit() } catch (e) {}
document.getElementById('link').click()
document.getElementById('blank').click()
try { const ws = new WebSocket('${rec.replace('http', 'ws')}/ws'); ws.onerror = () => {} } catch (e) {}
fetch('${rec}/fetch').then(() => { r.fetch = 'ok' }, () => { r.fetch = 'blocked' }).finally(() => {
  document.getElementById('out').textContent = JSON.stringify(r)
  setTimeout(() => { location.href = '${rec}/nav' }, 50)
})
</script>
</body></html>
`
}

beforeAll(async () => {
  execFileSync(path.join(root, 'node_modules/.bin/tsc'), ['-p', 'tsconfig.electron.json'], { cwd: root, stdio: 'inherit' })
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'litecode-right-panel-')))
  userData = path.join(tmp, 'userData')
  project = path.join(tmp, 'panel-app')
  outside = path.join(tmp, 'outside')
  await fs.mkdir(path.join(project, 'src'), { recursive: true })
  await fs.mkdir(path.join(project, 'site'), { recursive: true })
  await fs.mkdir(path.join(outside, 'secret-dir'), { recursive: true })
  await fs.writeFile(path.join(outside, 'secret.txt'), 'TOP-SECRET-OUTSIDE\n')
  await fs.writeFile(path.join(outside, 'leak.js'), 'window.fromGameJs = "LEAKED"')
  await fs.writeFile(path.join(project, 'src', 'hello.ts'), HELLO)
  await fs.writeFile(path.join(project, 'README.md'), '# 제목\n')
  await fs.writeFile(path.join(project, 'site', 'game.html'), GAME('v1'))
  await fs.writeFile(path.join(project, 'site', 'game.js'), 'window.fromGameJs = "js-ok"')
  await fs.writeFile(path.join(project, 'site', 'style.css'), '#title { color: rgb(255, 0, 0); }')
  await fs.writeFile(path.join(project, 'site', 'dot.png'), PNG)
  // 밖을 가리키는 링크 — 나무에 안 보여야 하고, HTML 이 상대 경로로 불러도 안 실려야 한다
  await fs.symlink(outside, path.join(project, 'outlink'))
  await fs.symlink(path.join(outside, 'secret.txt'), path.join(project, 'outfile.txt'))
  await fs.symlink(path.join(outside, 'leak.js'), path.join(project, 'site', 'leak.js'))
  await fs.writeFile(path.join(project, 'site', 'leaky.html'), '<script src="leak.js"></script><p id="v"></p><script>document.getElementById("v").textContent = String(window.fromGameJs)</script>')

  recorder = http.createServer((req, res) => {
    hits.push(req.url ?? '')
    res.end('x')
  })
  const recPort = await freePort()
  await new Promise<void>((resolve) => recorder.listen(recPort, '127.0.0.1', resolve))
  await fs.writeFile(path.join(project, 'site', 'escape.html'), escapeHtml(`http://127.0.0.1:${recPort}`))

  const port = await freePort()
  vite = await createServer({ configFile: path.join(root, 'vite.config.ts'), server: { port, strictPort: true } })
  await vite.listen()
  app = await electron.launch({
    args: ['.', `--user-data-dir=${userData}`, '--use-mock-keychain'],
    cwd: root,
    env: {
      ...isolatedEnv(tmp),
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
  await page.getByPlaceholder('메시지를 입력하세요…').waitFor({ timeout: 10_000 })
  // 가짜 LLM 은 "echo: <보낸 글>" 로 답한다 — 인라인 코드가 그대로 답에 실려 칩이 된다
  await page.getByPlaceholder('메시지를 입력하세요…').fill('파일 `src/hello.ts` `README.md` `site/game.html` `site/escape.html` `site/leaky.html`')
  await page.keyboard.press('Enter')
  await page.locator('.bubble--assistant .md-file').nth(4).waitFor({ timeout: 30_000 })
})

afterAll(async () => {
  await app?.close()
  await vite?.close()
  await new Promise((resolve) => recorder?.close(resolve))
  if (tmp) await fs.rm(tmp, { recursive: true, force: true })
})

const panel = () => page.locator('.file-preview')
const chip = (name: string) => page.locator('.bubble--assistant .md-file', { hasText: name }).first()
const fileTabs = () => panel().locator('.file-preview__tab[data-file]')
const tab = (name: string) => panel().getByRole('tab', { name })
const frame = () => page.frameLocator('.file-preview__frame')

describe('오른쪽 패널 — 탭', () => {
  it('칩 두 개 → 탭 두 개(뒤에 연 것이 골라짐), 같은 칩을 다시 눌러도 한 탭. 탭을 누르면 그 파일, × 로 닫으면 옆 탭', async () => {
    await chip('src/hello.ts').click()
    await panel().waitFor()
    await chip('README.md').click()
    await expect.poll(() => fileTabs().count()).toBe(2)
    await chip('src/hello.ts').click()
    expect(await fileTabs().count()).toBe(2)
    expect(await fileTabs().evaluateAll((tabs) => tabs.map((tab) => [tab.getAttribute('data-file'), tab.getAttribute('aria-selected')]))).toEqual([
      ['src/hello.ts', 'true'],
      ['README.md', 'false'],
    ])
    expect(await panel().locator('.file-view .file-preview__path').textContent()).toBe('src/hello.ts')
    expect(await panel().locator('.file-view .file-preview__path-name').textContent()).toBe('hello.ts') // 파일 이름만 굵게
    expect(await panel().locator('.file-preview__kind').textContent()).toBe('TypeScript')
    await tab('README.md').click()
    await expect.poll(() => panel().locator('.file-preview__md h1').textContent().catch(() => '')).toBe('제목')
    // 탭 줄은 대화 머리와 같은 높이(52), 경로 줄은 그 아래
    expect((await panel().locator('.file-preview__head').boundingBox())!.height).toBe((await page.locator('.main__header').boundingBox())!.height)
    await panel().getByRole('button', { name: 'README.md 닫기' }).click()
    await expect.poll(() => fileTabs().count()).toBe(1)
    expect(await tab('hello.ts').getAttribute('aria-selected')).toBe('true')
    expect(await panel().locator('.file-view .file-preview__path').textContent()).toBe('src/hello.ts')
  })

  it('"+" 는 파일 탭으로 — 탭 줄 빈 곳은 창 끌기, 탭·버튼은 아님', async () => {
    await panel().getByRole('button', { name: '파일 목록' }).click()
    expect(await tab('파일').getAttribute('aria-selected')).toBe('true')
    const region = (selector: string) => panel().locator(selector).first().evaluate((el) => getComputedStyle(el).getPropertyValue('-webkit-app-region'))
    expect(await region('.file-preview__head')).toBe('drag')
    expect(await region('[role="tab"]')).toBe('no-drag')
    expect(await region('.file-preview__tab-close')).toBe('no-drag')
    expect(await region('.file-preview__fullscreen')).toBe('no-drag')
  })
})

describe('오른쪽 패널 — 파일 탭(폴더 나무)', () => {
  const row = (relative: string) => panel().locator(`.file-tree__item[data-path="${relative}"] > .file-tree__row`)

  it('프로젝트 폴더 — 폴더 먼저·이름 순, 밖을 가리키는 링크(폴더·파일)는 안 보인다. 경로 줄은 프로젝트 절대 경로', async () => {
    await tab('파일').click()
    await row('src').waitFor()
    const names = await panel().locator('.file-tree__body > .file-tree__level > .file-tree__item').evaluateAll((items) => items.map((item) => item.getAttribute('data-path')))
    expect(names).toEqual(['site', 'src', 'README.md'])
    expect(await panel().locator('.file-tree .file-preview__path').getAttribute('title')).toBe(project)
    expect(await page.content()).not.toContain('secret-dir')
    // 화면이 오염돼 밖을 물어도 메인이 거부한다
    expect(await page.evaluate((dir) => window.litecode.listDirectory(dir, 'outlink'), project)).toEqual({ status: 'unavailable' })
    expect(await page.evaluate((dir) => window.litecode.listDirectory(dir, '..'), project)).toEqual({ status: 'unavailable' })
    expect(await page.evaluate((dir) => window.litecode.listDirectory(dir, ''), outside)).toEqual({ status: 'unavailable' })
  })

  it('폴더를 펼쳐 파일을 누르면 그 파일 탭 — 이미 연 파일이면 그 탭으로(새 탭 없음). 다른 탭에 갔다 와도 펼친 폴더가 그대로', async () => {
    await row('site').click()
    await row('site/style.css').waitFor()
    expect(await panel().locator('.file-tree__item[data-path="site/leak.js"]').count()).toBe(0) // 밖 링크 파일
    await row('site/style.css').click()
    await expect.poll(() => tab('style.css').getAttribute('aria-selected')).toBe('true')
    expect(await panel().locator('.file-preview__text').textContent()).toBe('#title { color: rgb(255, 0, 0); }')
    await tab('파일').click()
    expect(await row('site/style.css').isVisible()).toBe(true)
    await row('src').click()
    await row('src/hello.ts').click()
    expect(await fileTabs().count()).toBe(2) // hello.ts 는 이미 열려 있었다
    expect(await tab('hello.ts').getAttribute('aria-selected')).toBe('true')
  })

  it('다시 읽기 — 새로 생긴 파일이 나무에, 바뀐 내용이 파일 탭에', async () => {
    await fs.writeFile(path.join(project, 'src', 'added.ts'), 'new\n')
    await fs.writeFile(path.join(project, 'src', 'hello.ts'), 'export const a = 2\n')
    await panel().getByRole('button', { name: '다시 읽기' }).click()
    await expect.poll(() => panel().locator('.file-preview__text').textContent()).toBe('export const a = 2')
    await tab('파일').click()
    await panel().getByRole('button', { name: '다시 읽기' }).click()
    await row('src/added.ts').waitFor()
  })
})

describe('오른쪽 패널 — HTML 실행 미리보기', () => {
  it('.html 탭은 렌더링 — 상대 경로 스크립트·스타일·이미지가 실리고, 버튼을 누르면 iframe 안 스크립트가 글을 바꾼다', async () => {
    await chip('site/game.html').click()
    await expect.poll(() => panel().locator('.file-preview__kind').textContent()).toBe('HTML')
    await frame().locator('#state').waitFor()
    expect(await panel().locator('.file-preview__frame').getAttribute('sandbox')).toBe('allow-scripts')
    expect(await frame().locator('#title').textContent()).toBe('v1')
    expect(await frame().locator('#title').evaluate((el) => getComputedStyle(el).color)).toBe('rgb(255, 0, 0)')
    await expect.poll(() => frame().locator('#dot').evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBe(1)
    await frame().locator('#go').click()
    await expect.poll(() => frame().locator('#state').textContent()).toBe('clicked js-ok')
    await page.screenshot({ path: path.join(root, 'shots', 'right-panel-html.png') })
  })

  it('원문 보기 ↔ 렌더링해서 보기, 다시 읽기로 바뀐 HTML 이 다시 돈다', async () => {
    await panel().getByRole('button', { name: '원문 보기' }).click()
    expect(await panel().locator('.file-preview__frame').count()).toBe(0)
    expect(await panel().locator('.file-preview__text').textContent()).toContain('<h1 id="title">v1</h1>')
    await panel().getByRole('button', { name: '렌더링해서 보기' }).click()
    await frame().locator('#title').waitFor()
    await fs.writeFile(path.join(project, 'site', 'game.html'), GAME('v2'))
    await panel().getByRole('button', { name: '다시 읽기' }).click()
    await expect.poll(() => frame().locator('#title').textContent()).toBe('v2')
    expect(await frame().locator('#state').textContent()).toBe('ready')
  })

  it('격리 — iframe 은 window.litecode·부모 DOM·저장소에 못 닿고, 밖으로 가는 요청(fetch·img·script·css·iframe·폼·링크·팝업·이동·WebSocket)은 0', async () => {
    await chip('site/escape.html').click()
    await expect.poll(() => frame().locator('#out').textContent().catch(() => 'pending'), { timeout: 10_000 }).not.toBe('pending')
    const result = JSON.parse((await frame().locator('#out').textContent())!)
    expect(result).toMatchObject({ litecode: 'undefined', parent: 'blocked', top: 'blocked', storage: 'blocked', cookie: 'blocked', popup: 'null', fetch: 'blocked' })
    await page.waitForTimeout(1_500) // 이동 시도(50ms 뒤)·이미지·프리페치가 나갈 시간
    expect(hits).toEqual([])
    // 이동이 막혀 문서가 그대로, 앱 창도 그대로
    expect(await frame().locator('#out').count()).toBe(1)
    expect(page.url()).toMatch(/^http:\/\/localhost:\d+\/$/)
    expect(app.windows()).toHaveLength(1)
  })

  it('HTML 이 상대 경로로 부른 리소스가 밖을 가리키는 링크면 안 실린다', async () => {
    await chip('site/leaky.html').click()
    await expect.poll(() => frame().locator('#v').textContent().catch(() => '')).toBe('undefined')
    expect(await page.content()).not.toContain('LEAKED')
  })
})

describe('오른쪽 패널 — 전체 화면·닫기·다시 열기', () => {
  it('전체 화면이면 패널이 창을 채우고(폭 조절 손잡이 없음), Esc 는 전체 화면만 푼다', async () => {
    const before = (await panel().boundingBox())!
    await panel().getByRole('button', { name: '전체 화면', exact: true }).click()
    const viewport = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }))
    await expect.poll(async () => (await panel().boundingBox())!.width).toBe(viewport.width)
    const full = (await panel().boundingBox())!
    expect([full.x, full.y, full.height]).toEqual([0, 0, viewport.height])
    expect(await panel().locator('.file-preview__resize').count()).toBe(0)
    await page.screenshot({ path: path.join(root, 'shots', 'right-panel-fullscreen.png') })
    await panel().getByRole('button', { name: '전체 화면 끝내기' }).click()
    await expect.poll(async () => Math.round((await panel().boundingBox())!.width)).toBe(Math.round(before.width))
    await panel().getByRole('button', { name: '전체 화면', exact: true }).click()
    await panel().evaluate((el) => (el as HTMLElement).focus()) // 포커스를 패널에
    await page.keyboard.press('Escape')
    await expect.poll(async () => Math.round((await panel().boundingBox())!.width)).toBe(Math.round(before.width))
    expect(await panel().count()).toBe(1)
  })

  it('닫으면 대화 머리에 "오른쪽 패널 열기" — 누르면 연 탭 그대로 돌아온다', async () => {
    const opened = await fileTabs().evaluateAll((tabs) => tabs.map((tab) => tab.getAttribute('data-file')))
    await panel().getByRole('button', { name: '닫기 (Esc)' }).click()
    await panel().waitFor({ state: 'detached' })
    await page.locator('.main__header').getByRole('button', { name: '오른쪽 패널 열기' }).click()
    await panel().waitFor()
    expect(await fileTabs().evaluateAll((tabs) => tabs.map((tab) => tab.getAttribute('data-file')))).toEqual(opened)
    expect(await page.locator('.main__header').getByRole('button', { name: '오른쪽 패널 열기' }).count()).toBe(0)
  })
})
