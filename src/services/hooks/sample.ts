import path from 'node:path'
import { matchesTool, type HookEvent } from '../../../shared/hooks.ts'
import type { HookInput } from './run.ts'

// 시험 실행의 견본 입력 (이슈 #102 3단계) — 훅 팝업의 [시험 실행] 이 실제 사건 대신 넘기는 것. 모양은 진짜 사건과 같다 (run.ts hookStdin).
// 도구 훅은 매처에 맞는 첫 견본 도구로 — 맞는 것이 없으면(MCP 도구 매처 등) bash.

export const SAMPLE_CONVERSATION = 'hook-test'

/** 견본 도구 인자 — 엔진(레거시)의 인자 이름 그대로 (read·write·edit 는 filePath). file: 파일 도구면 프로젝트 기준 경로 */
const SAMPLE_TOOLS: readonly { name: string; file?: string; input(file: string): Record<string, unknown> }[] = [
  { name: 'bash', input: () => ({ command: 'echo hello', description: 'Print a greeting' }) },
  { name: 'edit', file: 'src/example.ts', input: (file) => ({ filePath: file, oldString: 'before', newString: 'after' }) },
  { name: 'write', file: 'src/example.ts', input: (file) => ({ filePath: file, content: 'export const example = 1\n' }) },
  { name: 'read', file: 'src/example.ts', input: (file) => ({ filePath: file }) },
  { name: 'task', input: () => ({ description: 'Sample task', prompt: 'Look around the project', subagent_type: 'general' }) },
  { name: 'todowrite', input: () => ({ todos: [{ content: 'Sample todo', status: 'pending' }] }) },
]

/** 그 이벤트의 견본 사건. directory 는 프로젝트 폴더(realpath) */
export function sampleHookInput(event: HookEvent, matcher: string, directory: string): HookInput {
  const base: HookInput = { event, directory, conversationId: SAMPLE_CONVERSATION, mode: 'build' }
  if (event === 'PreToolUse' || event === 'PostToolUse') {
    const tool = SAMPLE_TOOLS.find((sample) => matchesTool(matcher, sample.name)) ?? SAMPLE_TOOLS[0]!
    const file = tool.file && path.join(directory, tool.file)
    return { ...base, tool: { name: tool.name, input: tool.input(file ?? ''), ...(event === 'PostToolUse' && { response: 'ok' }), ...(file && { file }) } }
  }
  if (event === 'UserPromptSubmit') return { ...base, prompt: 'Sample prompt' }
  if (event === 'Notification') return { ...base, notification: { type: 'done', message: 'Sample notification' } }
  return base
}
