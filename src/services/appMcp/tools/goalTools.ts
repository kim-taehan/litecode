import type { Context } from 'cordis'
import { realDirectory } from '../../projectPath.ts'
import { APP_MCP_NAME } from '../../mcp.ts'
import type { AppMcpTool } from '../rpc.ts'
import type { Conversation } from '../../../../shared/contract.ts'
import {
  GOAL_BLOCKED_AFTER_ROUNDS,
  GOAL_CREATE_TOOL,
  GOAL_GET_TOOL,
  GOAL_OBJECTIVE_MAX,
  GOAL_ROUNDS_DEFAULT,
  GOAL_ROUNDS_MAX,
  GOAL_UPDATE_TOOL,
  type GoalView,
} from '../../../../shared/goal.ts'
import '../../appMcp.ts'
import '../../chat.ts'
import '../../goals.ts'
import '../../goalDriver.ts'
import '../../llm.ts'
import '../../sessions.ts'

// 목표 모델 도구 (이슈 #626) — dsh packages/goal/tool-goal 의 충실 이식. get_goal·create_goal·update_goal
// (동작 edit·pause·resume·complete·blocked). 부른 대화는 목표 도구와 같은 길(ctx.llm.callerOf → 저장된 대화의
// engineSessionId). 목적이 이미 있는 대화에서 create, goal 라운드 안에서의 create·edit·pause·resume(dsh
// requireDirectHuman), paused 된 것의 모델 resume — dsh 와 같이 거절한다. 결과는 dsh 의 compact JSON 그대로.

const NO_CALLER = 'Could not tell which conversation made this call. Call the tool again.'

function textValue(args: Record<string, unknown>, name: string, max: number): string {
  const value = args[name]
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required.`)
  if (value.length > max) throw new Error(`${name} is too long (${value.length} characters, the limit is ${max}).`)
  return value.trim()
}

/** dsh goalValue — id·revision(update 의 CAS) 포함 compact JSON */
function goalValue(goal: GoalView | undefined): string {
  if (!goal) return JSON.stringify({ goal: null })
  return JSON.stringify({
    goal: {
      id: goal.id,
      revision: goal.revision,
      objective: goal.objective,
      phase: goal.phase,
      roundsStarted: goal.roundsStarted,
      maxGoalRounds: goal.maxGoalRounds,
      ...(goal.blockedReason ? { blockedReason: { code: goal.blockedReason.code, message: goal.blockedReason.message } } : {}),
    },
    activation: goal.armed ? 'armed' : 'disarmed',
  })
}

export function GoalTools(ctx: Context): void {
  const caller = async (tool: string, args: Record<string, unknown>, directory: string): Promise<Conversation> => {
    const found = await ctx.llm.callerOf(directory, { server: APP_MCP_NAME, tool }, args)
    if (!found) throw new Error(NO_CALLER)
    if (found.child || ctx.chat.isTaskSession(found.sessionId)) throw new Error('A background task cannot set or change the conversation goal.')
    const conversation = (await ctx.sessions.list()).find((entry) => entry.engineSessionId === found.sessionId)
    if (!conversation || (await realDirectory(conversation.project)) !== directory) throw new Error(NO_CALLER)
    return conversation
  }

  const get: AppMcpTool = {
    name: GOAL_GET_TOOL,
    description: 'Read the current goal of this conversation, including the id and revision that update_goal requires.',
    inputSchema: { type: 'object', properties: {} },
    async run(args, { directory }) {
      const conversation = await caller(GOAL_GET_TOOL, args, directory)
      const view = await ctx.goals.view(conversation.id)
      return goalValue(view)
    },
  }

  const create: AppMcpTool = {
    name: GOAL_CREATE_TOOL,
    description:
      'Create a persisted goal that keeps this session working across automatic continuation rounds. ' +
      `Use it when the direct human request is a long-running objective, even if the user did not say "goal"; not for single-turn work. ` +
      `A new goal replaces a completed one only; while another goal is active, paused, or blocked the call fails — update or clear it (the human can, with /goal). ` +
      `The app then continues the goal on its own after each turn, up to ${GOAL_ROUNDS_DEFAULT} rounds unless limited.`,
    inputSchema: {
      type: 'object',
      properties: {
        objective: { type: 'string', description: `The concrete completion objective inferred from the direct human request, at most ${GOAL_OBJECTIVE_MAX} characters.` },
        max_goal_rounds: { type: 'integer', minimum: 1, maximum: GOAL_ROUNDS_MAX, description: `Optional limit on automatic continuation rounds (default ${GOAL_ROUNDS_DEFAULT}).` },
      },
      required: ['objective'],
    },
    async run(args, { directory }) {
      const conversation = await caller(GOAL_CREATE_TOOL, args, directory)
      if (ctx.goalDriver.inRound(conversation.id)) throw new Error('A goal cannot be created during an automatic goal round; report progress or the blocker within the current round instead.')
      const view = await ctx.goals.create(conversation.id, {
        objective: textValue(args, 'objective', GOAL_OBJECTIVE_MAX),
        ...(typeof args['max_goal_rounds'] === 'number' && args['max_goal_rounds'] > 0 ? { maxGoalRounds: args['max_goal_rounds'] } : {}),
      })
      return goalValue(view)
    },
  }

  const update: AppMcpTool = {
    name: GOAL_UPDATE_TOOL,
    description:
      'Update the current goal of this conversation. Actions: edit (new objective and/or round cap — a direct human request), ' +
      'pause / resume (a direct human request; a paused goal can only be resumed by the human), complete (only when the objective is actually achieved), ' +
      `blocked (only after the same blocking condition persists for at least ${GOAL_BLOCKED_AFTER_ROUNDS} consecutive goal rounds — difficulty, uncertainty, or useful ` +
      'remaining work is not blocked). Pass the exact id and revision from get_goal.',
    inputSchema: {
      type: 'object',
      properties: {
        goal_id: { type: 'string', description: 'Exact id returned by get_goal.' },
        revision: { type: 'integer', description: 'Exact positive revision returned by get_goal.' },
        action: { type: 'string', enum: ['edit', 'pause', 'resume', 'complete', 'blocked'], description: 'The update to apply.' },
        objective: { type: 'string', description: 'Replacement objective; valid only with action edit.' },
        max_goal_rounds: { type: 'integer', description: `Replacement cap (1~${GOAL_ROUNDS_MAX}); valid only with action edit.` },
        blocked_reason: { type: 'string', description: 'Required only with action blocked: the concrete condition that persisted across rounds and blocks progress.' },
      },
      required: ['goal_id', 'revision', 'action'],
    },
    async run(args, { directory }) {
      const conversation = await caller(GOAL_UPDATE_TOOL, args, directory)
      const goalId = textValue(args, 'goal_id', 200)
      const revision = args['revision']
      if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 1) throw new Error('revision must be a positive safe integer.')
      const action = args['action']
      if (action !== 'edit' && action !== 'pause' && action !== 'resume' && action !== 'complete' && action !== 'blocked') {
        throw new Error('action must be one of: edit, pause, resume, complete, blocked.')
      }
      const inRound = ctx.goalDriver.inRound(conversation.id)
      const hasText = (value: unknown): value is string => typeof value === 'string' && value.trim() !== ''
      const hasRoundCap = (value: unknown): value is number => typeof value === 'number' && value !== 0
      const invalid = (message: string) => {
        throw new Error(message)
      }
      if (action === 'edit' || action === 'pause' || action === 'resume') {
        if (inRound) throw new Error(`${action} requires a direct human request — a goal round cannot start it. Report progress or the blocker within the current round instead.`)
        if (action === 'edit') {
          if (hasText(args['blocked_reason'])) invalid('blocked_reason is valid only with action blocked.')
          if (!hasText(args['objective']) && !hasRoundCap(args['max_goal_rounds'])) invalid('edit requires objective and/or max_goal_rounds.')
          const view = await ctx.goals.edit(conversation.id, { id: goalId, revision }, {
            ...(hasText(args['objective']) ? { objective: args['objective'] } : {}),
            ...(hasRoundCap(args['max_goal_rounds']) ? { maxGoalRounds: args['max_goal_rounds'] } : {}),
          })
          return goalValue(view)
        }
        if (hasText(args['objective']) || hasRoundCap(args['max_goal_rounds']) || hasText(args['blocked_reason'])) {
          invalid('objective and max_goal_rounds are valid only with action edit; blocked_reason is valid only with action blocked.')
        }
        if (action === 'resume') {
          const current = await ctx.goals.view(conversation.id)
          if (current && current.id === goalId && current.revision === revision && current.phase === 'paused') {
            throw new Error('the model cannot resume a paused goal; the user must resume it (/goal resume).')
          }
        }
        const view = action === 'pause' ? await ctx.goals.pause(conversation.id, { id: goalId, revision }) : await ctx.goals.resume(conversation.id, { id: goalId, revision })
        return goalValue(view)
      }
      if (hasText(args['objective']) || hasRoundCap(args['max_goal_rounds'])) invalid('objective and max_goal_rounds are valid only with action edit.')
      const current = await ctx.goals.view(conversation.id)
      if (action === 'complete') {
        if (hasText(args['blocked_reason'])) invalid('blocked_reason is valid only with action blocked.')
        const view = await ctx.goals.complete(conversation.id, { id: goalId, revision })
        return goalValue(view)
      }
      const reason = textValue(args, 'blocked_reason', 500)
      if (inRound && (current?.roundsStarted ?? 0) < GOAL_BLOCKED_AFTER_ROUNDS) {
        invalid(`blocked requires at least ${GOAL_BLOCKED_AFTER_ROUNDS} consecutive goal rounds; current round is ${current?.roundsStarted ?? 0}.`)
      }
      const view = await ctx.goals.block(conversation.id, { id: goalId, revision }, { code: 'model-reported', message: reason })
      return goalValue(view)
    },
  }

  ctx.effect(() => ctx.appMcp.register(get))
  ctx.effect(() => ctx.appMcp.register(create))
  ctx.effect(() => ctx.appMcp.register(update))
}
GoalTools.inject = ['appMcp', 'llm', 'sessions', 'chat', 'goals', 'goalDriver']
