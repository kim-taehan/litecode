import type { Context } from 'cordis'
import '../services/triggers.ts'

// `!` 셸 — 입력 첫 글자가 `!` 면 셸 모드. 입력창 색으로 경고하고(closed-code composerMode: `!rm -rf` 를 질문으로 착각해 보내지
// 않게), Enter 로 그 명령을 낸다 — 화면이 그 대화에 결과 카드를 붙이고 메인(ctx.shell)이 프로젝트 폴더에서 한 번 돌린다.
// 결과는 대화 맥락에 넣지 않는다. 사용자가 카드의 "AI 에게 보내기" 를 누를 때만 들어간다 (사용자 결정 2026-10-02, closed-code 방식).
// 터미널 칸과는 별개다(⌘↓). opencode 의 bash 권한 규칙을 거치지 않는다 — 사용자가 직접 친 명령이다.

export function BangTrigger(ctx: Context): void {
  ctx.effect(() =>
    ctx.triggers.register({
      char: '!',
      opensAt: 'start',
      wholeLine: true,
      tone: 'danger',
      hint: '셸 — 프로젝트 폴더에서 바로 실행하고 결과를 카드로 남깁니다 (AI 에게는 카드에서 보낼 때만)',
      async candidates() {
        return []
      },
      async pick() {
        return { kind: 'error', message: '고를 항목이 없습니다' }
      },
      async submit(scope, line) {
        const command = line.slice(1).trim()
        if (!command) return { kind: 'error', message: '실행할 명령을 입력하세요' }
        return { kind: 'shell', directory: scope.directory, command }
      },
    }),
  )
}
BangTrigger.inject = ['triggers']
