import type { Context } from 'cordis'
import type { ExtensionSummary } from '../../../../shared/extensions.ts'
import type { AppMcpTool } from '../rpc.ts'
import '../../appMcp.ts'
import '../../extensions.ts'

// SonarQube 재검사 도구 (이슈 #563) — sonarqube-fix 스킬이 고친 뒤 부른다: 고친 파일만 내장 서버로 범위 분석하고 남은 이슈를 돌려준다.
// SonarQube 확장(server.admin = sonarqube)이 켜져 있는 동안만 도구가 보인다 — 확장을 끄거나 지우면 빠진다(스킬과 같은 운명).
// 서버가 꺼져 있으면 도구는 있지만 사유를 돌려준다(띄우기는 사용자가 패널에서). 설명·결과 글은 모델이 읽는다 — 영어

const TOOL: Omit<AppMcpTool, 'run'> = {
  name: 'sonarqube_check',
  description:
    "Re-run SonarQube analysis on the given project-relative files or folders (the ones you just changed) with the app's embedded SonarQube server, wait for the result, and return the issues that remain in them. Use after fixing SonarQube issues to confirm they are gone. Takes 15-60 seconds.",
  inputSchema: {
    type: 'object',
    properties: { paths: { type: 'array', items: { type: 'string' }, minItems: 1, description: 'Project-relative paths, e.g. ["src/a.ts", "config/"]' } },
    required: ['paths'],
  },
}

export function SonarqubeTools(ctx: Context): void {
  let off: (() => void) | undefined
  const sync = (list: readonly ExtensionSummary[]): void => {
    const on = list.some((extension) => extension.server !== undefined && extension.state === 'on' && extension.id === 'sonarqube')
    if (on && !off) {
      off = ctx.appMcp.register({
        ...TOOL,
        async run(args, { directory }) {
          const paths = Array.isArray(args['paths']) ? args['paths'].filter((item): item is string => typeof item === 'string' && item.trim() !== '') : []
          if (paths.length === 0) throw new Error('Give at least one project-relative path in paths.')
          const result = await ctx.extensions.sonarCheck(directory, paths)
          if (!result.ok) throw new Error(result.reason)
          return JSON.stringify({ remaining: result.total, issues: result.issues, ...(result.skipped.length > 0 && { skippedPaths: result.skipped }) })
        },
      })
    } else if (!on && off) {
      off()
      off = undefined
    }
  }
  ctx.on('extensions/changed', sync)
  void ctx.extensions.list().then(sync)
  ctx.effect(() => () => {
    off?.()
    off = undefined
  })
}
SonarqubeTools.inject = ['appMcp', 'extensions']
