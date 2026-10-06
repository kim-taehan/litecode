import type { Context } from 'cordis'
import { APP_MCP_NAME, SECRET_NAME, type McpServerInput } from '../../mcp.ts'
import type { AppMcpTool } from '../rpc.ts'
import { HOOK_EVENTS, TOOL_HOOK_EVENTS } from '../../../../shared/hooks.ts'
import {
  HOOK_TOOL,
  hookRequest,
  maskMcpArgs,
  MCP_TOOL,
  mcpRequest,
  SKILL_BODY_MAX,
  SKILL_TOOL,
  skillRequest,
  type MakeScope,
  type McpRequest,
} from '../../../../shared/make.ts'
import '../../appMcp.ts'
import '../../hooks.ts'
import '../../skills.ts'

// 만들기 도구 셋 (이슈 #145, 시안 _workspace/mock-make) — 대화로 스킬·MCP 서버·훅을 만들 때 **앱이 저장 위치를 정한다**. 모델이 습관대로
// `.claude/` 아래에 파일을 만들면 앱이 못 읽는다 — 프롬프트로 부탁하지 않고 도구를 준다 (사용자 결정 2026-10-06).
// 여기는 인자 검사와 승인 확인만 한다. 쓰는 일은 ctx.skills.create · ctx.mcp.save / addToProjectFile · ctx.hooks.saveHook 의 공개 메서드가 한다
// (화면의 팝업이 쓰는 길과 같다). 엔진을 모른다.
//
// 셋 다 사용자 승인 카드를 거쳐야만 등록된다 — 세 겹 (세션 도구와 같다, sessions.ts):
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
const INSTEAD = 'Use this instead of writing files under `.claude/` or `.opencode/` yourself — the app decides where it is saved. The user must approve.'
const HOOKS_OFF = 'The hooks feature is turned off, so nothing was added. Ask the user to turn it on in Settings > Features, then call again.'
const SCOPE_PROPERTY = {
  type: 'string',
  enum: ['project', 'all'],
  description: 'Where it applies: "project" (this project only, the default) or "all" (every project). The user can change it when approving.',
}

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
  async function approvedScope(directory: string, tool: string, args: Record<string, unknown>): Promise<MakeScope> {
    const caller = await ctx.llm.callerOf(directory, { server: APP_MCP_NAME, tool }, args)
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

  const skill: AppMcpTool = {
    name: SKILL_TOOL,
    description: `Create a skill for litecode — a reusable instruction (SKILL.md) that the model loads when it is relevant and that the user can call with /name. ${INSTEAD} The app writes the frontmatter (name, description); pass only the body. An existing skill with the same name is never overwritten. The skill shows up in the skill list after the current turn finishes.`,
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Skill name: lowercase letters, digits and hyphens (for example "pr-check").' },
        description: { type: 'string', description: 'One or two sentences: what the skill does and when to use it. The model picks skills by this text.' },
        body: { type: 'string', description: `The SKILL.md body in Markdown, without frontmatter. At most ${SKILL_BODY_MAX} characters.` },
        scope: SCOPE_PROPERTY,
      },
      required: ['name', 'description', 'body'],
    },
    async run(args, { directory }) {
      const request = await skillOf(args, directory)
      const scope = await approvedScope(directory, SKILL_TOOL, args)
      const file = await ctx.skills.create(request, scope, directory)
      return `${moved(request.scope, scope)}Created the skill "${request.name}" for ${SCOPE_TEXT[scope]}: ${file}. Do not write this file yourself. It appears in the skill list (and as /${request.name}) after this turn finishes.`
    },
  }

  const mcp: AppMcpTool = {
    name: MCP_TOOL,
    description: `Add an MCP server to litecode so its tools become available to the model. ${INSTEAD} A local server runs a command on this PC; a remote server is reached over HTTP. A reserved or already used server name is rejected. Header values (and env values that look like secrets, or that you list in secret_names) are stored encrypted by the app and never written to a project file. The server's tools are available from the next turn, not in this one.`,
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Server name: letters, digits, "_" and "-" (at most 32). Tool names become <name>_<tool>.' },
        type: { type: 'string', enum: ['local', 'remote'], description: '"local" runs a command on this PC, "remote" connects to an http(s) URL.' },
        command: { type: 'array', items: { type: 'string' }, description: 'Local only: the program followed by its arguments, for example ["npx", "-y", "some-mcp"].' },
        env: { type: 'object', additionalProperties: { type: 'string' }, description: 'Local only: environment variables for the command.' },
        url: { type: 'string', description: 'Remote only: the http(s) URL of the server.' },
        headers: { type: 'object', additionalProperties: { type: 'string' }, description: 'Remote only: HTTP headers (always stored as secrets).' },
        secret_names: { type: 'array', items: { type: 'string' }, description: 'Names of env entries to store as secrets, in addition to those detected by name (KEY, TOKEN, SECRET, PASSWORD, AUTH, CREDENTIAL).' },
        scope: SCOPE_PROPERTY,
      },
      required: ['name', 'type'],
    },
    async run(args, { directory }) {
      const request = mcpOf(args, directory)
      const scope = await approvedScope(directory, MCP_TOOL, args)
      const input = serverInput(request)
      const head = `${moved(request.scope, scope)}Added the MCP server "${request.name}" for ${SCOPE_TEXT[scope]}`
      const tail = `Its tools (${request.name}_*) are available from the next turn, not in this one.`
      if (toFile(request, scope)) return `${head}: ${ctx.mcp.addToProjectFile(input, directory)}. Do not edit this file yourself. ${tail}`
      ctx.mcp.save({ ...input, scope }, directory)
      const where = scope === 'all' ? "the app's MCP list" : "the app's MCP list for this project (it has secret values, so it was not written to .mcp.json)"
      return `${head}, saved in ${where}. ${tail}`
    },
  }

  const hook: AppMcpTool = {
    name: HOOK_TOOL,
    description: `Add a hook to litecode — a shell command the app runs by itself, in the project folder, every time an event happens. ${INSTEAD} Events: ${HOOK_EVENTS.join(', ')}. For ${TOOL_HOOK_EVENTS.join(' and ')} give a matcher of tool names (for example "edit|write"); leave it out to match every tool. The hook is saved in the app, never in a project file, and takes effect from the next turn. If the hooks feature is turned off nothing is added.`,
    inputSchema: {
      type: 'object',
      properties: {
        event: { type: 'string', enum: [...HOOK_EVENTS], description: 'When the command runs.' },
        matcher: { type: 'string', description: `Tool names separated by "|" or a regular expression. Only for ${TOOL_HOOK_EVENTS.join(' and ')}; empty matches every tool.` },
        command: { type: 'string', description: 'The shell command to run. It receives the event as JSON on stdin.' },
        scope: SCOPE_PROPERTY,
      },
      required: ['event', 'command'],
    },
    async run(args, { directory }) {
      const request = hookOf(args)
      const scope = await approvedScope(directory, HOOK_TOOL, args)
      const hooks = ctx.get('hooks')
      if (!hooks) throw new Error(HOOKS_OFF)
      hooks.saveHook({ event: request.event, matcher: request.matcher, command: request.command, scope }, directory)
      const on = request.matcher ? `${request.event} (${request.matcher})` : request.event
      return `${moved(request.scope, scope)}Added the hook on ${on} for ${SCOPE_TEXT[scope]}: ${request.command}. It is saved in the app and takes effect from the next turn.`
    },
  }

  for (const tool of [skill, mcp, hook]) ctx.effect(() => ctx.appMcp.register(tool))

  // 틀린 요청은 승인 카드를 띄우기 전에 막는다 — 사유가 모델에 가고 턴은 이어진다. 하위 작업의 호출은 엔진 규칙이 이미 막는다
  const checks: Record<string, (args: Record<string, unknown>, directory: string) => unknown> = {
    [`${APP_MCP_NAME}_${SKILL_TOOL}`]: skillOf,
    [`${APP_MCP_NAME}_${MCP_TOOL}`]: mcpOf,
    [`${APP_MCP_NAME}_${HOOK_TOOL}`]: hookOf,
  }
  ctx.on('llm/pre-tool', async (info) => {
    const check = checks[info.tool]
    if (!check || info.child) return undefined
    try {
      await check((info.input && typeof info.input === 'object' ? info.input : {}) as Record<string, unknown>, info.directory)
      return undefined
    } catch (error) {
      return { deny: true as const, reason: (error as Error).message }
    }
  })

  // 승인 카드에 가는 인자에서 비밀 값을 가린다 (화면·폰으로 넘어가는 값이다). 도구가 받는 인자는 그대로다
  ctx.on('llm/attention-input', (ref, input) => {
    if (ref.server !== APP_MCP_NAME || ref.tool !== MCP_TOOL || !input || typeof input !== 'object') return undefined
    return maskMcpArgs(input as Record<string, unknown>, isSecret)
  })
}
MakeTools.inject = ['appMcp', 'llm', 'skills', 'mcp']
