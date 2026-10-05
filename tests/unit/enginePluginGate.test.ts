import fs from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { Context, Service } from 'cordis'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LlmService } from '../../src/services/llm.ts'
import { TrajectoryService } from '../../src/services/trajectory.ts'

// 엔진이 플러그인 파일을 실행할 폴더는 엔진에 넘기지 않는다 (이슈 #101, 실측 _workspace/01ah_plugin_block.md) — 그 폴더의 첫 `/api/*` 호출과
// 첫 턴에 그 파일이 엔진 프로세스 안에서 돈다(계획 모드·승인과 무관). 그래서 ctx.llm 이 폴더를 엔진에 넘기는 모든 길에서 **가짜 엔진이 받은
// 요청이 0건** 인지를 본다. 엔진은 무엇을 물어도 200 을 주는 HTTP 서버다 (요청이 닿으면 여기서 센다)

/** 이 파일이 만든 임시 폴더 — 끝나면 이 경로만 지운다 */
const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'litecode-plugingate-')))
afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }))

let server: http.Server
let requests: string[] = []
let url = ''
let cases = 0
let base = ''
let project = ''
let configDir = ''

beforeEach(async () => {
  base = path.join(ROOT, `case-${++cases}`)
  project = path.join(base, 'proj')
  configDir = path.join(base, 'config')
  fs.mkdirSync(project, { recursive: true })
  fs.mkdirSync(configDir, { recursive: true })
  requests = []
  server = http.createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`)
    const route = (req.url ?? '').split('?')[0]!
    if (route.startsWith('/api/')) return void res.end(JSON.stringify({ data: [{ name: 'c', template: 't', path: 'a.txt', type: 'file' }] }))
    if (route === '/mcp' || route === '/session/status') return void res.end('{}')
    res.end('[]')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterEach(() => {
  server.closeAllConnections()
  server.close()
})

async function start(): Promise<{ llm: LlmService; ctx: Context }> {
  const dir = configDir
  class FakeProviders extends Service {
    constructor(ctx: Context) {
      super(ctx, 'providers')
    }
    get(id: string) {
      return { id }
    }
  }
  class FakeEngine extends Service {
    configDir = dir
    constructor(ctx: Context) {
      super(ctx, 'engine')
    }
    async connection() {
      return { url, headers: {}, closed: new AbortController().signal, providerBaseURL: () => 'http://proxy.invalid/v1', mcpConfig: (def: unknown) => def }
    }
    async purgeDeleted() {}
  }
  const ctx = new Context()
  ctx.plugin(FakeProviders)
  ctx.plugin(FakeEngine)
  ctx.plugin(LlmService)
  ctx.plugin(TrajectoryService)
  return new Promise((resolve) => ctx.inject(['llm', 'trajectory'], (ready) => resolve({ llm: ready.llm, ctx: ready })))
}

function plantPlugin(rel = 'proj/.opencode/plugin/x.js'): string {
  const file = path.join(base, rel)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, 'export default async () => ({})\n')
  return file
}

describe('플러그인 파일이 걸린 폴더 — 엔진에 요청이 하나도 안 간다', () => {
  it('턴: 거절하고 걸린 파일 경로를 사유에 싣는다. 턴 이벤트도 없다', async () => {
    const file = plantPlugin()
    const { llm, ctx } = await start()
    const seen: string[] = []
    ctx.on('llm/turn-started', () => void seen.push('started'))
    ctx.on('llm/before-turn', () => void seen.push('before-turn'))
    const result = await llm.chat('p', 'm', project, 'hi')
    expect(result.ok).toBe(false)
    expect(result.error).toContain(file)
    expect(seen).toEqual([])
    expect(requests).toEqual([])
  })

  it('맥락 넣기(addContext)', async () => {
    const file = plantPlugin()
    const { llm } = await start()
    const result = await llm.addContext('p', 'm', project, 'ls output', llm.newMessageId())
    expect(result).toMatchObject({ ok: false })
    expect(result.error).toContain(file)
    expect(requests).toEqual([])
  })

  it('파일·명령 후보, 스킬 목록 (`/api/fs/*`·`/api/command`·`/skill`)', async () => {
    const file = plantPlugin()
    const { llm } = await start()
    await expect(llm.findFiles(project, 'a', 10)).rejects.toThrow(file)
    await expect(llm.listDirectory(project, '')).rejects.toThrow(file)
    await expect(llm.listCommands(project)).rejects.toThrow(file)
    await expect(llm.listSkills(project)).rejects.toThrow(file)
    expect(requests).toEqual([])
  })

  it('터미널 (`POST /api/pty`)', async () => {
    const file = plantPlugin()
    const { llm } = await start()
    await expect(llm.openTerminal(project, { onData: () => {}, onExit: () => {} } as never)).rejects.toThrow(file)
    expect(requests).toEqual([])
  })

  it('옛 기록 읽기 (history — `/api/session/{id}/message` 가 로더를 돌린다): 사유를 돌려주고 폴더 없음으로 보지 않는다', async () => {
    const file = plantPlugin()
    const { llm } = await start()
    const history = await llm.history(project, 'ses_1')
    expect(history.messages).toEqual([])
    expect(history.missingFolder).toBeUndefined()
    expect(history.error).toContain(file)
    expect(requests).toEqual([])
  })

  it('Trajectory 탭 (readMessages·readSubtasks)', async () => {
    const file = plantPlugin()
    const { llm, ctx } = await start()
    await expect(llm.readMessages(project, 'ses_1')).rejects.toThrow(file)
    await expect(llm.readSubtasks(project, [])).rejects.toThrow(file)
    const trajectory = await ctx.trajectory.read(project, 'ses_1')
    expect(trajectory.records).toEqual([])
    expect(trajectory.error).toContain(file)
    expect(requests).toEqual([])
  })

  it('MCP 붙이기·상태·끊기·잇기', async () => {
    const file = plantPlugin()
    const { llm } = await start()
    await expect(llm.mcpStatus(project)).rejects.toThrow(file)
    await expect(llm.mcpAdd(project, 'x', { type: 'remote', url: 'http://127.0.0.1:1/' } as never)).rejects.toThrow(file)
    await expect(llm.mcpDisconnect(project, 'x')).rejects.toThrow(file)
    await expect(llm.mcpConnect(project, 'x')).rejects.toThrow(file)
    expect(requests).toEqual([])
  })

  it('상위 폴더의 것·설정 항목·앱 설정 폴더의 것도 같다', async () => {
    const { llm } = await start()
    const above = plantPlugin('.opencode/plugins/up.ts')
    await expect(llm.listCommands(project)).rejects.toThrow(above)
    fs.rmSync(path.join(base, '.opencode'), { recursive: true })

    fs.writeFileSync(path.join(project, 'opencode.json'), '{"plugin":["some-npm-plugin"]}')
    await expect(llm.listCommands(project)).rejects.toThrow('some-npm-plugin')
    fs.rmSync(path.join(project, 'opencode.json'))

    const app = plantPlugin('config/plugin/l.js')
    await expect(llm.listCommands(project)).rejects.toThrow(app)
    expect(requests).toEqual([])
  })
})

describe('깨끗한 폴더', () => {
  it('그대로 엔진에 간다', async () => {
    const { llm } = await start()
    expect(await llm.listCommands(project)).toEqual([expect.objectContaining({ name: 'c' })])
    expect(await llm.mcpStatus(project)).toEqual({})
    expect((await llm.history(project, 'ses_1')).error).toBeUndefined()
    expect(requests.length).toBeGreaterThan(0)
    expect(requests.every((request) => request.includes(encodeURIComponent(project)) || request.includes('/api/session/ses_1/message'))).toBe(true)
  })

  it('검사는 매 호출 — 통과한 뒤 생긴 파일도 다음 호출에서 걸리고, 치우면 다시 된다 (캐시 없음)', async () => {
    const { llm } = await start()
    await llm.listCommands(project)
    const before = requests.length
    const file = plantPlugin()
    await expect(llm.listCommands(project)).rejects.toThrow(file)
    expect((await llm.chat('p', 'm', project, 'hi')).error).toContain(file)
    expect(requests.length).toBe(before)
    fs.rmSync(file)
    await llm.listCommands(project)
    expect(requests.length).toBeGreaterThan(before)
  })

  it('없는 폴더는 지금처럼 폴더 없음', async () => {
    const { llm } = await start()
    expect(await llm.history(path.join(base, 'gone'), 'ses_1')).toEqual({ messages: [], missingFolder: true })
    expect(requests).toEqual([])
  })
})
