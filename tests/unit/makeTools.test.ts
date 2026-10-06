import { Context, Service } from 'cordis'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HooksService } from '../../src/services/hooks.ts'
import { McpService } from '../../src/services/mcp.ts'
import { SkillsService } from '../../src/services/skills.ts'
import type { AppMcpTool } from '../../src/services/appMcp/rpc.ts'
import { MakeTools } from '../../src/services/appMcp/tools/make.ts'
import type { EngineSkill, PreTool, PreToolDecision } from '../../src/services/llm.ts'
import type { ToolCaller } from '../../src/services/toolCalls.ts'
import { setMainLanguage } from '../../src/i18n.ts'
import { attentionTarget } from '../../shared/delegation.ts'
import { HOOK_TOOL, hookRequest, maskMcpArgs, MCP_TOOL, mcpRequest, SECRET_MASK, SKILL_TOOL, skillRequest } from '../../shared/make.ts'
import type { AttentionTarget } from '../../shared/contract.ts'

// 만들기 도구 셋 (이슈 #145) — create_skill·add_mcp_server·add_hook. ctx.skills·ctx.mcp·ctx.hooks 는 진짜다(임시 폴더·임시 파일),
// ctx.llm 은 가짜: callerOf 는 시험이 정한 "부른 대화"(승인 여부·카드에서 고른 저장할 곳)를 준다 (진짜 찾기·승인 기록은 toolCalls·turnEvents 시험).
// ctx.appMcp 는 등록된 도구를 모으기만 한다

class FakeLlm extends Service {
  skills: EngineSkill[] = []
  caller: ToolCaller | undefined
  asked: { directory: string; tool: string }[] = []
  reloads = 0
  constructor(ctx: Context) {
    super(ctx, 'llm')
  }
  async listSkills(): Promise<EngineSkill[]> {
    return this.skills
  }
  async callerOf(directory: string, ref: { server: string; tool: string }): Promise<ToolCaller | undefined> {
    this.asked.push({ directory, tool: ref.tool })
    return this.caller
  }
  reloadWhenIdle(): void {
    this.reloads++
  }
  gateTools(): void {}
  async mcpStatus(): Promise<Record<string, never>> {
    return {}
  }
}
class FakeChat extends Service {
  constructor(ctx: Context) {
    super(ctx, 'chat')
  }
}
class FakeSessions extends Service {
  constructor(ctx: Context) {
    super(ctx, 'sessions')
  }
  async list(): Promise<never[]> {
    return []
  }
}
class FakeAppMcp extends Service {
  tools = new Map<string, AppMcpTool>()
  constructor(ctx: Context) {
    super(ctx, 'appMcp')
  }
  register(tool: AppMcpTool): () => void {
    this.tools.set(tool.name, tool)
    return () => void this.tools.delete(tool.name)
  }
}

const reversing = {
  available: () => true,
  encrypt: (plain: string) => Buffer.from([...plain].reverse().join('')),
  decrypt: (sealed: Buffer) => [...sealed.toString()].reverse().join(''),
}

let root: string
let project: string
let appSkills: string
let userData: string

beforeEach(async () => {
  setMainLanguage('en')
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'litecode-make-')))
  project = path.join(root, 'shop-web')
  appSkills = path.join(root, 'app', 'skills')
  userData = path.join(root, 'userData')
  await fs.mkdir(project)
  await fs.mkdir(userData)
})

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 })
})

const approvedBy = (scope: 'project' | 'all' | undefined, patch: Partial<ToolCaller> = {}): ToolCaller => ({
  sessionId: 'ses_1',
  callId: 'call_1',
  child: false,
  approved: true,
  ...(scope && { target: { kind: 'scope', scope } as AttentionTarget }),
  ...patch,
})

async function start(opts: { hooks?: boolean } = {}) {
  const ctx = new Context()
  ctx.plugin(FakeLlm)
  ctx.plugin(FakeChat)
  ctx.plugin(FakeSessions)
  ctx.plugin(FakeAppMcp)
  ctx.plugin(SkillsService, { appDir: appSkills })
  ctx.plugin(McpService, {
    file: path.join(userData, 'mcp.json'),
    secretsFile: path.join(userData, 'mcp-secrets.json'),
    projectsFile: path.join(userData, 'mcp-projects.json'),
    cipher: reversing,
    env: { HOME: path.join(root, 'home'), XDG_CONFIG_HOME: path.join(root, 'xdg') },
    fallbackCwd: root,
  })
  if (opts.hooks !== false) ctx.plugin(HooksService, { file: path.join(userData, 'hooks.json'), projectsFile: path.join(userData, 'hooks-projects.json') })
  ctx.plugin(MakeTools)
  const ready = await new Promise<Context>((resolve) => ctx.inject(['appMcp', 'llm', 'skills', 'mcp'], resolve))
  await new Promise((resolve) => setTimeout(resolve, 0))
  const llm = ready.llm as unknown as FakeLlm
  const tools = (ready.appMcp as unknown as FakeAppMcp).tools
  const run = (tool: string, args: Record<string, unknown>): Promise<string> => tools.get(tool)!.run(args, { directory: project })
  const preTool = (tool: string, input: unknown, child = false): Promise<PreToolDecision | undefined> =>
    Promise.resolve(ctx.serial('llm/pre-tool', { sessionId: 'ses_1', directory: project, tool, input, child, signal: new AbortController().signal } satisfies PreTool))
  return { ctx, llm, tools, run, preTool }
}

const readJson = async (file: string): Promise<unknown> => JSON.parse(await fs.readFile(file, 'utf8'))
const exists = (file: string): Promise<boolean> => fs.access(file).then(() => true, () => false)

const SKILL = { name: 'pr-check', description: 'Checks before opening a PR.', body: '1. run typecheck\n2. run tests' }
const REMOTE = { name: 'wiki', type: 'remote', url: 'http://wiki-mcp.internal/mcp' }
const LOCAL = { name: 'files', type: 'local', command: ['npx', '-y', 'files-mcp'], env: { ROOT: '/data' } }
const HOOK = { event: 'PostToolUse', matcher: 'edit|write', command: 'npm run format' }

describe('만들기 도구 셋 — 등록', () => {
  it('셋이 도구 목록에 있고, 설명이 "직접 파일을 만들지 말고 이 도구를 써라 · 사용자가 승인한다" 를 말한다', async () => {
    const { tools } = await start()
    for (const name of [SKILL_TOOL, MCP_TOOL, HOOK_TOOL]) {
      const tool = tools.get(name)
      expect(tool, name).toBeDefined()
      expect(tool!.description, name).toContain('Use this instead of writing files under `.claude/` or `.opencode/` yourself — the app decides where it is saved. The user must approve.')
    }
  })

  it('훅 기능이 꺼져 있어도 셋 다 등록된다 — add_hook 은 부르면 "꺼져 있다" 를 돌려준다', async () => {
    const { tools } = await start({ hooks: false })
    expect([...tools.keys()].sort()).toEqual([HOOK_TOOL, MCP_TOOL, SKILL_TOOL].sort())
  })
})

describe('create_skill', () => {
  it('승인 → <프로젝트>/.opencode/skills/<이름>/SKILL.md 에 앱이 쓴 frontmatter + 본문, 엔진 다시 읽기를 턴 뒤로 예약, 결과 글이 자리를 말한다', async () => {
    const { llm, run } = await start()
    llm.caller = approvedBy('project')
    const result = await run(SKILL_TOOL, SKILL)
    const file = path.join(project, '.opencode', 'skills', 'pr-check', 'SKILL.md')
    expect(await fs.readFile(file, 'utf8')).toBe('---\nname: pr-check\ndescription: "Checks before opening a PR."\n---\n\n1. run typecheck\n2. run tests\n')
    expect(result).toContain(file)
    expect(result).toContain('this project only')
    expect(llm.reloads).toBe(1)
    expect(llm.asked).toEqual([{ directory: project, tool: SKILL_TOOL }])
  })

  it('카드에서 저장할 곳을 "모든 프로젝트" 로 바꾸면 앱 스킬 폴더에 생기고, 결과 글이 바뀐 자리를 말한다', async () => {
    const { llm, run } = await start()
    llm.caller = approvedBy('all')
    const result = await run(SKILL_TOOL, { ...SKILL, scope: 'project' })
    const file = path.join(appSkills, 'pr-check', 'SKILL.md')
    expect(await exists(file)).toBe(true)
    expect(await exists(path.join(project, '.opencode'))).toBe(false)
    expect(result).toContain('The user changed where it is saved')
    expect(result).toContain('all projects')
    expect(result).toContain(file)
  })

  it('거절(허용 기록 없음)·부른 대화를 못 찾음·하위 작업 → 오류, 아무것도 안 생긴다', async () => {
    const { llm, run } = await start()
    llm.caller = approvedBy('project', { approved: false })
    await expect(run(SKILL_TOOL, SKILL)).rejects.toThrow(/not approved/)
    llm.caller = undefined
    await expect(run(SKILL_TOOL, SKILL)).rejects.toThrow(/Could not tell/)
    llm.caller = approvedBy('project', { child: true })
    await expect(run(SKILL_TOOL, SKILL)).rejects.toThrow(/Sub-tasks/)
    expect(await exists(path.join(project, '.opencode'))).toBe(false)
    expect(llm.reloads).toBe(0)
  })

  it('저장할 곳 없이 온 허용(내용을 못 그리는 화면 — 폰·보통의 승인 카드)은 받지 않는다', async () => {
    const { llm, run } = await start()
    llm.caller = approvedBy(undefined)
    await expect(run(SKILL_TOOL, SKILL)).rejects.toThrow(/desktop/)
    expect(await exists(path.join(project, '.opencode'))).toBe(false)
  })

  it('이름 형식이 틀리면 부른 대화를 찾기도 전에 오류 (승인을 쓰지 않는다)', async () => {
    const { llm, run } = await start()
    llm.caller = approvedBy('project')
    for (const name of ['PR Check', '../evil', 'a_b', '-x', 'x-', '']) await expect(run(SKILL_TOOL, { ...SKILL, name }), name).rejects.toThrow(/name/)
    await expect(run(SKILL_TOOL, { ...SKILL, body: '---\nname: x\n---\nhi' })).rejects.toThrow(/frontmatter/)
    await expect(run(SKILL_TOOL, { ...SKILL, scope: 'everywhere' })).rejects.toThrow(/scope/)
    expect(llm.asked).toEqual([])
  })

  it('같은 이름이 이미 있으면(엔진 목록 · 그 자리의 파일) 덮어쓰지 않고 오류', async () => {
    const { llm, run } = await start()
    llm.caller = approvedBy('project')
    llm.skills = [{ name: 'pr-check', description: 'old', location: path.join(root, 'home', '.claude', 'skills', 'pr-check', 'SKILL.md'), content: '' }]
    await expect(run(SKILL_TOOL, SKILL)).rejects.toThrow(/already exists/)
    llm.skills = []
    const file = path.join(project, '.opencode', 'skills', 'pr-check', 'SKILL.md')
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, 'MINE')
    await expect(run(SKILL_TOOL, SKILL)).rejects.toThrow(/already exists/)
    expect(await fs.readFile(file, 'utf8')).toBe('MINE')
  })

  it('프로젝트의 .opencode 가 폴더 밖을 가리키는 링크면 쓰지 않는다', async () => {
    const { llm, run } = await start()
    const outside = path.join(root, 'outside')
    await fs.mkdir(outside)
    await fs.symlink(outside, path.join(project, '.opencode'))
    llm.caller = approvedBy('project')
    await expect(run(SKILL_TOOL, SKILL)).rejects.toThrow(/outside/)
    expect(await fs.readdir(outside)).toEqual([])
  })
})

describe('add_mcp_server', () => {
  it('이 프로젝트만(비밀 없음) → .mcp.json 에 Claude Code 모양으로 — 있던 서버·다른 열쇠는 그대로', async () => {
    const { llm, run } = await start()
    const file = path.join(project, '.mcp.json')
    await fs.writeFile(file, JSON.stringify({ mcpServers: { old: { command: 'old-mcp', args: ['--x'] } }, other: 1 }))
    llm.caller = approvedBy('project')
    const result = await run(MCP_TOOL, LOCAL)
    expect(await readJson(file)).toEqual({
      mcpServers: { old: { command: 'old-mcp', args: ['--x'] }, files: { command: 'npx', args: ['-y', 'files-mcp'], env: { ROOT: '/data' } } },
      other: 1,
    })
    expect(result).toContain(file)
    expect(result).toContain('next turn')
    expect(await exists(path.join(userData, 'mcp.json'))).toBe(false)
  })

  it('.mcp.json 이 없으면 만든다 — 원격(헤더 없음)은 type http', async () => {
    const { llm, run } = await start()
    llm.caller = approvedBy('project')
    await run(MCP_TOOL, REMOTE)
    expect(await readJson(path.join(project, '.mcp.json'))).toEqual({ mcpServers: { wiki: { type: 'http', url: 'http://wiki-mcp.internal/mcp' } } })
  })

  it('깨진 .mcp.json 은 덮어쓰지 않고 오류 (승인을 쓰기 전에)', async () => {
    const { llm, run } = await start()
    const file = path.join(project, '.mcp.json')
    await fs.writeFile(file, '{ "mcpServers": ')
    llm.caller = approvedBy('project')
    await expect(run(MCP_TOOL, LOCAL)).rejects.toThrow(/\.mcp\.json/)
    expect(await fs.readFile(file, 'utf8')).toBe('{ "mcpServers": ')
    expect(llm.asked).toEqual([])
  })

  it('.mcp.json 이 폴더 밖을 가리키는 링크면 쓰지 않는다', async () => {
    const { llm, run } = await start()
    const outside = path.join(root, 'outside.json')
    await fs.writeFile(outside, '{}')
    await fs.symlink(outside, path.join(project, '.mcp.json'))
    llm.caller = approvedBy('project')
    await expect(run(MCP_TOOL, LOCAL)).rejects.toThrow(/outside/)
    expect(await fs.readFile(outside, 'utf8')).toBe('{}')
  })

  it('모든 프로젝트 → 앱 MCP 목록에, 비밀 헤더 값은 safeStorage 길로 (정의 파일·결과 글에 값이 없다)', async () => {
    const { llm, run, ctx } = await start()
    llm.caller = approvedBy('all')
    const result = await run(MCP_TOOL, { ...REMOTE, headers: { Authorization: 'Bearer s3cret-token' }, scope: 'all' })
    expect(await readJson(path.join(userData, 'mcp.json'))).toEqual([
      { name: 'wiki', type: 'remote', url: 'http://wiki-mcp.internal/mcp', vars: [{ name: 'Authorization', secret: true }], enabled: true },
    ])
    expect(await fs.readFile(path.join(userData, 'mcp-secrets.json'), 'utf8')).not.toContain('s3cret-token')
    expect(await readJson(path.join(userData, 'mcp-secrets.json'))).toHaveProperty('wiki.Authorization')
    expect(result).not.toContain('s3cret-token')
    expect(result).toContain('all projects')
    expect(await exists(path.join(project, '.mcp.json'))).toBe(false)
    expect((await ctx.mcp.list()).map((server) => server.name)).toEqual(['wiki'])
  })

  it('이 프로젝트만 + 비밀 값 → 프로젝트 파일에 적지 않고 앱 안의 그 프로젝트 전용 목록에 (비밀은 safeStorage)', async () => {
    const { llm, run } = await start()
    llm.caller = approvedBy('project')
    const result = await run(MCP_TOOL, { ...LOCAL, env: { ROOT: '/data', API_TOKEN: 'tok-123', PAT: 'pat-456' }, secret_names: ['PAT'] })
    expect(await exists(path.join(project, '.mcp.json'))).toBe(false)
    const projects = (await readJson(path.join(userData, 'mcp-projects.json'))) as Record<string, { servers: unknown[] }>
    expect(projects[project]!.servers).toEqual([
      {
        name: 'files',
        type: 'local',
        command: ['npx', '-y', 'files-mcp'],
        vars: [{ name: 'ROOT', value: '/data', secret: false }, { name: 'API_TOKEN', secret: true }, { name: 'PAT', secret: true }],
        enabled: true,
      },
    ])
    for (const file of ['mcp-projects.json', 'mcp-secrets.json']) {
      const text = await fs.readFile(path.join(userData, file), 'utf8')
      expect(text).not.toContain('tok-123')
      expect(text).not.toContain('pat-456')
    }
    expect(result).not.toMatch(/tok-123|pat-456/)
    expect(result).toContain('not written to .mcp.json')
  })

  it('예약 이름(litecode)·이미 있는 이름(앱 목록 · 폴더 정의)·틀린 이름은 오류, 승인을 쓰지 않는다', async () => {
    const { llm, run, ctx } = await start()
    llm.caller = approvedBy('project')
    await expect(run(MCP_TOOL, { ...REMOTE, name: 'litecode' })).rejects.toThrow(/litecode/)
    // 브라우저 기능이 꺼져 있어도(내장 서버가 안 떠 있어도) 그 이름은 예약이다 — 받아 두면 영영 못 붙는 서버가 된다
    await expect(run(MCP_TOOL, { ...REMOTE, name: 'chrome' })).rejects.toThrow(/chrome/)
    await expect(run(MCP_TOOL, { ...REMOTE, name: 'bad name!' })).rejects.toThrow()
    ctx.mcp.save({ name: 'wiki', type: 'remote', url: 'http://a.internal/mcp', vars: [] })
    await expect(run(MCP_TOOL, REMOTE)).rejects.toThrow(/wiki/)
    await fs.writeFile(path.join(project, '.mcp.json'), JSON.stringify({ mcpServers: { files: { command: 'x' } } }))
    await expect(run(MCP_TOOL, LOCAL)).rejects.toThrow(/files/)
    await expect(run(MCP_TOOL, { ...LOCAL, name: 'x', command: [] })).rejects.toThrow(/command/)
    await expect(run(MCP_TOOL, { name: 'x', type: 'remote', url: 'ftp://x' })).rejects.toThrow()
    expect(llm.asked).toEqual([])
  })

  it('거절이면 어디에도 안 생긴다', async () => {
    const { llm, run } = await start()
    llm.caller = approvedBy('project', { approved: false })
    await expect(run(MCP_TOOL, LOCAL)).rejects.toThrow(/not approved/)
    expect(await exists(path.join(project, '.mcp.json'))).toBe(false)
    expect(await exists(path.join(userData, 'mcp.json'))).toBe(false)
  })
})

describe('add_hook', () => {
  it('승인 → 이 프로젝트만이면 hooks-projects.json 의 그 프로젝트에, 모든 프로젝트면 hooks.json 에 (프로젝트 폴더에는 아무것도 안 쓴다)', async () => {
    const { llm, run, ctx } = await start()
    llm.caller = approvedBy('project')
    const result = await run(HOOK_TOOL, HOOK)
    expect(result).toContain('this project only')
    expect(await ctx.hooks.list(project)).toMatchObject([{ event: 'PostToolUse', matcher: 'edit|write', command: 'npm run format', scope: 'project', on: true }])
    expect(await ctx.hooks.list()).toEqual([]) // 모든 프로젝트 묶음에는 없다

    llm.caller = approvedBy('all')
    const moved = await run(HOOK_TOOL, { event: 'Stop', command: 'say done', matcher: 'ignored', scope: 'project' })
    expect(moved).toContain('The user changed where it is saved')
    expect(await ctx.hooks.list()).toMatchObject([{ event: 'Stop', matcher: '', command: 'say done', scope: 'all' }])
    expect(await fs.readdir(project)).toEqual([])
  })

  it('훅 기능이 꺼져 있으면 "꺼져 있다 — 설정 > 기능에서 켜야 한다" 를 돌려주고 등록하지 않는다. 승인 카드도 뜨지 않는다(실행 전 판정이 막는다)', async () => {
    const { llm, run, preTool } = await start({ hooks: false })
    llm.caller = approvedBy('project')
    await expect(run(HOOK_TOOL, HOOK)).rejects.toThrow(/hooks feature is turned off.*Settings > Features/)
    expect(llm.asked).toEqual([])
    expect(await fs.readdir(userData)).toEqual([])
    expect(await preTool(`litecode_${HOOK_TOOL}`, HOOK)).toEqual({ deny: true, reason: expect.stringMatching(/hooks feature is turned off/) })
  })

  it('지원하지 않는 이벤트·빈 명령·못 읽는 매처는 오류', async () => {
    const { llm, run } = await start()
    llm.caller = approvedBy('project')
    await expect(run(HOOK_TOOL, { ...HOOK, event: 'PreCompact' })).rejects.toThrow(/event/)
    await expect(run(HOOK_TOOL, { ...HOOK, command: '  ' })).rejects.toThrow(/command/)
    await expect(run(HOOK_TOOL, { ...HOOK, matcher: '(' })).rejects.toThrow(/matcher/)
    expect(llm.asked).toEqual([])
  })

  it('거절이면 저장하지 않는다', async () => {
    const { llm, run, ctx } = await start()
    llm.caller = approvedBy('project', { approved: false })
    await expect(run(HOOK_TOOL, HOOK)).rejects.toThrow(/not approved/)
    expect(await ctx.hooks.list(project)).toEqual([])
  })
})

describe('승인 카드 앞에서 — 실행 전 판정과 카드에 가는 인자', () => {
  it('틀린 요청은 카드를 띄우지 않고 사유로 막는다, 맞는 요청·다른 도구·하위 작업은 판정하지 않는다', async () => {
    const { preTool } = await start()
    expect(await preTool(`litecode_${SKILL_TOOL}`, { ...SKILL, name: 'Bad Name' })).toEqual({ deny: true, reason: expect.stringMatching(/name/) })
    expect(await preTool(`litecode_${MCP_TOOL}`, { ...REMOTE, name: 'litecode' })).toEqual({ deny: true, reason: expect.stringMatching(/litecode/) })
    expect(await preTool(`litecode_${SKILL_TOOL}`, SKILL)).toBeUndefined()
    expect(await preTool(`litecode_${HOOK_TOOL}`, HOOK)).toBeUndefined()
    expect(await preTool('bash', { command: 'ls' })).toBeUndefined()
    expect(await preTool(`litecode_${SKILL_TOOL}`, { ...SKILL, name: 'Bad Name' }, true)).toBeUndefined()
  })

  it('승인 카드에 가는 add_mcp_server 인자는 비밀 값이 가려진다 — 다른 도구는 그대로(undefined)', async () => {
    const { ctx } = await start()
    const ref = { server: 'litecode', tool: MCP_TOOL }
    const masked = ctx.bail('llm/attention-input', ref, { ...REMOTE, headers: { Authorization: 'Bearer s3cret' } })
    expect(JSON.stringify(masked)).not.toContain('s3cret')
    expect(masked).toEqual({ ...REMOTE, headers: { Authorization: SECRET_MASK } })
    expect(ctx.bail('llm/attention-input', { server: 'litecode', tool: SKILL_TOOL }, SKILL)).toBeUndefined()
    expect(ctx.bail('llm/attention-input', { server: 'github', tool: MCP_TOOL }, REMOTE)).toBeUndefined()
  })
})

describe('shared/make.ts — 인자 다듬기', () => {
  const secretName = (name: string): boolean => /TOKEN|KEY/i.test(name)

  it('skillRequest: 기본은 이 프로젝트만, 설명은 한 줄로', () => {
    expect(skillRequest({ ...SKILL, description: 'a\n  b' })).toEqual({ ...SKILL, description: 'a b', scope: 'project' })
    expect(skillRequest({ ...SKILL, scope: 'all' }).scope).toBe('all')
  })

  it('mcpRequest: 원격 헤더는 전부 비밀, 로컬 env 는 이름·secret_names·가려진 값으로', () => {
    expect(mcpRequest({ ...REMOTE, headers: { 'X-Team': 'a' } }, secretName).vars).toEqual([{ name: 'X-Team', value: 'a', secret: true }])
    expect(mcpRequest({ ...LOCAL, env: { ROOT: '/d', API_KEY: 'k', PAT: 'p', OLD: SECRET_MASK }, secret_names: ['PAT'] }, secretName).vars).toEqual([
      { name: 'ROOT', value: '/d', secret: false },
      { name: 'API_KEY', value: 'k', secret: true },
      { name: 'PAT', value: 'p', secret: true },
      { name: 'OLD', value: SECRET_MASK, secret: true },
    ])
    expect(() => mcpRequest({ ...LOCAL, env: { A: 1 } })).toThrow(/env/)
    expect(() => mcpRequest({ name: 'x', type: 'stdio' })).toThrow(/type/)
  })

  it('maskMcpArgs: 비밀만 가리고, 못 읽는 인자는 값 전부를 가린다', () => {
    expect(maskMcpArgs({ ...LOCAL, env: { ROOT: '/d', API_KEY: 'k' } }, secretName)).toEqual({ ...LOCAL, env: { ROOT: '/d', API_KEY: SECRET_MASK } })
    expect(maskMcpArgs({ name: 'x', type: 'weird', env: { ROOT: '/d' }, headers: { A: 'b' } }, secretName)).toEqual({ name: 'x', type: 'weird', env: { ROOT: SECRET_MASK }, headers: { A: SECRET_MASK } })
  })

  it('hookRequest: 도구 이벤트가 아니면 매처를 버린다', () => {
    expect(hookRequest({ event: 'Stop', matcher: 'bash', command: ' x ' })).toEqual({ event: 'Stop', matcher: '', command: 'x', scope: 'project' })
    expect(hookRequest({ ...HOOK, scope: 'all' })).toEqual({ ...HOOK, scope: 'all' })
  })

  it('attentionTarget: 화면이 보낸 "저장할 곳" 은 아는 모양만', () => {
    expect(attentionTarget({ kind: 'scope', scope: 'all', extra: 1 })).toEqual({ kind: 'scope', scope: 'all' })
    expect(attentionTarget({ kind: 'scope', scope: 'home' })).toBeUndefined()
    expect(attentionTarget({ kind: 'conversation', conversationId: 'c' })).toEqual({ kind: 'conversation', conversationId: 'c' })
  })
})
