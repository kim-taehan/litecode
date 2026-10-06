import type { Context } from 'cordis'
import fs from 'node:fs/promises'
import { projectFile } from '../../fileMentions.ts'
import { insideOf } from '../../projectPath.ts'
import type { AppMcpTool } from '../rpc.ts'
import '../../appMcp.ts'

// present (이슈 #91, dsh deliverables/tool-present 의 아이디어) — AI 가 "이 파일들이 이번 작업의 결과물" 이라고 선언한다. 화면을 조작하지 않는다
// (패널을 열지 않는다) — 선언은 그 도구 호출 기록에만 남고, 화면이 턴이 끝난 뒤 답 아래 "결과물" 카드로 그린다. 내용은 복사하지 않는다(경로·제목만).
// 경로 판정은 open(파일) 과 같은 projectFile — realpath 로 풀어 프로젝트 안의 일반 파일일 때만(dsh 는 프로젝트 밖도 받지만 우리는 다른 화면 도구와 같은 경계).
//
// **전부 받아들였을 때만 성공이다.** 엔진(opencode 1.18.18)은 MCP 결과의 structuredContent 를 파트에 남기지 않는다(동봉 바이너리에서 MCP SDK 의
// 스키마·검증 말고는 쓰는 곳이 없다) → 화면이 받아들인 목록을 아는 길은 "성공한 호출의 인자" 뿐이다(turnProgress.ts 가 그렇게 읽는다, 결과 글은
// 파싱하지 않는다). 일부만 받아들이면 그 둘이 어긋나므로 하나라도 못 쓰면 isError + 항목별 사유로 거절하고 모델이 고쳐 다시 부르게 한다.
// 설명·결과 글은 모델이 읽는다 — 화면 언어와 무관하게 영어 (tr() 을 타지 않는다)

/** 한 번에 선언할 수 있는 파일 수 */
export const PRESENT_MAX_FILES = 10

const NOT_A_FILE = 'not a file inside this project (missing, a folder, or outside the project)'

/** 인자 → 선언한 파일의 프로젝트 기준 상대 경로들. 하나라도 못 쓰면 던진다 — 그 글이 모델에 가서 고쳐 부를 근거가 된다 */
export async function presentedPaths(directory: string, args: Record<string, unknown>): Promise<string[]> {
  const files = args['files']
  if (!Array.isArray(files) || files.length < 1 || files.length > PRESENT_MAX_FILES) throw new Error(`files must be a list of 1 to ${PRESENT_MAX_FILES} entries.`)
  const root = await fs.realpath(directory)
  const accepted: string[] = []
  const rejected: string[] = []
  for (const [index, entry] of files.entries()) {
    const asked = entry && typeof entry === 'object' ? (entry as { path?: unknown }).path : undefined
    if (typeof asked !== 'string' || !asked.trim()) {
      rejected.push(`entry ${index + 1}: path is required`)
      continue
    }
    const file = await projectFile(directory, asked.trim())
    if (file) accepted.push(insideOf(root, file)!) // projectFile 이 폴더 안의 파일만 준다
    else rejected.push(`${asked}: ${NOT_A_FILE}`)
  }
  if (rejected.length > 0) {
    throw new Error(
      [
        'Nothing was presented. Fix or drop the rejected entries and call again with the full list.',
        'Rejected:',
        ...rejected.map((line) => `- ${line}`),
        ...(accepted.length > 0 ? ['Accepted:', ...accepted.map((line) => `- ${line}`)] : []),
      ].join('\n'),
    )
  }
  return accepted
}

export function PresentTool(ctx: Context): void {
  const tool: AppMcpTool = {
    name: 'present',
    description:
      'Declare the final deliverable files of your work; the user sees them as a card under your answer. Call it once when the work is done, with the files the user asked for (a report, a generated page, the main output) — not every file you touched. If any entry is rejected, nothing is presented.',
    inputSchema: {
      type: 'object',
      properties: {
        files: {
          type: 'array',
          minItems: 1,
          maxItems: PRESENT_MAX_FILES,
          description: `1 to ${PRESENT_MAX_FILES} existing files inside this project.`,
          items: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'Project-relative path. Absolute paths inside the project are accepted.' },
              title: { type: 'string', description: 'Short label shown instead of the file name.' },
            },
            required: ['path'],
          },
        },
      },
      required: ['files'],
    },
    async run(args, { directory }) {
      const paths = await presentedPaths(directory, args)
      return `Presented ${paths.length} ${paths.length === 1 ? 'file' : 'files'} to the user: ${paths.join(', ')}. They are listed in a card under your answer.`
    },
  }
  ctx.effect(() => ctx.appMcp.register(tool))
}
PresentTool.inject = ['appMcp']
