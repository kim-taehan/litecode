import type { TurnItem } from '../shared/ipc.ts'
import { chatStrings } from './chatStrings.ts'

// 답 한 턴의 화면 모양 — 진행 줄(TurnItem)을 "작업"(접히는 부분)과 "답"(늘 보이는 끝 글)으로 가르고 줄 글자를 만든다.
// 규칙은 dsh ui-chat conversation-nodes 를 따른다 (참조만): 답 = 마지막 도구·생각 뒤의 글. 도구 앞에 쓴 글·답에 붙은 생각은 작업이다

/** 같은 id 면 그 자리에서 바꾸고, 처음이면 끝에 붙인다 — 줄 순서는 처음 나타난 순서 */
export function upsertItem(items: readonly TurnItem[] | undefined, item: TurnItem): TurnItem[] {
  const list = items ?? []
  const index = list.findIndex((existing) => existing.id === item.id)
  if (index === -1) return [...list, item]
  return list.map((existing, at) => (at === index ? item : existing))
}

/** 끝난 턴을 작업과 답으로 가른다. 답 = 마지막 글이 아닌 줄 뒤에 이어지는 글 줄들 */
export function splitTurn(items: readonly TurnItem[]): { work: TurnItem[]; answer: TurnItem[] } {
  let cut = items.length
  while (cut > 0 && items[cut - 1]!.kind === 'text') cut--
  return { work: items.slice(0, cut), answer: items.slice(cut) }
}

/** 답 글. 답 줄이 다 끝났으면 그 글, 아니면(줄을 못 받았거나 덜 받음) 엔진이 준 답 전체(fallback) */
export function answerText(answer: readonly TurnItem[], fallback: string): string {
  const texts = answer.filter((item): item is Extract<TurnItem, { kind: 'text' }> => item.kind === 'text')
  if (texts.length === 0 || texts.some((item) => !item.done)) return fallback
  return texts.map((item) => item.text).join('')
}

/** 생각 줄 요약 — 끝났으면 첫 문단 첫 줄, 쓰는 중이면 마지막으로 다 쓴 문단의 첫 줄(없으면 지금 문단). `**` 는 뗀다 (dsh ReasoningRow) */
export function thinkSummary(text: string, done: boolean): string {
  const paragraphs = text.replaceAll('**', '').split(/\n\s*\n/).map((paragraph) => paragraph.trim()).filter(Boolean)
  if (paragraphs.length === 0) return ''
  const pick = done || paragraphs.length === 1 ? paragraphs[0]! : paragraphs[paragraphs.length - 2]!
  return pick.split('\n')[0]!.trim()
}

/** 도구 이름 첫 글자를 대문자로 (bash → Bash) */
export function toolTitle(name: string): string {
  return name ? name[0]!.toUpperCase() + name.slice(1) : '?'
}

/** 걸린 시간 — 최소 1초, 1분부터 분·초, 1시간부터 시간·분 (dsh message-chrome) */
export function formatDuration(ms: number): string {
  const total = Math.max(1, Math.floor(ms / 1000))
  if (total < 60) return chatStrings.seconds(total)
  if (total < 3600) return chatStrings.minutes(Math.floor(total / 60), total % 60)
  return chatStrings.hours(Math.floor(total / 3600), Math.floor((total % 3600) / 60))
}

/** 끝난 턴 머리 글 — 끊긴 턴(엔진 재시작 등)은 실패와 갈라 "중단됨" */
export function turnHeadText(duration: number | undefined, failed: boolean, interrupted = false): string {
  if (interrupted) return duration === undefined ? chatStrings.interrupted : chatStrings.interruptedAfter(formatDuration(duration))
  if (failed) return duration === undefined ? chatStrings.failed : chatStrings.failedAfter(formatDuration(duration))
  return duration === undefined ? chatStrings.completed : chatStrings.completedIn(formatDuration(duration))
}

/** 내 말 아래 시각 (HH:MM, 24시간) */
export function clockTime(at: number): string {
  const date = new Date(at)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

/** 인라인 코드가 파일 경로처럼 보이는가 — 실제 파일인지는 메인이 판정한다 (fileMentions.ts). 여기서는 물을 후보만 줄인다 */
export function looksLikePath(token: string): boolean {
  if (!token || token.length > 300 || /\s/.test(token)) return false
  return token.includes('/') || /\.[A-Za-z0-9]{1,8}$/.test(token)
}
