import type { Context } from 'cordis'
import { realDirectory } from '../../projectPath.ts'
import { APP_MCP_NAME } from '../../mcp.ts'
import type { AppMcpTool } from '../rpc.ts'
import type { Conversation } from '../../../../shared/contract.ts'
import { PLAN_EXIT_TOOL, PLAN_MAX } from '../../../../shared/plan.ts'
import '../../appMcp.ts'
import '../../chat.ts'
import '../../llm.ts'
import '../../planReview.ts'
import '../../sessions.ts'

// 계획 검토 도구 (이슈 #626) — dsh exit_plan_mode 의 충실 이식. 계획이 끝나면 완성된 markdown 으로
// 이 도구를 부르면 화면에 승인 카드가 뜨고: 승인 → 도구가 성공으로 돌아오고 모드는 planBack 으로,
// 계속 계획 → feedback 과 함께 실패로 돌아와 모델이 다시 계획을 세운다 (dsh Keep planning).
// dsh 와 같이 계획 모드가 아니어도 도구는 늘 등록되고, 계획이 아닐 때 부르면 실패로 돌아간다

const NO_CALLER = 'Could not tell which conversation made this call. Call the tool again.'

export function PlanTools(ctx: Context): void {
  const exit: AppMcpTool = {
    name: PLAN_EXIT_TOOL,
    description:
      "Use only in plan mode. Present your finished plan for the user's review and, on approval, leave plan mode. " +
      'The user may approve (the mode switches back and you carry out the plan from your next step) or keep ' +
      'planning — their feedback comes back in the tool result; revise and present again.',
    inputSchema: {
      type: 'object',
      properties: {
        plan: { type: 'string', description: `The complete plan, as markdown, starting with a # heading that names it. At most ${PLAN_MAX} characters.` },
      },
      required: ['plan'],
    },
    async run(args, { directory }) {
      const found = await ctx.llm.callerOf(directory, { server: APP_MCP_NAME, tool: PLAN_EXIT_TOOL }, args)
      if (!found) throw new Error(NO_CALLER)
      if (found.child || ctx.chat.isTaskSession(found.sessionId)) throw new Error('A background task cannot present a plan for review.')
      const conversation = (await ctx.sessions.list()).find((entry) => entry.engineSessionId === found.sessionId)
      if (!conversation || (await realDirectory(conversation.project)) !== directory) throw new Error(NO_CALLER)
      if (conversation.mode !== 'plan') throw new Error(`${PLAN_EXIT_TOOL} is only available in plan mode`)
      const plan = args['plan']
      if (typeof plan !== 'string' || !plan.trim()) throw new Error(`${PLAN_EXIT_TOOL} requires a non-empty markdown plan starting with a # heading`)
      if (plan.length > PLAN_MAX) throw new Error(`plan is too long (${plan.length} characters, the limit is ${PLAN_MAX}).`)
      if (!/^#\s+\S/.test(plan.trim())) throw new Error(`${PLAN_EXIT_TOOL} requires a non-empty markdown plan starting with a # heading`)
      const result = await ctx.planReview.start(conversation.id, plan)
      if (!result.approved) {
        throw new Error(result.feedback ? `The user chose to keep planning; their feedback: ${result.feedback}` : 'The user chose to keep planning; revise the plan and present it again.')
      }
      return 'Plan approved — plan mode exited; carry out the plan starting with your next step.'
    },
  }

  ctx.effect(() => ctx.appMcp.register(exit))
}
PlanTools.inject = ['appMcp', 'llm', 'sessions', 'chat', 'planReview']
