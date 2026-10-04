// 입력창 아래 통계 줄의 읽기 값 — dsh ui-chat StatsPills·TurnUsagePanel, ui-conversation ContextMeter 의 표기를 따른다.
// 숫자를 지어내지 않는다: 엔진이 준 값이 없으면 그 자리는 "—" (00_request 2026-10-01)

// 한 대화에 쌓인 턴 사용량과 그 합산은 shared/usage.ts — 턴이 끝날 때 메인(ctx.chat)이 더해 저장한다 (이슈 #52). 여기는 읽어서 그리기만
import { addTurn, type ChatUsage } from '../shared/usage.ts'
export { addTurn, type ChatUsage }

/** 화면에 보일 통계. 출력은 reasoning 을 포함한다 (OpenAI completion_tokens 와 같은 뜻 — opencode output 은 reasoning 을 뺀 값).
 *  컨텍스트 구성은 opencode 가 안 줘서 메시지 몫만 어림하고 나머지를 "시스템·도구" 한 줄로 둔다 — 둘로 나누지 않는다 (지어내지 않는다) */
export function chatStats(chat: ChatUsage | undefined, contextLimit?: number, maxOutput?: number): ChatStats {
  if (!chat) return {}
  const output = chat.tokens.output + chat.tokens.reasoning
  const used = chat.lastContextTokens
  const messages = chat.messageTokens === undefined ? undefined : Math.min(chat.messageTokens, used)
  return {
    turns: chat.turns,
    steps: chat.steps,
    llmMs: chat.llmMs,
    toolMs: chat.toolMs,
    ttftMs: chat.ttftSteps > 0 ? chat.ttftMs / chat.ttftSteps : undefined,
    tokensPerSecond: chat.llmMs > 0 ? output / (chat.llmMs / 1_000) : undefined,
    tokens: { input: chat.tokens.input, cacheRead: chat.tokens.cacheRead, cacheWrite: chat.tokens.cacheWrite, output },
    context: { used, limit: contextLimit, maxOutput, messages, systemAndTools: messages === undefined ? undefined : used - messages },
  }
}

/** 현재 대화의 통계 (대화 안의 턴을 합친 값). 엔진이 안 주는 값은 비운다 */
export interface ChatStats {
  turns?: number
  steps?: number
  /** LLM 요청에 걸린 시간 합 */
  llmMs?: number
  /** 도구 실행에 걸린 시간 합 */
  toolMs?: number
  /** 첫 토큰까지 평균 (TTFT) */
  ttftMs?: number
  tokensPerSecond?: number
  /** input 은 캐시 안 된 입력. 넷은 서로 겹치지 않는다 */
  tokens?: { input: number; cacheRead: number; cacheWrite: number; output: number }
  /** 지금 컨텍스트 크기와 모델 한도, 그 구성 (구성은 추정치라 ~ 를 붙인다) */
  /** maxOutput — 모델 설정의 최대 출력(자동 요약 문턱 눈금에 쓴다, 이슈 #27) */
  context?: { used: number; limit?: number; maxOutput?: number; systemAndTools?: number; messages?: number }
}

export const NONE = '—'

/** 517 / 12.2K / 517K / 1.2M */
export function compactTokens(value: number): string {
  const scaled = (n: number) => (n >= 100 ? String(Math.round(n)) : String(Math.round(n * 10) / 10))
  if (value < 1_000) return String(value)
  if (value < 1_000_000) return `${scaled(value / 1_000)}K`
  return `${scaled(value / 1_000_000)}M`
}

/** 45.2s, 1분부터 2m42s */
export function duration(ms: number): string {
  const s = ms / 1_000
  if (s < 60) return `${Math.round(s * 10) / 10}s`
  const whole = Math.round(s)
  return `${Math.floor(whole / 60)}m${whole % 60}s`
}

function exact(value: number): string {
  return `${value.toLocaleString('en-US')} tok`
}

function speed(tps: number): string {
  return `${tps >= 10 ? Math.round(tps) : Math.round(tps * 10) / 10} tok/s`
}

/** 입력 중 캐시에서 읽은 몫. 일부만 맞았는데 100% 로 반올림되지 않게 한다. 입력이 없으면 undefined */
export function cacheHitPercent(tokens: NonNullable<ChatStats['tokens']>): string | undefined {
  const billed = tokens.input + tokens.cacheRead + tokens.cacheWrite
  if (billed === 0) return undefined
  if (tokens.cacheRead === billed) return '100'
  const percent = Math.round((tokens.cacheRead * 100) / billed)
  return percent < 100 ? String(percent) : String(Math.floor((tokens.cacheRead * 1_000) / billed) / 10)
}

export interface StatsReadings {
  /** 첫 칸: [N turns M steps, X tok/s] 중 아는 것. 하나도 모르면 ["—"] */
  pace: string[]
  session: { llm: string; tool: string; ttft: string; tps: string }
  /** 둘째 칸: [합계 tok, Cache hit P%] 중 아는 것 */
  usage: string[]
  tokens: { total: string; cacheHit: string; uncached: string; cached: string; output: string }
  /** 셋째 칸의 백분율 (0~100). 한도를 모르면 undefined */
  percent?: number
  context: { figures: string; systemAndTools: string; messages: string }
}

export function statsReadings(stats: ChatStats = {}): StatsReadings {
  const { tokens, context } = stats
  const or = <T>(value: T | undefined, show: (v: T) => string) => (value === undefined ? NONE : show(value))

  const pace = [
    stats.turns !== undefined && stats.steps !== undefined ? `${stats.turns} turns ${stats.steps} steps` : undefined,
    stats.tokensPerSecond !== undefined ? speed(stats.tokensPerSecond) : undefined,
  ].filter((part) => part !== undefined)

  const total = tokens && tokens.input + tokens.cacheRead + tokens.cacheWrite + tokens.output
  const hit = tokens && cacheHitPercent(tokens)
  const usage = [total !== undefined ? `${compactTokens(total)} tok` : undefined, hit !== undefined ? `Cache hit ${hit}%` : undefined].filter(
    (part) => part !== undefined,
  )

  const percent = context?.limit ? Math.min(100, Math.round((context.used * 100) / context.limit)) : undefined
  const approx = (value: number) => `~${compactTokens(value)}`

  return {
    pace: pace.length > 0 ? pace : [NONE],
    session: { llm: or(stats.llmMs, duration), tool: or(stats.toolMs, duration), ttft: or(stats.ttftMs, duration), tps: or(stats.tokensPerSecond, speed) },
    usage: usage.length > 0 ? usage : [NONE],
    tokens: {
      total: or(total, exact),
      cacheHit: or(hit, (p) => `${p}%`),
      uncached: or(tokens?.input, exact),
      cached: or(tokens?.cacheRead, exact),
      output: or(tokens?.output, exact),
    },
    percent,
    context: {
      figures: context ? `${approx(context.used)} / ${or(context.limit, compactTokens)}` : NONE,
      systemAndTools: or(context?.systemAndTools, approx),
      messages: or(context?.messages, approx),
    },
  }
}
