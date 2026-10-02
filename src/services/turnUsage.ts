import type { EngineMessageInfo, EnginePart } from './turnProgress.ts'

// 턴 하나의 사용량·시간을 opencode 레거시 이벤트에서 모은다 — 결과는 opencode 를 모르는 중립 모양(TurnUsage)이다.
// 실측 근거 (opencode 1.18.18 — 토큰 매핑은 _workspace/01_probe.md 2026-10-01, 레거시 모양은 01w 2026-10-02):
// - 토큰은 스텝마다 step-finish 파트의 tokens {input, output, reasoning, cache:{read,write}} 에 온다. 매핑은 신규 세대와 같다
//   (input 은 캐시 제외, output 은 reasoning 제외). 더한다
// - 레거시 이벤트엔 data.timestamp 가 없다 — message.part.updated 의 properties.time(ms)·파트의 time.start/end·도구 state.time·user 메시지
//   time.created 로 잰다. 첫 토큰까지(TTFT)는 첫 스텝이면 user 메시지 생성(= 보낸 때)부터, 이후 스텝이면 직전 스텝 끝부터. 스텝의 첫 출력은
//   글·생각 파트의 time.start, 도구 스텝은 도구 파트가 처음 나타난 때(pending)
// - 실패한 스텝은 step-finish 없이 assistant info.error 만 남는다 — 그것도 스텝으로 센다

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

type Props = Record<string, unknown>

export class TurnMeter {
  private steps = 0
  private tokens = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }
  private llmMs = 0
  private toolMs = 0
  private ttftMs = 0
  private ttftSteps = 0
  private lastContextTokens = 0
  /** 첫 토큰을 재는 기준 — 보낸 때, 이후 직전 스텝의 끝 */
  private boundary?: number
  /** 지금 스텝의 첫 출력 시각 */
  private firstOutput?: number
  /** 시간을 이미 더한 도구 파트 */
  private timedTools = new Set<string>()
  /** step-finish 가 온(또는 실패로 센) 답 메시지 */
  private counted = new Set<string>()

  /** 이 턴의 이벤트 하나 (TurnScope 가 거른 것) */
  observe(type: string, props: Props): void {
    if (type === 'message.updated') {
      const info = props['info'] as EngineMessageInfo
      if (info.role === 'user') this.boundary ??= info.time?.created
      else if (info.error && !this.counted.has(info.id)) {
        this.counted.add(info.id) // 실패한 스텝
        this.steps++
        this.firstOutput = undefined
      }
      return
    }
    if (type !== 'message.part.updated') return
    const part = props['part'] as EnginePart
    const at = typeof props['time'] === 'number' ? props['time'] : undefined
    if (part.type === 'text' || part.type === 'reasoning') {
      this.output(part.time?.start ?? at)
      return
    }
    if (part.type === 'tool') {
      this.output(at ?? part.state?.time?.start)
      const { start, end } = part.state?.time ?? {}
      if (start !== undefined && end !== undefined && part.id && !this.timedTools.has(part.id)) {
        this.timedTools.add(part.id)
        this.toolMs += Math.max(0, end - start)
        this.boundary = Math.max(this.boundary ?? end, end)
      }
      return
    }
    if (part.type !== 'step-finish' || at === undefined) return
    this.steps++
    if (part.messageID) this.counted.add(part.messageID)
    if (this.firstOutput !== undefined) this.llmMs += Math.max(0, at - this.firstOutput)
    this.firstOutput = undefined
    this.boundary = at
    const step = part.tokens
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
  }

  /** 스텝의 첫 출력 — 그 스텝에서 처음일 때만 첫 토큰 시간을 잰다 */
  private output(at: number | undefined): void {
    if (at === undefined || this.firstOutput !== undefined) return
    this.firstOutput = at
    if (this.boundary !== undefined) {
      this.ttftMs += Math.max(0, at - this.boundary)
      this.ttftSteps++
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

/** 대화 메시지가 컨텍스트에서 차지하는 토큰 어림 — 레거시 GET /session/{id}/message 의 글자 수 ÷ 4.
 *  opencode 는 컨텍스트 구성(시스템 프롬프트·도구 정의·메시지)을 안 준다 (01_probe). 글 파트(합성 제외)·도구 입력(JSON)과 결과(output)를 센다.
 *  자동 요약 뒤의 몫만 세는 것은 L2 (지금은 전부) */
export function messageTokens(messages: readonly { parts?: readonly EnginePart[] }[]): number {
  let chars = 0
  for (const message of messages) {
    for (const part of message.parts ?? []) {
      if ((part.type === 'text' || part.type === 'reasoning') && !part.synthetic) chars += part.text?.length ?? 0
      if (part.type !== 'tool' || !part.state) continue
      if (part.state.input !== undefined) chars += JSON.stringify(part.state.input).length
      chars += part.state.output?.length ?? 0
    }
  }
  return Math.round(chars / 4)
}
