import type { Context } from 'cordis'
import fs from 'node:fs/promises'
import path from 'node:path'
import { projectFile } from '../../fileMentions.ts'
import type { AppMcpTool } from '../rpc.ts'
import '../../appMcp.ts'

// open_file (이슈 #51, 01z 3-3) — 그 프로젝트의 파일을 오른쪽 패널에 연다. 내용을 돌려주지 않는다(그건 read 도구).
// 경로 판정은 파일 칩·미리보기와 같은 projectFile — realpath 로 풀어 프로젝트 안의 일반 파일일 때만(링크로 밖을 가리키면 거절, 폴더 거절).
// 절대 경로도 받는다(모델이 자주 준다) — path.resolve 가 그대로 쓰고, 프로젝트 밖이면 같은 판정에 걸린다.
// 설명·결과 글은 모델이 읽는다 — 화면 언어와 무관하게 영어 (tr() 을 타지 않는다)

export interface OpenFileTarget {
  /** 프로젝트 기준 상대 경로 (`/` 구분) — 화면은 이 모양으로 탭을 연다 */
  path: string
  /** 1부터. 없거나 쓸 수 없는 값이면 파일 첫머리 */
  line?: number
}

/** 인자 → 열 파일. 못 쓰는 인자는 던진다 — 그 글이 모델에 가서 고쳐 부를 근거가 된다 */
export async function openFileTarget(directory: string, args: Record<string, unknown>): Promise<OpenFileTarget> {
  const asked = args['path']
  if (typeof asked !== 'string' || !asked.trim()) throw new Error('path is required (project-relative).')
  const file = await projectFile(directory, asked.trim())
  if (!file) throw new Error(`Not a file inside this project: ${asked}`)
  const relative = path.relative(await fs.realpath(directory), file).split(path.sep).join('/')
  const line = Number(args['line'])
  return { path: relative, ...(Number.isInteger(line) && line >= 1 && { line }) }
}

export function OpenFileTool(ctx: Context): void {
  const tool: AppMcpTool = {
    name: 'open_file',
    description:
      'Show a file from this project in the litecode side panel so the user can look at it. Use when the user asks to see or open a file. It does not return the file content — use the read tool for that. Fails if the user is currently viewing another project.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Project-relative path. Absolute paths inside the project are accepted.' },
        line: { type: 'number', description: '1-based line to scroll to and highlight. Omit to open at the top.' },
      },
      required: ['path'],
    },
    async run(args, { directory }) {
      const target = await openFileTarget(directory, args)
      ctx.appMcp.requireViewed(directory)
      ctx.emit('appMcp/open-file', directory, target.path, target.line)
      return target.line ? `Opened ${target.path} at line ${target.line} in the side panel.` : `Opened ${target.path} in the side panel.`
    },
  }
  ctx.effect(() => ctx.appMcp.register(tool))
}
OpenFileTool.inject = ['appMcp']
