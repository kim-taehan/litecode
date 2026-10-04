import type { Context } from 'cordis'
import type { AppMcpTool } from '../rpc.ts'
import '../../appMcp.ts'
import '../../terminals.ts'

// open_terminal (이슈 #51, 01z 3-3) — 터미널 칸을 펴고 명령을 **채워만** 둔다. 엔터는 사용자가 친다 — 이 도구의 값은 그것 하나다
// (바로 돌릴 것이면 모델에게는 bash 도구가 있다). 그래서 실행돼 버리는 글자를 막는다:
// 개행(\n·\r)이 섞이면 셸에 들어가는 즉시 그 자리까지 실행된다(closed-code 실측, opencode 1.18.18 pty·zsh). ESC·탭 같은 다른 C0 제어문자·DEL 도
// 셸에서 제 뜻대로 움직인다(완성·키 바인딩) — 한 줄 명령에 필요 없으니 통째로 거절한다.
// ctx.terminals 가 있어야 올라간다 — 터미널 칸(기능)을 끄면 이 도구는 목록에서 빠진다(ctx.appMcp 가 다시 붙이게 한다).

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/

/** 채울 명령 — 없으면 undefined(칸만 편다). 양끝 공백·개행은 뗀다(모델은 실행할 셈으로 끝에 개행을 붙인다 — 명령의 일부가 아니다).
 *  가운데 것은 못 뗀다: 공백으로 바꾸면 사용자가 확인할 글자가 모델이 말한 것과 달라진다 */
export function terminalCommand(args: Record<string, unknown>): string | undefined {
  const asked = args['command']
  if (asked === undefined || asked === null) return undefined
  if (typeof asked !== 'string') throw new Error('command must be a string.')
  const command = asked.trim()
  if (!command) return undefined
  if (CONTROL_CHARS.test(command)) throw new Error('Multi-line commands and control characters are rejected — they would run immediately.')
  return command
}

export function OpenTerminalTool(ctx: Context): void {
  const tool: AppMcpTool = {
    name: 'open_terminal',
    description:
      'Open the terminal pane and **type a command without running it**. The user reviews it and presses Enter. Use for commands the user should decide on (destructive, long-running, needing their credentials). Nothing is executed and no output comes back — use the shell tool when you need the result.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'One line to type into the terminal. Omit to only open the pane. Newlines are rejected.' },
      },
    },
    async run(args, { directory }) {
      const command = terminalCommand(args)
      ctx.appMcp.requireViewed(directory)
      if (command) await ctx.terminals.write(directory, command)
      ctx.emit('appMcp/open-terminal', directory)
      return command ? `Typed into the terminal (not executed): ${command}` : 'Opened the terminal pane.'
    },
  }
  ctx.effect(() => ctx.appMcp.register(tool))
}
OpenTerminalTool.inject = ['appMcp', 'terminals']
