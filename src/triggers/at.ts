import type { Context } from 'cordis'
import type { TriggerCandidate } from '../services/triggers.ts'
import '../services/triggers.ts'
import '../services/llm.ts'
import { tr } from '../i18n.ts'

// `@` 파일 참조 — 본문에 `@경로` 텍스트만 넣는다(사용자 결정 2026-10-01, dsh 방식). 모델이 read 도구로 읽는다.
// opencode 의 prompt.files 는 쓰지 않는다 — openai-compatible 경로에선 텍스트 첨부가 step.failed 를 내고 그 세션의 이후 턴이
// 전부 같은 오류로 실패한다 (01d Q1). 그래서 이 플러그인은 경로 문자열만 다룬다.
// 질의가 비었거나 `/` 로 끝나면 그 폴더 바로 아래를, 아니면 퍼지 검색을 보인다 (01d: 새 파일은 색인에 몇 초 늦게 잡힌다).

const LIMIT = 20

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
            : await ctx.llm.findFiles(scope.directory, query, LIMIT, signal)
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
