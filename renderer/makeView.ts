import type { Attention } from '../shared/ipc.ts'
import type { HookEvent } from '../shared/hooks.ts'
import { CREATE_TOOL, hookRequest, MAKE_SERVER, makeKind, mcpRequest, SECRET_MASK, skillRequest, type MakeScope } from '../shared/make.ts'
import { PROJECT_SKILLS_DIR } from '../shared/skills.ts'

// 만들기 도구(스킬·MCP 서버·훅, 이슈 #145 — 시안 _workspace/mock-make)의 승인 카드가 그릴 것. 순수 함수다 (React·IPC 없음).
// 인자는 메인과 같은 함수(shared/make.ts)로 읽는다 — 틀린 요청은 메인이 카드를 띄우기 전에 막으므로 여기까지 오면 읽힌다.
// 비밀 값은 메인이 가려서 보낸다(SECRET_MASK) — 화면은 진짜 값을 받지 않는다

type PermissionRequest = Extract<Attention, { kind: 'permission' }>

/** 스킬 본문 미리보기의 줄 수 — 나머지는 "본문 전체 보기" 로 편다 */
export const PREVIEW_LINES = 3

export type MakeCard =
  | {
      kind: 'skill'
      /** AI 가 고른 저장할 곳 — 카드에서 먼저 선택돼 있다 */
      scope: MakeScope
      name: string
      description: string
      body: string
      /** 본문의 처음 PREVIEW_LINES 줄 */
      preview: string
      /** 미리보기 뒤에 남은 줄 수 */
      more: number
      /** "이 프로젝트만" 일 때 쓸 자리 (프로젝트 기준) */
      file: string
    }
  | {
      kind: 'mcp'
      scope: MakeScope
      name: string
      type: 'local' | 'remote'
      /** 원격이면 주소, 로컬이면 명령 줄 */
      target: string
      /** 헤더·env — 비밀이면 값이 없다 */
      vars: { name: string; value?: string; secret: boolean }[]
      /** 비밀 값이 있다 — "이 프로젝트만" 이어도 프로젝트의 .mcp.json 이 아니라 앱 안에 둔다 */
      inApp: boolean
    }
  | {
      kind: 'hook'
      scope: MakeScope
      event: HookEvent
      /** 도구 이벤트가 아니면 빈 글자 */
      matcher: string
      command: string
    }

function parse(json: string): Record<string, unknown> {
  const value: unknown = JSON.parse(json)
  if (!value || typeof value !== 'object') throw new Error('not an object')
  return value as Record<string, unknown>
}

/** 만들기 도구의 승인 요청이면 카드 내용을, 아니면(다른 권한·인자를 못 이었다·못 읽는다) undefined — 보통의 승인 카드로 그린다 */
export function makeCard(request: PermissionRequest): MakeCard | undefined {
  if (request.mcp?.server !== MAKE_SERVER || request.mcp.tool !== CREATE_TOOL || request.input === undefined) return undefined
  try {
    const args = parse(request.input)
    const kind = makeKind(args)
    if (kind === 'skill') {
      const skill = skillRequest(args)
      const lines = skill.body.split('\n')
      return {
        kind: 'skill',
        scope: skill.scope,
        name: skill.name,
        description: skill.description,
        body: skill.body,
        preview: lines.slice(0, PREVIEW_LINES).join('\n'),
        more: Math.max(0, lines.length - PREVIEW_LINES),
        file: `${PROJECT_SKILLS_DIR}/${skill.name}/SKILL.md`,
      }
    }
    if (kind === 'mcp_server') {
      const server = mcpRequest(args)
      const secret = (entry: { value: string; secret: boolean }): boolean => entry.secret || entry.value === SECRET_MASK
      return {
        kind: 'mcp',
        scope: server.scope,
        name: server.name,
        type: server.type,
        target: server.type === 'remote' ? server.url! : server.command!.join(' '),
        vars: server.vars.map((entry) => (secret(entry) ? { name: entry.name, secret: true } : { name: entry.name, value: entry.value, secret: false })),
        inApp: server.vars.some(secret),
      }
    }
    const hook = hookRequest(args)
    return { kind: 'hook', scope: hook.scope, event: hook.event, matcher: hook.matcher, command: hook.command }
  } catch {
    // 못 읽는 인자 — 보통의 승인 카드로 (그 허용은 저장할 곳이 실리지 않아 도구가 받지 않는다)
    return undefined
  }
}
