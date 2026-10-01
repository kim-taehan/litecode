import type { Context } from 'cordis'
import '../services/triggers.ts'
import '../services/terminals.ts'

// `!` 셸 — 입력 첫 글자가 `!` 면 셸 모드. 입력창 색으로 경고하고(closed-code composerMode: `!rm -rf` 를 질문으로 착각해 보내지
// 않게), Enter 로 그 프로젝트 폴더의 터미널 칸(ctx.terminals)에서 돌린다. 결과는 대화 맥락에 넣지 않는다 (사용자 결정 2026-10-01).
// opencode 의 bash 권한 규칙을 거치지 않는다 — 사용자가 직접 친 명령이다.

export function BangTrigger(ctx: Context): void {
  ctx.effect(() =>
    ctx.triggers.register({
      char: '!',
      opensAt: 'start',
      wholeLine: true,
      tone: 'danger',
      hint: '셸 — 프로젝트 폴더의 터미널에서 바로 실행합니다 (대화에는 안 들어갑니다)',
      async candidates() {
        return []
      },
      async pick() {
        return { kind: 'error', message: '고를 항목이 없습니다' }
      },
      async submit(scope, line) {
        const command = line.slice(1).trim()
        if (!command) return { kind: 'error', message: '실행할 명령을 입력하세요' }
        try {
          await ctx.terminals.run(scope.directory, command)
        } catch (error) {
          return { kind: 'error', message: `터미널을 열지 못했습니다: ${(error as Error).message}` }
        }
        return { kind: 'shell', directory: scope.directory }
      },
    }),
  )
}
BangTrigger.inject = ['triggers', 'terminals']
