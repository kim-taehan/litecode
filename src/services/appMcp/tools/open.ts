import type { Context } from 'cordis'
import fs from 'node:fs/promises'
import { projectFile } from '../../fileMentions.ts'
import { insideOf } from '../../projectPath.ts'
import type { AppMcpTool } from '../rpc.ts'
import '../../appMcp.ts'
import '../../terminals.ts'

// open (이슈 #51, 01z 3-3 — 도구 수 줄이기로 open_file·open_terminal 을 kind 로 합쳤다, 2026-10-06) — 화면만 연다. 둘 다 묻지 않는 같은 권한이다.
//
// kind 'file' — 그 프로젝트의 파일을 오른쪽 패널에 연다. 내용을 돌려주지 않는다(그건 read 도구).
// 경로 판정은 파일 칩·미리보기와 같은 projectFile — realpath 로 풀어 프로젝트 안의 일반 파일일 때만(링크로 밖을 가리키면 거절, 폴더 거절).
// 절대 경로도 받는다(모델이 자주 준다) — path.resolve 가 그대로 쓰고, 프로젝트 밖이면 같은 판정에 걸린다.
//
// kind 'terminal' — 터미널 칸을 펴고 명령을 **채워만** 둔다. 엔터는 사용자가 친다 — 이 갈래의 값은 그것 하나다
// (바로 돌릴 것이면 모델에게는 bash 도구가 있다). 그래서 실행돼 버리는 글자를 막는다:
// 개행(\n·\r)이 섞이면 셸에 들어가는 즉시 그 자리까지 실행된다(closed-code 실측, opencode 1.18.18 pty·zsh). ESC·탭 같은 다른 C0 제어문자·DEL 도
// 셸에서 제 뜻대로 움직인다(완성·키 바인딩) — 한 줄 명령에 필요 없으니 통째로 거절한다.
// 터미널 칸(기능)을 끄면 도구는 남고 이 갈래만 "꺼져 있다" 를 돌려준다 (만들기 도구의 훅 갈래와 같은 모양 — 도구 하나라 목록에서 뺄 수 없다).
//
// 설명·결과 글은 모델이 읽는다 — 화면 언어와 무관하게 영어 (tr() 을 타지 않는다)

export const OPEN_TOOL = 'open'

// C0·DEL·C1 + 방향 제어(LRE~RLO·LRI~PDI·LRM/RLM)·보이지 않는 글자(ZWSP·ZWNJ·ZWJ·WJ·BOM) — 뒤의 둘은 사용자가 확인하는 글자를 실제와 달라
// 보이게 한다 (이슈 #178, 02x B 4-10)
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩‎‏​-‍⁠﻿]/

export interface OpenFileTarget {
  /** 프로젝트 기준 상대 경로 (`/` 구분) — 화면은 이 모양으로 탭을 연다 */
  path: string
  /** 1부터. 없거나 쓸 수 없는 값이면 파일 첫머리 */
  line?: number
}

/** 인자 → 열 파일. 못 쓰는 인자는 던진다 — 그 글이 모델에 가서 고쳐 부를 근거가 된다 */
export async function openFileTarget(directory: string, args: Record<string, unknown>): Promise<OpenFileTarget> {
  const asked = args['path']
  if (typeof asked !== 'string' || !asked.trim()) throw new Error('kind "file" needs path (project-relative).')
  const file = await projectFile(directory, asked.trim())
  if (!file) throw new Error(`Not a file inside this project: ${asked}`)
  const relative = insideOf(await fs.realpath(directory), file)! // projectFile 이 폴더 안의 파일만 준다
  const line = Number(args['line'])
  return { path: relative, ...(Number.isInteger(line) && line >= 1 && { line }) }
}

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

export function OpenTool(ctx: Context): void {
  async function openFile(directory: string, args: Record<string, unknown>): Promise<string> {
    const target = await openFileTarget(directory, args)
    ctx.appMcp.requireViewed(directory)
    ctx.emit('appMcp/open-file', directory, target.path, target.line)
    return target.line ? `Opened ${target.path} at line ${target.line} in the side panel.` : `Opened ${target.path} in the side panel.`
  }

  async function openTerminal(directory: string, args: Record<string, unknown>): Promise<string> {
    const command = terminalCommand(args)
    const terminals = ctx.get('terminals')
    if (!terminals) throw new Error('The terminal pane is turned off in Settings > Features, so nothing was opened.')
    ctx.appMcp.requireViewed(directory)
    if (command) await terminals.write(directory, command)
    ctx.emit('appMcp/open-terminal', directory)
    return command ? `Typed into the terminal (not executed): ${command}` : 'Opened the terminal pane.'
  }

  const tool: AppMcpTool = {
    name: OPEN_TOOL,
    description:
      'Show something to the user in the litecode window. kind "file": open a project file in the side panel (optionally at a line); it does not return the content — use the read tool for that. kind "terminal": open the terminal pane and type a one-line command **without running it** — the user reviews it and presses Enter; no output comes back — use the shell tool when you need the result. Fails if the user is viewing another project.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['file', 'terminal'] },
        path: { type: 'string', description: 'file: project-relative path (absolute paths inside the project are accepted).' },
        line: { type: 'number', description: 'file: 1-based line to scroll to and highlight.' },
        command: { type: 'string', description: 'terminal: one line to type. Omit to only open the pane. Newlines are rejected.' },
      },
      required: ['kind'],
    },
    async run(args, { directory }) {
      if (args['kind'] === 'file') return openFile(directory, args)
      if (args['kind'] === 'terminal') return openTerminal(directory, args)
      throw new Error('kind must be "file" or "terminal".')
    },
  }
  ctx.effect(() => ctx.appMcp.register(tool))
}
OpenTool.inject = ['appMcp']
