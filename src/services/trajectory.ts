import { Context, Service } from 'cordis'
import { realDirectory } from './llm.ts'
import './llm.ts'
import { tr } from '../i18n.ts'
import { toolDiffs, type FileDiff } from './toolDiffs.ts'

// Trajectory 탭의 데이터 (ctx.trajectory) — 한 대화의 스텝·도구 호출을 시간 순 중립 레코드로 준다. 화면은 opencode 형식을 모른다.
// 원천은 대화 영속화와 같은 GET /api/session/{id}/message (ctx.llm.readMessages) — 같은 응답을 Chat 은 말풍선으로(historyMessages),
// 여기서는 레코드로 바꾼다. 재시작해도 응답이 바이트 단위로 같다 (01e 2e). opencode 형식을 아는 것은 이 파일의 변환 함수뿐이다 —
// 엔진을 바꾸면 ctx.llm·ctx.engine 과 함께 이 변환도 바꾼다.
//
// 실측 (01e, opencode 1.18.18):
// - assistant 메시지 하나 = 스텝 하나. time.created = step.started, time.completed = step.ended. 텍스트 없이 도구만 부른 스텝도 있다
// - step.started 는 provider 응답이 **오기 시작한** 시각이다(요청을 보낸 때가 아니다, [slow] 30초 대기 실측) → 스텝의 시작은
//   직전 시각(커서: 같은 턴의 user 생성, 직전 스텝·도구 완료 중 가장 늦은 것)으로 잡고, created 는 첫 응답 시각(firstAt)으로 둔다
// - 도구 파트: {type:"tool", id, name, state:{status, input, content, structured, error?}, time:{created, ran, completed}}.
//   실패는 status "error" + error.message 뿐이다(type 은 늘 unknown, 코드 없음). grep 결과 없음·bash exit≠0 은 success 다
// - 지시문(AGENTS.md)이 대화 중 바뀌면 type "system" 메시지가 남는다(첫 로드는 안 남는다). 도구 목록 변화 이력은 opencode 에 없다

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
  /** 모델 스텝 하나. start = 요청을 보낸 쪽 시각(커서), firstAt = 응답이 오기 시작한 시각 — start→firstAt 이 대기 */
  | { kind: 'assistant'; text: string; start: number; firstAt: number; end?: number; tokens?: TrajectoryTokens; error?: string }
  /** 도구 호출 하나. input 은 인자 JSON 문자열, ranAt = 실행 시작, exit = bash 의 종료 코드, diffs = 바꾼 파일 (toolDiffs.ts) */
  | { kind: 'tool'; name: string; input: string; result: string; error?: string; start: number; ranAt?: number; end?: number; exit?: number; diffs?: FileDiff[] }

export interface Trajectory {
  records: TrajectoryRecord[]
  /** 작업 폴더가 없어 엔진에 묻지 않았다 */
  missingFolder?: boolean
  /** 불러오지 못한 사유 */
  error?: string
}

/** /message 응답 중 여기서 읽는 필드 (01e 2b 실측) */
interface RawMessage {
  type: string
  text?: string
  time?: { created?: number; completed?: number }
  content?: RawPart[]
  tokens?: { input?: number; output?: number; reasoning?: number; cache?: { read?: number } }
  error?: { message?: string }
}

interface RawPart {
  type: string
  text?: string
  name?: string
  state?: {
    status?: string
    input?: unknown
    content?: { type?: string; text?: string }[]
    structured?: { exit?: unknown }
    error?: { message?: string }
  }
  time?: { created?: number; ran?: number; completed?: number }
}

/** opencode 메시지(asc) → 시간 순 레코드. 스텝 뒤에 그 스텝이 부른 도구가 온다 */
export function trajectoryRecords(raw: readonly unknown[]): TrajectoryRecord[] {
  const records: TrajectoryRecord[] = []
  let cursor = 0
  const reach = (time: number | undefined) => {
    if (time !== undefined && time > cursor) cursor = time
  }

  for (const message of raw as RawMessage[]) {
    const created = message.time?.created
    if (message.type === 'user') {
      const at = created ?? cursor
      records.push({ kind: 'user', text: message.text ?? '', at })
      cursor = at
      continue
    }
    if (message.type === 'system') {
      const at = created ?? cursor
      const sources = [...(message.text ?? '').matchAll(/^Instructions from: (.+)$/gm)].map((match) => match[1]!.trim())
      records.push({ kind: 'context', text: sources.length > 0 ? tr('trajectory.contextChangedFrom', { sources: sources.join(', ') }) : tr('trajectory.contextChanged'), at })
      reach(at)
      continue
    }
    if (message.type !== 'assistant') continue // 모델 바꿈·압축 등은 이번 범위 밖

    const parts = message.content ?? []
    const firstAt = created ?? cursor
    const step: Extract<TrajectoryRecord, { kind: 'assistant' }> = {
      kind: 'assistant',
      text: parts.filter((part) => part.type === 'text').map((part) => part.text ?? '').join(''),
      start: Math.min(cursor || firstAt, firstAt),
      firstAt,
    }
    if (message.time?.completed !== undefined) step.end = message.time.completed
    if (message.tokens) {
      const { input = 0, output = 0, reasoning = 0, cache } = message.tokens
      step.tokens = { input, output, reasoning, cacheRead: cache?.read ?? 0 }
    }
    if (message.error) step.error = message.error.message ?? tr('error.unknown')
    records.push(step)
    reach(step.end)

    for (const part of parts) {
      if (part.type !== 'tool') continue
      const state = part.state ?? {}
      const call: Extract<TrajectoryRecord, { kind: 'tool' }> = {
        kind: 'tool',
        name: part.name ?? '',
        input: JSON.stringify(state.input ?? {}),
        result: (state.content ?? []).map((item) => item.text ?? '').join(''),
        start: part.time?.created ?? firstAt,
      }
      if (state.status === 'error') call.error = state.error?.message ?? tr('error.unknown')
      if (part.time?.ran !== undefined) call.ranAt = part.time.ran
      if (part.time?.completed !== undefined) call.end = part.time.completed
      if (typeof state.structured?.exit === 'number') call.exit = state.structured.exit
      const diffs = toolDiffs(call.name, state.input, state.structured)
      if (diffs) call.diffs = diffs
      records.push(call)
      reach(call.end)
    }
  }
  return records
}

export class TrajectoryService extends Service {
  static readonly inject = ['llm', 'engine']

  constructor(ctx: Context) {
    super(ctx, 'trajectory')
  }

  /** 대화 하나의 레코드. directory 는 그 세션의 작업 폴더 — 없으면 엔진에 묻지 않는다 (없는 폴더의 세션 요청은 500 이고
   *  그 경로가 opencode 재시작 전까지 계속 500 이 된다, ctx.llm.history 와 같은 이유) */
  async read(directory: string, sessionId: string): Promise<Trajectory> {
    if (!(await realDirectory(directory))) return { records: [], missingFolder: true }
    try {
      const conn = await this.ctx.engine.connection()
      return { records: trajectoryRecords(await this.ctx.llm.readMessages(conn, sessionId)) }
    } catch (error) {
      return { records: [], error: tr('error.trajectoryLoad', { message: (error as Error).message }) }
    }
  }
}
