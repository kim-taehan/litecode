import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import { alive } from '../live/support/opencodeServer.ts'

// 설치본 스모크 테스트 (2b, _workspace/00_request.md 성공 기준 2) — `npm run dist:mac` 이 만든 .app 을 그대로 띄운다.
// 폐쇄망 PC 에서 Finder 로 연 앱처럼: PATH 는 `/usr/bin:/bin:/usr/sbin:/sbin` 뿐이고 HOME·XDG 는 빈 임시 폴더다 — 사용자
// ~/.bun/bin/opencode 도 ~/.cache/opencode/bin/rg 도 안 보인다. OPENCODE_BIN 도 주지 않는다. 그래서 대화가 되면 동봉 opencode 로 된 것이다.
// 바깥으로 나가는 연결은 기록용 프록시(HTTPS_PROXY)로 모은다 — 받는 쪽이 502 로 끊으므로 rg 를 github 에서 받으려 하면 grep 이 실패하고
// 시도가 기록에 남는다. 창은 띄우지 않는다(LITECODE_TEST_HIDDEN). 설치하지 않고 빌드 폴더의 .app 을 직접 실행한다.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
/** 검사할 .app — 기본은 이 판(mac-arm64)의 산출물. 다른 .app 을 볼 때(동봉물을 뺀 사본으로 빨강 확인 등)만 바꾼다 */
const appBundle = process.env.LITECODE_DIST_APP ?? path.join(root, 'release', 'mac-arm64', 'litecode.app')
const bundledOpencode = path.join(appBundle, 'Contents', 'Resources', 'opencode', 'opencode')
const GUI_PATH = '/usr/bin:/bin:/usr/sbin:/sbin'

let app: ElectronApplication
let page: Page
let tmp: string
let userData: string
let project: string
let proxy: http.Server
/** 프록시로 나가려 한 곳 (`host:port`) */
const outbound: string[] = []

/** 설치본이 소스보다 오래됐으면 옛 코드를 검사하게 된다 — 초록이 거짓이 되지 않게 먼저 멈춘다 */
async function assertFresh(): Promise<void> {
  const built = await fs.stat(path.join(appBundle, 'Contents', 'Resources', 'app.asar')).catch(() => undefined)
  if (!built) throw new Error(`설치본이 없습니다: ${appBundle}\n  먼저 npm run dist:mac`)
  if (process.env.LITECODE_DIST_APP) return
  let newest = 0
  for (const dir of ['electron', 'src', 'shared', 'renderer']) {
    for (const entry of await fs.readdir(path.join(root, dir), { withFileTypes: true, recursive: true })) {
      if (entry.isFile()) newest = Math.max(newest, (await fs.stat(path.join(entry.parentPath, entry.name))).mtimeMs)
    }
  }
  if (newest > built.mtimeMs) throw new Error(`설치본이 소스보다 오래됐습니다: ${appBundle}\n  먼저 npm run dist:mac`)
}

async function launch(): Promise<void> {
  const xdg = (name: string) => path.join(tmp, 'xdg', name)
  const via = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`
  app = await electron.launch({
    executablePath: path.join(appBundle, 'Contents', 'MacOS', 'litecode'),
    args: [`--user-data-dir=${userData}`, '--use-mock-keychain'],
    cwd: tmp,
    // process.env 를 물려주지 않는다 — GUI 앱이 받는 만큼만
    env: {
      PATH: GUI_PATH,
      HOME: path.join(tmp, 'home'),
      TMPDIR: os.tmpdir(),
      USER: process.env.USER ?? '',
      XDG_CONFIG_HOME: xdg('config'),
      XDG_DATA_HOME: xdg('data'),
      XDG_STATE_HOME: xdg('state'),
      XDG_CACHE_HOME: xdg('cache'),
      HTTPS_PROXY: via,
      HTTP_PROXY: via,
      NO_PROXY: '127.0.0.1,localhost',
      LITECODE_TEST_HIDDEN: '1',
      LITECODE_TEST_LANGUAGE: 'ko', // 셀렉터가 한국어 — 기본 언어가 en 이 된 뒤로 빠져 있었다
    },
  })
  page = await app.firstWindow()
  await page.locator('.sidebar-toggle').waitFor({ timeout: 30_000 })
}

beforeAll(async () => {
  await assertFresh()
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'litecode-dist-')))
  userData = path.join(tmp, 'userData')
  project = path.join(tmp, 'dist-project')
  await fs.mkdir(path.join(tmp, 'home'))
  await fs.mkdir(project)
  await fs.writeFile(path.join(project, 'notes.txt'), 'first line\nneedle-2b-offline here\n')

  // 기록용 프록시 — 어디로 나가려 했는지만 적고 502 로 끊는다 (01b_offline 과 같은 방식)
  proxy = http.createServer((req, res) => {
    outbound.push(req.headers.host ?? String(req.url))
    res.writeHead(502).end()
  })
  proxy.on('connect', (req, socket) => {
    outbound.push(String(req.url))
    socket.on('error', () => {}) // 받는 쪽이 끊긴 소켓에 더 쓰다 RST 를 받는다 — 기록은 이미 했다
    socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n')
  })
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve))

  await launch()
})

afterAll(async () => {
  await app?.close()
  await new Promise((resolve) => proxy?.close(resolve))
  if (tmp) await fs.rm(tmp, { recursive: true, force: true })
})

const record = async () =>
  JSON.parse(await fs.readFile(path.join(userData, 'opencode-server.json'), 'utf8')) as { pid: number; command: string; url: string }
async function enginePid(): Promise<number> {
  await expect.poll(() => record().then((r) => r.pid, () => 0), { timeout: 60_000 }).toBeGreaterThan(0)
  return (await record()).pid
}

const dialog = () => page.getByRole('dialog', { name: '설정' })
const field = (label: string) => dialog().getByLabel(label, { exact: true })
const replies = () => page.locator('.bubble--assistant')
const fakeLlm = async () => (await (await fetch(`${inject('fakeLlmUrl')}/requests`)).json()) as { count: number }

async function send(text: string): Promise<string> {
  const before = await replies().count()
  await page.getByPlaceholder('메시지를 입력하세요…').fill(text)
  await page.keyboard.press('Enter')
  await expect.poll(() => replies().count(), { timeout: 60_000 }).toBe(before + 1)
  return (await replies().last().textContent()) ?? ''
}

describe('설치본 (.app) — 동봉 opencode·rg', () => {
  it('설치본의 화면이 asar 안의 렌더러로 뜬다', async () => {
    expect(page.url()).toMatch(/^file:\/\/.*\/Contents\/Resources\/app\.asar\/dist\/renderer\/index\.html$/)
    expect(await page.locator('.open-guide').textContent({ timeout: 10_000 })).toContain('폴더를 열어')
  })

  it('빈 PATH 에서도 앱이 띄운 opencode 는 .app 안의 동봉 실행 파일이다', async () => {
    const pid = await enginePid()
    const { command } = await record()
    expect(command.startsWith(`${bundledOpencode} serve `)).toBe(true)
    expect(execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }).trim()).toBe(command)
    expect(execFileSync(bundledOpencode, ['--version'], { encoding: 'utf8' }).trim()).toBe('1.18.18')
  })

  it('설정 화면에서 provider 를 가짜 LLM 으로 바꾸고 폴더를 열면 대화가 된다', async () => {
    const before = await enginePid()
    await page.getByRole('button', { name: '⚙ 설정' }).click()
    await dialog().waitFor({ timeout: 5_000 })
    await dialog().getByRole('button', { name: '모델', exact: true }).click() // 설정은 일반 페이지로 열린다
    await dialog().locator('.provider-card', { hasText: 'Internal LiteLLM Gateway' }).getByRole('button', { name: '편집' }).click()
    await field('Base URL').fill(`${inject('fakeLlmUrl')}/v1`)
    await dialog().getByRole('button', { name: '적용' }).click()
    await expect.poll(() => field('Base URL').count(), { timeout: 5_000 }).toBe(0)
    await page.keyboard.press('Escape')
    // 설정 적용은 opencode 재시작이다 — 새 opencode 도 동봉 실행 파일이어야 한다
    await expect.poll(() => record().then((r) => r.pid, () => before), { timeout: 60_000 }).not.toBe(before)
    expect((await record()).command.startsWith(`${bundledOpencode} serve `)).toBe(true)

    await app.evaluate(({ dialog }, picked) => {
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [picked] })) as typeof dialog.showOpenDialog
    }, project)
    await page.locator('.open-guide').getByRole('button', { name: '폴더 열기…' }).click()
    await expect.poll(() => page.locator('.project-switch__name').textContent({ timeout: 1_000 }), { timeout: 10_000 }).toBe('dist-project')

    const count = (await fakeLlm()).count
    expect(await send('설치본에서 안녕')).toBe('echo: 설치본에서 안녕')
    expect((await fakeLlm()).count).toBeGreaterThan(count)
  })

  // 01b_offline: rg 가 없으면 grep 도구가 github 에서 ripgrep 을 받으려 한다 — 폐쇄망에선 실패하거나 ~300초 멈춘다
  it('grep 도구가 동봉 rg 로 성공하고, 바깥(github)으로 나가려 하지 않는다', async () => {
    const reply = await send('[call:grep {"pattern":"needle-2b-offline"}]')
    expect(reply).toContain(path.join(project, 'notes.txt'))
    expect(reply).toContain('needle-2b-offline here')
    expect(outbound).toEqual([])
    // opencode 가 rg 를 받아 두는 자리 — 동봉 rg 를 썼다면 비어 있다
    expect(await fs.readdir(path.join(tmp, 'xdg', 'cache', 'opencode', 'bin')).catch(() => [])).toEqual([])
  })

  it('앱을 끄면 동봉 opencode 도 꺼진다', async () => {
    const pid = await enginePid()
    await app.close()
    expect(alive(pid)).toBe(false)
  })
})
