import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core'
import { createServer, type ViteDevServer } from 'vite'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import type { Mode } from '../../shared/modes.ts'
import { freePort, isolatedEnv } from './support/opencodeServer.ts'

// MCP 서버 연결 실물 테스트 (이슈 #28) — 진짜 opencode 1.18.18(레거시 경로) + 가짜 LLM + 진짜 Electron 창 + 가짜 MCP 서버 둘
// (로컬 stdio = 이 파일이 쓰는 node 스크립트, 원격 streamable HTTP = 이 프로세스의 127.0.0.1 서버, Bearer 토큰이 있어야 답한다).
// 지키는 것: 설정 > MCP 에서 추가 → 연결 테스트·연결됨·도구 수 → 가짜 LLM 이 MCP 도구를 부르면 결과가 "MCP · 서버 · 도구" 줄로 →
// 매번 묻기의 승인 카드에 서버·도구 → 계획 모드엔 MCP 도구가 없다 → 프로젝트 .mcp.json 서버는 그 프로젝트 대화에만 → 개인 설정 서버는 읽기 전용 →
// 비밀(원격 토큰·로컬 비밀 env)이 opencode.json·opencode 프로세스 env·mcp.json 에 평문으로 없다 → 끄기·삭제 → 기능 끄기.
// 도구 호출 확인은 가짜 LLM 이 받은 요청의 tools(opencode 가 실제로 모델에 내민 목록)와 가짜 MCP 가 남긴 tools/call 기록으로 한다.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

let vite: ViteDevServer
let devServerUrl: string
let app: ElectronApplication
let page: Page
/** 이 테스트가 만든 임시 폴더 — 끝나면 이 경로만 지운다 */
let tmp: string
let userData: string
let projectA: string
let projectB: string
let fakeScript: string
let remote: http.Server
let remoteUrl: string
/** 원격 가짜 MCP 가 받은 요청 (Authorization·메서드·도구 호출) */
const remoteSeen: { auth?: string; method?: string; tool?: string }[] = []

const TOKEN = 'Bearer remote-secret-tok-28'
const LOCAL_SECRET = 'local-secret-value-28'

/** 줄 단위 JSON-RPC 가짜 MCP — 도구 둘. 받은 메시지를 MCP_LOG 에, 자기 env 를 MCP_LOG.env 에 적는다 */
const FAKE_MCP = `
const fs = require('node:fs')
const LOG = process.env.MCP_LOG, NAME = process.env.MCP_NAME || 'fake'
fs.writeFileSync(LOG + '.env', JSON.stringify(process.env))
const TOOLS = [
  { name: 'echo_upper', description: 'Upper-cases the text (fake MCP)', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
  { name: 'secret_info', description: 'Returns a fixed value (fake MCP)', inputSchema: { type: 'object', properties: {} } },
]
let buf = ''
process.stdin.on('data', (d) => {
  buf += d
  let i
  while ((i = buf.indexOf('\\n')) !== -1) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1)
    if (!line) continue
    const m = JSON.parse(line)
    fs.appendFileSync(LOG, JSON.stringify({ method: m.method, name: m.params && m.params.name }) + '\\n')
    if (m.id === undefined) continue
    let result = {}
    if (m.method === 'initialize') result = { protocolVersion: m.params.protocolVersion || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: NAME, version: '0' } }
    else if (m.method === 'tools/list') result = { tools: TOOLS }
    else if (m.method === 'tools/call') result = { content: [{ type: 'text', text: m.params.name === 'echo_upper' ? String(m.params.arguments.text).toUpperCase() + ' (from ' + NAME + ')' : 'FIXED-42' }] }
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) + '\\n')
  }
})
`

const logOf = (name: string) => path.join(tmp, `mcp-${name}.jsonl`)
const calls = async (name: string) =>
  (await fs.readFile(logOf(name), 'utf8').catch(() => ''))
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { method?: string; name?: string })
    .filter((entry) => entry.method === 'tools/call')
const localDef = (name: string) => ({ command: process.execPath, args: [fakeScript], env: { MCP_LOG: logOf(name), MCP_NAME: name } })

async function startRemote(): Promise<void> {
  remote = http.createServer((req, res) => {
    let body = ''
    req.on('data', (part) => (body += part))
    req.on('end', () => {
      if (req.method !== 'POST') return void res.writeHead(req.method === 'DELETE' ? 200 : 405).end()
      const message = JSON.parse(body) as { id?: number; method: string; params?: { name?: string; arguments?: { msg?: string }; protocolVersion?: string } }
      remoteSeen.push({ auth: req.headers.authorization, method: message.method, tool: message.params?.name })
      if (req.headers.authorization !== TOKEN) return void res.writeHead(401).end()
      if (message.id === undefined) return void res.writeHead(202).end()
      const result =
        message.method === 'initialize'
          ? { protocolVersion: message.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'remote', version: '0' } }
          : message.method === 'tools/list'
            ? { tools: [{ name: 'remote_ping', description: 'Remote ping (fake MCP)', inputSchema: { type: 'object', properties: { msg: { type: 'string' } } } }] }
            : message.method === 'tools/call'
              ? { content: [{ type: 'text', text: `PONG ${message.params?.arguments?.msg}` }] }
              : {}
      res.writeHead(200, { 'content-type': 'application/json', ...(message.method === 'initialize' && { 'mcp-session-id': 'sess-28' }) })
      res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }))
    })
  })
  await new Promise<void>((resolve) => remote.listen(0, '127.0.0.1', resolve))
  remoteUrl = `http://127.0.0.1:${(remote.address() as AddressInfo).port}/mcp`
}

beforeAll(async () => {
  execFileSync(path.join(root, 'node_modules/.bin/tsc'), ['-p', 'tsconfig.electron.json'], { cwd: root, stdio: 'inherit' })
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'litecode-mcp-')))
  userData = path.join(tmp, 'userData')
  projectA = path.join(tmp, 'mcp-app-a')
  projectB = path.join(tmp, 'mcp-app-b')
  await fs.mkdir(projectA, { recursive: true })
  await fs.mkdir(projectB, { recursive: true })
  fakeScript = path.join(tmp, 'fake-mcp.cjs')
  await fs.writeFile(fakeScript, FAKE_MCP)
  // 프로젝트 A 의 Claude Code 정의 — 자동 실행, 그 프로젝트에만
  await fs.writeFile(path.join(projectA, '.mcp.json'), JSON.stringify({ mcpServers: { projsrv: localDef('projsrv') } }))
  // 개인 설정 (격리 XDG_CONFIG_HOME) — opencode 가 스스로 띄운다, 화면엔 읽기 전용
  const personal = path.join(tmp, 'xdg', 'config', 'opencode')
  await fs.mkdir(personal, { recursive: true })
  const mine = localDef('mine')
  await fs.writeFile(path.join(personal, 'opencode.json'), JSON.stringify({ mcp: { mine: { type: 'local', command: [mine.command, ...mine.args], environment: mine.env } } }))
  await startRemote()

  const port = await freePort()
  vite = await createServer({ configFile: path.join(root, 'vite.config.ts'), server: { port, strictPort: true } })
  await vite.listen()
  devServerUrl = `http://localhost:${port}`
  app = await electron.launch({
    args: ['.', `--user-data-dir=${userData}`, '--use-mock-keychain'],
    cwd: root,
    env: { ...isolatedEnv(tmp), LITECODE_TEST_HIDDEN: '1', LITECODE_DEV_SERVER_URL: devServerUrl, LITECODE_GATEWAY_URL: `${inject('fakeLlmUrl')}/v1` },
  })
  page = await app.firstWindow()
  await page.locator('.sidebar-toggle:visible').waitFor()
  await app.evaluate(({ dialog }, picked) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [picked] })) as typeof dialog.showOpenDialog
  }, projectA)
  await page.locator('.open-guide').getByRole('button', { name: '폴더 열기…' }).click()
  await page.locator('.composer__input').waitFor({ timeout: 10_000 })
}, 120_000)

afterAll(async () => {
  await app?.close()
  await vite?.close()
  remote?.close()
  if (tmp) await fs.rm(tmp, { recursive: true, force: true })
})

const dialog = () => page.locator('.settings-panel')
const row = (name: string) => dialog().locator(`.mcp-card[data-mcp="${name}"]`)
const status = (name: string) => row(name).locator('.mcp-card__status').textContent({ timeout: 1_000 })
const input = () => page.locator('.composer__input')
const lastTurn = () => page.locator('.turn').last()
const lastHead = () => lastTurn().locator('.turn__head-label').textContent({ timeout: 1_000 })
type Requests = { count: number; lastChat: { tools: string[]; messages: { text: string }[] } }
const requests = async (): Promise<Requests> => (await (await fetch(`${inject('fakeLlmUrl')}/requests`)).json()) as Requests

async function openMcp(): Promise<void> {
  if (!(await dialog().isVisible())) await page.getByRole('button', { name: '설정', exact: true }).click()
  await dialog().getByRole('button', { name: 'MCP', exact: true }).click()
  await dialog().locator('.mcp-page').waitFor()
}

async function closeSettings(): Promise<void> {
  await page.keyboard.press('Escape')
  await expect.poll(() => dialog().count(), { timeout: 5_000 }).toBe(0)
}

/** 화면 IPC 로 그 프로젝트에 새 엔진 세션 한 턴 — 가짜 LLM 이 받은 요청의 tools */
async function toolsIn(directory: string, mode: Mode = 'build'): Promise<string[]> {
  const text = `mcp tools ${path.basename(directory)} ${mode} ${Date.now()}`
  const result = await page.evaluate(
    ([dir, prompt, chosen]) => window.litecode.sendMessage(`mcp-probe-${Date.now()}`, 'gateway-local', 'qwen3.8-27b', dir, prompt, undefined, undefined, chosen as Mode),
    [directory, text, mode] as const,
  )
  expect(result, mode).toMatchObject({ ok: true, text: `echo: ${text}` })
  const { lastChat } = await requests()
  expect(lastChat.messages.at(-1)!.text.startsWith(text)).toBe(true)
  return lastChat.tools
}

/** 보내고 그 턴이 끝날 때까지 */
async function send(text: string): Promise<void> {
  const before = await page.locator('.bubble--assistant').count()
  await input().fill(text)
  await input().press('Enter')
  await expect.poll(() => page.locator('.bubble--assistant').count(), { timeout: 60_000 }).toBe(before + 1)
}

/** 편집 카드의 env·헤더 한 줄 */
async function fillVar(editor: ReturnType<Page['locator']>, index: number, name: string, value: string, secret: boolean): Promise<void> {
  await editor.getByRole('button', { name: '+ 추가' }).click()
  await editor.getByLabel(`이름 ${index}`, { exact: true }).fill(name)
  await editor.getByLabel(`값 ${index}`, { exact: true }).fill(value)
  const box = editor.getByLabel(`비밀 ${index}`, { exact: true })
  if ((await box.isChecked()) !== secret) await box.click()
}

describe('MCP 서버 연결 (이슈 #28)', () => {
  it('설정 > MCP — 프로젝트 .mcp.json 서버와 개인 설정 서버가 출처 배지와 함께 읽기 전용으로, 연결됨·도구 2', async () => {
    await openMcp()
    await expect.poll(() => status('projsrv'), { timeout: 60_000 }).toBe('연결됨')
    expect(await row('projsrv').locator('.mcp-card__source').textContent()).toBe('프로젝트')
    expect(await row('projsrv').locator('.mcp-card__tools-toggle').textContent()).toBe('도구 2')
    expect(await row('projsrv').getByRole('button', { name: '편집' }).count()).toBe(0)
    expect(await row('projsrv').locator('.mcp-card__readonly').textContent()).toBe('읽기 전용')
    expect(await row('mine').locator('.mcp-card__source').textContent()).toBe('개인 설정')
    expect(await status('mine')).toBe('연결됨')
    expect(await row('mine').getByRole('switch').count()).toBe(0)
    // 도구를 펼치면 이름·설명
    await row('projsrv').locator('.mcp-card__tools-toggle').click()
    expect(await row('projsrv').locator('.mcp-tools__name').allTextContents()).toEqual(['echo_upper', 'secret_info'])
    expect(await row('projsrv').locator('.mcp-tools__description').first().textContent()).toBe('Upper-cases the text (fake MCP)')
  })

  it('로컬 서버 추가 — 연결 테스트(저장 전) 도구 2, 저장하면 연결됨·도구 2', async () => {
    await page.locator('.mcp-page').getByRole('button', { name: '+ 서버 추가' }).click()
    const editor = dialog().locator('.mcp-editor')
    await editor.getByLabel('이름', { exact: true }).fill('loc')
    await editor.getByLabel('명령', { exact: true }).fill(process.execPath)
    await editor.getByLabel('인자 (한 줄에 하나)').fill(fakeScript)
    await fillVar(editor, 1, 'MCP_LOG', logOf('loc'), false)
    await fillVar(editor, 2, 'MCP_NAME', 'loc', false)
    await fillVar(editor, 3, 'LOC_API_KEY', LOCAL_SECRET, true)
    await editor.getByRole('button', { name: '연결 테스트' }).click()
    await expect.poll(() => editor.locator('.mcp-editor__test').textContent({ timeout: 1_000 }), { timeout: 20_000 }).toContain('연결됨 · 도구 2')
    expect(await fs.stat(path.join(userData, 'mcp.json')).then(() => true, () => false)).toBe(false) // 저장 전
    await editor.getByRole('button', { name: '저장' }).click()
    await expect.poll(() => status('loc'), { timeout: 60_000 }).toBe('연결됨')
    expect(await row('loc').locator('.mcp-card__source').textContent()).toBe('앱')
    expect(await row('loc').locator('.mcp-card__tools-toggle').textContent()).toBe('도구 2')
  })

  it('원격 서버 추가 — 토큰 헤더(비밀)로 연결됨·도구 1, 틀린 토큰은 연결 테스트가 HTTP 401', async () => {
    await page.locator('.mcp-page').getByRole('button', { name: '+ 서버 추가' }).click()
    const editor = dialog().locator('.mcp-editor')
    await editor.getByLabel('이름', { exact: true }).fill('rem')
    await editor.getByRole('radio', { name: '원격' }).click()
    await editor.getByLabel('주소', { exact: true }).fill(remoteUrl)
    await fillVar(editor, 1, 'Authorization', 'Bearer wrong', true)
    await editor.getByRole('button', { name: '연결 테스트' }).click()
    await expect.poll(() => editor.locator('.mcp-editor__test').textContent({ timeout: 1_000 }), { timeout: 20_000 }).toContain('HTTP 401')
    await editor.getByLabel('값 1', { exact: true }).fill(TOKEN)
    await editor.getByRole('button', { name: '저장' }).click()
    await expect.poll(() => status('rem'), { timeout: 60_000 }).toBe('연결됨')
    expect(await row('rem').locator('.mcp-card__tools-toggle').textContent()).toBe('도구 1')
    expect(await row('rem').locator('.mcp-card__target').textContent()).toBe(remoteUrl)
    await closeSettings()
  })

  it('가짜 LLM 이 MCP 도구를 부르면 결과가 "MCP · 서버 · 도구" 줄로 — 로컬·원격 모두, 서버에 tools/call 이 간다', async () => {
    await send('[call:loc_echo_upper {"text":"hi mcp"}]')
    expect(await page.locator('.bubble--assistant').last().textContent()).toBe('tool: HI MCP (from loc)')
    expect(await calls('loc')).toEqual([{ method: 'tools/call', name: 'echo_upper' }])
    await lastTurn().locator('.turn__head').click()
    const mcpRow = lastTurn().locator('.turn-row[data-mcp="loc/echo_upper"]')
    expect(await mcpRow.locator('.turn-row__title').textContent()).toBe('MCP · loc · echo_upper')
    await mcpRow.locator('.turn-row__line').click()
    expect(await mcpRow.locator('.turn-row__code').allTextContents()).toEqual(['{"text":"hi mcp"}', 'HI MCP (from loc)'])

    await send('[call:rem_remote_ping {"msg":"yo"}]')
    expect(await page.locator('.bubble--assistant').last().textContent()).toBe('tool: PONG yo')
    expect(remoteSeen.filter((entry) => entry.tool === 'remote_ping').map((entry) => entry.auth)).toEqual([TOKEN])
  })

  it('매번 묻기: 승인 카드에 서버·도구 — 허용하면 실행된다. 계획 모드엔 MCP 도구가 없다', async () => {
    await page.locator('.mode-chip').click()
    await page.locator('.mode-menu').getByRole('menuitemradio', { name: '매번 묻기' }).click()
    await input().fill('[call:loc_secret_info {}]')
    await input().press('Enter')
    const card = page.locator('.attention-card[data-kind="permission"]')
    await card.waitFor({ timeout: 30_000 })
    expect(await card.locator('.attention-card__headline').textContent()).toBe('MCP 도구를 실행하려고 합니다')
    expect(await card.locator('.attention-card__command').textContent()).toBe('MCP · loc · secret_info')
    expect(await calls('loc')).toHaveLength(1) // 허용 전엔 안 불렸다
    await card.getByRole('button', { name: '한 번 허용' }).click()
    await expect.poll(() => page.locator('.bubble--assistant').last().textContent({ timeout: 1_000 }), { timeout: 30_000 }).toBe('tool: FIXED-42')
    expect(await calls('loc')).toHaveLength(2)
    await page.locator('.mode-chip').click()
    await page.locator('.mode-menu').getByRole('menuitemradio', { name: '기본' }).click()

    const plan = await toolsIn(projectA, 'plan')
    expect(plan.filter((tool) => /^(loc|rem|projsrv|mine)_/.test(tool))).toEqual([])
    expect(plan).toContain('read')
  })

  it('프로젝트 .mcp.json 서버는 그 프로젝트 대화에서만, 앱·개인 서버는 어느 프로젝트에서나', async () => {
    const inA = await toolsIn(projectA)
    expect(inA).toEqual(expect.arrayContaining(['projsrv_echo_upper', 'loc_echo_upper', 'rem_remote_ping', 'mine_echo_upper']))
    const inB = await toolsIn(projectB)
    expect(inB.filter((tool) => tool.startsWith('projsrv_'))).toEqual([])
    expect(inB).toEqual(expect.arrayContaining(['loc_echo_upper', 'rem_remote_ping', 'mine_echo_upper']))
  })

  it('비밀이 opencode.json·opencode 프로세스 env·mcp.json 에 평문으로 없다 — 로컬 서버 자식 env 에만 있고 서버 비밀번호는 비었다', async () => {
    const files = ['opencode/opencode.json', 'mcp.json', 'mcp-secrets.json', 'settings.json']
    for (const file of files) {
      const text = await fs.readFile(path.join(userData, file), 'utf8').catch(() => '')
      expect(text, file).not.toContain('remote-secret-tok-28')
      expect(text, file).not.toContain(LOCAL_SECRET)
    }
    expect(await fs.readFile(path.join(userData, 'opencode/opencode.json'), 'utf8')).not.toContain('"mcp"')
    const { pid } = JSON.parse(await fs.readFile(path.join(userData, 'opencode-server.json'), 'utf8')) as { pid: number }
    const withEnv = execFileSync('ps', ['-E', '-ww', '-o', 'command=', '-p', String(pid)], { encoding: 'utf8' })
    expect(withEnv).toContain('OPENCODE_DB=') // env 가 보이는 ps 다
    expect(withEnv).not.toContain('remote-secret-tok-28')
    expect(withEnv).not.toContain(LOCAL_SECRET)
    const childEnv = JSON.parse(await fs.readFile(`${logOf('loc')}.env`, 'utf8')) as Record<string, string>
    expect(childEnv['LOC_API_KEY']).toBe(LOCAL_SECRET)
    expect(childEnv['OPENCODE_SERVER_PASSWORD']).toBe('')
  })

  it('끄면 꺼짐·도구가 빠지고, 삭제(두 번 눌러)하면 목록·mcp.json 에서 빠진다', async () => {
    await openMcp()
    await expect.poll(() => status('loc'), { timeout: 30_000 }).toBe('연결됨')
    await row('loc').getByRole('switch').click()
    await expect.poll(() => status('loc'), { timeout: 30_000 }).toBe('꺼짐')
    await row('rem').getByRole('button', { name: '삭제' }).click()
    await row('rem').getByRole('button', { name: '삭제 확인' }).click()
    await expect.poll(() => row('rem').count(), { timeout: 30_000 }).toBe(0)
    expect(await fs.readFile(path.join(userData, 'mcp.json'), 'utf8')).not.toContain('"rem"')
    await closeSettings()
    const tools = await toolsIn(projectA)
    expect(tools.filter((tool) => /^(loc|rem)_/.test(tool))).toEqual([])
    expect(tools).toContain('projsrv_echo_upper')
  })

  it('설정 > 기능에서 MCP 를 끄면 메뉴가 사라지고 앱·프로젝트 서버가 안 붙는다 — 개인 설정 서버는 opencode 것이라 그대로', async () => {
    await page.getByRole('button', { name: '설정', exact: true }).click()
    await dialog().getByRole('button', { name: '기능', exact: true }).click()
    const toggle = dialog().locator('[data-feature="mcp"]').getByRole('switch')
    expect(await toggle.getAttribute('aria-checked')).toBe('true')
    await toggle.click()
    await expect.poll(() => dialog().getByRole('button', { name: 'MCP', exact: true }).count(), { timeout: 10_000 }).toBe(0)
    await closeSettings()
    const tools = await toolsIn(projectA)
    expect(tools.filter((tool) => tool.startsWith('projsrv_'))).toEqual([])
    expect(tools).toContain('mine_echo_upper')
  })
})
