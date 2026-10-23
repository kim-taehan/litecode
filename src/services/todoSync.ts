// 할 일 동기화 재촉 (ctx.todoGuard 의 순수 부분, 이슈 #619 — #406 의 연장). 시스템 프롬프트의 TODO_SYNC_RULE
// (instructions.ts) 는 작은 모델이 지키지 않는다 (실측 2026-10-14: 도구 134회 동안 0/7, #406). 그래서 앱이 세기한다:
// 남은 항목이 있는 목록을 성공한 todowrite 로 쓴 뒤(그 epoch), 모델이 다른 도구를 실행에 넣은 8번째·32번째에
// 모델에게 보낼 알림 한 줄을 돌려준다. 실행은 묶음(todoGuard.ts)이 ctx.llm.remind 로 (합성 글 — repeatGuard #284 와 같은 길).

/** 성공한 todowrite 이후 몇 번째 도구 실행(실행에 들어간)에서 재촉하나 — 두 번 그 뒤는 조용하다 */
export const TODO_SYNC_NUDGE_AT: readonly number[] = [8, 32]

/** 성공한 todowrite 인자의 목록에서 안 끝난 항목 수. status 는 엔진이 검사하지 않는 글자라(턴 정본과 같은 규칙 — turnProgress.ts)
 *  completed·cancelled(구분 없이)만 끝나고, 글자가 없거나 모르는 값은 안 끝난 걸로. todos 가 배열이 아니면(틀린 인자) undefined —
 *  그 목록은 엔진이 안 바꾸므로 epoch 도 안 바꾼다 */
export function pendingCount(input: unknown): number | undefined {
  const todos = (input && typeof input === 'object' ? (input as { todos?: unknown }) : {}).todos
  if (!Array.isArray(todos)) return undefined
  return todos.filter((entry) => {
    const status = (entry && typeof entry === 'object' ? (entry as { status?: unknown }) : {}).status
    const done = typeof status === 'string' && (status.toLowerCase() === 'completed' || status.toLowerCase() === 'cancelled')
    return !done
  }).length
}

/** 모델에게 보낼 재촉 한 줄 (영어 — 모델용, repeatReminder 와 같은 모양) */
export function todoSyncReminder(count: number): string {
  return `You have made ${count} tool calls since your last todowrite. Your list still has unfinished items — call todowrite now with the full list, finished items as "completed" and the current one as "in_progress". If nothing has changed yet, continue the work.`
}

/** 그 대화(엔진 세션)마다 epoch 하나: 마지막 성공한 todowrite 의 남은 항목 수 + 그 뒤 도구 실행 수 + 보낸 재촉 수 */
export class TodoSyncTracker {
  private readonly sessions = new Map<string, { pending: number; since: number; nudged: number }>()

  /** 성공한 todowrite (llm/tool-done, error 없음) — 목록이 안 끝나면 새 epoch, 끝나면 그 동안 조용. 도구 실행 수는 0 부터 */
  todoWritten(session: string, input: unknown): void {
    const pending = pendingCount(input)
    if (pending === undefined) return
    this.sessions.set(session, { pending, since: 0, nudged: 0 })
  }

  /** 도구 호출 실행 진입 (llm/tool-started, 부모의 것만) — 한 칸씩 세고, 정한 횟수면 재촉 문구를 (아닐 때 undefined) */
  toolStarted(session: string): string | undefined {
    const epoch = this.sessions.get(session)
    if (!epoch || epoch.pending === 0) return undefined
    epoch.since += 1
    const at = TODO_SYNC_NUDGE_AT[epoch.nudged]
    if (epoch.since === at) {
      epoch.nudged += 1
      return todoSyncReminder(epoch.since)
    }
    return undefined
  }

  /** 새 턴·끝난 턴 — 그 동안의 세기 버린다 */
  reset(session: string): void {
    this.sessions.delete(session)
  }
}
