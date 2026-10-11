import { createHash } from 'node:crypto'

// 같은 도구·같은 인자 연속 호출 세기 (이슈 #284, ctx.repeatGuard 의 순수 부분). 아이디어는 dsh guard/repeat-tool-reminder —
// 차단하지 않고 정한 횟수에만 알린다, 인자는 키 순서를 무시한 정규화 JSON 으로 같음을 본다, 다른 호출이 끼면 1 부터 다시.

/** 연속 몇 번째에 알리나 — 그 밖의 횟수(9번째 이상 포함)에는 조용하다 */
export const REPEAT_THRESHOLDS: readonly number[] = [3, 5, 8]

/** 모델에게 보내는 알림 한 줄 (영어 — 모델용) */
export function repeatReminder(tool: string, count: number): string {
  return `You have called \`${tool}\` with the same arguments ${count} times in a row. Review the previous results and change your approach, or finish.`
}

/** 키를 정렬한 JSON — 키 순서만 다른 두 인자는 같은 글이 된다. 인자는 엔진이 JSON 으로 준 값이라 JSON 값만 다룬다 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sorted(value)) ?? 'undefined'
}

function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted)
  if (value === null || typeof value !== 'object') return value
  const record = value as Record<string, unknown>
  return Object.fromEntries(Object.keys(record).sort().map((key) => [key, sorted(record[key])]))
}

/** 호출 하나의 열쇠 — 도구 이름 + 정규화한 인자의 해시 */
export function callKey(tool: string, input: unknown): string {
  return `${tool}:${createHash('sha256').update(canonicalJson(input)).digest('hex')}`
}

/** 대화(열쇠)마다 마지막 호출과 그 연속 횟수를 쥔다 */
export class RepeatCounter {
  private readonly chains = new Map<string, { key: string; count: number }>()

  /** 호출 하나를 센다 — 이번이 알릴 횟수면 그 횟수, 아니면 undefined */
  observe(conversation: string, tool: string, input: unknown): number | undefined {
    const key = callKey(tool, input)
    const chain = this.chains.get(conversation)
    const count = chain?.key === key ? chain.count + 1 : 1
    this.chains.set(conversation, { key, count })
    return REPEAT_THRESHOLDS.includes(count) ? count : undefined
  }

  /** 그 대화를 처음부터 다시 센다 (새 턴) */
  reset(conversation: string): void {
    this.chains.delete(conversation)
  }
}
