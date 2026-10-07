import { Context, Service } from 'cordis'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { EngineService } from '../../src/services/engine.ts'
import { ProviderRegistry } from '../../src/services/providers.ts'

// 엔진이 뜨는 중에 온 설정 변경 (이슈 #126 오류 1). 앱을 켜면 엔진이 로그인 셸 PATH 를 읽는 동안(수십~수백 ms) 훅 서비스의 게이트·기능 스위치·설정
// 변경이 도착한다 — 그 기동이 아직 설정을 읽기 전이면 다시 띄우지 않고(그 기동이 바뀐 값을 읽는다), 읽은 뒤에 값이 달라졌을 때만 다시 띄운다.
// opencode 는 띄우지 않는다 — OPENCODE_BIN 을 "serve 인자를 파일에 적고 /doc 에 200 을 주는" node 스크립트로 바꾼다. HOME 도 임시 폴더로 돌린다

let dir: string
let log: string
let ctx: Context
let engineFiber: { dispose(): Promise<void> }

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'litecode-engine-launch-')))
  log = path.join(dir, 'serve.log')
  fs.writeFileSync(log, '')
})

afterEach(async () => {
  await engineFiber.dispose() // 띄운 가짜 서버를 끈다
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 })
})

class FakeFeatures extends Service {
  on = new Set<string>(['skills', 'hooks'])
  constructor(ctx: Context) {
    super(ctx, 'features')
  }
  isEnabled(id: string): boolean {
    return this.on.has(id)
  }
}

class FakeSettings extends Service {
  claudeSkills = false
  constructor(ctx: Context) {
    super(ctx, 'settings')
  }
  get() {
    return { claudeSkills: this.claudeSkills }
  }
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const serves = (): number => fs.readFileSync(log, 'utf8').split('\n').filter((line) => line.startsWith('serve')).length
const config = (): { permission?: Record<string, unknown>; skills?: unknown } => JSON.parse(fs.readFileSync(path.join(dir, 'opencode', 'opencode.json'), 'utf8'))

/** loginDelayMs 동안 "뜨는 중(설정을 읽기 전)" 이다 */
async function start(loginDelayMs: number) {
  const fake = path.join(dir, 'fake-opencode')
  fs.writeFileSync(
    fake,
    [
      `#!${process.execPath}`,
      `const fs = require('node:fs'), http = require('node:http')`,
      `if (process.argv.includes('--version')) { console.log('9.9.9-fake'); process.exit(0) }`,
      `fs.appendFileSync(process.env.FAKE_LOG, process.argv.slice(2).join(' ') + '\\n')`,
      `console.log('fake opencode listening')`,
      `const port = Number(process.argv[process.argv.indexOf('--port') + 1])`,
      `http.createServer((_q, s) => { s.writeHead(200); s.end('{}') }).listen(port, '127.0.0.1')`,
      `process.on('SIGTERM', () => process.exit(0))`,
    ].join('\n'),
    { mode: 0o755 },
  )
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: dir, OPENCODE_BIN: fake, FAKE_LOG: log }
  delete env['XDG_CONFIG_HOME']
  ctx = new Context()
  ctx.plugin(FakeFeatures)
  ctx.plugin(FakeSettings)
  ctx.plugin(ProviderRegistry, { defaults: [{ id: 'gw', displayName: 'gw', baseURL: 'http://127.0.0.1:9/v1', protocol: 'openai-chat-completions', models: [{ id: 'm1', displayName: 'm1' }] }] })
  engineFiber = ctx.plugin(EngineService, {
    configDir: path.join(dir, 'opencode'),
    db: path.join(dir, 'opencode.db'),
    pidFile: path.join(dir, 'opencode-server.json'),
    env,
    loginPath: () => wait(loginDelayMs).then(() => undefined),
  })
  const ready = await new Promise<Context>((resolve) => ctx.inject(['engine', 'features', 'settings'], resolve))
  return { engine: ready.engine, features: ready.features as unknown as FakeFeatures, settings: ready.settings as unknown as FakeSettings }
}

describe('EngineService — 뜨는 중에 온 설정 변경', () => {
  it('뜨는 중에 게이트가 정해지면 한 번만 뜨고, 그 서버가 그 게이트로 뜬다', async () => {
    const { engine } = await start(150)
    const first = engine.connection()
    await wait(20)
    engine.setGate(['bash']) // 앱 시작 때 HooksService 의 syncGate
    const conn = await first
    await wait(300)
    expect(serves()).toBe(1)
    expect(conn.gated('bash')).toBe(true)
    expect(await engine.connection()).toBe(conn)
  })

  it('뜨는 중에 기능 스위치·설정이 바뀌어도 한 번만 뜨고, 바뀐 값으로 뜬다', async () => {
    const { engine, features, settings } = await start(150)
    const first = engine.connection()
    await wait(20)
    features.on.add('web')
    ctx.emit('features/changed', ['skills', 'hooks', 'web'])
    settings.claudeSkills = true
    ctx.emit('settings/changed', { claudeSkills: true } as never)
    const conn = await first
    await wait(300)
    expect(serves()).toBe(1)
    expect(config().permission?.['webfetch']).not.toBe('deny')
    expect(await engine.connection()).toBe(conn)
  })

  it('떠 있나(up) — 띄우기 전·죽은 뒤에는 아니다. 묻는 것만으로는 띄우지 않는다 (#126 오류 13)', async () => {
    const { engine } = await start(0)
    expect(engine.up).toBe(false)
    expect(serves()).toBe(0)
    const conn = await engine.connection()
    expect(engine.up).toBe(true)
    const record = JSON.parse(fs.readFileSync(path.join(dir, 'opencode-server.json'), 'utf8')) as { pid: number }
    process.kill(record.pid, 'SIGKILL') // 엔진이 죽었다
    await new Promise<void>((resolve) => conn.closed.addEventListener('abort', () => resolve()))
    expect(engine.up).toBe(false)
    expect(serves()).toBe(1)
  })

  it('설정을 읽은 뒤에 게이트가 달라지면 다시 띄운다 — 같은 값이면 그대로', async () => {
    const { engine } = await start(0)
    const conn = await engine.connection()
    engine.setGate([])
    await wait(100)
    expect(serves()).toBe(1)
    engine.setGate(['bash'])
    const next = await engine.connection()
    expect(next).not.toBe(conn)
    // 옛 서버가 꺼지는 데는 시간이 든다 — 느린 CI(GitHub 러너)에서는 새 연결이 돌아온 뒤에야 닫혔다는 신호가 온다. 신호를 기다린다
    if (!conn.closed.aborted) await new Promise<void>((resolve) => conn.closed.addEventListener('abort', () => resolve(), { once: true }))
    expect(conn.closed.aborted).toBe(true)
    expect(next.gated('bash')).toBe(true)
    expect(serves()).toBe(2)
  })

  it('version 은 `<bin> --version` 첫 줄, outputTail 은 띄운 서버 출력의 끝 — 띄우기 전엔 빈 글 (문제 신고 묶음, #177)', async () => {
    const { engine } = await start(0)
    expect(engine.outputTail()).toBe('')
    expect(await engine.version()).toBe('9.9.9-fake')
    expect(serves()).toBe(0) // 버전을 묻는 것은 서버를 띄우지 않는다
    await engine.connection()
    for (let tries = 0; tries < 50 && !engine.outputTail(); tries++) await wait(20)
    expect(engine.outputTail()).toContain('fake opencode listening')
  })

  it('뜨는 중에 다시 띄우기로 밀려난 기동이 읽은 값은 새 기동의 값으로 치지 않는다', async () => {
    const { engine } = await start(150)
    void engine.connection().catch(() => {})
    await wait(20)
    const second = engine.restart() // provider 저장 — 첫 기동은 물러나지만 끝까지 뜬 뒤 꺼진다
    await wait(250) // 첫 기동이 설정을 읽었다(게이트 없음), 둘째는 아직 읽기 전
    engine.setGate(['bash'])
    const conn = await second
    // 고정 시간 대신 값이 반영될 때까지 기다린다 — 느린 CI(GitHub 러너)에서는 300ms 로 모자랐다
    for (let tries = 0; tries < 250 && !conn.gated('bash'); tries++) await wait(20)
    expect(conn.gated('bash')).toBe(true)
    expect(serves()).toBe(2)
    expect(await engine.connection()).toBe(conn)
  })

  it('다시 띄우는 중(앞 서버가 꺼지는 동안)에 값이 되돌아가도 새 서버는 지금 값으로 뜬다', async () => {
    const { engine } = await start(0)
    await engine.connection()
    engine.setGate(['bash']) // 다시 띄우기 시작
    engine.setGate([]) // 새 서버가 설정을 읽기 전에 되돌린다
    const conn = await engine.connection()
    await wait(300)
    expect(conn.gated('bash')).toBe(false)
    expect(serves()).toBe(2)
    expect(await engine.connection()).toBe(conn)
  })
})
