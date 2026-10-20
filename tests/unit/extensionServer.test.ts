import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseServerDeclaration, resolveLaunch, startServer, type ServerDeclaration, type ServerHandle, type ServerState } from '../../src/services/extensions/server.ts'

// 확장의 내장 서버 (이슈 #537 1단계) — manifest 의 선언형 `server` 검사와, 그 선언대로 띄우고(포트 확인 → 기동 → 준비 → 관리자 준비) 내리는 실행기.
// SonarQube 는 띄우지 않는다 — 확장 폴더의 `bin/node`(이 node 로 가는 링크)가 상태 주소를 흉내 내는 스크립트를 돌린다 (engineLaunch.test.ts 와 같은 방식)

const SONAR: ServerDeclaration = {
  command: 'server/runtime/bin/java',
  cwd: 'server/sonarqube',
  args: ['-jar', 'lib/sonar-application.jar', '-Dsonar.web.port=${port}', '-Dsonar.embeddedDatabase.port=${freePort:db}', '-Dsonar.path.data=${dataDir}/data'],
  env: { SONAR_HOME: '${extensionDir}/server/sonarqube' },
  port: 9000,
  health: { path: '/api/system/status', field: 'status', ready: 'UP' },
  admin: 'sonarqube',
}

describe('parseServerDeclaration — 선언 검사', () => {
  it('맞는 선언은 그대로 돌려준다 (env·cwd·admin 은 없어도 된다)', () => {
    expect(parseServerDeclaration(SONAR)).toEqual({ ok: true, server: SONAR })
    const { cwd: _cwd, admin: _admin, ...bare } = SONAR
    expect(parseServerDeclaration({ ...bare, env: undefined })).toEqual({ ok: true, server: { ...bare, env: {} } })
  })

  // 실행 파일·작업 폴더는 확장 폴더 안만 — zip 항목과 같은 경로 규칙(paths.ts)
  it.each([['/usr/bin/java'], ['../java'], ['server/../../java'], ['C:/java.exe'], ['server\\java'], [''], ['server/'], [42]])('command %j 는 거절한다', (command) => {
    expect(parseServerDeclaration({ ...SONAR, command })).toEqual({ ok: false, field: 'command' })
  })

  it.each([['../x'], ['/tmp'], ['']])('cwd %j 는 거절한다', (cwd) => {
    expect(parseServerDeclaration({ ...SONAR, cwd })).toEqual({ ok: false, field: 'cwd' })
  })

  // 셸을 거치지 않는다 — 인자는 문자열 배열이고 한 줄 명령을 받지 않는다
  it.each([['-jar x.jar'], [['-jar', 1]], [undefined]])('args %j 는 거절한다', (args) => {
    expect(parseServerDeclaration({ ...SONAR, args })).toEqual({ ok: false, field: 'args' })
  })

  it.each([[{ 'A B': 'x' }], [{ A: 1 }], [['A=1']], [{ '': 'x' }]])('env %j 는 거절한다', (env) => {
    expect(parseServerDeclaration({ ...SONAR, env })).toEqual({ ok: false, field: 'env' })
  })

  it.each([[80], [0], [70000], [9000.5], ['9000']])('port %j 는 거절한다 (1024~65535 정수)', (port) => {
    expect(parseServerDeclaration({ ...SONAR, port })).toEqual({ ok: false, field: 'port' })
  })

  it.each([[{ path: 'api/system/status', field: 'status', ready: 'UP' }], [{ path: '/s', field: '', ready: 'UP' }], [{ path: '/s', field: 'status' }], ['/api/system/status']])(
    'health %j 는 거절한다',
    (health) => {
      expect(parseServerDeclaration({ ...SONAR, health })).toEqual({ ok: false, field: 'health' })
    },
  )

  it('admin 은 앱이 아는 이름만 (지금은 sonarqube)', () => {
    expect(parseServerDeclaration({ ...SONAR, admin: 'jenkins' })).toEqual({ ok: false, field: 'admin' })
  })

  // 자리표시는 앱이 채우는 넷만 — 모르는 이름이 그대로 실행 인자로 새지 않게
  it('모르는 자리표시(${...})가 인자·env 에 있으면 거절한다', () => {
    expect(parseServerDeclaration({ ...SONAR, args: ['-Dx=${home}'] })).toEqual({ ok: false, field: 'args' })
    expect(parseServerDeclaration({ ...SONAR, args: ['-Dx=${freePort:}'] })).toEqual({ ok: false, field: 'args' })
    expect(parseServerDeclaration({ ...SONAR, env: { X: '${HOME}' } })).toEqual({ ok: false, field: 'env' })
  })

  it('객체가 아니면 shape', () => {
    expect(parseServerDeclaration('java -jar x')).toEqual({ ok: false, field: 'shape' })
    expect(parseServerDeclaration(null)).toEqual({ ok: false, field: 'shape' })
  })
})

describe('SonarQube 확장 초안 (extensions/sonarqube/extension.json)', () => {
  const root = path.join(import.meta.dirname, '../..')
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'extensions/sonarqube/extension.json'), 'utf8')) as { server: unknown; permissions: string[] }

  it('server 선언이 검사를 통과하고 server 권한을 선언한다', () => {
    expect(parseServerDeclaration(manifest.server)).toMatchObject({ ok: true, server: { port: 9000, admin: 'sonarqube' } })
    expect(manifest.permissions).toContain('server')
  })

  // 선언이 띄우는 jar 이름에 버전이 박혀 있다 — 받기 스크립트의 버전만 올리면 서버가 안 뜬다
  it('띄우는 jar 의 버전이 받기 스크립트(scripts/fetch-sonarqube.mjs)의 SonarQube 버전과 같다', () => {
    const script = fs.readFileSync(path.join(root, 'scripts/fetch-sonarqube.mjs'), 'utf8')
    const version = /const SONARQUBE = \{\n\s+version: '([^']+)'/.exec(script)?.[1]
    expect(version).toBeDefined()
    expect((manifest.server as ServerDeclaration).args).toContain(`lib/sonar-application-${version}.jar`)
  })
})

describe('resolveLaunch — 자리표시 채우기', () => {
  it('확장 폴더·데이터 폴더·포트·빈 포트를 채우고 경로를 확장 폴더 기준 절대 경로로', () => {
    const launch = resolveLaunch(SONAR, { extensionDir: '/ext/sonarqube', dataDir: '/data/sonarqube', freePorts: { db: 50150 } })
    expect(launch.file).toBe(path.join('/ext/sonarqube', 'server/runtime/bin/java'))
    expect(launch.cwd).toBe(path.join('/ext/sonarqube', 'server/sonarqube'))
    expect(launch.args).toEqual(['-jar', 'lib/sonar-application.jar', '-Dsonar.web.port=9000', '-Dsonar.embeddedDatabase.port=50150', '-Dsonar.path.data=/data/sonarqube/data'])
    expect(launch.env).toEqual({ SONAR_HOME: '/ext/sonarqube/server/sonarqube' })
    expect(launch.baseUrl).toBe('http://127.0.0.1:9000')
    expect(launch.healthUrl).toBe('http://127.0.0.1:9000/api/system/status')
  })

  it('cwd 가 없으면 확장 폴더', () => {
    const { cwd: _cwd, ...noCwd } = SONAR
    expect(resolveLaunch(noCwd, { extensionDir: '/ext/x', dataDir: '/d', freePorts: { db: 1 } }).cwd).toBe('/ext/x')
  })
})

// ── 실행기 — 가짜 서버 ──

const FAKE = `
import http from 'node:http'
import fs from 'node:fs'
import { spawn } from 'node:child_process'
const [port, mode, record] = process.argv.slice(2)
fs.writeFileSync(record, JSON.stringify({ args: process.argv.slice(2), env: { FAKE_DB: process.env.FAKE_DB }, cwd: process.cwd(), pid: process.pid }))
if (mode === 'crash') { console.error('boom: 실패 사유'); process.exit(3) }
if (mode === 'stubborn') process.on('SIGTERM', () => {})
else process.on('SIGTERM', () => setTimeout(() => process.exit(0), 50))
if (mode === 'grandchild') {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  fs.writeFileSync(record + '.grandchild', String(child.pid))
}
const started = Date.now()
http.createServer((req, res) => {
  if (req.url !== '/api/system/status') { res.statusCode = 404; return res.end() }
  const up = mode !== 'never' && Date.now() - started > 300
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify({ status: up ? 'UP' : 'STARTING' }))
}).listen(Number(port), '127.0.0.1')
`

let dir: string
let extensionDir: string
let dataDir: string
let record: string
const handles: ServerHandle[] = []

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'litecode-ext-server-')))
  extensionDir = path.join(dir, 'ext')
  dataDir = path.join(dir, 'data dir') // userData 처럼 빈칸이 든 경로
  record = path.join(dir, 'record.json')
  fs.mkdirSync(path.join(extensionDir, 'bin'), { recursive: true })
  fs.symlinkSync(process.execPath, path.join(extensionDir, 'bin', 'node'))
  fs.writeFileSync(path.join(extensionDir, 'fake.mjs'), FAKE)
})

afterEach(async () => {
  await Promise.all(handles.splice(0).map((handle) => handle.stop()))
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 })
})

async function freePort(): Promise<number> {
  const server = net.createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as net.AddressInfo
  await new Promise((resolve) => server.close(resolve))
  return port
}

function fakeServer(port: number, mode: string): ServerDeclaration {
  return {
    command: 'bin/node',
    args: ['fake.mjs', '${port}', mode, record, '${dataDir}'],
    env: { FAKE_DB: '${freePort:db}' },
    port,
    health: { path: '/api/system/status', field: 'status', ready: 'UP' },
  }
}

const TIMING = { readyTimeoutMs: 5_000, pollMs: 50, killGraceMs: 500 }

function start(declaration: ServerDeclaration, extra: Partial<Parameters<typeof startServer>[1]> = {}): { handle: ServerHandle; states: ServerState[] } {
  const states: ServerState[] = []
  const handle = startServer(declaration, { extensionDir, dataDir, ...TIMING, onState: (state) => states.push(state), ...extra })
  handles.push(handle)
  return { handle, states }
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function until(check: () => boolean, ms = 3_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!check()) {
    if (Date.now() > deadline) throw new Error('기한 초과')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

describe('startServer — 단계', () => {
  it('포트 확인 → 기동 → 준비(STARTING) → 실행 중, 자리표시를 채워 셸 없이 띄운다', async () => {
    const port = await freePort()
    const { handle, states } = start(fakeServer(port, 'normal'))
    const end = await handle.ready
    expect(end).toMatchObject({ phase: 'running' })
    const phases = states.map((state) => state.phase)
    expect(phases[0]).toBe('port')
    expect(phases).toContain('launching')
    expect(states).toContainEqual(expect.objectContaining({ phase: 'starting', detail: 'STARTING' }))
    expect(phases.at(-1)).toBe('running')
    expect(handle.state()).toMatchObject({ phase: 'running' })

    const seen = JSON.parse(fs.readFileSync(record, 'utf8')) as { args: string[]; env: { FAKE_DB: string }; cwd: string }
    expect(seen.args).toEqual([String(port), 'normal', record, dataDir])
    expect(Number(seen.env.FAKE_DB)).toBeGreaterThan(0)
    expect(seen.cwd).toBe(extensionDir)
    expect(fs.existsSync(dataDir)).toBe(true) // 데이터 폴더는 띄우기 전에 만든다
  })

  it('포트를 누가 쓰고 있으면 띄우지 않고 port-in-use', async () => {
    const taken = net.createServer()
    await new Promise<void>((resolve) => taken.listen(0, '127.0.0.1', resolve))
    const port = (taken.address() as net.AddressInfo).port
    try {
      const { handle, states } = start(fakeServer(port, 'normal'))
      expect(await handle.ready).toMatchObject({ phase: 'failed', error: 'port-in-use' })
      expect(states.map((state) => state.phase)).toEqual(['port', 'failed'])
      expect(fs.existsSync(record)).toBe(false)
    } finally {
      await new Promise((resolve) => taken.close(resolve))
    }
  })

  it('준비 전에 끝나면 exited — 출력의 끝을 실패 사유로 싣는다', async () => {
    const { handle } = start(fakeServer(await freePort(), 'crash'))
    const end = await handle.ready
    expect(end).toMatchObject({ phase: 'failed', error: 'exited' })
    expect(end.output).toContain('boom: 실패 사유')
  })

  it('실행 파일이 없으면 spawn-failed', async () => {
    const { handle } = start({ ...fakeServer(await freePort(), 'normal'), command: 'bin/missing' })
    expect(await handle.ready).toMatchObject({ phase: 'failed', error: 'spawn-failed' })
  })

  it('기한 안에 준비가 안 되면 내리고 not-ready', async () => {
    const { handle } = start(fakeServer(await freePort(), 'never'), { readyTimeoutMs: 800 })
    expect(await handle.ready).toMatchObject({ phase: 'failed', error: 'not-ready', detail: 'STARTING' })
    const { pid } = JSON.parse(fs.readFileSync(record, 'utf8')) as { pid: number }
    await until(() => !alive(pid))
  })

  it('관리자 준비(prepare)는 준비된 뒤 기본 주소로 한 번 — 단계 admin 을 지나 running', async () => {
    const port = await freePort()
    const seen: string[] = []
    const { handle, states } = start(fakeServer(port, 'normal'), { prepare: async (baseUrl) => void seen.push(baseUrl) })
    expect(await handle.ready).toMatchObject({ phase: 'running' })
    expect(seen).toEqual([`http://127.0.0.1:${port}`])
    expect(states.map((state) => state.phase).slice(-2)).toEqual(['admin', 'running'])
  })

  it('관리자 준비가 실패하면 서버를 내리고 admin-failed (사유를 detail 에)', async () => {
    const { handle } = start(fakeServer(await freePort(), 'normal'), {
      prepare: async () => {
        throw new Error('admin-locked')
      },
    })
    expect(await handle.ready).toMatchObject({ phase: 'failed', error: 'admin-failed', detail: 'admin-locked' })
    const { pid } = JSON.parse(fs.readFileSync(record, 'utf8')) as { pid: number }
    await until(() => !alive(pid))
  })

  it('실행 중에 서버가 스스로 끝나면 failed·exited 로 알린다', async () => {
    const { handle, states } = start(fakeServer(await freePort(), 'normal'))
    await handle.ready
    const { pid } = JSON.parse(fs.readFileSync(record, 'utf8')) as { pid: number }
    process.kill(pid, 'SIGKILL')
    await until(() => states.at(-1)?.phase === 'failed')
    expect(handle.state()).toMatchObject({ phase: 'failed', error: 'exited' })
  })

  // 실측 §6: SonarQube 부모가 죽으면 자식이 9000 을 쥔 채 남는다 — 다음 띄우기가 port-in-use 로 막힌다
  it('부모가 스스로 끝나면 남은 자식(손자 프로세스)도 거둔다', async () => {
    const { handle, states } = start(fakeServer(await freePort(), 'grandchild'))
    await handle.ready
    const { pid } = JSON.parse(fs.readFileSync(record, 'utf8')) as { pid: number }
    const grandchild = Number(fs.readFileSync(record + '.grandchild', 'utf8'))
    process.kill(pid, 'SIGKILL')
    await until(() => !alive(grandchild))
    await until(() => states.at(-1)?.phase === 'failed')
  })
})

describe('startServer — 내리기', () => {
  it('stop: 정상 종료 신호로 내리고 stopping → stopped. 두 번 불러도 된다', async () => {
    const { handle, states } = start(fakeServer(await freePort(), 'normal'))
    await handle.ready
    const { pid } = JSON.parse(fs.readFileSync(record, 'utf8')) as { pid: number }
    await Promise.all([handle.stop(), handle.stop()])
    expect(alive(pid)).toBe(false)
    expect(states.map((state) => state.phase).slice(-2)).toEqual(['stopping', 'stopped'])
  })

  // SonarQube 는 자식(검색 엔진·웹·계산 엔진)을 따로 띄우고, 부모만 죽으면 자식이 포트를 쥔 채 남는다 (실측 01_probe_537 §6) — 프로세스 그룹째 끈다
  it('자식(손자 프로세스)까지 같이 내린다', async () => {
    const { handle } = start(fakeServer(await freePort(), 'grandchild'))
    await handle.ready
    const grandchild = Number(fs.readFileSync(record + '.grandchild', 'utf8'))
    expect(alive(grandchild)).toBe(true)
    await handle.stop()
    await until(() => !alive(grandchild))
  })

  it('정상 종료 신호를 무시하면 기한 뒤 강제로 끈다', async () => {
    const { handle } = start(fakeServer(await freePort(), 'stubborn'))
    await handle.ready
    const { pid } = JSON.parse(fs.readFileSync(record, 'utf8')) as { pid: number }
    const began = Date.now()
    await handle.stop()
    expect(alive(pid)).toBe(false)
    expect(Date.now() - began).toBeGreaterThanOrEqual(TIMING.killGraceMs - 50)
  })

  it('뜨는 중에 멈추면 기다리지 않고 내리고 stopped (failed 가 아니다)', async () => {
    const { handle } = start(fakeServer(await freePort(), 'never'), { readyTimeoutMs: 60_000 })
    await until(() => fs.existsSync(record))
    await handle.stop()
    expect(await handle.ready).toMatchObject({ phase: 'stopped' })
  })
})
