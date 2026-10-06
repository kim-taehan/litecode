// 대화로 스킬·MCP 서버·훅 만들기 (이슈 #145, 시안 _workspace/mock-make) 의 공용 규칙 — 메인(앱 MCP 의 도구 셋)과 화면(승인 카드)이 같은 것을 쓴다.
// 타입 + 순수 함수뿐이다 (Node·Electron·React·엔진을 모른다). 모델이 습관대로 `.claude/` 아래에 파일을 만들면 앱이 못 읽는다 — 그래서 도구로 받고
// **저장 위치는 앱이 정한다**. 인자 검사 글은 모델이 읽는다(영어)

import { checkHookDraft, TOOL_HOOK_EVENTS, type HookEvent } from './hooks.ts'
import type { AttentionTarget } from './contract.ts'

/** 앱 MCP 서버 이름 (src/services/mcp.ts 의 APP_MCP_NAME 과 같다 — 화면은 서비스 파일을 import 못 한다) */
export const MAKE_SERVER = 'litecode'
/** 만들기 도구 하나 (모델이 보는 이름 `litecode_create`) — 무엇을 만드는지는 인자 kind 로 가른다 (도구 수 줄이기, 2026-10-06) */
export const CREATE_TOOL = 'create'

/** create 의 kind */
export type MakeKind = 'skill' | 'mcp_server' | 'hook'
const MAKE_KINDS: readonly MakeKind[] = ['skill', 'mcp_server', 'hook']
/** kind 마다 꼭 있어야 하는 인자 — 스키마는 모든 인자를 optional 로 평평하게 두고(모델이 헷갈리지 않게) 여기서 본다 */
const MAKE_NEEDS: Record<MakeKind, readonly string[]> = { skill: ['name', 'description', 'body'], mcp_server: ['name', 'type'], hook: ['event', 'hook_command'] }

/** create 의 인자 → kind. kind 가 틀렸거나 그 kind 에 꼭 있어야 하는 인자가 없으면 던진다 (모델이 읽는다) */
export function makeKind(args: Record<string, unknown>): MakeKind {
  const kind = args['kind']
  if (!MAKE_KINDS.includes(kind as MakeKind)) throw new Error('kind must be "skill", "mcp_server" or "hook".')
  const missing = MAKE_NEEDS[kind as MakeKind].filter((name) => args[name] === undefined || args[name] === null || args[name] === '')
  if (missing.length > 0) throw new Error(`kind "${String(kind)}" needs ${missing.join(' and ')}.`)
  return kind as MakeKind
}

/** 저장할 곳 — project: 이 프로젝트만, all: 모든 프로젝트 */
export type MakeScope = 'project' | 'all'

/** 승인 카드에 가는 비밀 값의 자리 — 진짜 값은 화면으로 넘기지 않는다 */
export const SECRET_MASK = '••••••••'

export const SKILL_NAME_MAX = 64
export const SKILL_DESCRIPTION_MAX = 1024
export const SKILL_BODY_MAX = 40_000
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** 스킬 이름으로 쓸 수 있나 — 소문자·숫자·하이픈 (폴더 이름이 된다) */
export function isSkillName(name: string): boolean {
  return name.length <= SKILL_NAME_MAX && SKILL_NAME.test(name)
}

/** scope 인자 — 안 줬으면 이 프로젝트만 */
function scopeOf(value: unknown): MakeScope {
  if (value === undefined || value === null || value === 'project') return 'project'
  if (value === 'all') return 'all'
  throw new Error('scope must be "project" or "all".')
}

function text(args: Record<string, unknown>, name: string, max: number): string {
  const value = args[name]
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required.`)
  if (value.length > max) throw new Error(`${name} is too long (${value.length} characters, the limit is ${max}).`)
  return value.trim()
}

export interface SkillRequest {
  name: string
  /** 한 줄 */
  description: string
  /** SKILL.md 본문 (frontmatter 없이 — 앱이 쓴다) */
  body: string
  scope: MakeScope
}

/** create(kind skill) 의 인자 → 다듬은 요청. 틀리면 던진다 */
export function skillRequest(args: Record<string, unknown>): SkillRequest {
  const name = text(args, 'name', SKILL_NAME_MAX)
  if (!isSkillName(name)) throw new Error('name must be lowercase letters, digits and hyphens (for example "pr-check").')
  const description = text(args, 'description', SKILL_DESCRIPTION_MAX).replace(/\s+/g, ' ')
  const body = text(args, 'body', SKILL_BODY_MAX)
  if (/^---\r?\n/.test(body)) throw new Error('body must not start with frontmatter — the app writes the name and description.')
  return { name, description, body, scope: scopeOf(args['scope']) }
}

export interface McpRequest {
  name: string
  type: 'local' | 'remote'
  command?: string[]
  url?: string
  /** 로컬이면 env, 원격이면 헤더 */
  vars: { name: string; value: string; secret: boolean }[]
  scope: MakeScope
}

function stringMap(value: unknown, name: string): Record<string, string> {
  if (value === undefined || value === null) return {}
  if (typeof value !== 'object' || Array.isArray(value) || Object.values(value).some((entry) => typeof entry !== 'string')) throw new Error(`${name} must be an object of string values.`)
  return value as Record<string, string>
}

/** create(kind mcp_server) 의 인자 → 다듬은 요청. 틀리면 던진다 (이름 규칙·주소 모양은 ctx.mcp 가 본다).
 *  비밀: 원격 헤더는 전부, 로컬 env 는 isSecret(이름) 이거나 `secret_names` 에 든 것. 가려진 값(SECRET_MASK — 승인 카드에 간 인자)도 비밀이다 */
export function mcpRequest(args: Record<string, unknown>, isSecret: (name: string) => boolean = () => false): McpRequest {
  const name = text(args, 'name', 64)
  const type = args['type']
  if (type !== 'local' && type !== 'remote') throw new Error('type must be "local" or "remote".')
  const marked = args['secret_names']
  if (marked !== undefined && !(Array.isArray(marked) && marked.every((entry) => typeof entry === 'string'))) throw new Error('secret_names must be a list of names.')
  const values = stringMap(type === 'local' ? args['env'] : args['headers'], type === 'local' ? 'env' : 'headers')
  const vars = Object.entries(values).map(([key, value]) => ({
    name: key,
    value,
    secret: type === 'remote' || value === SECRET_MASK || isSecret(key) || (marked as string[] | undefined)?.includes(key) === true,
  }))
  const scope = scopeOf(args['scope'])
  if (type === 'remote') {
    const url = text(args, 'url', 2000)
    return { name, type, url, vars, scope }
  }
  const command = args['command']
  if (!Array.isArray(command) || command.length === 0 || command.some((part) => typeof part !== 'string' || !part.trim())) {
    throw new Error('command must be a non-empty list of strings (the program followed by its arguments).')
  }
  return { name, type, command: command as string[], vars, scope }
}

/** 승인 카드에 줄 인자 — 비밀 값을 가린다 (이름은 남는다). MCP 서버가 아닌 모양(다른 kind 에 섞여 온 env·headers 포함)·못 읽는 인자는 값 전부를 가린다 */
export function maskMcpArgs(args: Record<string, unknown>, isSecret: (name: string) => boolean): Record<string, unknown> {
  let secrets: Set<string> | undefined
  try {
    secrets = new Set(mcpRequest(args, isSecret).vars.filter((entry) => entry.secret).map((entry) => entry.name))
  } catch {
    // 못 읽는 인자 — 아래에서 전부 가린다
  }
  const masked = (value: unknown): unknown =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, !secrets || secrets.has(key) ? SECRET_MASK : entry]))
      : value
  return { ...args, ...('env' in args && { env: masked(args['env']) }), ...('headers' in args && { headers: masked(args['headers']) }) }
}

export interface HookRequest {
  event: HookEvent
  /** 도구 이벤트가 아니면 빈 글자 */
  matcher: string
  command: string
  scope: MakeScope
}

const HOOK_ERRORS: Record<string, string> = {
  event: 'event is not supported. Use one of PreToolUse, PostToolUse, UserPromptSubmit, Stop, SessionStart, Notification.',
  command: 'hook_command is required.',
  matcher: 'matcher is not a valid tool-name pattern (names separated by "|", or a regular expression).',
}

/** create(kind hook) 의 인자 → 다듬은 요청 (shared/hooks.ts checkHookDraft 와 같은 판정). 틀리면 던진다.
 *  명령은 `hook_command` — 평평한 스키마에서 MCP 서버의 `command`(목록)와 이름이 겹치지 않게 */
export function hookRequest(args: Record<string, unknown>): HookRequest {
  const scope = scopeOf(args['scope'])
  const checked = checkHookDraft({ event: args['event'], matcher: args['matcher'], command: args['hook_command'], scope })
  if ('error' in checked) throw new Error(HOOK_ERRORS[checked.error] ?? `${checked.error} is invalid.`)
  const { event, matcher, command } = checked.draft
  return { event, matcher: TOOL_HOOK_EVENTS.includes(event) ? matcher : '', command, scope }
}

/** 화면(IPC)이 보낸 "저장할 곳" 에서 아는 모양만 — 그 밖은 undefined */
export function scopeTarget(value: unknown): AttentionTarget | undefined {
  const target = value as { kind?: unknown; scope?: unknown } | null | undefined
  if (target?.kind === 'scope' && (target.scope === 'project' || target.scope === 'all')) return { kind: 'scope', scope: target.scope }
  return undefined
}
