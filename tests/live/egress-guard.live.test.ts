import { Context } from 'cordis'
import fs from 'node:fs/promises'
import http from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import { ProviderRegistry } from '../../src/services/providers.ts'
import { LlmService } from '../../src/services/llm.ts'
import { EngineService, type EngineConnection } from '../../src/services/engine.ts'
import { engineOptions, isolatedEnv, opencodeBin } from './support/opencodeServer.ts'

// 망 지킴이 (이슈 #19, 01x 권장 B·E) — 엔진이 띄운 opencode 가 한 턴(신규 세대·레거시) 동안 밖으로 나가려는 요청이 0 인지 본다.
// 1.18.18 을 올리거나 엔진 설정을 바꿀 때 새 외부 호출을 잡는다.
// - 망: opencode 자식 env 의 HTTP(S)_PROXY·ALL_PROXY 를 127.0.0.1 기록 프록시로 둔다. 프록시는 요청 첫 줄(CONNECT host:port / GET url)만
//   적고 502 로 끊는다 — 밖으로는 한 바이트도 안 나간다. 프록시를 무시하는 직접 연결은 macOS 에서 sandbox-exec 가 막는다(셀 수는 없다 — 01x 와 같은 한계)
// - 사용자 설정 흉내: 임시 HOME 의 ~/.config/opencode/opencode.json 에 enabled_providers:["other"]·share:"auto"·lsp:true·formatter:true
//   (레거시가 읽는다, 01x 2-5), ~/.claude/CLAUDE.md·~/.claude/skills·~/.agents/skills 표식, 그리고 개발 셸처럼 물려받은
//   OPENCODE_EXPERIMENTAL·OPENCODE_AUTO_SHARE·OTEL_EXPORTER_OTLP_ENDPOINT — 엔진이 지워야 한다
// 이 테스트는 실제 ~/.config/opencode·~/.claude 를 읽지도 쓰지도 않는다.

const MARKERS = ['MARK_HOME_CLAUDE_MD', 'MARK_HOME_CLAUDE_SKILL', 'MARK_HOME_AGENTS_SKILL']
const SANDBOX = '(version 1)(allow default)(deny network-outbound)(allow network-outbound (remote ip "localhost:*"))(allow network-outbound (remote unix-socket))'

let root: string
let home: string
let work: string
let proxy: http.Server
const egress: string[] = []
let services: Context
const fibers: { dispose(): Promise<void> }[] = []

const fakeBaseURL = () => `${inject('fakeLlmUrl')}/v1`
const fakeLlm = async () =>
  (await (await fetch(`${inject('fakeLlmUrl')}/requests`)).json()) as { count: number; chatModels: string[]; lastChat?: { tools: string[] }; lastChatText: string }

/** 엔진이 띄울 opencode — macOS 면 localhost 밖 연결을 막는 sandbox 안에서 (exec 라 PID 는 opencode 그대로) */
async function guardedBinary(): Promise<string> {
  if (process.platform !== 'darwin') return opencodeBin()
  const wrapper = path.join(root, 'opencode-sandboxed')
  await fs.writeFile(wrapper, `#!/bin/sh\nexec sandbox-exec -p '${SANDBOX}' ${JSON.stringify(opencodeBin())} "$@"\n`, { mode: 0o755 })
  return wrapper
}

/** 레거시 경로 한 턴 — 세션 생성 → POST /session/{id}/message(턴이 끝나야 200, 01w 1절) */
async function legacyTurn(conn: Pick<EngineConnection, 'url' | 'headers'>, text: string): Promise<string> {
  const q = `?directory=${encodeURIComponent(work)}`
  const json = { ...conn.headers, 'content-type': 'application/json' }
  const created = await fetch(`${conn.url}/session${q}`, { method: 'POST', headers: json, body: JSON.stringify({ title: 'egress' }) })
  expect(created.status).toBe(200)
  const { id } = (await created.json()) as { id: string }
  const res = await fetch(`${conn.url}/session/${id}/message${q}`, {
    method: 'POST',
    headers: json,
    body: JSON.stringify({ model: { providerID: 'egress', modelID: 'echo' }, agent: 'litecode-full', parts: [{ type: 'text', text }] }),
    // LSP 가 켜져 있으면 write 한 번에 npm 설치를 3번 시도한다(거부 망 ~72초, 01x 2-6) — 그보다 짧게 끊어 빨강으로 보이게
    signal: AbortSignal.timeout(40_000),
  })
  expect(res.status).toBe(200)
  const { info, parts } = (await res.json()) as { info: { error?: unknown }; parts: { type: string; text?: string }[] }
  expect(info.error).toBeUndefined()
  return parts.filter((part) => part.type === 'text').map((part) => part.text).join('')
}

beforeAll(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'litecode-egress-')))
  home = path.join(root, 'home')
  work = path.join(root, 'work')
  await fs.mkdir(work)
  const skill = (name: string, mark: string) => `---\nname: ${name}\ndescription: ${mark} skill\n---\nbody\n`
  const files: Record<string, string> = {
    '.config/opencode/opencode.json': JSON.stringify({ enabled_providers: ['other'], share: 'auto', lsp: true, formatter: true }),
    '.claude/CLAUDE.md': MARKERS[0]!,
    '.claude/skills/home-claude/SKILL.md': skill('home-claude', MARKERS[1]!),
    '.agents/skills/home-agents/SKILL.md': skill('home-agents', MARKERS[2]!),
  }
  for (const [name, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(home, name)), { recursive: true })
    await fs.writeFile(path.join(home, name), content)
  }

  proxy = http.createServer((req, res) => {
    egress.push(`${req.method} ${req.url}`)
    res.writeHead(502).end()
  })
  proxy.on('connect', (req: http.IncomingMessage, socket: Socket) => {
    egress.push(`CONNECT ${req.url}`)
    socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n')
  })
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve))
  const via = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`

  const env: NodeJS.ProcessEnv = {
    ...isolatedEnv(root),
    HOME: home,
    OPENCODE_BIN: await guardedBinary(),
    ...Object.fromEntries(['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy'].map((name) => [name, via])),
    NO_PROXY: '127.0.0.1,localhost',
    no_proxy: '127.0.0.1,localhost',
    // 개발 셸에서 물려받을 수 있는 것 — 엔진이 지우지 않으면 exa 검색·lsp 도구·자동 공유·trace 내보내기가 켜진다 (01x 7·표 20)
    OPENCODE_EXPERIMENTAL: '1',
    OPENCODE_AUTO_SHARE: '1',
    OTEL_EXPORTER_OTLP_ENDPOINT: 'http://otel.example.invalid:4318',
  }
  delete env['XDG_CONFIG_HOME'] // 사용자 전역 설정을 Finder 실행처럼 ~/.config/opencode 에서 읽게

  const ctx = new Context()
  fibers.push(ctx.plugin(ProviderRegistry, { defaults: [] }))
  fibers.push(ctx.plugin(EngineService, { ...engineOptions(path.join(root, 'state')), env }))
  fibers.push(ctx.plugin(LlmService))
  services = await new Promise<Context>((resolve) => ctx.inject(['providers', 'engine', 'llm'], (ready) => resolve(ready)))
  services.providers.save({ displayName: 'Egress', baseURL: fakeBaseURL(), protocol: 'openai-chat-completions', models: [{ id: 'echo', displayName: 'Echo' }] })
})

afterAll(async () => {
  for (const fiber of fibers.reverse()) await fiber.dispose()
  await new Promise((resolve) => proxy?.close(resolve))
  if (root) await fs.rm(root, { recursive: true, force: true })
})

describe('엔진 기본값 — 사용자 설정이 켜 둔 것이 있어도 밖으로 안 나간다 (#19)', () => {
  it('신규 세대 한 턴이 우리 provider 로 되고, Claude Code 자료가 실리지 않는다', async () => {
    expect(await services.llm.chat({ providerId: 'egress', modelId: 'echo', directory: work, prompt: '신규 세대 턴' })).toMatchObject({ ok: true, text: 'echo: 신규 세대 턴' })
    const sent = (await fakeLlm()).lastChatText
    for (const marker of MARKERS) expect(sent, marker).not.toContain(marker)
  })

  // 사용자 전역 enabled_providers:["other"] 면 레거시 턴은 Model not found 다(01x 4). share auto 면 opncd.ai, lsp true 면 write 때 npm
  it('레거시 한 턴(파일 쓰기 포함)이 우리 provider 로 되고, Claude Code 자료·실험 도구가 실리지 않는다', async () => {
    const conn = await services.engine.connection()
    const file = path.join(work, 'hello.sh')
    const text = await legacyTurn(conn, `[call:write ${JSON.stringify({ filePath: file, content: 'echo hi\n' })}]`)
    expect(text).toMatch(/^tool: /)
    expect(await fs.readFile(file, 'utf8')).toBe('echo hi\n') // 포매터가 손대지 않았다

    const { lastChat, lastChatText } = await fakeLlm()
    for (const marker of MARKERS) expect(lastChatText, marker).not.toContain(marker)
    expect(lastChat?.tools).toContain('write')
    expect(lastChat?.tools).not.toContain('websearch') // 레거시 websearch 는 OPENCODE_EXPERIMENTAL 일 때만 실린다 (01x 2-1)
    expect(lastChat?.tools).not.toContain('lsp')
  })

  // 모델 없이 만든 세션은 내장 opencode Zen(opencode.ai)으로 간다 — 엔진 opencode.json 의 model 이 막는다 (01x 2-4)
  it('모델 없이 만든 신규 세대 세션도 앱 provider 의 모델로 프롬프트를 보낸다', async () => {
    const conn = await services.engine.connection()
    const json = { ...conn.headers, 'content-type': 'application/json' }
    const created = await fetch(`${conn.url}/api/session`, { method: 'POST', headers: json, body: JSON.stringify({ location: { directory: work } }) })
    expect(created.status).toBe(200)
    const { id } = ((await created.json()) as { data: { id: string } }).data
    const before = (await fakeLlm()).count
    // 모델은 세션 생성 응답에 없고 프롬프트 때 정해진다 — 가짜 LLM 이 그 요청을 받았는지로 본다(Zen 이면 opencode.ai 로 가 기록 프록시에 남는다)
    expect((await fetch(`${conn.url}/api/session/${id}/prompt`, { method: 'POST', headers: json, body: JSON.stringify({ prompt: { text: '모델 없음' } }) })).status).toBe(200)
    await expect.poll(async () => (await fakeLlm()).count, { timeout: 15_000 }).toBeGreaterThan(before)
    expect((await fakeLlm()).chatModels.at(-1)).toBe('echo')
  })

  it('그동안 기록 프록시에 온 바깥 요청이 0 이다 (share 는 백그라운드라 조금 더 본다)', async () => {
    await new Promise((resolve) => setTimeout(resolve, 3_000))
    expect(egress).toEqual([])
  })
})
