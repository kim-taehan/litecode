// 턴 하나의 사용량·시간을 opencode 세션 SSE 이벤트에서 모은다 — 결과는 opencode 를 모르는 중립 모양(TurnUsage)이다.
// 실측 근거 (_workspace/01_probe.md, opencode 1.18.18, 2026-10-01):
// - 토큰은 스텝마다 session.next.step.ended 의 data.tokens {input, output, reasoning, cache:{read,write}} 에 온다.
//   input 은 캐시 제외, output 은 reasoning 제외. 세션 합계는 opencode 가 안 준다 → 더한다
// - 모든 이벤트에 data.timestamp(ms). text.delta 는 세션 SSE 에 안 온다 → 스텝의 첫 출력(text.started, 도구 스텝은
//   tool.input.started)을 첫 토큰 시각으로 쓴다 (첫 delta 와 2ms 차이)
// - step.started 는 요청 시각이 아니라 스트림 첫 바이트 뒤에 찍힌다 → 첫 토큰까지(TTFT)는 첫 스텝이면 prompted 부터,
//   이후 스텝이면 직전 스텝 끝(step.ended·tool.success|failed 중 늦은 것)부터 잰다

export interface TurnUsage {
  /** step.ended + step.failed 수 */
  steps: number
  /** 스텝 합. input 은 캐시 안 된 입력 */
  tokens: { input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number }
  /** 스텝마다 첫 출력 → 스텝 끝의 합 */
  llmMs: number
  /** 도구 호출 → 결과의 합 */
  toolMs: number
  /** 첫 토큰까지 걸린 시간의 합과 그 표본 수 — 평균은 위층이 대화 단위로 낸다 */
  ttftMs: number
  ttftSteps: number
  /** 마지막 스텝의 컨텍스트 크기 (프롬프트 + 출력) */
  lastContextTokens: number
  /** 그중 대화 메시지 몫 — 추정치 (messageTokens). 못 구하면 없다 */
  messageTokens?: number
}

type Data = Record<string, unknown>
type StepTokens = { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } }

export class TurnMeter {
  private steps = 0
  private tokens = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }
  private llmMs = 0
  private toolMs = 0
  private ttftMs = 0
  private ttftSteps = 0
  private lastContextTokens = 0
  /** 첫 토큰을 재는 기준 — prompted, 이후 직전 스텝의 끝 */
  private boundary?: number
  /** 지금 스텝의 첫 출력 시각 */
  private firstOutput?: number
  private calls = new Map<string, number>()

  observe(type: string, data: Data): void {
    const at = typeof data['timestamp'] === 'number' ? data['timestamp'] : undefined
    if (at === undefined) return
    switch (type) {
      case 'session.next.prompted':
        this.boundary = at
        return
      case 'session.next.step.started':
        this.firstOutput = undefined
        return
      case 'session.next.text.started':
      case 'session.next.tool.input.started':
        if (this.firstOutput !== undefined) return
        this.firstOutput = at
        if (this.boundary !== undefined) {
          this.ttftMs += Math.max(0, at - this.boundary)
          this.ttftSteps++
        }
        return
      case 'session.next.tool.called':
        if (typeof data['callID'] === 'string') this.calls.set(data['callID'], at)
        return
      case 'session.next.tool.success':
      case 'session.next.tool.failed': {
        const called = typeof data['callID'] === 'string' ? this.calls.get(data['callID']) : undefined
        if (called !== undefined) this.toolMs += Math.max(0, at - called)
        this.boundary = at
        return
      }
      case 'session.next.step.ended':
      case 'session.next.step.failed': {
        this.steps++
        if (this.firstOutput !== undefined) this.llmMs += Math.max(0, at - this.firstOutput)
        this.firstOutput = undefined
        this.boundary = at
        const step = data['tokens'] as StepTokens | undefined
        if (!step) return
        const input = step.input ?? 0
        const output = step.output ?? 0
        const reasoning = step.reasoning ?? 0
        const cacheRead = step.cache?.read ?? 0
        const cacheWrite = step.cache?.write ?? 0
        this.tokens.input += input
        this.tokens.output += output
        this.tokens.reasoning += reasoning
        this.tokens.cacheRead += cacheRead
        this.tokens.cacheWrite += cacheWrite
        this.lastContextTokens = input + cacheRead + cacheWrite + output + reasoning
        return
      }
    }
  }

  /** 끝난(또는 실패한) 스텝이 하나도 없으면 undefined */
  usage(): TurnUsage | undefined {
    if (this.steps === 0) return undefined
    return {
      steps: this.steps,
      tokens: { ...this.tokens },
      llmMs: this.llmMs,
      toolMs: this.toolMs,
      ttftMs: this.ttftMs,
      ttftSteps: this.ttftSteps,
      lastContextTokens: this.lastContextTokens,
    }
  }
}

type ContextPart = { type?: string; text?: string; state?: { input?: unknown; content?: ContextPart[] } }
type ContextMessage = { type?: string; text?: string; content?: ContextPart[] }

/** 대화 메시지가 컨텍스트에서 차지하는 토큰 어림 — GET /api/session/{id}/context(마지막 압축 이후 메시지)의 글자 수 ÷ 4.
 *  opencode 는 컨텍스트 구성(시스템 프롬프트·도구 정의·메시지)을 안 준다 (01_probe). 모양은 2026-10-01 실측:
 *  user 는 text, assistant 는 content[] — text 조각은 text, 도구 조각은 state.input(JSON) 과 state.content[].text */
export function messageTokens(context: ContextMessage[]): number {
  let chars = 0
  for (const message of context) {
    chars += message.text?.length ?? 0
    for (const part of message.content ?? []) {
      chars += part.text?.length ?? 0
      if (part.type !== 'tool' || !part.state) continue
      if (part.state.input !== undefined) chars += JSON.stringify(part.state.input).length
      for (const piece of part.state.content ?? []) chars += piece.text?.length ?? 0
    }
  }
  return Math.round(chars / 4)
}
