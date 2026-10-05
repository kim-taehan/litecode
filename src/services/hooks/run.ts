import { execShell, type ExecEnd, type ExecHandle } from '../exec.ts'
import { keepEnds, keepTail } from '../outputBuffer.ts'
import { tr } from '../../i18n.ts'
import { BLOCKING_HOOK_EVENTS, hookTimeout, type HookDef, type HookEvent, type HookOutcome } from '../../../shared/hooks.ts'

// 훅 하나 실행 + 결과 해석 (이슈 #102, 01af §6-2·6-3). 엔진을 모른다 — 받은 것은 중립 레코드(HookInput)뿐이다.
// - 명령은 **정의에 적힌 글 그대로** 셸에 넘긴다. 도구 인자·프롬프트·결과는 stdin JSON 과 env 로만 간다 — 셸 문자열에 끼워 넣지 않는다
//   (AI 의 행동이 방아쇠라 인자가 곧 공격면이다 — 명령 주입 방지). `$LITECODE_FILE` 은 앱이 정한 경로 값이다
// - 종료 코드 0 = 통과, 2 = 막기(stderr 가 사유), 그 밖·기한 초과·실행 실패 = 실패지만 진행 (Claude Code 규칙).
//   막을 것이 없는 이벤트(도구 실행 후·세션 시작·알림)의 "막기" 는 실패로 적는다
//   통과한 훅의 stdout 은 맥락(context) — 맥락을 받는 이벤트(프롬프트 제출·세션 시작)에서만 쓰인다. stdout 이 JSON 객체면
//   `additionalContext`(맨 위 또는 hookSpecificOutput 안)만 맥락으로 읽고, `"decision":"block"` 은 막기(`reason` 이 사유)다.
//   `updatedInput`·`permissionDecision` 은 읽지 않는다 (인자 고쳐 쓰기는 안 됨, 실행 전 판정은 2단계)
// - 실행 규칙(로그인 셸·프로세스 그룹·기한)은 exec.ts — `!명령` 과 같다. env 는 앱 자신의 것이라 엔진의 서버 비밀번호·프록시 토큰이 없다

/** 훅에 넘기는 사건 하나 (중립) */
export interface HookInput {
  event: HookEvent
  /** 프로젝트 폴더 (realpath) — cwd */
  directory: string
  /** 앱 대화 id */
  conversationId: string
  mode?: string
  /** 도구 훅 */
  tool?: { name: string; input: unknown; response?: unknown; file?: string }
  /** 프롬프트 제출 */
  prompt?: string
  /** 알림 — type: permission·question(답 필요)·done·failed(턴 끝), message: 짧은 설명 */
  notification?: { type: string; message: string }
}

/** 훅 하나가 돈 결과 */
export interface HookRun {
  event: HookEvent
  command: string
  outcome: HookOutcome
  /** 걸린 시간(초, 0.1 단위) */
  seconds: number
  /** 막은 사유(stderr) 또는 실패 사유 */
  reason?: string
  /** 통과한 훅이 낸 맥락 글 */
  context?: string
  exitCode: number | null
}

const CONTEXT_LIMIT = 10_000
const REASON_LIMIT = 4_000

/** stdin 으로 쓰는 JSON — Claude Code 훅 입력과 같은 이름 */
export function hookStdin(input: HookInput): Record<string, unknown> {
  return {
    hook_event_name: input.event,
    session_id: input.conversationId,
    cwd: input.directory,
    ...(input.mode && { mode: input.mode }),
    ...(input.tool && { tool_name: input.tool.name, tool_input: input.tool.input ?? {} }),
    ...(input.tool && input.tool.response !== undefined && { tool_response: input.tool.response }),
    ...(input.prompt !== undefined && { prompt: input.prompt }),
    ...(input.notification && { notification_type: input.notification.type, message: input.notification.message }),
  }
}

/** 앱 env 에 더하는 값 */
export function hookEnv(input: HookInput): Record<string, string> {
  return {
    LITECODE_PROJECT_DIR: input.directory,
    CLAUDE_PROJECT_DIR: input.directory, // Claude Code 훅 호환
    ...(input.tool?.file && { LITECODE_FILE: input.tool.file }),
  }
}

/** 띄울 것 — 명령 글은 정의 그대로다 (입력이 섞이지 않는다) */
export function hookSpawn(hook: Pick<HookDef, 'command'>, input: HookInput): { command: string; env: Record<string, string>; stdin: string } {
  return { command: hook.command, env: hookEnv(input), stdin: JSON.stringify(hookStdin(input)) }
}

/** 끝난 실행 → 결과. seconds 는 기한(초) — 시간 초과 사유에 쓴다 */
export function decodeHook(end: ExecEnd, stdout: string, stderr: string, seconds: number): Pick<HookRun, 'outcome' | 'reason' | 'context'> {
  if (end.status === 'timeout') return { outcome: 'failed', reason: tr('hooks.timeout', { seconds }) }
  if (end.status === 'stopped') return { outcome: 'failed', reason: tr('hooks.stopped') }
  if (end.status === 'error' || end.exitCode === null) return { outcome: 'failed', reason: end.error || tr('hooks.notRun') }
  if (end.exitCode === 2) return { outcome: 'blocked', reason: stderr.trim() || tr('hooks.blockedDefault') }
  if (end.exitCode !== 0) return { outcome: 'failed', reason: [tr('hooks.exit', { code: end.exitCode }), stderr.trim()].filter(Boolean).join(' — ') }
  const text = stdout.trim()
  const json = text.startsWith('{') ? parseObject(text) : undefined
  if (!json) return { outcome: 'passed', ...(text && { context: text }) }
  if (json['decision'] === 'block') return { outcome: 'blocked', reason: typeof json['reason'] === 'string' && json['reason'].trim() ? json['reason'].trim() : tr('hooks.blockedDefault') }
  const specific = json['hookSpecificOutput'] as Record<string, unknown> | undefined
  const context = [json['additionalContext'], specific?.['additionalContext']].find((value): value is string => typeof value === 'string' && !!value.trim())
  return { outcome: 'passed', ...(context && { context: context.trim() }) }
}

function parseObject(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text)
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

/** 훅 하나를 돌린다 — 던지지 않는다. onStart 로 실행 손잡이를 준다(멈추기·정리용). timeoutMs 는 테스트만 준다 (기본: 정의·이벤트의 기한) */
export async function runHook(hook: HookDef, input: HookInput, opts: { onStart?(handle: ExecHandle): void; timeoutMs?: number } = {}): Promise<HookRun> {
  const seconds = hookTimeout(hook.event, hook.timeout)
  const stdout = keepEnds(CONTEXT_LIMIT / 2, CONTEXT_LIMIT / 2)
  const stderr = keepTail(REASON_LIMIT)
  const startedAt = Date.now()
  const handle = execShell({
    ...hookSpawn(hook, input),
    cwd: input.directory,
    timeoutMs: opts.timeoutMs ?? seconds * 1000,
    onOutput: (stream, text) => (stream === 'stdout' ? stdout : stderr).push(text),
  })
  opts.onStart?.(handle)
  const end = await handle.done
  const decoded = decodeHook(end, stdout.head() + stdout.tail(), stderr.text(), seconds)
  return {
    event: hook.event,
    command: hook.command,
    seconds: Math.round((Date.now() - startedAt) / 100) / 10,
    exitCode: end.exitCode,
    ...decoded,
    ...(decoded.outcome === 'blocked' && !BLOCKING_HOOK_EVENTS.includes(hook.event) && { outcome: 'failed' as const }), // 막을 것이 없는 이벤트
  }
}
