import { Context } from 'cordis'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs/promises'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ExtensionServerStatus } from '../../shared/extensions.ts'
import { SettingsService } from '../../src/services/settings.ts'
import { ExtensionsService, type ExtensionsOptions } from '../../src/services/extensions.ts'
import { SERVER_RECORD } from '../../src/services/extensions/server.ts'
import { ExtensionStore } from '../../src/services/extensions/store.ts'
import type { KeyCipher } from '../../src/services/providers.ts'
import { makeZip } from './support/zipWriter.ts'

// 확장의 내장 서버를 ctx.extensions 에 연결 (이슈 #537 2단계) — 통로 server.status·start·stop·setOptions, 목록의 server 상태, 앱 쪽 설정(startWithApp·stopWithApp),
// 끄기·지우기에 내리기, 앱 종료(dispose), 내장 서버로 가는 network.fetch 에 관리자 토큰 붙이기(패널에는 주지 않는다).
// SonarQube 는 띄우지 않는다 — zip 에 든 `bin/server`(sh 스크립트)가 이 node 로 가짜 서버를 돌린다. 가짜 서버는 상태 주소와 관리자 API(실측 01_probe_537 §5 의 모양)를 흉내 낸다

const APP = '1.0.0'

const FAKE = `
import http from 'node:http'
let password = 'admin'
const tokens = new Map()
const started = Date.now()
const user = (auth = '') => {
  if (auth.startsWith('Bearer ')) return [...tokens.values()].includes(auth.slice(7))
  if (!auth.startsWith('Basic ')) return false
  const [login, pw] = Buffer.from(auth.slice(6), 'base64').toString().split(':')
  return login === 'admin' && pw === password
}
process.on('SIGTERM', () => setTimeout(() => process.exit(0), 50))
http.createServer((req, res) => {
  let body = ''
  req.on('data', (part) => (body += part))
  req.on('end', () => {
    const form = new URLSearchParams(body)
    const json = (status, value) => { res.statusCode = status; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(value)) }
    const url = new URL(req.url, 'http://x')
    if (url.pathname === '/api/system/status') return json(200, { status: Date.now() - started > 200 ? 'UP' : 'STARTING' })
    if (url.pathname === '/echo') return json(200, { authorization: req.headers.authorization ?? null })
    if (url.pathname === '/api/authentication/validate') return json(200, { valid: user(req.headers.authorization) })
    if (!user(req.headers.authorization)) { res.statusCode = 401; return res.end() }
    if (url.pathname === '/api/users/change_password') { password = form.get('password'); res.statusCode = 204; return res.end() }
    if (url.pathname === '/api/user_tokens/revoke') { tokens.delete(form.get('name')); res.statusCode = 204; return res.end() }
    if (url.pathname === '/api/user_tokens/generate') { const token = 'squ_' + Math.random().toString(16).slice(2); tokens.set(form.get('name'), token); return json(200, { token }) }
    res.statusCode = 404
    res.end()
  })
}).listen(Number(process.argv[2]), '127.0.0.1')
`

let dir: string
let root: string
let port: number
let zipCount = 0
const contexts: Context[] = []

beforeEach(async () => {
  dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'litecode-ext-servers-')))
  root = path.join(dir, 'extensions')
  port = await freePort()
})
afterEach(async () => {
  // 남은 가짜 서버를 거둔다 — 기록이 있는 것만
  contexts.splice(0)
  for (const id of ['srv-ext']) {
    try {
      const { pid } = JSON.parse(await fs.readFile(path.join(root, 'data', id, 'server', SERVER_RECORD), 'utf8')) as { pid: number }
      process.kill(-pid, 'SIGKILL')
    } catch {
      // 없다
    }
  }
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 })
})

async function freePort(): Promise<number> {
  const server = net.createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port: free } = server.address() as net.AddressInfo
  await new Promise((resolve) => server.close(resolve))
  return free
}

/** 서버 확장 하나를 설치해 둔다 (zip → 저장소, 실행 비트 그대로) */
async function install(id = 'srv-ext', extra: Record<string, unknown> = {}): Promise<void> {
  const file = path.join(dir, `ext-${zipCount++}.zip`)
  const manifest = {
    id,
    name: `${id} 이름`,
    description: '설명',
    version: '1.0.0',
    entry: 'index.html',
    permissions: ['server', 'network'],
    server: { command: 'bin/server', args: ['${port}'], port, health: { path: '/api/system/status', field: 'status', ready: 'UP' }, admin: 'sonarqube' },
    ...extra,
  }
  const script = `#!/bin/sh\n"${process.execPath}" "$(dirname "$0")/../fake.mjs" "$@"\n`
  await fs.writeFile(
    file,
    makeZip([
      { name: 'extension.json', data: JSON.stringify(manifest) },
      { name: 'index.html', data: '<p>x</p>' },
      { name: 'fake.mjs', data: FAKE },
      { name: 'bin/server', data: script, mode: 0o100755 },
    ]),
  )
  const store = new ExtensionStore(root)
  const staged = await store.stage(file, APP)
  expect(staged.result.problems).toEqual([])
  await store.install(staged.token!, APP)
  await store.applyPending()
}

const cipher: KeyCipher = {
  available: () => true,
  encrypt: (plain) => Buffer.from(`sealed:${Buffer.from(plain).toString('hex')}`),
  decrypt: (sealed) => Buffer.from(sealed.toString().slice('sealed:'.length), 'hex').toString(),
}

async function boot(options: Partial<ExtensionsOptions> = {}): Promise<{ ext: ExtensionsService; ctx: Context; fiber: { dispose(): Promise<unknown> } }> {
  const ctx = new Context()
  contexts.push(ctx)
  ctx.plugin(SettingsService, { file: path.join(dir, 'settings.json') })
  const fiber = ctx.plugin(ExtensionsService, { root, appVersion: APP, cipher, serverTiming: { readyTimeoutMs: 5_000, pollMs: 50, killGraceMs: 500 }, ...options })
  const ready = await new Promise<Context>((resolve) => ctx.inject(['extensions'], (injected) => resolve(injected)))
  await ready.extensions.idle()
  return { ext: ready.extensions, ctx, fiber }
}

async function status(ext: ExtensionsService, id = 'srv-ext'): Promise<ExtensionServerStatus> {
  const result = await ext.call(id, 'server.status', undefined)
  if (!result.ok) throw new Error(result.error)
  return result.result as ExtensionServerStatus
}

async function until(check: () => Promise<boolean> | boolean, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('기한 초과')
    await new Promise((resolve) => setTimeout(resolve, 30))
  }
}

const recordPid = async (): Promise<number | undefined> => {
  try {
    return (JSON.parse(await fs.readFile(path.join(root, 'data', 'srv-ext', 'server', SERVER_RECORD), 'utf8')) as { pid: number }).pid
  } catch {
    return undefined
  }
}
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe('server.* 통로', () => {
  it('처음엔 stopped — 주소·포트와 기본 설정(startWithApp 꺼짐·stopWithApp 켜짐). 목록에도 같은 상태가 실린다', async () => {
    await install()
    const { ext } = await boot()
    const expected = { phase: 'stopped', port, url: `http://127.0.0.1:${port}`, options: { startWithApp: false, stopWithApp: true } }
    expect(await status(ext)).toEqual(expected)
    expect((await ext.list())[0]?.server).toEqual(expected)
  })

  it('server 권한이 없는 확장은 permission-missing', async () => {
    const file = path.join(dir, 'plain.zip')
    await fs.writeFile(file, makeZip([{ name: 'extension.json', data: JSON.stringify({ id: 'plain-ext', name: 'n', description: 'd', version: '1.0.0', entry: 'index.html' }) }, { name: 'index.html', data: '<p>' }]))
    const store = new ExtensionStore(root)
    await store.install((await store.stage(file, APP)).token!, APP)
    await store.applyPending()
    const { ext } = await boot()
    for (const method of ['server.status', 'server.start', 'server.stop', 'server.setOptions']) {
      expect(await ext.call('plain-ext', method, {}), method).toEqual({ ok: false, error: 'permission-missing' })
    }
  })

  it('start → 기다리지 않고 상태를 돌려주고, 단계를 지나 running. 목록 바뀜(extensions/changed)으로도 나간다', async () => {
    await install()
    const { ext, ctx } = await boot()
    const phases: string[] = []
    ctx.on('extensions/changed', (list) => {
      const phase = list[0]?.server?.phase
      if (phase && phases.at(-1) !== phase) phases.push(phase)
    })
    const started = await ext.call('srv-ext', 'server.start', undefined)
    expect(started).toMatchObject({ ok: true })
    await until(async () => (await status(ext)).phase === 'running')
    expect(phases).toEqual(expect.arrayContaining(['port', 'launching', 'admin', 'running']))
    expect(phases.at(-1)).toBe('running')
  })

  it('내장 서버 주소로 가는 network.fetch 는 동의 없이 닿고, 패널이 준 authorization 을 버리고 관리자 토큰을 붙인다', async () => {
    await install()
    const { ext } = await boot()
    await ext.call('srv-ext', 'server.start', undefined)
    await until(async () => (await status(ext)).phase === 'running')
    const result = await ext.call('srv-ext', 'network.fetch', { url: `http://127.0.0.1:${port}/echo`, headers: { Authorization: 'Basic stolen' } })
    expect(result).toMatchObject({ ok: true, result: { status: 200 } })
    const { authorization } = JSON.parse((result as { result: { body: string } }).result.body) as { authorization: string }
    expect(authorization).toMatch(/^Bearer squ_/)
    // 토큰은 패널이 읽을 수 있는 곳(secrets·storage)에 없다 — 봉한 관리자 비밀은 서버 데이터 폴더에
    expect(await fs.readFile(path.join(root, 'data', 'srv-ext', 'server', 'admin.json'), 'utf8')).not.toContain(authorization.slice(7))
    // 다른 주소(같은 기기의 다른 포트)는 여전히 동의를 묻는다
    expect(await ext.call('srv-ext', 'network.fetch', { url: `http://127.0.0.1:${await freePort()}/` })).toMatchObject({ ok: false, error: 'consent-required' })
  })

  it('stop → stopped, 서버 프로세스와 기록이 없어진다', async () => {
    await install()
    const { ext } = await boot()
    await ext.call('srv-ext', 'server.start', undefined)
    await until(async () => (await status(ext)).phase === 'running')
    const pid = (await recordPid())!
    expect(await ext.call('srv-ext', 'server.stop', undefined)).toMatchObject({ ok: true, result: { phase: 'stopped' } })
    expect(alive(pid)).toBe(false)
    await until(async () => (await recordPid()) === undefined)
  })

  it('setOptions — 앱 쪽 설정(settings.extensionServers)에 남고 상태에 실린다. 모양이 틀리면 params-invalid', async () => {
    await install()
    const { ext, ctx } = await boot()
    expect(await ext.call('srv-ext', 'server.setOptions', { startWithApp: true })).toMatchObject({ ok: true, result: { options: { startWithApp: true, stopWithApp: true } } })
    expect(await ext.call('srv-ext', 'server.setOptions', { stopWithApp: false })).toMatchObject({ ok: true, result: { options: { startWithApp: true, stopWithApp: false } } })
    expect(ctx.settings.get().extensionServers).toEqual({ 'srv-ext': { startWithApp: true, stopWithApp: false } })
    for (const params of [{}, { startWithApp: 'yes' }, { port: 1 }, null, [true]]) {
      expect(await ext.call('srv-ext', 'server.setOptions', params), JSON.stringify(params)).toEqual({ ok: false, error: 'params-invalid' })
    }
  })
})

describe('앱·확장의 생애와 같이', () => {
  it('정상 종료 뒤 남은 기록(끝난 PID)만으로는 다음 실행이 띄우지 않고 기록을 지운다 (QA 03_qa_537 차단)', async () => {
    await install()
    // 앱 종료(release)는 SIGTERM 만 보내고 기다리지 않는다 → 앱이 먼저 꺼지면 exit 처리기(기록 지우기)가 돌지 않는다.
    // 그 결과(서버는 정상 종료됨, 기록만 남음)를 그대로 만든다: 끝난 PID + 확장 폴더
    const dead = spawnSync('true').pid
    const data = path.join(root, 'data', 'srv-ext', 'server')
    await fs.mkdir(data, { recursive: true })
    await fs.writeFile(path.join(data, SERVER_RECORD), JSON.stringify({ pid: dead, dir: path.join(root, 'installed', 'srv-ext') }))
    const { ext } = await boot()
    await new Promise((resolve) => setTimeout(resolve, 1500))
    const s = await status(ext)
    expect(s.options.startWithApp).toBe(false)
    expect(s.phase).toBe('stopped')
    expect(await recordPid()).toBeUndefined()
  })

  it('서버가 스스로 끝난 뒤 그 포트를 남이 잡아도 관리자 토큰을 보내지 않는다 (QA 03_qa_537 경고)', async () => {
    await install()
    const { ext } = await boot()
    await ext.call('srv-ext', 'server.start', undefined)
    await until(async () => (await status(ext)).phase === 'running')
    const pid = (await recordPid())!
    process.kill(-pid, 'SIGKILL')
    await until(async () => (await status(ext)).phase === 'failed')
    // 같은 포트를 다른 프로그램이 잡는다
    let seen: string | undefined
    const impostor = http.createServer((req, res) => {
      seen = req.headers.authorization
      res.end('{}')
    })
    await new Promise<void>((resolve) => impostor.listen(port, '127.0.0.1', resolve))
    try {
      await ext.call('srv-ext', 'network.fetch', { url: `http://127.0.0.1:${port}/api/issues/search` })
      expect(seen).toBeUndefined()
    } finally {
      await new Promise((resolve) => impostor.close(resolve))
    }
  })

  it('startWithApp 이면 앱이 켜질 때 띄운다 (아니면 안 띄운다)', async () => {
    await install()
    let { ext } = await boot()
    expect((await status(ext)).phase).toBe('stopped')
    await ext.call('srv-ext', 'server.setOptions', { startWithApp: true })
    ;({ ext } = await boot())
    await until(async () => (await status(ext)).phase === 'running')
  })

  it('확장을 끄면 내린다', async () => {
    await install()
    const { ext } = await boot()
    await ext.call('srv-ext', 'server.start', undefined)
    await until(async () => (await status(ext)).phase === 'running')
    const pid = (await recordPid())!
    await ext.setEnabled('srv-ext', false)
    expect(alive(pid)).toBe(false)
    expect((await ext.list())[0]?.server?.phase).toBe('stopped')
  })

  it('확장을 지우면 내리고 서버 데이터도 지운다', async () => {
    await install()
    const { ext } = await boot()
    await ext.call('srv-ext', 'server.start', undefined)
    await until(async () => (await status(ext)).phase === 'running')
    const pid = (await recordPid())!
    expect(await ext.remove('srv-ext')).toEqual({ ok: true })
    expect(alive(pid)).toBe(false)
    await expect(fs.stat(path.join(root, 'data', 'srv-ext'))).rejects.toThrow()
  })

  it('앱 종료(dispose) — stopWithApp 이면 정상 종료 신호를 보낸다', async () => {
    await install()
    const { ext, fiber } = await boot()
    await ext.call('srv-ext', 'server.start', undefined)
    await until(async () => (await status(ext)).phase === 'running')
    const pid = (await recordPid())!
    await fiber.dispose()
    await until(() => !alive(pid))
  })

  it('stopWithApp 을 끄면 앱이 꺼져도 서버가 남고, 다음 실행이 그 서버를 다시 잡는다(새로 띄우지 않는다)', async () => {
    await install()
    let { ext, fiber } = await boot()
    await ext.call('srv-ext', 'server.setOptions', { stopWithApp: false })
    await ext.call('srv-ext', 'server.start', undefined)
    await until(async () => (await status(ext)).phase === 'running')
    const pid = (await recordPid())!
    await fiber.dispose()
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(alive(pid)).toBe(true)
    ;({ ext } = await boot())
    await until(async () => (await status(ext)).phase === 'running')
    expect(await recordPid()).toBe(pid)
    // 다시 잡은 서버에도 토큰을 붙인다 (관리자 준비를 다시 했다 — 저장된 토큰으로)
    const echoed = await ext.call('srv-ext', 'network.fetch', { url: `http://127.0.0.1:${port}/echo` })
    expect((echoed as { result: { body: string } }).result.body).toContain('Bearer squ_')
    await ext.call('srv-ext', 'server.stop', undefined)
    expect(alive(pid)).toBe(false)
  })
})
