import { Context, Service } from 'cordis'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AppMcpService } from '../../src/services/appMcp.ts'
import { handleRpc, type AppMcpTool } from '../../src/services/appMcp/rpc.ts'
import { OpenTool, openFileTarget, terminalCommand } from '../../src/services/appMcp/tools/open.ts'
import { PresentTool, PRESENT_MAX_FILES } from '../../src/services/appMcp/tools/present.ts'
import type { EngineMcp } from '../../src/services/engine.ts'
import type { McpStatus } from '../../src/services/llm.ts'
import { APP_MCP_NAME, McpService } from '../../src/services/mcp.ts'
import { listMcpTools } from '../../src/services/mcpClient.ts'

// 앱 MCP 서버 (이슈 #51, 설계 _workspace/01z_desktop_mcp.md) — JSON-RPC 처리, 서버의 경계(토큰·메서드·본문 상한·프로젝트 키), 화면 도구(open 의 파일·터미널),
// ctx.mcp 로 붙는 길. 서버는 진짜 HTTP 로 띄운다(127.0.0.1, OS 가 고른 포트). 엔진(ctx.llm 의 mcp*)은 기록하는 가짜 — 진짜 opencode 는 안 띄운다.

const echo: AppMcpTool = {
  name: 'echo',
  description: 'Echo',
  inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
  async run(args, call) {
    if (args['text'] === 'boom') throw new Error('No such thing: boom')
    return `${call.directory}:${String(args['text'])}`
  },
}
const call = { directory: '/p' }
const rpc = (message: unknown) => handleRpc(message, [echo], call, 'litecode')

describe('JSON-RPC (appMcp/rpc.ts)', () => {
  it('initialize 는 부른 protocolVersion 을 그대로 돌려준다 — 없으면 우리 것', async () => {
    const asked = await rpc({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: { roots: {} } } })
    expect(asked).toEqual({
      jsonrpc: '2.0',
      id: 0,
      result: { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'litecode', version: '1' } },
    })
    const bare = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize' })
    expect((bare!.result as { protocolVersion: string }).protocolVersion).toBe('2025-06-18')
  })

  it('알림(id 없음)에는 답이 없다 — initialized, 그리고 호출 끝마다 오는 cancelled 도 무시', async () => {
    expect(await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' })).toBeNull()
    expect(await rpc({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 2, reason: 'done' } })).toBeNull()
    expect(await rpc({ jsonrpc: '2.0', method: 'tools/call', params: { name: 'echo', arguments: { text: 'x' } } })).toBeNull() // 알림으로 온 호출은 돌리지 않는다
  })

  it('tools/list 는 이름·설명·inputSchema 만', async () => {
    expect((await rpc({ jsonrpc: '2.0', id: 'a', method: 'tools/list' }))!.result).toEqual({
      tools: [{ name: 'echo', description: 'Echo', inputSchema: echo.inputSchema }],
    })
  })

  it('tools/call — 결과 글, 그리고 호출 신원(폴더)은 서버가 준 것', async () => {
    const answer = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'echo', arguments: { text: 'hi' }, _meta: { progressToken: 2 } } })
    expect(answer).toEqual({ jsonrpc: '2.0', id: 2, result: { content: [{ type: 'text', text: '/p:hi' }] } })
  })

  it('도구 실패·모르는 도구는 JSON-RPC 오류가 아니라 isError + 글 (그 글이 모델에 간다)', async () => {
    const failed = await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'echo', arguments: { text: 'boom' } } })
    expect(failed).toEqual({ jsonrpc: '2.0', id: 3, result: { content: [{ type: 'text', text: 'No such thing: boom' }], isError: true } })
    const unknown = await rpc({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'nope' } })
    expect(unknown!.error).toBeUndefined()
    expect(unknown!.result).toEqual({ content: [{ type: 'text', text: 'Unknown tool: nope' }], isError: true })
  })

  it('모르는 메서드는 -32601, 객체가 아닌 요청은 -32600, id 가 null 인 것은 요청이다', async () => {
    expect((await rpc({ jsonrpc: '2.0', id: 5, method: 'prompts/list' }))!.error).toMatchObject({ code: -32601 })
    expect((await rpc([{ jsonrpc: '2.0', id: 6, method: 'ping' }]))!.error).toMatchObject({ code: -32600 })
    expect(await rpc({ jsonrpc: '2.0', id: null, method: 'ping' })).toEqual({ jsonrpc: '2.0', id: null, result: {} })
  })
})

describe('open 터미널의 명령 — 채워만 둔다', () => {
  it('양끝 공백·개행은 떼고, 없거나 빈 글이면 칸만 연다', () => {
    expect(terminalCommand({ command: '  npm test\n' })).toBe('npm test')
    expect(terminalCommand({})).toBeUndefined()
    expect(terminalCommand({ command: ' \n ' })).toBeUndefined()
  })

  it('가운데 개행·제어문자는 거절한다 — 셸에 들어가는 즉시 실행된다', () => {
    for (const command of ['echo a\necho b', 'echo a\rrm -rf x', 'ls\u001b[A', 'a\tb', 'a\u007fb', 'a\u0000b']) {
      expect(() => terminalCommand({ command })).toThrow('Multi-line commands and control characters are rejected')
    }
    expect(() => terminalCommand({ command: 3 })).toThrow('command must be a string')
  })
})

// ── 서버·도구·붙이기 (진짜 HTTP) ──

class FakeLlm extends Service {
  status = new Map<string, Record<string, McpStatus>>()
  calls: string[] = []
  added: Record<string, EngineMcp> = {}
  constructor(ctx: Context) {
    super(ctx, 'llm')
  }
  async mcpStatus(directory: string) {
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
  async mcpConnect() {}
}

/** ctx.terminals 흉내 — 쓴 글을 적는다 */
class FakeTerminals extends Service {
  written: [string, string][] = []
  constructor(ctx: Context) {
    super(ctx, 'terminals')
  }
  async write(directory: string, data: string) {
    this.written.push([directory, data])
  }
}

let tmp: string
let project: string
let other: string
let disposers: { dispose(): Promise<void> }[]

beforeEach(async () => {
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'litecode-appmcp-unit-')))
  project = path.join(tmp, 'proj')
  other = path.join(tmp, 'other')
  await fs.mkdir(path.join(project, 'src'), { recursive: true })
  await fs.mkdir(other)
  await fs.writeFile(path.join(project, 'src', 'a.ts'), 'one\ntwo\n')
  await fs.writeFile(path.join(other, 'secret.txt'), 'x')
  disposers = []
})
afterEach(async () => {
  for (const fiber of disposers.reverse()) await fiber.dispose()
  await fs.rm(tmp, { recursive: true, force: true })
})

async function start() {
  const ctx = new Context()
  ctx.plugin(FakeLlm)
  ctx.plugin(McpService, { env: { HOME: path.join(tmp, 'home'), XDG_CONFIG_HOME: path.join(tmp, 'xdg') }, fallbackCwd: tmp })
  disposers.push(ctx.plugin(AppMcpService))
  ctx.plugin(OpenTool)
  const terminalsFiber = ctx.plugin(FakeTerminals)
  const ready = await new Promise<Context>((resolve) => ctx.inject(['llm', 'mcp', 'appMcp', 'terminals'], resolve))
  await ready.appMcp.ready()
  const events: unknown[][] = []
  ctx.on('appMcp/open-file', (...args) => void events.push(['file', ...args]))
  ctx.on('appMcp/open-terminal', (...args) => void events.push(['terminal', ...args]))
  const def = ready.appMcp.definition(project) as Extract<EngineMcp, { type: 'remote' }>
  const post = (body: unknown, init: { url?: string; headers?: Record<string, string> } = {}) =>
    fetch(init.url ?? def.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(init.headers ?? def.headers) },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    })
  /** 도구 호출 — 결과 글과 isError */
  const tool = async (name: string, args: Record<string, unknown>, url?: string) => {
    const res = await post({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, { url })
    const { result } = (await res.json()) as { result: { content: { text: string }[]; isError?: boolean } }
    return { text: result.content[0]!.text, isError: !!result.isError }
  }
  const toolNames = async () => {
    const res = await post({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    return ((await res.json()) as { result: { tools: { name: string }[] } }).result.tools.map((entry) => entry.name)
  }
  await expect.poll(toolNames).toEqual(['open'])
  return { ctx, llm: ready.llm as unknown as FakeLlm, mcp: ready.mcp, appMcp: ready.appMcp, terminals: ready.terminals as unknown as FakeTerminals, terminalsFiber, def, post, tool, toolNames, events }
}

describe('서버의 경계', () => {
  it('127.0.0.1 에만 열리고, 주소의 마지막 마디는 프로젝트마다 다른 무작위 키, 토큰은 Bearer', async () => {
    const { appMcp, def } = await start()
    expect(def.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp\/[0-9a-f]{32}$/)
    expect(def.headers!['Authorization']).toMatch(/^Bearer [0-9a-f]{64}$/)
    const second = appMcp.definition(other) as Extract<EngineMcp, { type: 'remote' }>
    expect(second.url).not.toBe(def.url)
    expect(appMcp.definition(project)).toEqual(def) // 같은 폴더는 같은 주소 — 매 턴 다시 붙이지 않는다
    expect(def.url).not.toContain(path.basename(project))
  })

  it('토큰이 없거나 틀리면 401 — 메서드·경로보다 먼저', async () => {
    const { def, post } = await start()
    const request = { jsonrpc: '2.0', id: 1, method: 'tools/list' }
    expect((await post(request, { headers: {} })).status).toBe(401)
    expect((await post(request, { headers: { Authorization: 'Bearer wrong' } })).status).toBe(401)
    expect((await post(request, { headers: { Authorization: def.headers!['Authorization']!.slice(0, -1) } })).status).toBe(401)
    expect((await fetch(def.url)).status).toBe(401)
    expect((await post(request)).status).toBe(200)
  })

  it('GET 은 405 (엔진이 붙자마자 SSE 를 얻으려 한 번 한다), 모르는 프로젝트 키는 404', async () => {
    const { def, post } = await start()
    const get = await fetch(def.url, { headers: { ...def.headers, accept: 'text/event-stream' } })
    expect(get.status).toBe(405)
    expect(get.headers.get('allow')).toBe('POST')
    const request = { jsonrpc: '2.0', id: 1, method: 'tools/list' }
    expect((await post(request, { url: def.url.replace(/[0-9a-f]{32}$/, 'f'.repeat(32)) })).status).toBe(404)
    expect((await post(request, { url: def.url.replace(/\/mcp\/.*/, '/mcp/') })).status).toBe(404)
    expect((await post(request, { url: def.url.replace('/mcp/', '/other/') })).status).toBe(404)
  })

  it('본문 상한(64KB)을 넘으면 413, 깨진 JSON 은 400, 알림은 202 에 빈 본문', async () => {
    const { post } = await start()
    const big = await post({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'open', arguments: { kind: 'file', path: 'x'.repeat(70_000) } } })
    expect(big.status).toBe(413)
    const broken = await post('{nope')
    expect(broken.status).toBe(400)
    expect(await broken.json()).toMatchObject({ error: { code: -32700 } })
    for (const method of ['notifications/initialized', 'notifications/cancelled']) {
      const notified = await post({ jsonrpc: '2.0', method })
      expect(notified.status).toBe(202)
      expect(await notified.text()).toBe('')
    }
  })

  it('프로젝트 신원은 요청이 아니라 주소가 정한다 — 다른 프로젝트 주소로 온 호출은 그 프로젝트의 것', async () => {
    const { appMcp, tool, events } = await start()
    const otherUrl = (appMcp.definition(other) as Extract<EngineMcp, { type: 'remote' }>).url
    appMcp.view(other)
    // other 주소로 proj 의 파일을 달라고 해도(인자로 폴더를 주장해도) other 안에서만 찾는다
    expect(await tool('open', { kind: 'file', path: 'src/a.ts', directory: project }, otherUrl)).toEqual({ text: 'Not a file inside this project: src/a.ts', isError: true })
    expect(await tool('open', { kind: 'file', path: 'secret.txt' }, otherUrl)).toEqual({ text: 'Opened secret.txt in the side panel.', isError: false })
    expect(events).toEqual([['file', other, 'secret.txt', undefined]])
  })

  it('서비스를 내리면 서버가 닫힌다', async () => {
    const { def, post } = await start()
    await disposers.pop()!.dispose()
    await expect(post({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).rejects.toThrow()
    expect(def.url).toBeTruthy()
  })
})

describe('open — kind file', () => {
  it('보고 있는 프로젝트의 파일을 연다 — 상대·절대 경로, 줄(1부터)', async () => {
    const { appMcp, tool, events } = await start()
    appMcp.view(project)
    expect(await tool('open', { kind: 'file', path: 'src/a.ts' })).toEqual({ text: 'Opened src/a.ts in the side panel.', isError: false })
    expect(await tool('open', { kind: 'file', path: path.join(project, 'src', 'a.ts'), line: 2 })).toEqual({ text: 'Opened src/a.ts at line 2 in the side panel.', isError: false })
    expect(await tool('open', { kind: 'file', path: './src/../src/a.ts', line: 0 })).toEqual({ text: 'Opened src/a.ts in the side panel.', isError: false })
    expect(events).toEqual([
      ['file', project, 'src/a.ts', undefined],
      ['file', project, 'src/a.ts', 2],
      ['file', project, 'src/a.ts', undefined],
    ])
  })

  it('프로젝트 밖·링크로 밖·폴더·없는 파일은 거절한다 (화면에 아무것도 안 간다)', async () => {
    const { appMcp, tool, events } = await start()
    appMcp.view(project)
    await fs.symlink(path.join(other, 'secret.txt'), path.join(project, 'link.txt'))
    await fs.symlink(other, path.join(project, 'linkdir'))
    for (const asked of ['../other/secret.txt', path.join(other, 'secret.txt'), 'link.txt', 'linkdir/secret.txt', 'src', 'nope.ts', '/etc/hosts']) {
      expect(await tool('open', { kind: 'file', path: asked })).toEqual({ text: `Not a file inside this project: ${asked}`, isError: true })
    }
    expect((await tool('open', { kind: 'file' })).isError).toBe(true)
    expect(events).toEqual([])
  })

  it('사용자가 다른 프로젝트를 보고 있으면 열지 않고 그 사실을 돌려준다', async () => {
    const { appMcp, tool, events } = await start()
    appMcp.view(other)
    expect(await tool('open', { kind: 'file', path: 'src/a.ts' })).toEqual({
      text: 'The user is viewing another project (other). Ask them to switch back, then call again.',
      isError: true,
    })
    appMcp.view(undefined) // 창이 없다
    expect(await tool('open', { kind: 'file', path: 'src/a.ts' })).toMatchObject({ text: expect.stringContaining('not viewing this project'), isError: true })
    expect(events).toEqual([])
  })

  it('openFileTarget — 줄은 1 이상의 정수만', async () => {
    expect(await openFileTarget(project, { path: 'src/a.ts', line: 3 })).toEqual({ path: 'src/a.ts', line: 3 })
    expect(await openFileTarget(project, { path: 'src/a.ts', line: '7' })).toEqual({ path: 'src/a.ts', line: 7 })
    for (const line of [0, -1, 1.5, 'x', null]) expect(await openFileTarget(project, { path: 'src/a.ts', line })).toEqual({ path: 'src/a.ts' })
  })
})

// 이슈 #91 — 결과물 선언. 엔진은 MCP 결과의 structuredContent 를 파트에 남기지 않는다(동봉 1.18.18 바이너리에서 MCP SDK 의 스키마·검증 말고는 쓰는 곳이 없다)
// → **전부 받아들였을 때만 성공**이다: 그래야 화면이 "성공한 호출의 인자" 만으로 받아들인 목록을 안다 (turnProgress.ts). 하나라도 못 쓰면 isError + 사유
describe('present', () => {
  const withPresent = async () => {
    const started = await start()
    started.ctx.plugin(PresentTool)
    await expect.poll(started.toolNames).toEqual(['open', 'present'])
    return started
  }

  it('프로젝트 안의 파일을 선언한다 — 상대·절대 경로, 화면을 건드리지 않고(보고 있지 않아도 된다) 결과 글은 프로젝트 기준 경로', async () => {
    const { tool, events } = await withPresent()
    await fs.writeFile(path.join(project, 'report.md'), '# r')
    expect(await tool('present', { files: [{ path: 'report.md', title: 'Report' }, { path: path.join(project, 'src', 'a.ts') }] })).toEqual({
      text: 'Presented 2 files to the user: report.md, src/a.ts. They are listed in a card under your answer.',
      isError: false,
    })
    expect(await tool('present', { files: [{ path: './src/../src/a.ts' }] })).toEqual({
      text: 'Presented 1 file to the user: src/a.ts. They are listed in a card under your answer.',
      isError: false,
    })
    expect(events).toEqual([])
  })

  it('하나라도 못 쓰면 아무것도 선언하지 않는다 — 밖·링크로 밖·폴더·없는 파일은 사유와 함께, 쓸 수 있던 것도 알려 준다', async () => {
    const { tool } = await withPresent()
    await fs.symlink(path.join(other, 'secret.txt'), path.join(project, 'link.txt'))
    const { text, isError } = await tool('present', { files: [{ path: 'src/a.ts' }, { path: '../other/secret.txt' }, { path: 'link.txt' }, { path: 'src' }, { path: 'nope.md' }, { title: 'no path' }] })
    expect(isError).toBe(true)
    expect(text).toBe(
      [
        'Nothing was presented. Fix or drop the rejected entries and call again with the full list.',
        'Rejected:',
        '- ../other/secret.txt: not a file inside this project (missing, a folder, or outside the project)',
        '- link.txt: not a file inside this project (missing, a folder, or outside the project)',
        '- src: not a file inside this project (missing, a folder, or outside the project)',
        '- nope.md: not a file inside this project (missing, a folder, or outside the project)',
        '- entry 6: path is required',
        'Accepted:',
        '- src/a.ts',
      ].join('\n'),
    )
  })

  it(`개수는 1~${PRESENT_MAX_FILES} — 비었거나 배열이 아니거나 넘치면 거절`, async () => {
    const { tool } = await withPresent()
    const many = Array.from({ length: PRESENT_MAX_FILES + 1 }, () => ({ path: 'src/a.ts' }))
    for (const files of [[], undefined, 'src/a.ts', many]) {
      expect(await tool('present', { files })).toEqual({ text: `files must be a list of 1 to ${PRESENT_MAX_FILES} entries.`, isError: true })
    }
    expect((await tool('present', { files: many.slice(1) })).isError).toBe(false)
  })
})

describe('open — kind terminal', () => {
  it('보고 있는 프로젝트의 터미널에 명령을 채우기만 한다 — 엔터(개행)는 보내지 않는다', async () => {
    const { appMcp, tool, terminals, events } = await start()
    appMcp.view(project)
    expect(await tool('open', { kind: 'terminal', command: 'npm run build\n' })).toEqual({ text: 'Typed into the terminal (not executed): npm run build', isError: false })
    expect(terminals.written).toEqual([[project, 'npm run build']])
    expect(await tool('open', { kind: 'terminal' })).toEqual({ text: 'Opened the terminal pane.', isError: false })
    expect(terminals.written).toHaveLength(1)
    expect(events).toEqual([['terminal', project], ['terminal', project]])
  })

  it('개행이 든 명령은 거절 — 아무것도 쓰지 않고 칸도 열지 않는다', async () => {
    const { appMcp, tool, terminals, events } = await start()
    appMcp.view(project)
    expect(await tool('open', { kind: 'terminal', command: 'echo a\nrm -rf /' })).toEqual({
      text: 'Multi-line commands and control characters are rejected — they would run immediately.',
      isError: true,
    })
    expect(terminals.written).toEqual([])
    expect(events).toEqual([])
  })

  it('다른 프로젝트를 보고 있으면 쓰지 않고 그 사실을 돌려준다', async () => {
    const { appMcp, tool, terminals, events } = await start()
    appMcp.view(other)
    expect(await tool('open', { kind: 'terminal', command: 'ls' })).toMatchObject({ text: expect.stringContaining('viewing another project (other)'), isError: true })
    expect(terminals.written).toEqual([])
    expect(events).toEqual([])
  })

  it('터미널 칸을 끄면(ctx.terminals 가 내려가면) 도구는 남고 터미널 갈래만 "꺼져 있다" 를 돌려준다 — 파일 갈래는 그대로', async () => {
    const { appMcp, terminals, terminalsFiber, toolNames, tool, events } = await start()
    appMcp.view(project)
    await terminalsFiber.dispose()
    expect(await toolNames()).toEqual(['open'])
    expect(await tool('open', { kind: 'terminal', command: 'ls' })).toEqual({ text: 'The terminal pane is turned off in Settings > Features, so nothing was opened.', isError: true })
    expect(terminals.written).toEqual([])
    expect(await tool('open', { kind: 'file', path: 'src/a.ts' })).toMatchObject({ isError: false })
    expect(events).toEqual([['file', project, 'src/a.ts', undefined]])
  })
})

describe('open — kind', () => {
  it('kind 가 없거나 모르는 값이면 읽을 수 있는 오류 — 아무것도 열지 않는다', async () => {
    const { appMcp, tool, terminals, events } = await start()
    appMcp.view(project)
    for (const kind of [undefined, 'folder', 3]) {
      expect(await tool('open', { kind, path: 'src/a.ts', command: 'ls' })).toEqual({ text: 'kind must be "file" or "terminal".', isError: true })
    }
    expect(await tool('open', { kind: 'file' })).toEqual({ text: 'kind "file" needs path (project-relative).', isError: true })
    expect(terminals.written).toEqual([])
    expect(events).toEqual([])
  })

  it('옛 이름(open_file·open_terminal)은 모르는 도구다 — 별칭이 없다', async () => {
    const { appMcp, tool } = await start()
    appMcp.view(project)
    expect(await tool('open_file', { path: 'src/a.ts' })).toEqual({ text: 'Unknown tool: open_file', isError: true })
    expect(await tool('open_terminal', { command: 'ls' })).toEqual({ text: 'Unknown tool: open_terminal', isError: true })
  })
})

describe('ctx.mcp 로 붙는 길', () => {
  it('매 턴 그 폴더에 `litecode` 로 붙인다 — 원격·Bearer 헤더, timeout 은 주지 않는다(엔진에선 호출 기한이 된다)', async () => {
    const { mcp, llm, def } = await start()
    await mcp.prepare(project)
    expect(llm.added[APP_MCP_NAME]).toEqual({ type: 'remote', url: def.url, headers: def.headers })
    await mcp.prepare(other)
    expect(llm.calls).toEqual(['add proj litecode', 'add other litecode'])
    expect((llm.added[APP_MCP_NAME] as { url: string }).url).not.toBe(def.url) // 폴더마다 다른 주소(프로젝트 키)
  })

  it('앱의 MCP 클라이언트(팝업의 도구 목록)로도 읽힌다 — initialize → initialized → tools/list', async () => {
    const { def } = await start()
    const tools = await listMcpTools(def, { cwd: tmp })
    expect(tools.map((entry) => entry.name)).toEqual(['open'])
    expect(tools[0]!.description).toContain('side panel')
  })

  it('팝업 목록엔 "모든 프로젝트" 맨 끝에 내장 한 줄 — 주소·토큰은 안 나간다. 그 프로젝트에서 끄면 끊는다', async () => {
    const { mcp, llm, def } = await start()
    const builtin = (await mcp.list(project)).at(-1)!
    expect(builtin).toMatchObject({ name: 'litecode', source: 'builtin', scope: 'all', vars: [], enabled: true, status: 'connected' })
    expect(builtin.tools!.map((entry) => entry.name)).toEqual(['open'])
    expect(JSON.stringify(builtin)).not.toContain(def.headers!['Authorization']!.slice(7))
    expect(builtin.url).toBeUndefined()
    expect(await mcp.list()).toEqual([]) // 프로젝트 없이는 붙는 곳이 없다

    mcp.setEnabled('litecode', false, project)
    await mcp.prepare(project)
    expect(llm.calls.at(-1)).toBe('disconnect proj litecode')
    expect((await mcp.list(project)).at(-1)).toMatchObject({ name: 'litecode', enabled: false })
  })

  it('서비스를 내리면 다음 붙이기가 끊는다', async () => {
    const { mcp, llm } = await start()
    await mcp.prepare(project)
    await disposers.pop()!.dispose()
    await mcp.prepare(project)
    expect(llm.calls).toEqual(['add proj litecode', 'disconnect proj litecode'])
  })
})
