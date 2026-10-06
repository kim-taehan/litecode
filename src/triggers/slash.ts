import type { Context } from 'cordis'
import '../services/triggers.ts'
import type { AppCommand } from '../services/triggers.ts'
import '../services/llm.ts'
import { skillPrompt, type SkillInfo } from '../services/skills.ts'
import { tr } from '../i18n.ts'

// `/` 명령 — 입력 첫 글자일 때만 (closed-code composerMode: 경로·날짜의 `/` 를 명령으로 잡지 않는다).
// 목록은 그 폴더의 opencode 명령(내장 init·review, 설정 폴더·프로젝트 .opencode/command·opencode.json). 실행은 앱이 template 을
// 풀어 평범한 프롬프트로 보낸다 — 신규 세대엔 명령 실행이 없고, 레거시 /session/{id}/command 는 기록·맥락이 갈라진다 (01d Q2).
// 모르는 `/xxx` 는 막고 알린다 (사용자 결정 2026-10-01, dsh 방식 — 명령 줄을 몰래 평범한 프롬프트로 바꾸지 않는다).
// 명령의 agent 필드는 아직 안 따른다 — 첫 턴엔 세션이 없어 바꿀 곳이 없고, 바꾼 agent 가 다음 턴에도 남는지 안 쟀다 (01d).
// 스킬(이슈 #7)도 같은 `/` 에 "스킬" 그룹으로 섞는다(dsh — 이름이 겹치면 명령이 이긴다). 고르면 앱이 SKILL.md 본문을 붙여 보내고 말풍선엔
// 친 글 그대로(`/이름 인자`). 스킬은 기능 묶음(ctx.skills)이라 꺼져 있으면 없다 — 그래서 inject 가 아니라 쓸 때 ctx.get 으로 본다
// 앱 명령(이슈 #144, 사용자 결정 2026-10-06 — 둘뿐이다)은 맨 위 "앱" 그룹이고 엔진에 보내지 않는다: 화면이 결과를 받아 그 동작을 한다.
// 이름이 겹치면 앱 명령 > 엔진 명령 > 스킬. 인자를 받지 않는다 — 인자가 있으면 무시하지 않고 막고 알린다

const APP_COMMANDS: readonly { name: AppCommand; detail: 'trigger.app.compact' | 'trigger.app.clear' }[] = [
  { name: 'compact', detail: 'trigger.app.compact' },
  { name: 'clear', detail: 'trigger.app.clear' },
]
const isApp = (name: string): boolean => APP_COMMANDS.some((app) => app.name === name)

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
        const apps = APP_COMMANDS.filter((app) => app.name.includes(needle))
        const all = await ctx.llm.listCommands(scope.directory)
        const commands = all.filter((command) => command.name.toLowerCase().includes(needle) && !isApp(command.name))
        const skills = (await listSkills(scope.directory)).filter(
          (skill) => skill.name.toLowerCase().includes(needle) && !isApp(skill.name) && !all.some((command) => command.name === skill.name),
        )
        // 이름이 질의로 시작하는 것이 먼저 (dsh menu: 접두가 먼저)
        const byPrefix = (a: { name: string }, b: { name: string }) => Number(!a.name.toLowerCase().startsWith(needle)) - Number(!b.name.toLowerCase().startsWith(needle))
        apps.sort(byPrefix)
        commands.sort(byPrefix)
        skills.sort(byPrefix)
        return [
          ...apps.map((app) => ({ id: app.name, label: `/${app.name}`, detail: tr(app.detail), icon: 'app' as const, group: tr('trigger.group.app') })),
          ...commands.map((command) => ({ id: command.name, label: `/${command.name}`, detail: command.description, icon: 'command' as const, group: tr('trigger.group.commands') })),
          ...skills.map((skill) => ({ id: skill.name, label: `/${skill.name}`, detail: skill.description, icon: 'skill' as const, group: tr('trigger.group.skills') })),
        ]
      },
      // 고르면 이름만 채운다 — 인자를 이어 치고 Enter 로 낸다
      async pick(_scope, id) {
        return { kind: 'insert', text: `/${id} ` }
      },
      async submit(scope, line) {
        const match = /^\/(\S*)\s*([\s\S]*)$/.exec(line)
        const name = match?.[1] ?? ''
        const app = APP_COMMANDS.find((entry) => entry.name === name)
        if (app) return match![2]!.trim() ? { kind: 'error', message: tr('error.commandNoArgs', { name }) } : { kind: 'app', command: app.name }
        const command = name ? (await ctx.llm.listCommands(scope.directory)).find((entry) => entry.name === name) : undefined
        if (command) return { kind: 'send', text: expandTemplate(command.template, match![2]!.trim()), display: line }
        const skill = name ? (await listSkills(scope.directory)).find((entry) => entry.name === name) : undefined
        if (skill) return { kind: 'send', text: skillPrompt(skill, match![2]!.trim()), display: line }
        return { kind: 'error', message: name ? tr('error.unknownCommand', { name }) : tr('error.commandName') }
      },
    }),
  )

  /** 스킬 기능이 꺼졌으면 없다. 목록을 못 받으면 명령만 (dsh: 실패한 소스는 조용히 뺀다) */
  async function listSkills(directory: string): Promise<SkillInfo[]> {
    const skills = ctx.get('skills')
    if (!skills) return []
    return skills.list(directory).catch((error: unknown) => {
      console.warn('[triggers] 스킬 목록 실패', (error as Error).message)
      return []
    })
  }
}
SlashTrigger.inject = ['triggers', 'llm']
