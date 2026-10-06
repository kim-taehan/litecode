import type { Context } from 'cordis'
import { APP_MCP_NAME, SECRET_NAME, type McpServerInput } from '../../mcp.ts'
import type { AppMcpTool } from '../rpc.ts'
import { HOOK_EVENTS, TOOL_HOOK_EVENTS } from '../../../../shared/hooks.ts'
import { CREATE_TOOL, hookRequest, makeKind, maskMcpArgs, mcpRequest, SKILL_BODY_MAX, skillRequest, type MakeScope, type McpRequest } from '../../../../shared/make.ts'
import '../../appMcp.ts'
import '../../hooks.ts'
import '../../skills.ts'

// 만들기 도구 (이슈 #145, 시안 _workspace/mock-make — 처음엔 create_skill·add_mcp_server·add_hook 셋, 도구 수 줄이기로 create 하나에 kind 로 합쳤다
// 2026-10-06. 셋 다 같은 권한·같은 승인 카드 길이었다) — 대화로 스킬·MCP 서버·훅을 만들 때 **앱이 저장 위치를 정한다**. 모델이 습관대로
// `.claude/` 아래에 파일을 만들면 앱이 못 읽는다 — 프롬프트로 부탁하지 않고 도구를 준다 (사용자 결정 2026-10-06).
// 여기는 인자 검사와 승인 확인만 한다. 쓰는 일은 ctx.skills.create · ctx.mcp.save / addToProjectFile · ctx.hooks.saveHook 의 공개 메서드가 한다
// (화면의 팝업이 쓰는 길과 같다). 엔진을 모른다.
//
// 모든 kind 가 사용자 승인 카드를 거쳐야만 등록된다 — 세 겹 (세션 도구와 같다, sessions.ts):
// 1. 엔진 권한 — ask 라 부를 때마다 승인 카드가 뜬다 (engine.ts. 전체 권한에서도 묻고, 계획·하위 작업에는 도구가 없다)
// 2. 부른 대화 — ctx.llm.callerOf 로 그 폴더의 도는 턴에서 찾는다. 못 찾거나 하위 작업이면 거절
// 3. 앱 확인 — 사용자가 **내용을 보여 주는 앱의 카드에서** 허용한 호출만 받는다. 그 카드는 허용에 "저장할 곳"(caller.target, kind 'scope')을
//    싣는다 — 그것이 없는 허용(폰·내용을 못 이은 보통의 승인 카드)은 사용자가 무엇을 등록하는지 못 본 것이라 받지 않는다
//
// 저장할 곳은 사용자가 카드에서 바꿀 수 있다 (보내기 카드의 "대상 바꾸기" 와 같은 길) — 도구 인자의 scope 는 처음 선택일 뿐이고 실제로는
// 카드가 보낸 값으로 등록한다. 결과 글이 실제 자리를 말한다.
//
// 틀린 요청(이름 형식·이미 있는 이름·예약 이름·깨진 .mcp.json·꺼진 훅 기능)은 **카드를 띄우기 전에** 막는다 ('llm/pre-tool' — 사유가 모델에 간다).
// 같은 검사를 도구가 실행할 때 다시 한다 (판정을 거치지 않은 호출·그 사이에 바뀐 것).
//
// 도는 턴을 끊지 않는다: MCP 서버는 설정 파일이 아니라 매 턴 동적으로 붙는다(ctx.mcp — 엔진 재시작이 없다, 다음 턴에 붙는다). 훅의 도구 실행 전
// 게이트와 새 스킬은 엔진을 다시 띄워야 하지만 ctx.llm 이 도는 턴이 다 끝난 뒤로 미룬다 (gateTools·reloadWhenIdle).
// 설명·결과 글은 모델이 읽는다 — 화면 언어와 무관하게 영어. 비밀 값은 결과 글·카드 인자에 싣지 않는다

const NO_CALLER = 'Could not tell which conversation made this call. Call the tool again.'
const HOOKS_OFF = 'The hooks feature is turned off, so nothing was added. Ask the user to turn it on in Settings > Features, then call again.'

const isSecret = (name: string): boolean => SECRET_NAME.test(name)

const SCOPE_TEXT: Record<MakeScope, string> = { project: 'this project only', all: 'all projects' }

/** 결과 글의 머리 — 사용자가 카드에서 저장할 곳을 바꿨으면 그것부터 말한다 */
function moved(asked: MakeScope, scope: MakeScope): string {
  return asked === scope ? '' : `The user changed where it is saved: ${SCOPE_TEXT[scope]}. `
}

function serverInput(request: McpRequest): McpServerInput {
  return { name: request.name, type: request.type, ...(request.command && { command: request.command }), ...(request.url !== undefined && { url: request.url }), vars: request.vars }
}

export function MakeTools(ctx: Context): void {
  /** 그 호출을 사용자가 앱의 카드에서 허용했나 — 허용하며 고른 저장할 곳을 준다. 안 되면 그 사유를 던진다 (모델이 읽는다) */
  async function approvedScope(directory: string, args: Record<string, unknown>): Promise<MakeScope> {
    const caller = await ctx.llm.callerOf(directory, { server: APP_MCP_NAME, tool: CREATE_TOOL }, args)
    if (!caller) throw new Error(NO_CALLER)
    if (caller.child) throw new Error('Sub-tasks cannot create skills, MCP servers or hooks.')
    if (!caller.approved) throw new Error('This call was not approved by the user in litecode. Nothing was saved.')
    if (caller.target?.kind !== 'scope') throw new Error('This must be approved on the card in the litecode desktop app, which shows what will be saved. Nothing was saved.')
    return caller.target.scope
  }

  /** 스킬 요청 — 이름이 그 프로젝트에서 이미 보이면 던진다 */
  async function skillOf(args: Record<string, unknown>, directory: string) {
    const request = skillRequest(args)
    const existing = await ctx.skills.find(directory, request.name)
    if (existing) throw new Error(`A skill named "${request.name}" already exists (${existing.location}). Nothing was written — pick another name.`)
    return request
  }

  /** 비밀 값이 있는 서버는 프로젝트 파일에 적지 않는다 */
  const toFile = (request: McpRequest, scope: MakeScope): boolean => scope === 'project' && !request.vars.some((entry) => entry.secret)

  function mcpOf(args: Record<string, unknown>, directory: string) {
    const request = mcpRequest(args, isSecret)
    ctx.mcp.checkNew(serverInput(request), directory, toFile(request, request.scope))
    return request
  }

  function hookOf(args: Record<string, unknown>) {
    if (!ctx.get('hooks')) throw new Error(HOOKS_OFF)
    return hookRequest(args)
  }

  async function createSkill(args: Record<string, unknown>, directory: string): Promise<string> {
    const request = await skillOf(args, directory)
    const scope = await approvedScope(directory, args)
    const file = await ctx.skills.create(request, scope, directory)
    return `${moved(request.scope, scope)}Created the skill "${request.name}" for ${SCOPE_TEXT[scope]}: ${file}. Do not write this file yourself. It appears in the skill list (and as /${request.name}) after this turn finishes.`
  }

  async function addMcpServer(args: Record<string, unknown>, directory: string): Promise<string> {
    const request = mcpOf(args, directory)
    const scope = await approvedScope(directory, args)
    const input = serverInput(request)
    const head = `${moved(request.scope, scope)}Added the MCP server "${request.name}" for ${SCOPE_TEXT[scope]}`
    const tail = `Its tools (${request.name}_*) are available from the next turn, not in this one.`
    if (toFile(request, scope)) return `${head}: ${ctx.mcp.addToProjectFile(input, directory)}. Do not edit this file yourself. ${tail}`
    ctx.mcp.save({ ...input, scope }, directory)
    const where = scope === 'all' ? "the app's MCP list" : "the app's MCP list for this project (it has secret values, so it was not written to .mcp.json)"
    return `${head}, saved in ${where}. ${tail}`
  }

  async function addHook(args: Record<string, unknown>, directory: string): Promise<string> {
    const request = hookOf(args)
    const scope = await approvedScope(directory, args)
    const hooks = ctx.get('hooks')
    if (!hooks) throw new Error(HOOKS_OFF)
    hooks.saveHook({ event: request.event, matcher: request.matcher, command: request.command, scope }, directory)
    const on = request.matcher ? `${request.event} (${request.matcher})` : request.event
    return `${moved(request.scope, scope)}Added the hook on ${on} for ${SCOPE_TEXT[scope]}: ${request.command}. It is saved in the app and takes effect from the next turn.`
  }

  const create: AppMcpTool = {
    name: CREATE_TOOL,
    description: [
      'Create a skill, MCP server or hook in litecode. Use this instead of writing files under `.claude/` or `.opencode/` yourself — the app decides where it is saved. The user must approve.',
      '- kind "skill": name, description, body. A reusable instruction (SKILL.md) the model loads when relevant, also callable as /name. Never overwrites; listed after this turn.',
      '- kind "mcp_server": name, type, and command (+ env) for "local" or url (+ headers) for "remote". Secret values are stored encrypted, never in a project file. Its tools arrive next turn.',
      `- kind "hook": event, hook_command, and matcher for ${TOOL_HOOK_EVENTS.join('/')}. A shell command the app runs in the project folder on every event. Saved in the app, effective next turn.`,
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['skill', 'mcp_server', 'hook'] },
        scope: { type: 'string', enum: ['project', 'all'], description: 'Default "project" (this project only); "all" for every project. The user can change it.' },
        name: { type: 'string', description: 'skill: lowercase letters, digits, hyphens ("pr-check"). mcp_server: letters, digits, "_", "-" (tools become <name>_<tool>).' },
        description: { type: 'string', description: 'skill: what it does and when to use it — the model picks skills by this.' },
        body: { type: 'string', description: `skill: SKILL.md Markdown without frontmatter, at most ${SKILL_BODY_MAX} characters.` },
        type: { type: 'string', enum: ['local', 'remote'], description: 'mcp_server: "local" runs a command on this PC, "remote" is an http(s) URL.' },
        command: { type: 'array', items: { type: 'string' }, description: 'mcp_server local: program and arguments, e.g. ["npx", "-y", "some-mcp"].' },
        env: { type: 'object', additionalProperties: { type: 'string' }, description: 'mcp_server local: environment variables.' },
        secret_names: { type: 'array', items: { type: 'string' }, description: 'mcp_server local: env names to store as secrets, besides names with KEY, TOKEN, SECRET, PASSWORD, AUTH, CREDENTIAL.' },
        url: { type: 'string', description: 'mcp_server remote: http(s) URL.' },
        headers: { type: 'object', additionalProperties: { type: 'string' }, description: 'mcp_server remote: HTTP headers (always stored as secrets).' },
        event: { type: 'string', enum: [...HOOK_EVENTS], description: 'hook: when the command runs.' },
        hook_command: { type: 'string', description: 'hook: the shell command. It receives the event as JSON on stdin.' },
        matcher: { type: 'string', description: 'hook: tool names separated by "|" or a regular expression; empty matches every tool.' },
      },
      required: ['kind'],
    },
    async run(args, { directory }) {
      const kind = makeKind(args)
      if (kind === 'skill') return createSkill(args, directory)
      if (kind === 'mcp_server') return addMcpServer(args, directory)
      return addHook(args, directory)
    },
  }

  ctx.effect(() => ctx.appMcp.register(create))

  // 틀린 요청은 승인 카드를 띄우기 전에 막는다 — 사유가 모델에 가고 턴은 이어진다. 하위 작업의 호출은 엔진 규칙이 이미 막는다
  async function check(args: Record<string, unknown>, directory: string): Promise<unknown> {
    const kind = makeKind(args)
    if (kind === 'skill') return skillOf(args, directory)
    if (kind === 'mcp_server') return mcpOf(args, directory)
    return hookOf(args)
  }
  ctx.on('llm/pre-tool', async (info) => {
    if (info.tool !== `${APP_MCP_NAME}_${CREATE_TOOL}` || info.child) return undefined
    try {
      await check((info.input && typeof info.input === 'object' ? info.input : {}) as Record<string, unknown>, info.directory)
      return undefined
    } catch (error) {
      return { deny: true as const, reason: (error as Error).message }
    }
  })

  // 승인 카드에 가는 인자에서 비밀 값을 가린다 (화면·폰으로 넘어가는 값이다). 도구가 받는 인자는 그대로다.
  // kind 와 무관하게 늘 가린다 — 다른 kind 에 섞여 온 env·headers 는 MCP 서버로 못 읽혀 값 전부가 가려진다
  ctx.on('llm/attention-input', (ref, input) => {
    if (ref.server !== APP_MCP_NAME || ref.tool !== CREATE_TOOL || !input || typeof input !== 'object') return undefined
    return maskMcpArgs(input as Record<string, unknown>, isSecret)
  })
}
MakeTools.inject = ['appMcp', 'llm', 'skills', 'mcp']
