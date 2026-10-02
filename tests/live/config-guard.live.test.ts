import { spawn, type ChildProcess } from 'node:child_process'
import { Context } from 'cordis'
import fs from 'node:fs/promises'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import { ProviderRegistry } from '../../src/services/providers.ts'
import { EngineService, engineConfig, engineEnv, type EngineConnection } from '../../src/services/engine.ts'
import { engineOptions, freePort, isolatedEnv, opencodeBin } from './support/opencodeServer.ts'

// L0 설정 지킴이 (이슈 #12, 01w 4절·3절) — 레거시 경로로 한 턴을 돌려도
// ① npm 설치 시도가 0 이다: 앱 설정 폴더·사용자 $XDG_CONFIG_HOME/opencode·~/.opencode 에 표식, 프로젝트 .opencode 는 플래그로 빠진다
// ② 프로젝트 opencode.json·.opencode/opencode.json 의 MCP 가 뜨지 않는다 (OPENCODE_DISABLE_PROJECT_CONFIG — blockProjectConfig 를 켰을 때)
// ③ 앱이 정의한 MCP 자식은 서버 비밀번호를 못 받는다 (environment 빈 값 덮기)
// 레지스트리는 받은 요청만 세는 127.0.0.1 서버로 돌린다(npm_config_registry·NPM_CONFIG_REGISTRY — 01w 4절 ②). HOME 은 임시 폴더다 —
// 이 테스트는 실제 ~/.config/opencode·~/.opencode 를 건드리지 않는다.

let root: string
let home: string
let project: string
let registry: http.Server
const registryHits: string[] = []
let services: Context
const fibers: { dispose(): Promise<void> }[] = []

const fakeBaseURL = () => `${inject('fakeLlmUrl')}/v1`

/** 뜨면 MCP_LOG 에 자기 env 를 적고, initialize·tools/list 만 답하는 stdio MCP */
const FAKE_MCP = `import fs from 'node:fs'
import readline from 'node:readline'
fs.writeFileSync(process.env.MCP_LOG, JSON.stringify(process.env))
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return
  const m = JSON.parse(line)
  if (m.id === undefined) return
  const result = m.method === 'initialize'
    ? { protocolVersion: m.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '0.0.1' } }
    : m.method === 'tools/list' ? { tools: [] } : undefined
  const out = result ? { jsonrpc: '2.0', id: m.id, result } : { jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'nf' } }
  process.stdout.write(JSON.stringify(out) + '\\n')
})
`
const mcpDef = (name: string) => ({ type: 'local' as const, command: [process.execPath, path.join(root, 'mcp.mjs')], environment: { MCP_LOG: path.join(root, `mcp-${name}.json`) } })
const spawned = async (name: string) => fs.readFile(path.join(root, `mcp-${name}.json`), 'utf8').catch(() => undefined)
const exists = (file: string) => fs.stat(file).then(() => true, () => false)

/** 레거시 경로 한 턴 — 세션 생성 → POST /session/{id}/message(턴이 끝나야 200, 01w 1절) */
async function legacyTurn(conn: Pick<EngineConnection, 'url' | 'headers'>, dir: string, providerID: string, text: string): Promise<string> {
  const q = `?directory=${encodeURIComponent(dir)}`
  const json = { ...conn.headers, 'content-type': 'application/json' }
  const created = await fetch(`${conn.url}/session${q}`, { method: 'POST', headers: json, body: JSON.stringify({ title: 'guard' }) })
  expect(created.status).toBe(200)
  const { id } = (await created.json()) as { id: string }
  const res = await fetch(`${conn.url}/session/${id}/message${q}`, {
    method: 'POST',
    headers: json,
    body: JSON.stringify({ model: { providerID, modelID: 'echo' }, agent: 'build', parts: [{ type: 'text', text }] }),
    signal: AbortSignal.timeout(45_000),
  })
  expect(res.status).toBe(200)
  const { parts } = (await res.json()) as { parts: { type: string; text?: string }[] }
  return parts.filter((part) => part.type === 'text').map((part) => part.text).join('')
}

beforeAll(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'litecode-config-guard-')))
  home = path.join(root, 'home')
  project = path.join(root, 'project')
  await fs.mkdir(path.join(home, '.opencode'), { recursive: true }) // 있으면 opencode 가 설치 대상으로 삼는다 (01w "있다면")
  await fs.mkdir(path.join(project, '.opencode'), { recursive: true })
  await fs.writeFile(path.join(root, 'mcp.mjs'), FAKE_MCP)
  await fs.writeFile(path.join(project, 'opencode.json'), JSON.stringify({ mcp: { projmcp: mcpDef('projmcp') } }))
  await fs.writeFile(path.join(project, '.opencode', 'opencode.json'), JSON.stringify({ mcp: { dotmcp: mcpDef('dotmcp') } }))

  registry = http.createServer((req, res) => {
    registryHits.push(`${req.method} ${req.url}`)
    res.writeHead(404).end()
  })
  await new Promise<void>((resolve) => registry.listen(0, '127.0.0.1', resolve))
})

afterAll(async () => {
  for (const fiber of fibers.reverse()) await fiber.dispose()
  await new Promise((resolve) => registry?.close(resolve))
  if (root) await fs.rm(root, { recursive: true, force: true })
})

/** 엔진·opencode 가 물려받을 테스트 환경 — 임시 HOME + 기록 레지스트리 */
function guardedEnv(): NodeJS.ProcessEnv {
  const reg = `http://127.0.0.1:${(registry.address() as AddressInfo).port}/`
  return { ...isolatedEnv(root), HOME: home, npm_config_registry: reg, NPM_CONFIG_REGISTRY: reg, BUN_CONFIG_REGISTRY: reg }
}

describe('ctx.engine 이 띄운 opencode — 레거시 한 턴', () => {
  beforeAll(async () => {
    const ctx = new Context()
    fibers.push(ctx.plugin(ProviderRegistry, { defaults: [] }))
    // 프로젝트 설정 막기는 L1 과 같이 켠다(기본 꺼짐 — AGENTS.md 가 같이 꺼진다). 여기서는 켠 상태를 지킨다
    fibers.push(ctx.plugin(EngineService, { ...engineOptions(path.join(root, 'state')), env: guardedEnv(), blockProjectConfig: true }))
    services = await new Promise<Context>((resolve) => ctx.inject(['providers', 'engine'], (ready) => resolve(ready)))
    services.providers.save({ displayName: 'Guard', baseURL: fakeBaseURL(), protocol: 'openai-chat-completions', models: [{ id: 'echo', displayName: 'Echo' }] })
  })

  it('npm 설치 시도가 0 이고, 프로젝트 설정의 MCP 가 뜨지 않는다', async () => {
    const conn = await services.engine.connection()
    expect(await legacyTurn(conn, project, 'guard', 'guard turn')).toBe('echo: guard turn')
    // 설치는 백그라운드다(forkDetach) — 턴 뒤에도 조금 본다
    await new Promise((resolve) => setTimeout(resolve, 3_000))

    expect(registryHits).toEqual([])
    expect(await spawned('projmcp')).toBeUndefined()
    expect(await spawned('dotmcp')).toBeUndefined()
    // 설치를 시도한 폴더엔 opencode 가 .gitignore 를 만든다 — 사용자 저장소 안 .opencode 는 그대로여야 한다
    expect((await fs.readdir(path.join(project, '.opencode'))).sort()).toEqual(['opencode.json'])
    for (const dir of [path.join(root, 'state', 'opencode'), path.join(root, 'xdg', 'config', 'opencode'), path.join(home, '.opencode')]) {
      expect(await exists(path.join(dir, 'node_modules')), dir).toBe(true)
      expect(await exists(path.join(dir, 'package-lock.json')), dir).toBe(true)
    }
  })
})

// 엔진은 아직 MCP 를 정의하지 않는다(화면은 L4) — 생성기(engineConfig)가 만든 설정을 그대로 opencode 1.18.18 에 줘서
// "environment 빈 값이 MCP 자식 env 를 덮는다"(01w 3-2, 1/1) 에 기대는 것이 계속 맞는지 지킨다
describe('앱이 정의한 MCP 의 자식 env', () => {
  let child: ChildProcess | undefined
  afterAll(async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((resolve) => child!.once('exit', resolve))
      child.kill('SIGTERM')
      await exited
    }
  })

  it('서버 비밀번호·DB 경로가 빈 값으로 가고, 정의의 environment 는 그대로 간다', async () => {
    const dir = path.join(root, 'mcp-run')
    const work = path.join(root, 'mcp-work')
    await fs.mkdir(work, { recursive: true })
    const password = `pw-${Date.now()}-guard`
    const env = engineEnv(guardedEnv(), { configDir: path.join(dir, 'opencode'), db: path.join(dir, 'opencode.db'), password })
    const config = engineConfig(
      [{ id: 'guard', displayName: 'Guard', baseURL: 'unused', protocol: 'openai-chat-completions', models: [{ id: 'echo', displayName: 'Echo' }] }],
      { token: 't', baseURLFor: () => fakeBaseURL() },
      { childEnv: env, mcp: { appmcp: mcpDef('appmcp') } },
    )
    await fs.mkdir(path.join(dir, 'opencode'), { recursive: true })
    await fs.writeFile(path.join(dir, 'opencode', 'opencode.json'), JSON.stringify(config))

    const port = await freePort()
    child = spawn(opencodeBin(), ['serve', '--hostname', '127.0.0.1', '--port', String(port), '--pure'], { cwd: dir, env, stdio: 'ignore' })
    const conn = { url: `http://127.0.0.1:${port}`, headers: { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}` } }
    await expect
      .poll(() => fetch(`${conn.url}/doc`, { headers: conn.headers }).then((res) => res.status, () => 0), { timeout: 60_000, interval: 300 })
      .toBe(200)

    expect(await legacyTurn(conn, work, 'guard', 'mcp turn')).toBe('echo: mcp turn')
    await expect.poll(() => spawned('appmcp'), { timeout: 15_000 }).toBeDefined()
    const dumped = JSON.parse((await spawned('appmcp'))!) as Record<string, string>
    expect(dumped['OPENCODE_SERVER_PASSWORD']).toBe('')
    expect(dumped['OPENCODE_DB']).toBe('')
    expect(dumped['MCP_LOG']).toBe(path.join(root, 'mcp-appmcp.json'))
    expect(JSON.stringify(dumped)).not.toContain(password)
  })
})
