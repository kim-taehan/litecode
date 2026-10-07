import { Context, Service } from 'cordis'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BUNDLE_FILES, ReportService, reportStamp, scrubSecrets, type ReportHost } from '../../src/services/report.ts'
import { trajectoryRecords } from '../../src/services/trajectory.ts'
import type { EngineMessage } from '../../src/services/llm.ts'
import type { Conversation } from '../../src/services/sessions.ts'
import type { ProviderConfig } from '../../src/services/providers.ts'

// 대화 내보내기 · 문제 신고 묶음 (ctx.report, 이슈 #177). 밖으로 보내지 않고 사용자가 고른 자리에 파일로만 쓴다.
// 대화상자·폴더 열기는 host(여기선 기록하는 가짜), 엔진·목록·설정은 가짜 서비스. **묶음에 비밀이 없다**는 것을 가짜 키를 심어 두고 grep 으로 본다.

// ── 심어 둘 비밀 (묶음 어디에도 나오면 안 된다)
const SK_KEY = 'sk-live-FAKEKEY1234567890abcdef'
const PLAIN_KEY = 'plainProviderKey987' // 모양으로는 못 알아보는 provider 키
const URL_PASSWORD = 'hunter2pass'
const URL_TOKEN = 'qtok98765432'
const BEARER = 'abcdefghijklmnop.qrstu'
const MCP_HEADER = 'mcp-header-SECRET-42' // 모양으로는 못 알아보는 MCP 헤더 값
const MCP_ENV = 'envValueXYZ123' // 모양으로는 못 알아보는 MCP env 값
const ENGINE_PASSWORD = 'Zm9vYmFyYmF6cXV4'
const CHAT_TEXT = 'chat-content-should-not-be-in-bundle'
const PLANTED = [SK_KEY, PLAIN_KEY, URL_PASSWORD, URL_TOKEN, BEARER, MCP_HEADER, MCP_ENV, ENGINE_PASSWORD, CHAT_TEXT]

let tmp: string
let project: string
let logFile: string

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'litecode-report-unit-')))
  project = path.join(tmp, 'proj')
  fs.mkdirSync(project)
  fs.mkdirSync(path.join(tmp, 'logs'))
  logFile = path.join(tmp, 'logs', 'main.log')
})
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

const S = 'ses_1'
const RAW: EngineMessage[] = [
  { info: { id: 'u1', sessionID: S, role: 'user', time: { created: 1000 } }, parts: [{ type: 'text', id: 'u1:t', messageID: 'u1', text: 'list files' }] },
  {
    info: { id: 'a1', sessionID: S, role: 'assistant', parentID: 'u1', time: { created: 1010, completed: 1200 } },
    parts: [
      { type: 'step-start', id: 'a1:s' },
      { type: 'tool', id: 'a1:tool', tool: 'bash', callID: 'c1', state: { status: 'completed', input: { command: 'ls' }, output: 'a.txt', metadata: { exit: 0 }, time: { start: 1050, end: 1090 } } },
      { type: 'text', id: 'a1:t', text: 'one file', time: { start: 1100, end: 1150 } },
    ],
  },
]

class FakeLlm extends Service {
  reads: string[] = []
  fail?: Error
  constructor(ctx: Context) {
    super(ctx, 'llm')
  }
  async readMessages(workdir: string, sessionId: string): Promise<EngineMessage[]> {
    this.reads.push(`${workdir} ${sessionId}`)
    if (this.fail) throw this.fail
    return RAW
  }
  async readSubtasks(): Promise<Map<string, EngineMessage[]>> {
    return new Map()
  }
  mcpTool() {
    return () => undefined
  }
}

class FakeSessions extends Service {
  conversations: Conversation[] = []
  constructor(ctx: Context) {
    super(ctx, 'sessions')
  }
  async list(): Promise<Conversation[]> {
    return this.conversations
  }
}

class FakeSettings extends Service {
  constructor(ctx: Context) {
    super(ctx, 'settings')
  }
  get() {
    return { language: 'ko' }
  }
}

class FakeFeatures extends Service {
  constructor(ctx: Context) {
    super(ctx, 'features')
  }
  enabled() {
    return ['at', 'slash', 'mcp', 'trajectory']
  }
}

const PROVIDERS: ProviderConfig[] = [
  { id: 'gw', displayName: 'Gateway', baseURL: `http://admin:${URL_PASSWORD}@gw.local:8080/v1?token=${URL_TOKEN}`, protocol: 'openai-chat-completions', models: [{ id: 'qwen', displayName: 'Qwen' }] },
  { id: 'plain', displayName: 'Plain', baseURL: 'http://10.0.0.5/v1', protocol: 'openai-chat-completions', models: [] },
]
const KEYS: Record<string, string> = { gw: SK_KEY, plain: PLAIN_KEY }

class FakeProviders extends Service {
  constructor(ctx: Context) {
    super(ctx, 'providers')
  }
  all() {
    return PROVIDERS
  }
  apiKey(id: string) {
    return KEYS[id]
  }
}

class FakeEngine extends Service {
  constructor(ctx: Context) {
    super(ctx, 'engine')
  }
  async version() {
    return '1.18.18'
  }
  outputTail() {
    return `opencode server listening\nOPENCODE_SERVER_PASSWORD=${ENGINE_PASSWORD}\nprovider key ${PLAIN_KEY} echoed\n`
  }
}

class FakeMcp extends Service {
  constructor(ctx: Context) {
    super(ctx, 'mcp')
  }
  varValues() {
    return [MCP_HEADER, MCP_ENV]
  }
}

interface HostRecord {
  saveAnswer?: string
  folderAnswer?: string
  asked: string[]
  opened: string[]
}

function recordingHost(record: HostRecord): ReportHost {
  return {
    async chooseSaveFile(defaultName) {
      record.asked.push(`save ${defaultName}`)
      return record.saveAnswer
    },
    async chooseFolder() {
      record.asked.push('folder')
      return record.folderAnswer
    },
    async openFolder(dir) {
      record.opened.push(dir)
    },
  }
}

const NOW = new Date(2026, 9, 7, 13, 42, 5) // 지역 시각 2026-10-07 13:42

async function start(options: { mcp?: boolean } = {}) {
  const record: HostRecord = { asked: [], opened: [] }
  const ctx = new Context()
  ctx.plugin(FakeLlm)
  ctx.plugin(FakeSessions)
  ctx.plugin(FakeSettings)
  ctx.plugin(FakeFeatures)
  ctx.plugin(FakeProviders)
  ctx.plugin(FakeEngine)
  if (options.mcp !== false) ctx.plugin(FakeMcp)
  ctx.plugin(ReportService, { host: recordingHost(record), logFile, appVersion: '0.0.1', now: () => NOW })
  const ready = await new Promise<Context>((resolve) => ctx.inject(['report', 'llm', 'sessions'], resolve))
  return { report: ready.report, llm: ready.llm as unknown as FakeLlm, sessions: ready.sessions as unknown as FakeSessions, record }
}

const conversation = (over: Partial<Conversation> = {}): Conversation => ({
  id: 'c1',
  project: '',
  engineSessionId: S,
  title: '로그인 테스트가 깨지는 이유',
  updatedAt: 5000,
  model: { providerId: 'gw', modelId: 'qwen' },
  mode: 'build',
  ...over,
})

describe('reportStamp — 폴더·파일 이름의 시각', () => {
  it('지역 시각 YYYY-MM-DD-HHmm (두 자리 채움)', () => {
    expect(reportStamp(NOW)).toBe('2026-10-07-1342')
    expect(reportStamp(new Date(2026, 0, 2, 3, 4))).toBe('2026-01-02-0304')
  })
})

describe('scrubSecrets — 알려진 값 + 모양으로 가린다', () => {
  it('알려진 비밀 값은 모양과 무관하게 가린다 (JSON 안에 이스케이프된 꼴도)', () => {
    expect(scrubSecrets(`a ${PLAIN_KEY} b`, [PLAIN_KEY])).toBe('a [redacted] b')
    expect(scrubSecrets(JSON.stringify({ v: 'x"y\\zzzz' }), ['x"y\\zzzz'])).toBe('{"v":"[redacted]"}')
  })

  it('짧은 값(6자 미만)은 글을 망가뜨리지 않게 글자 그대로 찾지 않는다 — 모양 그물(redactSecrets)은 그대로 돈다', () => {
    expect(scrubSecrets('true core', ['true', 'core'])).toBe('true core')
    expect(scrubSecrets(`Authorization: Bearer ${BEARER}`, [])).toBe('Authorization: Bearer [redacted]')
  })
})

describe('ReportService.exportConversation — 대화 하나를 JSON 파일 하나로', () => {
  it('저장 위치를 묻고, 엔진 기록을 중립 레코드(Trajectory 모양)로 바꿔 쓴다', async () => {
    const { report, sessions, record, llm } = await start()
    sessions.conversations = [conversation({ project })]
    record.saveAnswer = path.join(tmp, 'out.json')
    expect(await report.exportConversation('c1')).toEqual({ saved: record.saveAnswer })
    expect(record.asked).toEqual(['save litecode-chat-2026-10-07-1342.json'])
    expect(llm.reads).toEqual([`${project} ${S}`])
    const saved = JSON.parse(fs.readFileSync(record.saveAnswer, 'utf8'))
    expect(saved).toEqual({
      format: 'litecode-conversation',
      formatVersion: 1,
      exportedAt: NOW.toISOString(),
      app: { version: '0.0.1' },
      conversation: { id: 'c1', title: '로그인 테스트가 깨지는 이유', project, model: { providerId: 'gw', modelId: 'qwen' }, mode: 'build', updatedAt: 5000 },
      records: trajectoryRecords(RAW, project),
    })
    // 말·도구 호출·결과·시각이 다 있다
    expect(saved.records.map((entry: { kind: string }) => entry.kind)).toEqual(['user', 'assistant', 'tool'])
    expect(saved.records[2]).toMatchObject({ name: 'bash', input: '{"command":"ls"}', result: 'a.txt', start: 1050, end: 1090 })
  })

  it('취소하면 엔진에 묻지도 쓰지도 않는다', async () => {
    const { report, sessions, llm } = await start()
    sessions.conversations = [conversation({ project })]
    expect(await report.exportConversation('c1')).toEqual({ canceled: true })
    expect(llm.reads).toEqual([])
  })

  it('첫 메시지 전(엔진 세션 없음)이면 빈 기록으로 저장한다', async () => {
    const { report, sessions, record, llm } = await start()
    sessions.conversations = [conversation({ project, engineSessionId: undefined })]
    record.saveAnswer = path.join(tmp, 'empty.json')
    await report.exportConversation('c1')
    expect(JSON.parse(fs.readFileSync(record.saveAnswer, 'utf8')).records).toEqual([])
    expect(llm.reads).toEqual([])
  })

  it('없는 대화·없는 폴더·기록 읽기 실패는 사유를 던지고 파일을 만들지 않는다', async () => {
    const { report, sessions, record, llm } = await start()
    record.saveAnswer = path.join(tmp, 'never.json')
    await expect(report.exportConversation('nope')).rejects.toThrow('없는 대화입니다')
    sessions.conversations = [conversation({ project: path.join(tmp, 'gone') })]
    await expect(report.exportConversation('c1')).rejects.toThrow(/작업 디렉터리가 없다/)
    sessions.conversations = [conversation({ project })]
    llm.fail = new Error('HTTP 500')
    await expect(report.exportConversation('c1')).rejects.toThrow('대화 기록을 읽지 못했습니다: HTTP 500')
    expect(fs.existsSync(record.saveAnswer)).toBe(false)
  })
})

describe('ReportService.createBundle — 문제 신고 묶음 (로컬 폴더)', () => {
  function plantLog(): void {
    fs.writeFileSync(
      logFile,
      [
        '2026-10-07T04:00:00.000Z ERROR boot ok',
        `2026-10-07T04:00:01.000Z ERROR [engine] request failed authorization: Bearer ${BEARER}`,
        `2026-10-07T04:00:02.000Z WARN key ${SK_KEY} rejected`,
        `2026-10-07T04:00:03.000Z WARN provider ${PLAIN_KEY} echoed`,
        `2026-10-07T04:00:04.000Z WARN mcp header ${MCP_HEADER} env ${MCP_ENV}`,
        `2026-10-07T04:00:05.000Z WARN url http://admin:${URL_PASSWORD}@gw.local/v1?token=${URL_TOKEN}`,
        '',
      ].join('\n'),
    )
  }

  function bundleText(dir: string): string {
    return fs.readdirSync(dir).map((name) => fs.readFileSync(path.join(dir, name), 'utf8')).join('\n')
  }

  it('고른 폴더 안에 litecode-report-<시각>/ 을 만들고 허용 목록의 파일만 넣는다', async () => {
    plantLog()
    const { report, record } = await start()
    record.folderAnswer = tmp
    const result = await report.createBundle()
    const dir = path.join(tmp, 'litecode-report-2026-10-07-1342')
    expect(result).toEqual({ saved: dir })
    expect(record.asked).toEqual(['folder'])
    expect(fs.readdirSync(dir).sort()).toEqual([...BUNDLE_FILES].sort())
  })

  it('묶음 전체에 sk-·Bearer 값·provider 키·주소 안 비밀번호·MCP 헤더/env 값·엔진 비밀번호·대화 내용이 없다 (심어 두고 grep)', async () => {
    plantLog()
    const { report, record, sessions, llm } = await start()
    sessions.conversations = [conversation({ project, title: CHAT_TEXT })]
    record.folderAnswer = tmp
    const { saved } = (await report.createBundle()) as { saved: string }
    const text = bundleText(saved)
    for (const secret of PLANTED) expect(text, secret).not.toContain(secret)
    expect(text).not.toMatch(/\bsk-[A-Za-z0-9_-]{4,}/)
    expect(text).not.toMatch(/Bearer\s+(?!\[redacted\])\S/)
    expect(llm.reads).toEqual([]) // 대화 내용은 읽지도 않는다
  })

  it('들어가는 것: 앱 버전·OS·켜진 기능·엔진 버전·로그(가린 채)·provider 이름과 주소(키 제외)', async () => {
    plantLog()
    const { report, record } = await start()
    record.folderAnswer = tmp
    const { saved } = (await report.createBundle()) as { saved: string }
    const about = JSON.parse(fs.readFileSync(path.join(saved, 'about.json'), 'utf8'))
    expect(about).toMatchObject({
      createdAt: NOW.toISOString(),
      app: { version: '0.0.1' },
      os: { platform: os.platform(), release: os.release(), arch: os.arch() },
      language: 'ko',
      features: ['at', 'slash', 'mcp', 'trajectory'],
      engine: { name: 'opencode', version: '1.18.18' },
    })
    const providers = JSON.parse(fs.readFileSync(path.join(saved, 'providers.json'), 'utf8'))
    expect(providers).toEqual([
      { id: 'gw', name: 'Gateway', baseURL: 'http://admin:[redacted]@gw.local:8080/v1?token=[redacted]', protocol: 'openai-chat-completions', models: ['qwen'], hasKey: true },
      { id: 'plain', name: 'Plain', baseURL: 'http://10.0.0.5/v1', protocol: 'openai-chat-completions', models: [], hasKey: true },
    ])
    const mainLog = fs.readFileSync(path.join(saved, 'main.log'), 'utf8')
    expect(mainLog).toContain('boot ok')
    expect(mainLog).toContain('Bearer [redacted]')
    expect(fs.readFileSync(path.join(saved, 'engine.log'), 'utf8')).toContain('opencode server listening')
  })

  it('MCP 기능이 꺼져 있어도(ctx.mcp 없음) 묶음은 만든다', async () => {
    const { report, record } = await start({ mcp: false })
    record.folderAnswer = tmp
    expect(await report.createBundle()).toEqual({ saved: path.join(tmp, 'litecode-report-2026-10-07-1342') })
  })

  it('앱 로그가 아직 없으면 main.log 를 빼고 만든다', async () => {
    const { report, record } = await start()
    record.folderAnswer = tmp
    const { saved } = (await report.createBundle()) as { saved: string }
    expect(fs.readdirSync(saved).sort()).toEqual(['about.json', 'engine.log', 'providers.json'])
  })

  it('같은 분에 다시 만들면 뒤에 -2 를 붙인다 (덮어쓰지 않는다)', async () => {
    const { report, record } = await start()
    record.folderAnswer = tmp
    await report.createBundle()
    expect(await report.createBundle()).toEqual({ saved: path.join(tmp, 'litecode-report-2026-10-07-1342-2') })
  })

  it('취소하면 아무것도 만들지 않는다', async () => {
    const { report } = await start()
    expect(await report.createBundle()).toEqual({ canceled: true })
    expect(fs.readdirSync(tmp).sort()).toEqual(['logs', 'proj'])
  })
})

describe('ReportService.openBundle — 이 실행에서 만든 묶음 폴더만 연다', () => {
  it('만든 폴더는 host 로 열고, 다른 경로는 거절한다', async () => {
    const { report, record } = await start()
    record.folderAnswer = tmp
    const { saved } = (await report.createBundle()) as { saved: string }
    await report.openBundle(saved)
    expect(record.opened).toEqual([saved])
    await expect(report.openBundle(project)).rejects.toThrow()
    await expect(report.openBundle('/Applications/Calculator.app')).rejects.toThrow()
    expect(record.opened).toEqual([saved])
  })
})
