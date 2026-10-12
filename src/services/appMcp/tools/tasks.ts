import type { Context } from 'cordis'
import { realDirectory } from '../../projectPath.ts'
import { APP_MCP_NAME } from '../../mcp.ts'
import type { AppMcpTool } from '../rpc.ts'
import { isTaskAgent, TASK_AGENTS, TASK_DESCRIPTION_MAX, TASK_PROMPT_MAX, TASK_START_TOOL } from '../../../../shared/tasks.ts'
import '../../appMcp.ts'
import '../../chat.ts'
import '../../llm.ts'
import '../../sessions.ts'

// 백그라운드 하위 작업 도구 (이슈 #319) — 내장 task 를 대신한다(엔진 설정에서 껐다). 작업은 ctx.chat 이 따로 만든 세션에서 돌리고(backgroundTasks.ts),
// 이 도구는 번호만 곧바로 돌려준다 — 메인 턴은 기다리지 않고 끝나고, 결과는 끝날 때 새 턴(출처 'task')으로 들어온다.
// 부른 대화: 목표 도구와 같은 길(ctx.llm.callerOf → 저장된 대화의 engineSessionId). 작업 세션이 부르면 거절(재귀 금지 — 작업 턴에선 도구도 숨긴다).
// 엔진 권한 규칙은 따로 적지 않았다 — 계획은 `*_*: deny` 라 도구가 없고(내장 task 를 막던 것과 같다), 매번 묻기는 `*_*: ask` 로 시작마다 묻고,
// 기본·전체 권한은 묻지 않는다. 설명·결과 글은 모델이 읽는다 — 영어

const NO_CALLER = 'Could not tell which conversation made this call. Call the tool again.'

function text(args: Record<string, unknown>, name: string, max: number): string {
  const value = args[name]
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required.`)
  if (value.length > max) throw new Error(`${name} is too long (${value.length} characters, the limit is ${max}).`)
  return value.trim()
}

export function TaskTools(ctx: Context): void {
  const start: AppMcpTool = {
    name: TASK_START_TOOL,
    description:
      'Start a sub-task that runs in the background in its own session, and return at once with its task number. It does not block: keep working on something else or end your turn — ' +
      'the result arrives later as a new message in this conversation. Do not wait, sleep or poll for it, and do not duplicate its work. ' +
      'Only a few tasks run at once in a conversation (2 by default, the user can change it); further ones wait in a queue and start when one ends — ' +
      'so you may start several at once. ' +
      'agent "explore": read-only research (search and read files). agent "general": multi-step work with this conversation\'s permissions. ' +
      'The sub-task cannot ask the user anything (actions that need approval are refused), cannot see this conversation, and cannot start tasks — make the prompt self-contained.',
    inputSchema: {
      type: 'object',
      properties: {
        agent: { type: 'string', enum: [...TASK_AGENTS] },
        description: { type: 'string', description: `A short (3-5 words) description, at most ${TASK_DESCRIPTION_MAX} characters.` },
        prompt: { type: 'string', description: `The full instructions for the sub-task, at most ${TASK_PROMPT_MAX} characters.` },
      },
      required: ['agent', 'description', 'prompt'],
    },
    async run(args, { directory }) {
      const agent = args['agent']
      if (!isTaskAgent(agent)) throw new Error(`agent must be one of: ${TASK_AGENTS.join(', ')}.`)
      const description = text(args, 'description', TASK_DESCRIPTION_MAX)
      const prompt = text(args, 'prompt', TASK_PROMPT_MAX)
      const found = await ctx.llm.callerOf(directory, { server: APP_MCP_NAME, tool: TASK_START_TOOL }, args)
      if (!found) throw new Error(NO_CALLER)
      if (found.child || ctx.chat.isTaskSession(found.sessionId)) throw new Error('A background task cannot start other tasks. Do the work yourself.')
      const conversation = (await ctx.sessions.list()).find((entry) => entry.engineSessionId === found.sessionId)
      if (!conversation || (await realDirectory(conversation.project)) !== directory) throw new Error(NO_CALLER)
      const { number, queued, limit } = await ctx.chat.startTask(conversation.id, { agent, description, prompt })
      const head = queued
        ? `Queued background task ${number} (${agent}): "${description}". ${limit} tasks are already running in this conversation; it starts when one of them ends.`
        : `Started background task ${number} (${agent}): "${description}". It runs on its own (at most ${limit} at once; more wait in a queue).`
      return (
        `${head} Its result will arrive as a new message when it ends. ` +
        'Do not wait or poll for it — continue with other work, or briefly tell the user what you started and end your response.'
      )
    },
  }

  ctx.effect(() => ctx.appMcp.register(start))
}
TaskTools.inject = ['appMcp', 'llm', 'sessions', 'chat']
