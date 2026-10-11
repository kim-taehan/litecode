import type { Context } from 'cordis'
import { realDirectory } from '../../projectPath.ts'
import { APP_MCP_NAME } from '../../mcp.ts'
import type { AppMcpTool } from '../rpc.ts'
import { GOAL_GET_TOOL, GOAL_MAX_ROUNDS, GOAL_NOTE_MAX, GOAL_UPDATE_TOOL, type Goal } from '../../../../shared/goal.ts'
import '../../appMcp.ts'
import '../../llm.ts'
import '../../sessions.ts'
import '../../goal.ts'

// 목표 도구 둘 (이슈 #285, dsh tool-goal 의 아이디어) — 모델 손잡이. goal_get 은 이 대화의 목표를 읽고, goal_update 는 done·blocked 만 알린다
// (만들기·멈추기·계속은 사람 손잡이 `/goal` 의 몫이다 — dsh 처럼 모델이 목표를 만들거나 고치지 않는다).
// 부른 대화: 호출 요청엔 "누가 불렀나" 가 없다(01z 1-2) — 세션 도구·만들기 도구와 같은 길로 ctx.llm.callerOf 가 그 폴더의 도는 턴에서 찾은 엔진 세션을
// 저장된 대화의 engineSessionId 로 맞춘다. 못 찾으면(앱이 돌린 턴이 아니다) 거절, 하위 작업이 부르면 거절(목표는 메인 대화의 것).
// 엔진 권한 규칙은 따로 적지 않았다 — 기본·전체 권한은 엔진 기본(허용), 매번 묻기는 `*_*: ask` 로 묻고, 계획은 `*_*: deny` 라 도구가 없다.
// 설명·결과 글은 모델이 읽는다 — 영어

const NO_CALLER = 'Could not tell which conversation made this call. Call the tool again.'

/** 모델에 돌려줄 목표 — 없으면 null */
export function goalView(goal: Goal | undefined): string {
  if (!goal) return JSON.stringify({ goal: null })
  return JSON.stringify({ goal: { objective: goal.text, status: goal.status, round: goal.rounds, max_rounds: GOAL_MAX_ROUNDS, ...(goal.note && { note: goal.note }) } })
}

export function GoalTools(ctx: Context): void {
  /** 이 호출을 부른 대화 id — 못 가리면 그 사유를 던진다 (모델이 읽는다) */
  async function caller(directory: string, tool: string, args: Record<string, unknown>): Promise<string> {
    const found = await ctx.llm.callerOf(directory, { server: APP_MCP_NAME, tool }, args)
    if (!found) throw new Error(NO_CALLER)
    if (found.child) throw new Error('Sub-tasks cannot read or update the goal. The main conversation does.')
    const conversation = (await ctx.sessions.list()).find((entry) => entry.engineSessionId === found.sessionId)
    if (!conversation || (await realDirectory(conversation.project)) !== directory) throw new Error(NO_CALLER)
    return conversation.id
  }

  const get: AppMcpTool = {
    name: GOAL_GET_TOOL,
    description: 'Read the goal the user set for this conversation with /goal: objective, status (active, paused, done, blocked) and the current automatic round. Returns {"goal": null} when there is none.',
    inputSchema: { type: 'object', properties: {} },
    async run(args, { directory }) {
      return goalView(await ctx.goal.get(await caller(directory, GOAL_GET_TOOL, args)))
    },
  }

  const update: AppMcpTool = {
    name: GOAL_UPDATE_TOOL,
    description:
      'Report the end of this conversation\'s goal. status "done": the whole objective is achieved and verified. status "blocked": you cannot continue without the user — put the concrete reason in note. ' +
      'Either one stops the automatic continuation. Do not call it while work remains.',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['done', 'blocked'] },
        note: { type: 'string', description: `One line for the user (required for blocked, at most ${GOAL_NOTE_MAX} characters).` },
      },
      required: ['status'],
    },
    async run(args, { directory }) {
      const status = args['status']
      if (status !== 'done' && status !== 'blocked') throw new Error('status must be "done" or "blocked".')
      const note = typeof args['note'] === 'string' ? args['note'].trim() : ''
      if (status === 'blocked' && !note) throw new Error('note is required for blocked: say what stops you.')
      const cid = await caller(directory, GOAL_UPDATE_TOOL, args)
      const finished = await ctx.goal.finish(cid, status, note)
      if (!finished) throw new Error(`There is no open goal in this conversation. Current: ${goalView(await ctx.goal.get(cid))}`)
      return status === 'done' ? 'Goal marked done. Automatic continuation stopped. Tell the user what was achieved.' : 'Goal marked blocked. Automatic continuation stopped. Tell the user what you need.'
    },
  }

  ctx.effect(() => ctx.appMcp.register(get))
  ctx.effect(() => ctx.appMcp.register(update))
}
GoalTools.inject = ['appMcp', 'llm', 'sessions', 'goal']
