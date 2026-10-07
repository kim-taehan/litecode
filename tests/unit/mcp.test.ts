import { Context, Service } from 'cordis'
import fs from 'node:fs/promises'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { EngineMcp } from '../../src/services/engine.ts'
import type { McpStatus } from '../../src/services/llm.ts'
import { McpService, parseJsonc, personalServers, projectServers, type McpServerInput } from '../../src/services/mcp.ts'
import { listMcpTools, mcpChildEnv } from '../../src/services/mcpClient.ts'
import { mcpToolOf, sanitizeMcpName } from '../../src/services/turnProgress.ts'

// ctx.mcp (이슈 #28) — 정의 저장·비밀 규칙·프로젝트/개인 정의 읽기·폴더마다 붙이기. opencode 쪽(ctx.llm 의 mcp*)은 기록하는 가짜로 둔다
// (진짜 opencode 와의 연결은 tests/live/mcp.live.test.ts).

/** 뒤집기 "암호화" — 파일에 평문이 안 남는지 본다 */
const reversing = {
  available: () => true,
  encrypt: (plain: string) => Buffer.from([...plain].reverse().join('')),
  decrypt: (sealed: Buffer) => [...sealed.toString()].reverse().join(''),
}

/** ctx.llm 의 mcp* 흉내 — 폴더마다 상태 맵을 쥐고 부른 것을 적는다 */
class FakeLlm extends Service {
  status = new Map<string, Record<string, McpStatus>>()
  calls: string[] = []
  added: Record<string, EngineMcp> = {}
  constructor(ctx: Context) {
    super(ctx, 'llm')
  }
  async mcpStatus(directory: string) {
    this.calls.push(`status ${path.basename(directory)}`)
    return { ...(this.status.get(directory) ?? {}) }
  }
  async mcpAdd(directory: string, name: string, def: EngineMcp) {
    this.calls.push(`add ${path.basename(directory)} ${name}`)
    this.added[name] = def
    this.status.set(directory, { ...(this.status.get(directory) ?? {}), [name]: { status: 'connected' } })
    return this.status.get(directory)!
  }
  async mcpDisconnect(directory: string, name: string) {
    this.calls.push(`disconnect ${path.basename(directory)} ${name}`)
    this.status.set(directory, { ...(this.status.get(directory) ?? {}), [name]: { status: 'disabled' } })
  }
  async mcpConnect(directory: string, name: string) {
    this.calls.push(`connect ${path.basename(directory)} ${name}`)
    this.status.set(directory, { ...(this.status.get(directory) ?? {}), [name]: { status: 'connected' } })
  }
  /** 폴더 → 모델에 안 보일 도구 (이슈 #164) */
  hidden = new Map<string, Readonly<Record<string, readonly string[]>>>()
  hideMcpTools(directory: string, hidden: Readonly<Record<string, readonly string[]>>) {
    this.hidden.set(directory, hidden)
  }
}

let tmp: string
let project: string
let other: string

beforeEach(async () => {
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'litecode-mcp-unit-')))
  project = path.join(tmp, 'proj')
  other = path.join(tmp, 'other')
  await fs.mkdir(project)
  await fs.mkdir(other)
})
afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true })
})

async function start(env: NodeJS.ProcessEnv = { HOME: path.join(tmp, 'home'), XDG_CONFIG_HOME: path.join(tmp, 'xdg') }) {
  const ctx = new Context()
  ctx.plugin(FakeLlm)
  ctx.plugin(McpService, {
    file: path.join(tmp, 'mcp.json'),
    secretsFile: path.join(tmp, 'mcp-secrets.json'),
    projectsFile: path.join(tmp, 'mcp-projects.json'),
    cipher: reversing,
    env,
    fallbackCwd: tmp,
  })
  const ready = await new Promise<Context>((resolve) => ctx.inject(['llm', 'mcp'], resolve))
  return { ctx, llm: ready.llm as unknown as FakeLlm, mcp: ready.mcp }
}

const remote = (over: Partial<McpServerInput> = {}): McpServerInput => ({
  name: 'wiki',
  type: 'remote',
  url: 'http://127.0.0.1:9/mcp',
  vars: [
    { name: 'Authorization', value: 'Bearer tok-123', secret: true },
    { name: 'X-Team', value: 'core', secret: false },
  ],
  ...over,
})

describe('McpService — 앱 서버 저장', () => {
  it('비밀 값은 암호화 파일에만, 정의 파일엔 평문 비밀이 없고 화면엔 설정 여부만 간다', async () => {
    const { mcp } = await start()
    mcp.save(remote())
    const stored = await fs.readFile(path.join(tmp, 'mcp.json'), 'utf8')
    const sealed = await fs.readFile(path.join(tmp, 'mcp-secrets.json'), 'utf8')
    expect(stored).not.toContain('tok-123')
    expect(sealed).not.toContain('tok-123')
    expect(stored).toContain('core') // 비밀이 아닌 값은 그대로
    const [summary] = await mcp.list()
    expect(summary).toMatchObject({ name: 'wiki', source: 'app', type: 'remote', enabled: true })
    expect(summary!.vars).toEqual([
      { name: 'Authorization', secret: true, hasValue: true },
      { name: 'X-Team', value: 'core', secret: false, hasValue: true },
    ])
    expect(JSON.stringify(await mcp.list())).not.toContain('tok-123')
  })

  it('비밀을 빈 칸으로 두고 고치면 저장된 값을 쓴다 — 주소를 바꾸면 다시 넣어야 한다', async () => {
    const { mcp, llm } = await start()
    mcp.save(remote())
    const keep = { ...remote(), originalName: 'wiki', vars: [{ name: 'Authorization', value: '', secret: true }] }
    mcp.save(keep)
    await mcp.prepare(project)
    expect(llm.added['wiki']).toMatchObject({ type: 'remote', headers: { Authorization: 'Bearer tok-123' } })
    expect(() => mcp.save({ ...keep, url: 'http://evil.example/mcp' })).toThrow(/다시 넣어야/)
    expect(() => mcp.save({ ...remote({ name: 'other' }), vars: [{ name: 'Authorization', value: '', secret: true }] })).toThrow(/넣어 주세요/)
  })

  it('이름·명령·주소·헤더 값을 검사한다', async () => {
    const { mcp } = await start()
    expect(() => mcp.save(remote({ name: 'has space' }))).toThrow(/32자/)
    expect(() => mcp.save(remote({ url: 'file:///x' }))).toThrow(/http/)
    expect(() => mcp.save({ name: 'loc', type: 'local', command: [' '], vars: [] })).toThrow(/명령/)
    expect(() => mcp.save(remote({ vars: [{ name: 'Authorization', value: 'Bearer a\nb', secret: true }] }))).toThrow()
    mcp.save(remote())
    expect(() => mcp.save(remote())).toThrow(/같은 이름/)
  })
})

describe('McpService — 폴더에 붙이기', () => {
  it('켠 앱 서버·프로젝트 서버를 붙이고, 같은 정의면 다시 붙이지 않고, 끄면 끊는다', async () => {
    const { mcp, llm } = await start()
    await fs.writeFile(path.join(project, '.mcp.json'), JSON.stringify({ mcpServers: { projsrv: { command: '/bin/echo', args: ['x'], env: { A: '1' } } } }))
    mcp.save({ name: 'loc', type: 'local', command: ['/bin/cat'], vars: [] })
    await mcp.prepare(project)
    expect(llm.calls.filter((call) => call.startsWith('add')).sort()).toEqual(['add proj loc', 'add proj projsrv'])
    expect(llm.added['projsrv']).toMatchObject({ type: 'local', command: ['/bin/echo', 'x'], environment: { A: '1' }, timeout: 15_000 })
    llm.calls = []
    await mcp.prepare(project)
    expect(llm.calls).toEqual(['status proj']) // 그대로면 묻기만
    mcp.setEnabled('loc', false, project)
    await mcp.prepare(project)
    expect(llm.calls).toContain('disconnect proj loc')
  })

  it('엔진이 다시 떠 상태에서 사라지면 다시 붙인다', async () => {
    const { mcp, llm } = await start()
    mcp.save({ name: 'loc', type: 'local', command: ['/bin/cat'], vars: [] })
    await mcp.prepare(project)
    llm.status.clear() // 재시작 — 동적 추가가 사라졌다
    llm.calls = []
    await mcp.prepare(project)
    expect(llm.calls).toContain('add proj loc')
  })

  it('지운 앱 서버는 opencode 상태에 disabled 로 남아도 목록에 "개인 설정" 으로 안 나온다', async () => {
    const { mcp } = await start()
    mcp.save({ name: 'loc', type: 'local', command: ['/bin/cat'], vars: [] })
    await mcp.list(project)
    mcp.remove('loc')
    expect((await mcp.list(project)).map((entry) => entry.name)).toEqual([])
  })

  it('붙일 것이 없으면 opencode 에 묻지 않는다', async () => {
    const { mcp, llm } = await start()
    await mcp.prepare(project)
    expect(llm.calls).toEqual([])
  })

  it('프로젝트 서버가 앱 서버와 이름이 같으면 앱 것을 붙이고 프로젝트 것은 가려졌다고 보인다', async () => {
    const { mcp, llm } = await start()
    await fs.writeFile(path.join(project, 'opencode.json'), JSON.stringify({ mcp: { loc: { type: 'local', command: ['/bin/echo'] } } }))
    mcp.save({ name: 'loc', type: 'local', command: ['/bin/cat'], vars: [] })
    const listed = await mcp.list(project)
    expect(llm.added['loc']).toMatchObject({ command: ['/bin/cat'] })
    expect(listed.find((entry) => entry.source === 'project')).toMatchObject({ name: 'loc', shadowed: true })
  })

  it('기능을 끄면(서비스가 내려가면) 붙인 서버를 끊는다', async () => {
    const ctx = new Context()
    ctx.plugin(FakeLlm)
    const fiber = ctx.plugin(McpService, { file: path.join(tmp, 'mcp.json'), env: {}, fallbackCwd: tmp })
    const ready = await new Promise<Context>((resolve) => ctx.inject(['llm', 'mcp'], resolve))
    const llm = ready.llm as unknown as FakeLlm
    ready.mcp.save({ name: 'loc', type: 'local', command: ['/bin/cat'], vars: [] })
    await ready.mcp.prepare(project)
    await fiber.dispose()
    expect(llm.calls).toContain('disconnect proj loc')
  })
})

// 이슈 #43 — `+` 메뉴의 MCP 팝업은 프로젝트 기준이다: "이 프로젝트만" 서버(앱 안에 프로젝트 경로별로 저장)와 프로젝트별 켜기/끄기
describe('McpService — 프로젝트 기준 (#43)', () => {
  const local = (name: string, command = '/bin/cat'): McpServerInput => ({ name, type: 'local', command: [command], vars: [] })
  const adds = (llm: FakeLlm) => llm.calls.filter((call) => call.startsWith('add')).sort()

  it('"이 프로젝트만" 서버는 그 프로젝트의 턴에만 붙고, 프로젝트 경로별 파일에 남아 다시 켜도 읽힌다', async () => {
    const { mcp, llm } = await start()
    mcp.save({ ...local('billing-db'), scope: 'project' }, project)
    mcp.save(local('wiki'))
    await mcp.prepare(project)
    await mcp.prepare(other)
    expect(adds(llm)).toEqual(['add other wiki', 'add proj billing-db', 'add proj wiki'])
    const stored = JSON.parse(await fs.readFile(path.join(tmp, 'mcp-projects.json'), 'utf8')) as Record<string, { servers: { name: string }[] }>
    expect(Object.keys(stored)).toEqual([project])
    expect(stored[project]!.servers.map((server) => server.name)).toEqual(['billing-db'])
    expect(JSON.parse(await fs.readFile(path.join(tmp, 'mcp.json'), 'utf8'))).toHaveLength(1) // 모든 프로젝트 서버 파일은 예전 모양 그대로

    const again = await start()
    expect((await again.mcp.list(project)).map((entry) => [entry.name, entry.source, entry.scope])).toEqual([
      ['billing-db', 'app', 'project'],
      ['wiki', 'app', 'all'],
    ])
    expect((await again.mcp.list(other)).map((entry) => entry.name)).toEqual(['wiki'])
  })

  it('"이 프로젝트만" 서버의 비밀도 암호화 파일에만 있고, 다른 프로젝트의 같은 이름 서버와 섞이지 않는다', async () => {
    const { mcp, llm } = await start()
    mcp.save({ ...remote({ name: 'api', vars: [{ name: 'Authorization', value: 'Bearer proj-tok', secret: true }] }), scope: 'project' }, project)
    mcp.save({ ...remote({ name: 'api', vars: [{ name: 'Authorization', value: 'Bearer other-tok', secret: true }] }), scope: 'project' }, other)
    for (const file of ['mcp-projects.json', 'mcp-secrets.json']) expect(await fs.readFile(path.join(tmp, file), 'utf8')).not.toMatch(/proj-tok|other-tok/)
    expect(JSON.stringify(await mcp.list(project))).not.toContain('proj-tok')
    await mcp.prepare(project)
    expect(llm.added['api']).toMatchObject({ headers: { Authorization: 'Bearer proj-tok' } })
    await mcp.prepare(other)
    expect(llm.added['api']).toMatchObject({ headers: { Authorization: 'Bearer other-tok' } })
    // 비밀을 비워 두고 고치면 그 프로젝트의 저장 값
    mcp.save({ ...remote({ name: 'api', vars: [{ name: 'Authorization', value: '', secret: true }] }), originalName: 'api' }, project)
    await mcp.prepare(project)
    expect(llm.added['api']).toMatchObject({ headers: { Authorization: 'Bearer proj-tok' } })
    mcp.remove('api', project)
    expect((await mcp.list(project)).map((entry) => entry.name)).toEqual([])
    expect((await mcp.list(other)).map((entry) => entry.name)).toEqual(['api'])
  })

  it('스위치는 그 프로젝트에서만 — A 에서 꺼도 B 에서는 붙고, 값은 프로젝트 경로별로 남는다', async () => {
    const { mcp, llm } = await start()
    mcp.save(local('wiki'))
    await mcp.prepare(project)
    await mcp.prepare(other)
    mcp.setEnabled('wiki', false, project)
    llm.calls = []
    await mcp.prepare(project)
    await mcp.prepare(other)
    expect(llm.calls).toContain('disconnect proj wiki')
    expect(llm.calls.some((call) => call.endsWith('other wiki'))).toBe(false)
    expect((await mcp.list(project))[0]).toMatchObject({ name: 'wiki', enabled: false, status: 'disabled' })
    expect((await mcp.list(other))[0]).toMatchObject({ name: 'wiki', enabled: true, status: 'connected' })

    const again = await start()
    await again.mcp.prepare(project)
    await again.mcp.prepare(other)
    expect(adds(again.llm)).toEqual(['add other wiki'])
    again.mcp.setEnabled('wiki', true, project)
    await again.mcp.prepare(project)
    expect(adds(again.llm)).toEqual(['add other wiki', 'add proj wiki'])
  })

  it('프로젝트 폴더 정의도 그 프로젝트에서 끌 수 있다 (파일은 안 고친다)', async () => {
    const { mcp, llm } = await start()
    const file = path.join(project, '.mcp.json')
    const text = JSON.stringify({ mcpServers: { deploy: { command: '/bin/echo' } } })
    await fs.writeFile(file, text)
    expect((await mcp.list(project))[0]).toMatchObject({ name: 'deploy', source: 'project', scope: 'project', origin: '.mcp.json', enabled: true })
    mcp.setEnabled('deploy', false, project)
    await mcp.prepare(project)
    expect(llm.calls).toContain('disconnect proj deploy')
    expect((await mcp.list(project))[0]).toMatchObject({ enabled: false, status: 'disabled' })
    expect(await fs.readFile(file, 'utf8')).toBe(text)
  })

  it('개인 설정 서버는 그 프로젝트에서 끄면 끊고 다시 켜면 잇는다', async () => {
    const dir = path.join(tmp, 'xdg', 'opencode')
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, 'opencode.json'), JSON.stringify({ mcp: { mine: { type: 'local', command: ['/bin/cat'] } } }))
    const { mcp, llm } = await start()
    llm.status.set(project, { mine: { status: 'connected' } }) // opencode 가 스스로 띄운 것
    llm.status.set(other, { mine: { status: 'connected' } })
    mcp.setEnabled('mine', false, project)
    await mcp.prepare(project)
    await mcp.prepare(other)
    expect(llm.calls.filter((call) => !call.startsWith('status'))).toEqual(['disconnect proj mine'])
    expect((await mcp.list(project))[0]).toMatchObject({ name: 'mine', source: 'personal', scope: 'all', enabled: false, status: 'disabled' })
    mcp.setEnabled('mine', true, project)
    await mcp.prepare(project)
    expect(llm.calls).toContain('connect proj mine')
  })

  it('예전 mcp.json 의 꺼진 서버는 모든 프로젝트에서 꺼진 채로 — 프로젝트 하나에서만 켤 수 있다', async () => {
    await fs.writeFile(path.join(tmp, 'mcp.json'), JSON.stringify([{ name: 'old', type: 'local', command: ['/bin/cat'], vars: [], enabled: false }]))
    const { mcp, llm } = await start()
    await mcp.prepare(project)
    expect(llm.calls).toEqual([])
    expect((await mcp.list(project))[0]).toMatchObject({ name: 'old', source: 'app', scope: 'all', enabled: false })
    mcp.setEnabled('old', true, project)
    await mcp.prepare(project)
    await mcp.prepare(other)
    expect(adds(llm)).toEqual(['add proj old'])
  })

  it('이름 충돌 — 앱 서버끼리는 묶음이 달라도 저장을 거절하고, 폴더 정의는 앱 서버(어느 묶음이든)에 가려진다', async () => {
    const { mcp, llm } = await start()
    mcp.save(local('wiki'))
    mcp.save({ ...local('billing-db'), scope: 'project' }, project)
    expect(() => mcp.save({ ...local('wiki'), scope: 'project' }, project)).toThrow(/같은 이름/)
    expect(() => mcp.save({ ...local('billing-db'), scope: 'project' }, project)).toThrow(/같은 이름/)
    expect(() => mcp.save(local('billing-db'))).toThrow(/proj/) // 어느 프로젝트의 것과 겹치는지 알려 준다
    mcp.save({ ...local('billing-db', '/bin/echo'), scope: 'project' }, other) // 다른 프로젝트의 전용 서버끼리는 겹쳐도 된다
    expect(() => mcp.save({ ...local('x'), scope: 'project' })).toThrow() // 프로젝트 없이 "이 프로젝트만" 은 없다

    await fs.writeFile(path.join(project, '.mcp.json'), JSON.stringify({ mcpServers: { 'billing-db': { command: '/bin/false' }, wiki: { command: '/bin/false' } } }))
    const listed = await mcp.list(project)
    expect(listed.filter((entry) => entry.source === 'project').map((entry) => [entry.name, entry.shadowed])).toEqual([
      ['billing-db', true],
      ['wiki', true],
    ])
    expect(llm.added['billing-db']).toMatchObject({ command: ['/bin/cat'] })
    expect(llm.added['wiki']).toMatchObject({ command: ['/bin/cat'] })
  })

  // 이슈 #51 — `litecode` 는 앱 자신의 MCP 서버(ctx.appMcp) 이름이다. 엔진 설정이 `litecode_*` 도구에 따로 권한을 주므로(계획 모드 허용 등)
  // 남의 서버가 그 이름으로 붙으면 안 된다 — 내장 서버가 올라와 있지 않아도
  it('이름 `litecode` 는 예약 — 저장을 거절하고, 폴더 정의·예전에 저장된 앱 서버는 붙이지 않는다(가려짐)', async () => {
    await fs.writeFile(path.join(tmp, 'mcp.json'), JSON.stringify([{ name: 'litecode', type: 'local', command: ['/bin/cat'], vars: [], enabled: true }]))
    const { mcp, llm } = await start()
    expect(() => mcp.save(local('litecode'))).toThrow(/앱이 쓰는 이름/)
    expect(() => mcp.save({ ...local('litecode'), scope: 'project' }, project)).toThrow(/앱이 쓰는 이름/)
    mcp.save(local('wiki'))
    expect(() => mcp.save({ ...local('litecode'), originalName: 'wiki' })).toThrow(/앱이 쓰는 이름/)
    mcp.save(local('Litecode')) // 엔진의 도구 이름은 대소문자를 가린다 — 다른 이름이다

    await fs.writeFile(path.join(project, '.mcp.json'), JSON.stringify({ mcpServers: { litecode: { command: '/bin/false' } } }))
    const listed = await mcp.list(project)
    expect(listed.filter((entry) => entry.name === 'litecode').map((entry) => [entry.source, entry.shadowed])).toEqual([
      ['project', true],
      ['app', true],
    ])
    expect(adds(llm).sort()).toEqual(['add proj Litecode', 'add proj wiki'])
    expect(llm.added['litecode']).toBeUndefined()
  })

  it('내장 서버 — registerBuiltin 한 정의를 매 턴 붙이고, 정의가 없으면(서버가 안 떴다) 건너뛰고, reattach 하면 다시 붙이고, 내리면 끊는다', async () => {
    const { mcp, llm } = await start()
    let url: string | undefined
    const off = mcp.registerBuiltin('litecode', (workdir) => (url ? { type: 'remote', url: `${url}/${path.basename(workdir)}` } : undefined))
    await mcp.prepare(project)
    expect(llm.calls).toEqual([]) // 붙일 것이 없다 — opencode 에 묻지 않는다
    url = 'http://127.0.0.1:1/mcp'
    await mcp.prepare(project)
    await mcp.prepare(project)
    expect(adds(llm)).toEqual(['add proj litecode'])
    expect(llm.added['litecode']).toEqual({ type: 'remote', url: 'http://127.0.0.1:1/mcp/proj' }) // timeout 없음
    mcp.reattach('litecode')
    await mcp.prepare(project)
    expect(adds(llm)).toEqual(['add proj litecode', 'add proj litecode'])
    off()
    await mcp.prepare(project)
    expect(llm.calls.at(-1)).toBe('disconnect proj litecode')
  })

  it('고치기·지우기는 그 프로젝트의 전용 서버를 먼저 찾고, 지우면 켜기 값도 같이 지운다', async () => {
    const { mcp } = await start()
    mcp.save({ ...local('db'), scope: 'project' }, project)
    mcp.setEnabled('db', false, project)
    mcp.save({ ...local('db2', '/bin/echo'), originalName: 'db' }, project)
    expect((await mcp.list(project))[0]).toMatchObject({ name: 'db2', scope: 'project', command: ['/bin/echo'] })
    mcp.remove('db2', project)
    mcp.save({ ...local('db'), scope: 'project' }, project)
    expect((await mcp.list(project))[0]).toMatchObject({ name: 'db', enabled: true }) // 예전 "꺼짐" 이 되살아나지 않는다
  })
})

describe('McpService — 서버 안의 도구 고르기 (#164)', () => {
  const local = (name: string, command: string[] = ['/bin/cat']): McpServerInput => ({ name, type: 'local', command, vars: [] })

  it('끈 도구는 그 프로젝트의 다음 턴에 ctx.llm 으로 간다 — 다른 프로젝트는 그대로, 파일엔 프로젝트별로 남는다', async () => {
    const { mcp, llm } = await start()
    mcp.save(local('wiki'))
    mcp.setTools('wiki', { off: ['delete_page'] }, project)
    await mcp.prepare(project)
    await mcp.prepare(other)
    expect(llm.hidden.get(project)).toEqual({ wiki: ['delete_page'] })
    expect(llm.hidden.get(other)).toEqual({})
    expect((await mcp.list(project))[0]!.toolSelection).toEqual({ off: ['delete_page'] })
    expect((await mcp.list(other))[0]!.toolSelection).toBeUndefined()
    const stored = JSON.parse(await fs.readFile(path.join(tmp, 'mcp-projects.json'), 'utf8')) as Record<string, { tools?: unknown }>
    expect(stored[project]!.tools).toEqual({ wiki: { off: ['delete_page'] } })

    const again = await start()
    await again.mcp.prepare(project)
    expect(again.llm.hidden.get(project)).toEqual({ wiki: ['delete_page'] })
    again.mcp.setTools('wiki', undefined, project) // [전부 켜기]
    await again.mcp.prepare(project)
    expect(again.llm.hidden.get(project)).toEqual({})
  })

  it('only(전부 끄기 뒤 고른 것) — 서버의 도구 목록을 물어 나머지를 숨긴다. 새 도구도 숨겨진다', async () => {
    const script = path.join(tmp, 'fake.cjs')
    await fs.writeFile(script, FAKE_STDIO) // 도구 first·second
    const { mcp, llm } = await start()
    mcp.save(local('docs', [process.execPath, script]))
    mcp.setTools('docs', { only: ['first'] }, project)
    await mcp.prepare(project)
    expect(llm.hidden.get(project)).toEqual({ docs: ['second'] })
    mcp.setTools('docs', { only: [] }, project)
    await mcp.prepare(project)
    expect(llm.hidden.get(project)).toEqual({ docs: ['first', 'second'] })
  })

  it('프로젝트 폴더 정의 서버도 고를 수 있고 .mcp.json 은 안 고친다. 내장 서버의 선택은 받지 않는다', async () => {
    const { mcp, llm } = await start()
    const file = path.join(project, '.mcp.json')
    const text = JSON.stringify({ mcpServers: { atlassian: { command: '/bin/cat' } } })
    await fs.writeFile(file, text)
    mcp.setTools('atlassian', { off: ['jira_delete'] }, project)
    mcp.registerBuiltin('litecode', () => ({ type: 'remote', url: 'http://127.0.0.1:1/mcp' }))
    expect(() => mcp.setTools('litecode', { off: ['x'] }, project)).toThrow()
    await mcp.prepare(project)
    expect(llm.hidden.get(project)).toEqual({ atlassian: ['jira_delete'] })
    expect(await fs.readFile(file, 'utf8')).toBe(text)
  })

  it('이름을 바꾸면 선택이 따라가고, 지우면 같이 지운다. 옛 파일(tools 없음)도 읽는다', async () => {
    await fs.writeFile(path.join(tmp, 'mcp-projects.json'), JSON.stringify({ [project]: { servers: [], enabled: { wiki: true } } }))
    const { mcp, llm } = await start()
    mcp.save({ ...local('db'), scope: 'project' }, project)
    mcp.setTools('db', { off: ['drop'] }, project)
    mcp.save({ ...local('db2'), originalName: 'db' }, project)
    expect((await mcp.list(project))[0]).toMatchObject({ name: 'db2', toolSelection: { off: ['drop'] } })
    mcp.remove('db2', project)
    mcp.save({ ...local('db2'), scope: 'project' }, project)
    expect((await mcp.list(project))[0]!.toolSelection).toBeUndefined()
    await mcp.prepare(project)
    expect(llm.hidden.get(project)).toEqual({})
  })
})

describe('프로젝트·개인 정의 읽기', () => {
  it('.mcp.json(Claude Code)·opencode.jsonc·.opencode 를 겹쳐 읽는다 — 뒤가 이기고 enabled:false 는 꺼진 채', async () => {
    await fs.mkdir(path.join(project, '.opencode'))
    await fs.writeFile(path.join(project, '.mcp.json'), JSON.stringify({ mcpServers: { a: { type: 'http', url: 'http://h/mcp', headers: { T: 'x' } }, b: { command: 'b1' } } }))
    await fs.writeFile(path.join(project, 'opencode.jsonc'), '{\n // 주석\n "mcp": { "b": { "type": "local", "command": ["b2"], }, "c": { "type": "remote", "url": "http://c", "enabled": false } },\n}')
    await fs.writeFile(path.join(project, '.opencode', 'opencode.json'), JSON.stringify({ mcp: { c: { type: 'remote', url: 'http://c2' } } }))
    const servers = Object.fromEntries(projectServers(project).map((server) => [server.name, server]))
    expect(servers['a']).toEqual({ name: 'a', enabled: true, origin: '.mcp.json', def: { type: 'remote', url: 'http://h/mcp', headers: { T: 'x' } } })
    expect(servers['b']).toMatchObject({ origin: 'opencode.jsonc', def: { type: 'local', command: ['b2'] } })
    expect(servers['c']).toMatchObject({ enabled: true, origin: '.opencode/opencode.json', def: { url: 'http://c2' } })
  })

  it('개인 설정은 XDG_CONFIG_HOME/opencode 에서 읽는다', async () => {
    const dir = path.join(tmp, 'xdg', 'opencode')
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, 'opencode.json'), JSON.stringify({ mcp: { mine: { type: 'local', command: ['m'] } } }))
    expect(personalServers({ XDG_CONFIG_HOME: path.join(tmp, 'xdg') }).map((server) => server.name)).toEqual(['mine'])
  })

  it('parseJsonc — 문자열 안의 // 는 그대로, 주석·끝 쉼표는 뗀다', () => {
    expect(parseJsonc('{"u":"http://x//y", /* c */ "a":[1,2,],}')).toEqual({ u: 'http://x//y', a: [1, 2] })
    expect(parseJsonc('{')).toBeUndefined()
  })
})

// opencode 는 서버·도구 이름의 [A-Za-z0-9_-] 밖 글자를 _ 로 바꿔 `<서버>_<도구>` 를 만든다 (#28 실측: rem-1 + remote-dash.tool → rem-1_remote-dash_tool)
describe('mcpToolOf — 엔진 도구 이름 → 서버·도구', () => {
  it('아는 서버 이름이면 가장 긴 것으로 가른다', () => {
    expect(mcpToolOf('my_srv_echo', ['my', 'my_srv'])).toEqual({ server: 'my_srv', tool: 'echo' })
    expect(mcpToolOf('rem-1_remote-dash_tool', ['rem-1'])).toEqual({ server: 'rem-1', tool: 'remote-dash_tool' })
    expect(mcpToolOf('a_b_c', ['a.b'])).toEqual({ server: 'a.b', tool: 'c' })
    expect(sanitizeMcpName('a.b')).toBe('a_b')
  })

  it('모르면 첫 _ 에서 가르고, 내장 도구·권한은 MCP 가 아니다', () => {
    expect(mcpToolOf('loc_echo_upper')).toEqual({ server: 'loc', tool: 'echo_upper' })
    for (const name of ['bash', 'apply_patch', 'list_mcp_resources', 'read_mcp_resource', 'external_directory', 'doom_loop']) expect(mcpToolOf(name), name).toBeUndefined()
  })
})

/** 줄 단위 JSON-RPC 가짜 MCP — 도구 둘, 자기 env 를 ENV_DUMP 에 적는다 */
const FAKE_STDIO = `
const fs = require('node:fs')
if (process.env.ENV_DUMP) fs.writeFileSync(process.env.ENV_DUMP, JSON.stringify(process.env))
let buf = ''
process.stdin.on('data', (d) => {
  buf += d
  let i
  while ((i = buf.indexOf('\\n')) !== -1) {
    const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1)
    if (m.id === undefined) continue
    const result = m.method === 'initialize' ? { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'f', version: '0' } }
      : m.method === 'tools/list' ? (m.params.cursor ? { tools: [{ name: 'second' }] } : { tools: [{ name: 'first', description: 'one' }], nextCursor: 'p2' }) : {}
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) + '\\n')
  }
})
`

describe('listMcpTools — 앱이 직접 붙어 도구 목록만 본다', () => {
  it('로컬: 커서 끝까지 읽고, 자식 env 에서 비밀 이름을 지우고 정의 env 를 얹는다', async () => {
    const script = path.join(tmp, 'fake.cjs')
    await fs.writeFile(script, FAKE_STDIO)
    const dump = path.join(tmp, 'env.json')
    const tools = await listMcpTools(
      { type: 'local', command: [process.execPath, script], environment: { ENV_DUMP: dump, MY_TOKEN: 'mine' } },
      { cwd: tmp, env: { PATH: process.env.PATH, OPENCODE_SERVER_PASSWORD: 'pw', GITHUB_TOKEN: 'ghp', HOME: '/h' } },
    )
    // tokens = 도구 정의 JSON 글자 수 ÷ 3.5 올림 (이슈 #164): {"name":"first","description":"one"} 36자 → 11, {"name":"second"} 17자 → 5
    expect(tools).toEqual([{ name: 'first', description: 'one', tokens: 11 }, { name: 'second', tokens: 5 }])
    const env = JSON.parse(await fs.readFile(dump, 'utf8')) as Record<string, string>
    expect(env['OPENCODE_SERVER_PASSWORD']).toBeUndefined()
    expect(env['GITHUB_TOKEN']).toBeUndefined()
    expect(env['MY_TOKEN']).toBe('mine')
    expect(env['HOME']).toBe('/h')
  })

  // 참고 레포 검토(02x A·B): 조각마다 toString() 하면 조각 경계에 걸린 한글이 깨진다 — 답을 '한' 의 첫 바이트 뒤에서 끊어 두 번에 쓴다
  it('로컬: 여러 바이트 글자가 조각 경계에 걸려도 깨지지 않는다', async () => {
    const script = path.join(tmp, 'split.cjs')
    await fs.writeFile(
      script,
      [
        "let buf = ''",
        "process.stdin.on('data', (d) => {",
        '  buf += d',
        '  let i',
        "  while ((i = buf.indexOf('\\n')) !== -1) {",
        '    const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1)',
        '    if (m.id === undefined) continue',
        "    if (m.method === 'initialize') { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: {} }) + '\\n'); continue }",
        "    const bytes = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'search', description: '한글 설명' }] } }) + '\\n')",
        "    const cut = bytes.indexOf(Buffer.from('한')) + 1",
        '    process.stdout.write(bytes.subarray(0, cut), () => setTimeout(() => process.stdout.write(bytes.subarray(cut)), 100))',
        '  }',
        '})',
      ].join('\n'),
    )
    expect(await listMcpTools({ type: 'local', command: [process.execPath, script] }, { cwd: tmp, env: { PATH: process.env.PATH } })).toMatchObject([{ name: 'search', description: '한글 설명' }])
  })

  // 참고 레포 검토(02x B): 헤더에 비밀을 실은 요청이 리다이렉트를 따라가면 그 값이 다른 곳으로 간다
  it('원격: 리다이렉트는 따라가지 않는다 — 옮겨 간 주소로 요청이 나가지 않고 사유로 거절', async () => {
    let followed = 0
    const other = http.createServer((_req, res) => {
      followed++
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }))
    })
    await new Promise<void>((resolve) => other.listen(0, '127.0.0.1', resolve))
    const redirecting = http.createServer((_req, res) => void res.writeHead(307, { location: `http://127.0.0.1:${(other.address() as AddressInfo).port}/mcp` }).end())
    await new Promise<void>((resolve) => redirecting.listen(0, '127.0.0.1', resolve))
    try {
      const url = `http://127.0.0.1:${(redirecting.address() as AddressInfo).port}/mcp`
      await expect(listMcpTools({ type: 'remote', url, headers: { Authorization: 'Bearer good' } }, { cwd: tmp })).rejects.toThrow('다른 주소로 넘기려')
      expect(followed).toBe(0)
    } finally {
      await new Promise<void>((resolve) => other.close(() => resolve()))
      await new Promise<void>((resolve) => redirecting.close(() => resolve()))
    }
  })

  it('로컬: 없는 명령·바로 끝나는 서버는 사유로 실패한다', async () => {
    await expect(listMcpTools({ type: 'local', command: ['/nonexistent/mcp'] }, { cwd: tmp, env: {} })).rejects.toThrow(/ENOENT/)
    await expect(listMcpTools({ type: 'local', command: ['/usr/bin/false'] }, { cwd: tmp, env: {} })).rejects.toThrow(/끝났습니다/)
  })

  it('원격: SSE 로 온 답도 읽고 세션 id·헤더를 싣는다, 401 은 HTTP 401', async () => {
    const seen: { auth?: string; session?: string }[] = []
    const server = http.createServer((req, res) => {
      let body = ''
      req.on('data', (part) => (body += part))
      req.on('end', () => {
        seen.push({ auth: req.headers.authorization, session: req.headers['mcp-session-id'] as string | undefined })
        if (req.method === 'DELETE') return void res.writeHead(200).end()
        if (req.headers.authorization !== 'Bearer good') return void res.writeHead(401).end()
        const message = JSON.parse(body) as { id?: number; method: string }
        if (message.id === undefined) return void res.writeHead(202).end()
        const result = message.method === 'initialize' ? { protocolVersion: '2025-06-18', capabilities: {} } : { tools: [{ name: 'ping', description: 'p' }] }
        res.writeHead(200, { 'content-type': 'text/event-stream', 'mcp-session-id': 's1' })
        res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n\n`)
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`
    try {
      expect(await listMcpTools({ type: 'remote', url, headers: { Authorization: 'Bearer good' } }, { cwd: tmp })).toMatchObject([{ name: 'ping', description: 'p' }])
      expect(seen[1]).toEqual({ auth: 'Bearer good', session: 's1' })
      await expect(listMcpTools({ type: 'remote', url, headers: { Authorization: 'Bearer bad' } }, { cwd: tmp })).rejects.toThrow('HTTP 401')
    } finally {
      server.close()
    }
  })

  // 이슈 #178 (02x B 4-5): `npx` 처럼 감싼 서버는 감싼 쪽만 죽고 진짜 서버(손자)가 남았다 — 프로세스 그룹째 끈다.
  // 정상 끝·기한 초과·감싼 쪽이 먼저 죽은 경우 모두. 손자가 SIGTERM 을 무시하면 유예 뒤 SIGKILL 로
  describe.skipIf(process.platform === 'win32')('로컬: 끝낼 때 손자 프로세스까지 끈다', () => {
    const WRAPPER = `
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const code = process.env.IGNORE_TERM ? "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)" : 'setInterval(() => {}, 1000)'
const grandchild = spawn(process.execPath, ['-e', code], { stdio: 'ignore' })
fs.writeFileSync(process.env.PID_FILE, String(grandchild.pid))
if (process.env.MODE === 'exit') process.exit(1)
let buf = ''
process.stdin.on('data', (d) => {
  if (process.env.MODE === 'silent') return
  buf += d
  let i
  while ((i = buf.indexOf('\\n')) !== -1) {
    const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1)
    if (m.id === undefined) continue
    const result = m.method === 'initialize' ? {} : { tools: [{ name: 'only' }] }
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) + '\\n')
  }
})
`
    const alive = (pid: number): boolean => {
      try {
        process.kill(pid, 0)
        return true
      } catch {
        return false
      }
    }
    async function gone(pid: number, withinMs: number): Promise<boolean> {
      const until = Date.now() + withinMs
      while (Date.now() < until) {
        if (!alive(pid)) return true
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
      return !alive(pid)
    }
    async function run(env: Record<string, string>, timeoutMs = 5_000): Promise<{ result: PromiseSettledResult<unknown>; grandchild: number }> {
      const script = path.join(tmp, 'wrapper.cjs')
      const pidFile = path.join(tmp, 'grandchild.pid')
      await fs.writeFile(script, WRAPPER)
      const [result] = await Promise.allSettled([
        listMcpTools({ type: 'local', command: [process.execPath, script], environment: { PID_FILE: pidFile, ...env } }, { cwd: tmp, env: { PATH: process.env.PATH }, timeoutMs }),
      ])
      return { result: result!, grandchild: Number(await fs.readFile(pidFile, 'utf8')) }
    }

    it('정상 끝', async () => {
      const { result, grandchild } = await run({ MODE: 'serve' })
      try {
        expect(result).toMatchObject({ status: 'fulfilled', value: [{ name: 'only' }] })
        expect(await gone(grandchild, 1_500)).toBe(true)
      } finally {
        if (alive(grandchild)) process.kill(grandchild, 'SIGKILL')
      }
    })

    it('기한 초과 — SIGTERM 을 무시하는 손자도 유예 뒤 SIGKILL', async () => {
      const { result, grandchild } = await run({ MODE: 'silent', IGNORE_TERM: '1' }, 500)
      try {
        expect(result.status).toBe('rejected')
        expect(await gone(grandchild, 4_000)).toBe(true)
      } finally {
        if (alive(grandchild)) process.kill(grandchild, 'SIGKILL')
      }
    }, 10_000)

    it('감싼 쪽이 먼저 죽었다', async () => {
      const { result, grandchild } = await run({ MODE: 'exit' })
      try {
        expect(result.status).toBe('rejected')
        expect(await gone(grandchild, 1_500)).toBe(true)
      } finally {
        if (alive(grandchild)) process.kill(grandchild, 'SIGKILL')
      }
    })
  })

  it('mcpChildEnv — OPENCODE_*·LITECODE_*·KEY/PASSWORD/SECRET/TOKEN 을 지운다', () => {
    expect(mcpChildEnv({ PATH: '/b', LITECODE_X: '1', OPENCODE_DB: 'd', AWS_SECRET_ACCESS_KEY: 's', db_password: 'p' }, { Z: '1' })).toEqual({ PATH: '/b', Z: '1' })
  })
})
