// 한 대화에 쌓인 턴 사용량 — 턴이 끝날 때마다 ctx.chat 이 더해 목록 정보(Conversation.usage)에 저장하고, 화면(renderer/stats.ts)이 읽는다
import type { TurnUsage } from './contract.ts'

/** ctx.llm 이 턴마다 주는 TurnUsage 를 더한 것. 컨텍스트 크기·메시지 몫은 마지막 턴 것 */
export interface ChatUsage {
  turns: number
  steps: number
  tokens: TurnUsage['tokens']
  llmMs: number
  toolMs: number
  ttftMs: number
  ttftSteps: number
  lastContextTokens: number
  messageTokens?: number
}

export function addTurn(chat: ChatUsage | undefined, turn: TurnUsage): ChatUsage {
  const t = chat?.tokens
  return {
    turns: (chat?.turns ?? 0) + 1,
    steps: (chat?.steps ?? 0) + turn.steps,
    tokens: {
      input: (t?.input ?? 0) + turn.tokens.input,
      output: (t?.output ?? 0) + turn.tokens.output,
      reasoning: (t?.reasoning ?? 0) + turn.tokens.reasoning,
      cacheRead: (t?.cacheRead ?? 0) + turn.tokens.cacheRead,
      cacheWrite: (t?.cacheWrite ?? 0) + turn.tokens.cacheWrite,
    },
    llmMs: (chat?.llmMs ?? 0) + turn.llmMs,
    toolMs: (chat?.toolMs ?? 0) + turn.toolMs,
    ttftMs: (chat?.ttftMs ?? 0) + turn.ttftMs,
    ttftSteps: (chat?.ttftSteps ?? 0) + turn.ttftSteps,
    lastContextTokens: turn.lastContextTokens,
    messageTokens: turn.messageTokens,
  }
}
