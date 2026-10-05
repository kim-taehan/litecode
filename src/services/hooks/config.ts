import fs from 'node:fs/promises'
import {
  HOOK_EVENTS,
  hookKey,
  hookTimeout,
  sendsOutside,
  TOOL_HOOK_EVENTS,
  type HookCandidate,
  type HookDef,
  type HookDraft,
  type HookEntry,
  type HookEvent,
  type HookScope,
} from '../../../shared/hooks.ts'

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

// ── 화면이 하는 편집 (이슈 #102 3단계) — 두 파일을 읽은 것(HookStore)을 제자리에서 바꾼다. 읽고 쓰기는 HooksService

/** 두 파일의 내용 — project 는 projects 안의 지금 프로젝트 것(같은 객체) */
export interface HookStore {
  all: HookDef[]
  project: ProjectHooks
  projects: Record<string, ProjectHooks>
}

/** missing: 고치려는 훅이 없다(그사이 파일이 바뀌었다), duplicate: 같은 내용(열쇠)의 훅이 이 프로젝트에서 이미 보인다 */
export type HookEditError = 'missing' | 'duplicate'

/** 그 열쇠의 프로젝트별 켜기 값을 새 열쇠로 옮긴다 (next 가 없으면 지운다) */
function rekey(projects: readonly ProjectHooks[], key: string, next?: string): void {
  for (const project of projects) {
    const value = project.enabled[key]
    if (value === undefined) continue
    delete project.enabled[key]
    if (next !== undefined) project.enabled[next] = value
  }
}

/** 초안(checkHookDraft 를 거친 것)을 넣는다 — 새 훅은 그 묶음의 맨 뒤에, 고친 훅은 제자리에(묶음을 바꿨으면 새 묶음의 맨 뒤로).
 *  꺼 둔 훅을 고쳐도 꺼진 채다. 내용이 바뀌면 열쇠도 바뀌므로 프로젝트별 켜기 값을 따라 옮긴다 */
export function putHook(store: HookStore, draft: HookDraft): HookEditError | undefined {
  const list = (scope: HookScope): HookDef[] => (scope === 'all' ? store.all : store.project.hooks)
  const from = draft.original && list(draft.original.scope)
  const at = from ? from.findIndex((hook) => hookKey(hook) === draft.original!.key) : -1
  if (draft.original && at < 0) return 'missing'
  const before = from?.[at]
  const next: HookDef = { event: draft.event, matcher: draft.matcher, command: draft.command, ...(draft.timeout !== undefined && { timeout: draft.timeout }), enabled: before?.enabled ?? true }
  const key = hookKey(next)
  if ([...store.all, ...store.project.hooks].some((hook) => hook !== before && hookKey(hook) === key)) return 'duplicate'
  if (!before) list(draft.scope).push(next)
  else if (draft.original!.scope === draft.scope) from![at] = next
  else {
    from!.splice(at, 1)
    list(draft.scope).push(next)
  }
  if (before) {
    const others = Object.values(store.projects).filter((project) => project !== store.project)
    rekey([store.project], draft.original!.key, key)
    // 모든 프로젝트 훅이었다 — 다른 프로젝트의 켜기 값도 따라간다. 이 프로젝트만의 것이 됐으면 다른 프로젝트에선 지운다
    if (draft.original!.scope === 'all') rekey(others, draft.original!.key, draft.scope === 'all' ? key : undefined)
  }
  return undefined
}

/** 훅 하나를 지운다 — 그 열쇠의 켜기 값도 (다시 같은 훅을 만들었을 때 예전 값이 되살아나지 않게). 없으면 false */
export function dropHook(store: HookStore, scope: HookScope, key: string): boolean {
  const list = scope === 'all' ? store.all : store.project.hooks
  const at = list.findIndex((hook) => hookKey(hook) === key)
  if (at < 0) return false
  list.splice(at, 1)
  rekey(scope === 'all' ? Object.values(store.projects) : [store.project], key)
  return true
}

/** 프로젝트 폴더의 파일들(읽은 JSON — 못 읽었으면 undefined)에서 가져오기 후보를 뽑는다. Claude Code `hooks` 형식 그대로라 parseHooks 가 읽는다
 *  (command 가 아닌 핸들러·모르는 이벤트·빈 명령은 빠진다). 이미 이 프로젝트에서 보이는 훅(같은 열쇠)과 앞 파일에서 나온 것은 뺀다.
 *  파일에 꺼짐으로 적혀 있어도 후보다 — 가져오면 켜진 훅이 된다 (사용자가 고른 것만 오니까) */
export function importCandidates(files: readonly { file: string; value: unknown }[], existing: ReadonlySet<string>): HookCandidate[] {
  const seen = new Set(existing)
  const found: HookCandidate[] = []
  for (const { file, value } of files) {
    for (const hook of parseHooks(value)) {
      const matcher = TOOL_HOOK_EVENTS.includes(hook.event) ? hook.matcher : '' // 도구 이벤트가 아니면 매처를 보지 않는다
      const key = hookKey({ ...hook, matcher })
      if (seen.has(key)) continue
      seen.add(key)
      found.push({
        key,
        event: hook.event,
        matcher,
        command: hook.command,
        ...(hook.timeout !== undefined && { timeout: hook.timeout }),
        seconds: hookTimeout(hook.event, hook.timeout),
        file,
        outbound: sendsOutside(hook.command),
      })
    }
  }
  return found
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
