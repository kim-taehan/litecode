import fs from 'node:fs/promises'
import { HOOK_EVENTS, hookKey, type HookDef, type HookEntry, type HookEvent } from '../../../shared/hooks.ts'

// 훅 정의 파일 (이슈 #102, 01af §6-2) — Claude Code `hooks` 형식의 부분집합:
//   { "hooks": { "<이벤트>": [ { "matcher": "edit|write", "hooks": [ { "type": "command", "command": "…", "timeout": 10 } ] } ] } }
// - 모든 프로젝트: userData `hooks.json` (위 모양 그대로)
// - 이 프로젝트만: userData `hooks-projects.json` — { "<프로젝트 realpath>": { "hooks": {위와 같다}, "enabled": { "<hookKey>": true|false } } }
//   enabled 는 그 프로젝트에서의 켜기 값 — 모든 프로젝트 훅도 덮는다 (mcp-projects.json 의 enabled 와 같은 방식). 프로젝트 폴더 안에는 쓰지 않는다
// - 아는 것만 남긴다: 모르는 이벤트·command 가 아닌 핸들러(http·prompt·agent)·빈 명령·모양이 틀린 원소는 버린다. 던지지 않는다
// - **읽을 때는 깨진 파일을 옮기지 않는다** (jsonFile.ts 와 다르다): 사용자가 손으로 고치는 파일이고 훅이 돌 때마다 읽는다 — 고치다 만 파일을
//   옆으로 치우면 편집 중인 파일이 사라진다. 읽기는 "훅 0개" 로 내려앉고 경고만 남긴다. 덮어쓰기 전(HooksService 의 저장)에만 jsonFile 로 옮겨 둔다

export interface ProjectHooks {
  hooks: HookDef[]
  enabled: Record<string, boolean>
}

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)

/** 저장 형식(맨 위 객체) → 훅 목록. 순서는 파일에 적힌 순서 (이벤트는 HOOK_EVENTS 순) */
export function parseHooks(value: unknown): HookDef[] {
  const events = isObject(value) && isObject(value['hooks']) ? value['hooks'] : {}
  const found: HookDef[] = []
  for (const event of HOOK_EVENTS) {
    const groups = events[event]
    if (!Array.isArray(groups)) continue
    for (const group of groups) {
      if (!isObject(group) || !Array.isArray(group['hooks'])) continue
      const matcher = typeof group['matcher'] === 'string' ? group['matcher'] : ''
      for (const hook of group['hooks']) {
        if (!isObject(hook) || hook['type'] !== 'command' || typeof hook['command'] !== 'string' || !hook['command'].trim()) continue
        const timeout = hook['timeout']
        found.push({
          event,
          matcher,
          command: hook['command'],
          ...(typeof timeout === 'number' && Number.isFinite(timeout) && timeout > 0 && { timeout }),
          enabled: hook['enabled'] !== false,
        })
      }
    }
  }
  return found
}

/** 훅 목록 → 저장 형식. 훅마다 묶음 하나로 적는다 (다시 읽으면 같은 목록) */
export function serializeHooks(hooks: readonly HookDef[]): { hooks: Partial<Record<HookEvent, unknown[]>> } {
  const events: Partial<Record<HookEvent, unknown[]>> = {}
  for (const hook of hooks) {
    ;(events[hook.event] ??= []).push({
      ...(hook.matcher && { matcher: hook.matcher }),
      hooks: [{ type: 'command', command: hook.command, ...(hook.timeout !== undefined && { timeout: hook.timeout }), ...(!hook.enabled && { enabled: false }) }],
    })
  }
  return { hooks: events }
}

/** hooks-projects.json 의 맨 위 객체 → 프로젝트별 훅·켜기 값 */
export function parseProjects(value: unknown): Record<string, ProjectHooks> {
  if (!isObject(value)) return {}
  const projects: Record<string, ProjectHooks> = {}
  for (const [directory, entry] of Object.entries(value)) {
    if (!isObject(entry)) continue
    const enabled = isObject(entry['enabled']) ? entry['enabled'] : {}
    projects[directory] = {
      hooks: parseHooks(entry),
      enabled: Object.fromEntries(Object.entries(enabled).filter((pair): pair is [string, boolean] => typeof pair[1] === 'boolean')),
    }
  }
  return projects
}

export function serializeProjects(projects: Record<string, ProjectHooks>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(projects).map(([directory, entry]) => [directory, { ...serializeHooks(entry.hooks), enabled: entry.enabled }]))
}

/** 그 프로젝트에서 본 훅 — 모든 프로젝트 것 먼저, 이 프로젝트만의 것 나중 (도는 순서). 켜짐은 프로젝트별 값이 훅의 enabled 를 덮는다 */
export function entriesFor(all: readonly HookDef[], project: ProjectHooks | undefined): HookEntry[] {
  const entry = (hook: HookDef, scope: HookEntry['scope']): HookEntry => {
    const key = hookKey(hook)
    return { ...hook, scope, key, on: project?.enabled[key] ?? hook.enabled }
  }
  return [...all.map((hook) => entry(hook, 'all')), ...(project?.hooks ?? []).map((hook) => entry(hook, 'project'))]
}

/** 어느 프로젝트에서든 켜져 있는 도구 실행 전 훅의 매처 (겹치지 않게, 정렬) — 엔진의 도구 실행 전 게이트 대상이다 (이슈 #102 2단계).
 *  엔진 설정은 프로젝트를 가리지 않고 하나라 **합집합**으로 건다: 모든 프로젝트 훅은 기본 켜기 값이나 어느 한 프로젝트의 켜기 값으로 켜져 있으면,
 *  이 프로젝트만의 훅은 그 프로젝트에서 켜져 있으면 들어간다. 그 훅이 없는 프로젝트에서는 승인 요청이 와도 맞는 훅이 없어 그대로 통과한다 */
export function gateMatchers(all: readonly HookDef[], projects: Record<string, ProjectHooks>): string[] {
  const views = [entriesFor(all, undefined), ...Object.values(projects).map((project) => entriesFor(all, project))]
  const matchers = views.flatMap((view) => view.filter((hook) => hook.on && hook.event === 'PreToolUse').map((hook) => hook.matcher.trim()))
  return [...new Set(matchers)].sort()
}

/** 파일을 읽어 JSON 으로 — 없으면 undefined, 못 읽거나 깨졌으면 경고 한 줄(같은 내용엔 한 번)과 undefined. 파일은 건드리지 않는다 */
export function lenientReader(): (file: string) => Promise<unknown> {
  const warned = new Map<string, string>()
  return async (file) => {
    const text = await fs.readFile(file, 'utf8').catch(() => undefined)
    if (text === undefined) return undefined
    try {
      const value: unknown = JSON.parse(text)
      warned.delete(file)
      return value
    } catch (error) {
      if (warned.get(file) !== text) console.warn(`[hooks] ${file} 을 읽지 못했다 (${(error as Error).name}) — 고칠 때까지 그 파일의 훅은 돌지 않는다`)
      warned.set(file, text)
      return undefined
    }
  }
}
