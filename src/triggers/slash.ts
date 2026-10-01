import type { Context } from 'cordis'
import '../services/triggers.ts'
import '../services/llm.ts'

// `/` 명령 — 입력 첫 글자일 때만 (closed-code composerMode: 경로·날짜의 `/` 를 명령으로 잡지 않는다).
// 목록은 그 폴더의 opencode 명령(내장 init·review, 설정 폴더·프로젝트 .opencode/command·opencode.json). 실행은 앱이 template 을
// 풀어 평범한 프롬프트로 보낸다 — 신규 세대엔 명령 실행이 없고, 레거시 /session/{id}/command 는 기록·맥락이 갈라진다 (01d Q2).
// 모르는 `/xxx` 는 막고 알린다 (사용자 결정 2026-10-01, dsh 방식 — 명령 줄을 몰래 평범한 프롬프트로 바꾸지 않는다).
// 명령의 agent 필드는 아직 안 따른다 — 첫 턴엔 세션이 없어 바꿀 곳이 없고, 바꾼 agent 가 다음 턴에도 남는지 안 쟀다 (01d).

/** opencode 의 치환 규칙 (01d 레거시 실측): `$ARGUMENTS` = 인자 전체, `$1`·`$2`… = 공백으로 나눈 조각. 없는 조각은 빈 글자 */
export function expandTemplate(template: string, args: string): string {
  const parts = args.split(/\s+/).filter(Boolean)
  return template.replace(/\$(ARGUMENTS|\d+)/g, (_match, key: string) => (key === 'ARGUMENTS' ? args : (parts[Number(key) - 1] ?? '')))
}

export function SlashTrigger(ctx: Context): void {
  ctx.effect(() =>
    ctx.triggers.register({
      char: '/',
      opensAt: 'start',
      async candidates(scope, query) {
        const needle = query.toLowerCase()
        const commands = (await ctx.llm.listCommands(scope.directory)).filter((command) => command.name.toLowerCase().includes(needle))
        // 이름이 질의로 시작하는 것이 먼저 (dsh menu: 접두가 먼저)
        commands.sort((a, b) => Number(!a.name.toLowerCase().startsWith(needle)) - Number(!b.name.toLowerCase().startsWith(needle)))
        return commands.map((command) => ({ id: command.name, label: `/${command.name}`, detail: command.description, icon: 'command', group: '명령' }))
      },
      // 고르면 이름만 채운다 — 인자를 이어 치고 Enter 로 낸다
      async pick(_scope, id) {
        return { kind: 'insert', text: `/${id} ` }
      },
      async submit(scope, line) {
        const match = /^\/(\S*)\s*([\s\S]*)$/.exec(line)
        const name = match?.[1] ?? ''
        const command = name ? (await ctx.llm.listCommands(scope.directory)).find((entry) => entry.name === name) : undefined
        if (!command) return { kind: 'error', message: name ? `모르는 명령입니다: /${name}` : '명령 이름을 입력하세요' }
        return { kind: 'send', text: expandTemplate(command.template, match![2]!.trim()), display: line }
      },
    }),
  )
}
SlashTrigger.inject = ['triggers', 'llm']
