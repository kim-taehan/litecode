import { Context, Service } from 'cordis'
import { failureText, realDirectory, type EngineMessage } from './llm.ts'
import './llm.ts'
import { tr } from '../i18n.ts'
import { toolDiffs, type FileDiff } from './toolDiffs.ts'
import { mcpToolOf, type McpToolRef, type McpToolResolver } from './turnProgress.ts'

// Trajectory 탭의 데이터 (ctx.trajectory) — 한 대화의 스텝·도구 호출을 시간 순 중립 레코드로 준다. 화면은 opencode 형식을 모른다.
// 원천은 대화 다시 열기와 같은 레거시 GET /session/{id}/message?directory= (ctx.llm.readMessages) — 같은 응답을 Chat 은 말풍선으로(historyMessages),
// 여기서는 레코드로 바꾼다. opencode 형식을 아는 것은 이 파일의 변환 함수뿐이다 — 엔진을 바꾸면 ctx.llm·ctx.engine 과 함께 이 변환도 바꾼다.
//
// 레거시 실측 (이슈 #20 L2, opencode 1.18.18 — 01w 1절 추론 과정 행):
// - assistant 메시지 하나 = 스텝 하나. time.created 는 스텝을 **시작한** 때(LLM 요청 전), completed 는 스텝 끝. 텍스트 없이 도구만 부른 스텝도 있다
// - 응답이 오기 시작한 때(firstAt)는 그 스텝의 첫 글·생각 파트 time.start 또는 도구 state.time.start — 없으면 created
// - 도구 파트: {type:"tool", tool, callID, state:{status, input, output, error(문자열), metadata, time:{start, end}}} — 신규 세대의 ran(실행 시작)은 없다
// - 자동 요약 답(summary:true)·합성 user(요약 뒤 Continue)·요약 user(compaction 파트)는 레코드가 아니다
// - 지시문: 레거시는 지시문 변화를 기록하지 않는다 — 앱이 매 턴 프로젝트 AGENTS.md 를 prompt system 으로 싣고(instructions.ts), 그 값이 user 메시지
//   info.system 에 남는다(L2 실측). 앞 턴과 달라진 user 뒤에 CONTEXT 레코드를 둔다 (첫 턴은 없다 — 처음 읽은 것은 바뀐 것이 아니다)
// - 하위 작업 (task, 이슈 #31): 부모 task 파트의 metadata.sessionId 가 자식 세션이다. 자식 기록(스텝·도구)을 그 task 레코드 바로 뒤에 subtask 표시를 달아
//   잇는다 — 화면이 묶어 들여 보인다. 자식의 user(= task 의 prompt)는 레코드가 아니다 (턴을 새로 세우면 안 된다)

declare module 'cordis' {
  interface Context {
    trajectory: TrajectoryService
  }
}

export interface TrajectoryTokens {
  input: number
  output: number
  reasoning: number
  cacheRead: number
}

/** Trajectory 한 줄. 시각은 ms. end 가 없으면 끝나지 않았다(진행 중이거나 끊김) */
export type TrajectoryRecord =
  | { kind: 'user'; text: string; at: number }
  /** 대화 중 지시문(AGENTS.md 등)이 바뀌었다 */
  | { kind: 'context'; text: string; at: number }
  /** 모델 스텝 하나. start = 요청을 보낸 쪽 시각(커서), firstAt = 응답이 오기 시작한 시각 — start→firstAt 이 대기.
   *  subtask 가 있으면 그 하위 작업(자식 세션)의 스텝이다 — "에이전트 · 설명" */
  | { kind: 'assistant'; text: string; start: number; firstAt: number; end?: number; tokens?: TrajectoryTokens; error?: string; subtask?: string }
  /** 도구 호출 하나. input 은 인자 JSON 문자열, ranAt = 실행 시작(신규 세대 기록만 — 레거시엔 없다), exit = bash 의 종료 코드, diffs = 바꾼 파일 (toolDiffs.ts) */
  /** mcp = MCP 도구 호출의 서버·도구 (이슈 #28 — 화면은 "MCP · 서버 · 도구") */
  | { kind: 'tool'; name: string; input: string; result: string; error?: string; start: number; ranAt?: number; end?: number; exit?: number; diffs?: FileDiff[]; subtask?: string; mcp?: McpToolRef }

export interface Trajectory {
  records: TrajectoryRecord[]
  /** 작업 폴더가 없어 엔진에 묻지 않았다 */
  missingFolder?: boolean
  /** 불러오지 못한 사유 */
  error?: string
}

/** 레거시 메시지(asc) → 시간 순 레코드. 스텝 뒤에 그 스텝이 부른 도구가 온다. root 는 세션 폴더 (바꾼 파일 경로 기준).
 *  children 은 task 파트가 띄운 자식 세션의 기록 — task 레코드 바로 뒤에 그 자식의 스텝·도구를 subtask 표시로 잇는다 */
export function trajectoryRecords(
  raw: readonly EngineMessage[],
  root = '',
  mcp: McpToolResolver = mcpToolOf,
  children?: ReadonlyMap<string, readonly EngineMessage[]>,
): TrajectoryRecord[] {
  const records: TrajectoryRecord[] = []
  let cursor = 0
  const reach = (time: number | undefined) => {
    if (time !== undefined && time > cursor) cursor = time
  }
  /** 앞 턴 user 의 system (지시문) — 처음엔 비교할 것이 없다 */
  let instructions: { value: string | undefined } | undefined

  /** 요약 user 를 봤다 — 다음 user 는 이음(합성 Continue·한도 초과 뒤 앞 user 의 복사본)이다 (historyMessages 와 같은 규칙) */
  let awaitingContinuation = false

  for (const { info, parts } of raw) {
    const created = info.time?.created
    if (info.role === 'user') {
      if (parts.some((part) => part.type === 'compaction')) {
        awaitingContinuation = true
        continue
      }
      if (awaitingContinuation) {
        awaitingContinuation = false
        continue
      }
      const typed = parts.filter((part) => part.type === 'text' && !part.synthetic)
      if (typed.length === 0) continue // 합성 글뿐
      const at = created ?? cursor
      records.push({ kind: 'user', text: typed.map((part) => part.text ?? '').join(''), at })
      cursor = at
      if (instructions && instructions.value !== info.system) {
        const sources = [...(info.system ?? '').matchAll(/^Instructions from: (.+)$/gm)].map((match) => match[1]!.trim())
        records.push({ kind: 'context', text: sources.length > 0 ? tr('trajectory.contextChangedFrom', { sources: sources.join(', ') }) : tr('trajectory.contextChanged'), at })
      }
      instructions = { value: info.system }
      continue
    }
    if (info.summary === true) {
      if (info.error) awaitingContinuation = false // 요약 실패 — 이음 없이 끝났다
      continue // 자동 요약 답
    }

    const starts = parts.flatMap((part) => (part.type === 'tool' ? [part.state?.time?.start] : part.type === 'text' || part.type === 'reasoning' ? [part.time?.start] : []))
    const known = starts.filter((time): time is number => time !== undefined)
    const firstAt = known.length > 0 ? Math.min(...known) : (created ?? cursor)
    const step: Extract<TrajectoryRecord, { kind: 'assistant' }> = {
      kind: 'assistant',
      text: parts.filter((part) => part.type === 'text' && !part.synthetic).map((part) => part.text ?? '').join(''),
      start: Math.min(cursor || firstAt, firstAt),
      firstAt,
    }
    if (info.time?.completed !== undefined) step.end = info.time.completed
    if (info.tokens) {
      const { input = 0, output = 0, reasoning = 0, cache } = info.tokens
      step.tokens = { input, output, reasoning, cacheRead: cache?.read ?? 0 }
    }
    if (info.error) step.error = info.error.name === 'MessageAbortedError' ? tr('error.stopped') : failureText(info.error)
    records.push(step)
    reach(step.end)

    for (const part of parts) {
      if (part.type !== 'tool') continue
      const state = part.state ?? {}
      const call: Extract<TrajectoryRecord, { kind: 'tool' }> = {
        kind: 'tool',
        name: part.tool ?? '',
        input: JSON.stringify(state.input ?? {}),
        result: state.output ?? '',
        start: state.time?.start ?? firstAt,
      }
      const ref = mcp(call.name)
      if (ref) call.mcp = ref
      if (state.status === 'error') call.error = state.error || tr('error.unknown')
      if (state.time?.end !== undefined) call.end = state.time.end
      if (typeof state.metadata?.exit === 'number') call.exit = state.metadata.exit
      const diffs = state.status === 'completed' ? toolDiffs(call.name, state.input, state.metadata, root) : undefined
      if (diffs) call.diffs = diffs
      records.push(call)
      reach(call.end)
      const child = call.name === 'task' ? state.metadata?.['sessionId'] : undefined
      const childRaw = typeof child === 'string' ? children?.get(child) : undefined
      if (childRaw) {
        const input = (state.input ?? {}) as { subagent_type?: unknown; description?: unknown }
        const subtask = [input.subagent_type, input.description].filter((value): value is string => typeof value === 'string' && value !== '').join(' · ')
        for (const record of trajectoryRecords(childRaw, root, mcp)) {
          if (record.kind === 'assistant' || record.kind === 'tool') records.push({ ...record, subtask })
        }
      }
    }
  }
  return records
}

export class TrajectoryService extends Service {
  static readonly inject = ['llm']

  constructor(ctx: Context) {
    super(ctx, 'trajectory')
  }

  /** 대화 하나의 레코드. directory 는 그 세션의 작업 폴더 — 없으면 엔진에 묻지 않는다 (없는 폴더의 세션 요청은 500 이고
   *  그 경로가 opencode 재시작 전까지 계속 500 이 된다, ctx.llm.history 와 같은 이유) */
  async read(directory: string, sessionId: string): Promise<Trajectory> {
    const workdir = await realDirectory(directory)
    if (!workdir) return { records: [], missingFolder: true }
    try {
      const raw = await this.ctx.llm.readMessages(workdir, sessionId)
      return { records: trajectoryRecords(raw, workdir, this.ctx.llm.mcpTool(workdir), await this.ctx.llm.readSubtasks(workdir, raw)) }
    } catch (error) {
      return { records: [], error: tr('error.trajectoryLoad', { message: (error as Error).message }) }
    }
  }
}
