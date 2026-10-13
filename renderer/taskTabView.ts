import type { Subtask, TurnItem } from '../shared/ipc.ts'

// 작업 탭(#325)의 모양 — 백그라운드 작업 줄(Subtask)의 진행 줄을 전체 기록 블록으로 바꾼다. 진행 줄은 메인이 상한을 걸어 전문으로 쌓는다
// (shared/tasks.ts addTaskItem). 여기는 접기·앞부분만 정한다 — 그리기는 TaskTab.tsx

/** 생각·지시문이 이보다 길면 접어서 시작한다 */
export const FOLD_CHARS = 600
export const FOLD_LINES = 8
/** 도구 결과를 접힌 채 보일 줄 수 */
export const RESULT_HEAD_LINES = 4

export interface Folded {
  text: string
  /** 접혔을 때 보일 앞부분 — 접을 만큼 길지 않으면 undefined */
  preview?: string
}

/** 긴 글은 앞 FOLD_LINES 줄·FOLD_CHARS 자까지를 앞부분으로 */
export function fold(text: string): Folded {
  const lines = text.split('\n')
  if (text.length <= FOLD_CHARS && lines.length <= FOLD_LINES) return { text }
  const head = lines.slice(0, FOLD_LINES).join('\n')
  return { text, preview: `${head.length > FOLD_CHARS ? head.slice(0, FOLD_CHARS) : head}…` }
}

export type TranscriptBlock =
  | ({ kind: 'think'; id: string } & Folded)
  | { kind: 'text'; id: string; text: string }
  | {
      kind: 'tool'
      id: string
      name: string
      summary?: string
      status: 'preparing' | 'running' | 'done' | 'error'
      /** 인자 — JSON 이면 들여쓴 모양 */
      input?: string
      result?: string
      /** 결과 앞부분 (RESULT_HEAD_LINES 줄) */
      head?: string
      /** 결과 줄 수 */
      lines: number
      /** "전체 보기" 를 둘 만큼 숨긴 것이 있다 (입력이 있거나 결과가 앞부분보다 길다) */
      more: boolean
      error?: string
    }

/** 진행 줄 → 전체 기록 블록 (나타난 순서). 생각·응답 글·도구만 — 압축·재시도·훅 같은 줄은 작업 탭에 그리지 않는다. 빈 생각·글은 뺀다 */
export function transcript(items: readonly TurnItem[]): TranscriptBlock[] {
  const blocks: TranscriptBlock[] = []
  for (const item of items) {
    if (item.kind === 'think') {
      const text = item.text.trim()
      if (text) blocks.push({ kind: 'think', id: item.id, ...fold(text) })
    } else if (item.kind === 'text') {
      if (item.text.trim()) blocks.push({ kind: 'text', id: item.id, text: item.text })
    } else if (item.kind === 'tool') {
      const result = item.result ? item.result.replace(/\n+$/, '') : undefined
      const resultLines = result ? result.split('\n') : []
      const input = item.input ? prettyInput(item.input) : undefined
      blocks.push({
        kind: 'tool',
        id: item.id,
        name: item.mcp ? `${item.mcp.server}/${item.mcp.tool}` : item.name,
        ...(item.summary && { summary: item.summary }),
        status: item.status,
        ...(input && { input }),
        ...(result && { result, head: resultLines.slice(0, RESULT_HEAD_LINES).join('\n') }),
        lines: resultLines.length,
        more: !!input || resultLines.length > RESULT_HEAD_LINES,
        ...(item.error && { error: item.error }),
      })
    }
  }
  return blocks
}

/** 인자 JSON 을 들여쓴 모양으로 — JSON 이 아니면(잘린 것 등) 그대로 */
export function prettyInput(input: string): string {
  try {
    return JSON.stringify(JSON.parse(input), null, 2)
  } catch {
    return input
  }
}

/** 탭 이름·머리의 번호와 설명 — 번호는 작업 id(`bgtask:<대화>:<번호>`)의 끝, 설명은 작업 줄의 "#N 설명" 에서 "#N " 을 뗀 것 */
export function taskTitle(taskId: string, task: Subtask | undefined): { number: string; description: string } {
  const number = taskId.slice(taskId.lastIndexOf(':') + 1)
  const description = (task?.description ?? '').replace(/^#\d+\s+/, '')
  return { number, description }
}
