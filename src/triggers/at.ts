import type { Context } from 'cordis'
import type { TriggerCandidate } from '../services/triggers.ts'
import '../services/triggers.ts'
import '../services/llm.ts'
import { tr } from '../i18n.ts'

// `@` 파일 참조 — 본문에 `@경로` 텍스트만 넣는다(사용자 결정 2026-10-01, dsh 방식). 모델이 read 도구로 읽는다.
// opencode 의 prompt.files 는 쓰지 않는다 — openai-compatible 경로에선 텍스트 첨부가 step.failed 를 내고 그 세션의 이후 턴이
// 전부 같은 오류로 실패한다 (01d Q1). 그래서 이 플러그인은 경로 문자열만 다룬다.
// 질의가 비었거나 `/` 로 끝나면 그 폴더 바로 아래를 보인다. 글자를 치면 "그 글자가 들어 있는 것"(포함 검색, 대소문자 무시)이 먼저다 —
// 지금 폴더 바로 아래에서 이름에 들어 있는 것(폴더도), 그다음 엔진 퍼지 검색 중 경로에 들어 있는 것, 끝으로 나머지 퍼지 결과
// (01d: 새 파일은 색인에 몇 초 늦게 잡힌다 — 폴더 목록은 색인을 안 거쳐 바로 잡힌다).

const LIMIT = 20
/** 엔진 퍼지 검색에서 받아 오는 수 — 포함하는 것을 앞으로 올리려고 보이는 수보다 넉넉히 */
const FIND_LIMIT = 100

type Entry = { path: string; type: 'file' | 'directory' }

const baseName = (entry: Entry): string => entry.path.replace(/\/$/, '').split('/').pop() ?? ''

/** 포함 검색 순서: 지금 폴더에서 이름에 tail 이 든 것 → 퍼지 결과 중 경로에 query 가 든 것 → 나머지 퍼지 결과. 같은 경로는 한 번 */
export function containing(listed: readonly Entry[], found: readonly Entry[], query: string): Entry[] {
  const needle = query.toLowerCase()
  const tail = needle.slice(needle.lastIndexOf('/') + 1)
  const ordered = [
    ...listed.filter((entry) => baseName(entry).toLowerCase().includes(tail)),
    ...found.filter((entry) => entry.path.toLowerCase().includes(needle)),
    ...found,
  ]
  const seen = new Set<string>()
  return ordered.filter((entry) => !seen.has(entry.path) && seen.add(entry.path)).slice(0, LIMIT)
}

/** 경로에 공백이 있으면 `@"…"` 로 감싼다. open: 닫는 따옴표 없이 (폴더로 들어가 계속 칠 때) */
export function reference(path: string, open = false): string {
  if (!/\s/.test(path)) return `@${path}`
  return open ? `@"${path}` : `@"${path}"`
}

export function AtTrigger(ctx: Context): void {
  ctx.effect(() =>
    ctx.triggers.register({
      char: '@',
      opensAt: 'boundary',
      async candidates(scope, query, signal) {
        const entries =
          !query || query.endsWith('/')
            ? await ctx.llm.listDirectory(scope.directory, query, signal)
            : containing(
                // 치던 경로의 폴더가 없으면(오타) 퍼지 결과만
                await ctx.llm.listDirectory(scope.directory, query.slice(0, query.lastIndexOf('/') + 1), signal).catch(() => []),
                await ctx.llm.findFiles(scope.directory, query, FIND_LIMIT, signal),
                query,
              )
        // .git 은 숨김·무시 파일과 달리 고를 일이 없다 (01d: fs/list 는 .git/ 까지 다 준다)
        return entries.filter((entry) => !/(^|\/)\.git\//.test(entry.path)).map(candidate)
      },
      async pick(_scope, id, action) {
        if (action === 'drill') return { kind: 'drill', text: reference(id, true) }
        return { kind: 'insert', text: `${reference(id)} ` }
      },
    }),
  )
}
AtTrigger.inject = ['triggers', 'llm']

function candidate(entry: { path: string; type: 'file' | 'directory' }): TriggerCandidate {
  const folder = entry.type === 'directory'
  const trimmed = folder ? entry.path.replace(/\/$/, '') : entry.path
  const cut = trimmed.lastIndexOf('/')
  return {
    id: entry.path,
    label: trimmed.slice(cut + 1) + (folder ? '/' : ''),
    detail: cut > 0 ? trimmed.slice(0, cut) : undefined,
    icon: folder ? 'folder' : 'file',
    group: tr('trigger.group.files'),
    drill: folder,
  }
}
