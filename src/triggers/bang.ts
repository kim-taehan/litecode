import type { Context } from 'cordis'
import '../services/triggers.ts'
import '../services/terminals.ts'
import { tr } from '../i18n.ts'

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
      // 물을 때마다 읽는다 — 언어를 바꾸면 다음 안내부터 그 언어로
      get hint() {
        return tr('trigger.bang.hint')
      },
      async candidates() {
        return []
      },
      async pick() {
        return { kind: 'error', message: tr('error.nothingToPick') }
      },
      async submit(scope, line) {
        const command = line.slice(1).trim()
        if (!command) return { kind: 'error', message: tr('error.commandRequired') }
        try {
          await ctx.terminals.run(scope.directory, command)
        } catch (error) {
          return { kind: 'error', message: tr('terminal.openFailed', { message: (error as Error).message }) }
        }
        return { kind: 'shell', directory: scope.directory }
      },
    }),
  )
}
BangTrigger.inject = ['triggers', 'terminals']
