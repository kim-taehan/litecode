import { isDeepStrictEqual } from 'node:util'
import type { EnginePart } from './turnProgress.ts'
import type { AttentionTarget } from '../../shared/contract.ts'

// 도는 턴의 도구 호출 장부 (이슈 #55 — 실측 2026-10-04 opencode 1.18.18, _workspace/01z_desktop_mcp.md 1-2·1-4).
// 앱 MCP 서버가 받는 호출 요청에는 "누가 불렀나" 가 없다(헤더·_meta 에 세션 id 없음, 6/6). 대신 그 폴더 /event 의 `running` 도구 파트
// (sessionID·callID·input)가 요청 1~3ms 뒤에 온다(10/10) — 승인(ask)을 거친 호출은 요청보다 훨씬 먼저 running 이다.
// 그래서 (폴더, 도구 이름, 인자 깊은 비교, 아직 안 쓴 callID)로 짝을 맞춘다. 짝이 없는 호출은 앱이 돌린 턴에서 온 것이 아니다.
// 승인 기록: 사용자가 **앱 화면에서** 허용한 callID 만 approved 다 — 엔진 비밀번호를 쥔 폴더 코드가 엔진 API 로 스스로 허용한 호출은
// 기록이 없다. opencode 형식(파트 모양)을 아는 것은 observe 뿐이다

export interface RunningCall {
  /** 그 도구를 부른 엔진 세션 — 하위 작업이면 자식 세션 */
  sessionId: string
  callId: string
  tool: string
  input: unknown
  /** 하위 작업(자식 세션)이 불렀다 */
  child: boolean
}

/** 부른 대화 — sessionId 는 그 턴의 본 세션(하위 작업이 불렀어도) */
export interface ToolCaller {
  sessionId: string
  callId: string
  child: boolean
  /** 사용자가 앱에서 이 호출을 허용했다 */
  approved: boolean
  /** 허용하면서 사용자가 고른 받을 대화 (이슈 #67) — 없으면 도구 인자대로. 화면이 보낸 값이라 도구가 자격을 다시 본다 */
  target?: AttentionTarget
}

export class ToolCalls {
  private readonly running = new Map<string, RunningCall>()
  /** 이미 짝이 된 호출 — 같은 호출이 두 번 짝이 되지 않는다 (승인도 한 번 쓰면 소진) */
  private readonly used = new Set<string>()
  /** 허용한 호출 → 그때 사용자가 고른 받을 대화 (안 골랐으면 undefined) */
  private readonly approved = new Map<string, AttentionTarget | undefined>()

  /** 도구 파트 하나 — running 이면 쥐고, 끝났으면(completed·error) 뺀다. pending 은 아직 인자가 없다 */
  observe(part: EnginePart | undefined, child: boolean): void {
    if (part?.type !== 'tool' || !part.callID) return
    const status = part.state?.status
    if (status === 'running') {
      this.running.set(part.callID, { sessionId: part.sessionID ?? '', callId: part.callID, tool: part.tool ?? '', input: part.state?.input ?? {}, child })
    } else if (status !== 'pending') this.running.delete(part.callID)
  }

  /** 그 호출의 인자 (running 일 때만) — 승인 카드가 대상·보낼 글을 그린다 */
  inputOf(callId: string): unknown {
    return this.running.get(callId)?.input
  }

  /** 사용자가 앱에서 그 호출을 허용했다 — target 은 그때 고른 받을 대화 (이슈 #67) */
  approve(callId: string, target?: AttentionTarget): void {
    this.approved.set(callId, target)
  }

  revoke(callId: string): void {
    this.approved.delete(callId)
  }

  /** 같은 도구·같은 인자로 돌고 있는, 아직 짝이 안 된 호출 */
  matching(tool: string, args: unknown): RunningCall[] {
    return [...this.running.values()].filter((call) => call.tool === tool && !this.used.has(call.callId) && isDeepStrictEqual(call.input, args))
  }

  /** 그 호출을 짝으로 쓴다 — 허용 기록이 있었는지(와 그때 고른 받을 대화)를 돌려주고 소진한다 */
  claim(callId: string): { approved: boolean; target?: AttentionTarget } {
    if (this.used.has(callId)) return { approved: false }
    this.used.add(callId)
    const approved = this.approved.has(callId)
    const target = this.approved.get(callId)
    this.approved.delete(callId)
    return { approved, ...(target && { target }) }
  }
}

/** 도는 턴 하나의 장부 */
export interface LiveCalls {
  /** 그 턴의 본 세션 */
  sessionId: string
  workdir: string
  calls: ToolCalls
}

/** 그 폴더의 도는 턴들에서 짝을 찾는다. 하나면 그것을 쓰고(소진), 없으면 'none', 둘 이상이면 가를 수 없어 'ambiguous' (소진하지 않는다) */
export function findCaller(lives: Iterable<LiveCalls>, workdir: string, tool: string, args: unknown): ToolCaller | 'none' | 'ambiguous' {
  const found = [...lives].filter((live) => live.workdir === workdir).flatMap((live) => live.calls.matching(tool, args).map((call) => ({ live, call })))
  if (found.length === 0) return 'none'
  if (found.length > 1) return 'ambiguous'
  const { live, call } = found[0]!
  return { sessionId: live.sessionId, callId: call.callId, child: call.child, ...live.calls.claim(call.callId) }
}

const POLL_MS = 10

/** running 이벤트가 요청보다 조금 늦게 올 수 있다 — 기한까지 다시 찾는다. 못 찾거나 가를 수 없으면 undefined */
export async function awaitCaller(find: () => ToolCaller | 'none' | 'ambiguous', waitMs: number): Promise<ToolCaller | undefined> {
  const deadline = Date.now() + waitMs
  while (true) {
    const found = find()
    if (found === 'ambiguous') return undefined
    if (found !== 'none') return found
    if (Date.now() >= deadline) return undefined
    await new Promise((resolve) => setTimeout(resolve, POLL_MS))
  }
}
