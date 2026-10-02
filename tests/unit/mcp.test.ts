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
}

let tmp: string
let project: string

beforeEach(async () => {
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'litecode-mcp-unit-')))
  project = path.join(tmp, 'proj')
  await fs.mkdir(project)
})
afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true })
})

async function start(env: NodeJS.ProcessEnv = { HOME: path.join(tmp, 'home'), XDG_CONFIG_HOME: path.join(tmp, 'xdg') }) {
  const ctx = new Context()
  ctx.plugin(FakeLlm)
  ctx.plugin(McpService, { file: path.join(tmp, 'mcp.json'), secretsFile: path.join(tmp, 'mcp-secrets.json'), cipher: reversing, env, fallbackCwd: tmp })
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
    mcp.setEnabled('loc', false)
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

describe('프로젝트·개인 정의 읽기', () => {
  it('.mcp.json(Claude Code)·opencode.jsonc·.opencode 를 겹쳐 읽는다 — 뒤가 이기고 enabled:false 는 꺼진 채', async () => {
    await fs.mkdir(path.join(project, '.opencode'))
    await fs.writeFile(path.join(project, '.mcp.json'), JSON.stringify({ mcpServers: { a: { type: 'http', url: 'http://h/mcp', headers: { T: 'x' } }, b: { command: 'b1' } } }))
    await fs.writeFile(path.join(project, 'opencode.jsonc'), '{\n // 주석\n "mcp": { "b": { "type": "local", "command": ["b2"], }, "c": { "type": "remote", "url": "http://c", "enabled": false } },\n}')
    await fs.writeFile(path.join(project, '.opencode', 'opencode.json'), JSON.stringify({ mcp: { c: { type: 'remote', url: 'http://c2' } } }))
    const servers = Object.fromEntries(projectServers(project).map((server) => [server.name, server]))
    expect(servers['a']).toEqual({ name: 'a', enabled: true, def: { type: 'remote', url: 'http://h/mcp', headers: { T: 'x' } } })
    expect(servers['b']!.def).toEqual({ type: 'local', command: ['b2'] })
    expect(servers['c']).toMatchObject({ enabled: true, def: { url: 'http://c2' } })
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
    expect(tools).toEqual([{ name: 'first', description: 'one' }, { name: 'second' }])
    const env = JSON.parse(await fs.readFile(dump, 'utf8')) as Record<string, string>
    expect(env['OPENCODE_SERVER_PASSWORD']).toBeUndefined()
    expect(env['GITHUB_TOKEN']).toBeUndefined()
    expect(env['MY_TOKEN']).toBe('mine')
    expect(env['HOME']).toBe('/h')
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
      expect(await listMcpTools({ type: 'remote', url, headers: { Authorization: 'Bearer good' } }, { cwd: tmp })).toEqual([{ name: 'ping', description: 'p' }])
      expect(seen[1]).toEqual({ auth: 'Bearer good', session: 's1' })
      await expect(listMcpTools({ type: 'remote', url, headers: { Authorization: 'Bearer bad' } }, { cwd: tmp })).rejects.toThrow('HTTP 401')
    } finally {
      server.close()
    }
  })

  it('mcpChildEnv — OPENCODE_*·LITECODE_*·KEY/PASSWORD/SECRET/TOKEN 을 지운다', () => {
    expect(mcpChildEnv({ PATH: '/b', LITECODE_X: '1', OPENCODE_DB: 'd', AWS_SECRET_ACCESS_KEY: 's', db_password: 'p' }, { Z: '1' })).toEqual({ PATH: '/b', Z: '1' })
  })
})
