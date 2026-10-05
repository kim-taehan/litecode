import type { HistoryMessage } from '../shared/contract.ts'
import { stopFeedbackReason } from '../shared/hooks.ts'
import type { TurnItem } from '../shared/ipc.ts'
import type { Translate } from './settingsStore.ts'

// 답 한 턴의 화면 모양 — 진행 줄(TurnItem)을 "작업"(접히는 부분)과 "답"(늘 보이는 끝 글)으로 가르고 줄 글자를 만든다.
// 규칙은 dsh ui-chat conversation-nodes 를 따른다 (참조만): 답 = 마지막 도구·생각 뒤의 글. 도구 앞에 쓴 글·답에 붙은 생각은 작업이다

// 진행 줄 끼워 넣기(upsertItem)는 shared/chatReducer.ts — 도는 턴의 진행 줄을 쥐는 메인(ctx.chat)과 같이 쓴다 (이슈 #52)
export { upsertItem } from '../shared/chatReducer.ts'

/** 끝난 턴을 작업과 답으로 가른다. 답 = 마지막 글이 아닌 줄 뒤에 이어지는 글 줄들.
 *  답 뒤에 붙은 훅 줄(턴 끝 훅 — 이슈 #102)은 작업이다: 답을 가를 때 건너뛴다 */
export function splitTurn(items: readonly TurnItem[]): { work: TurnItem[]; answer: TurnItem[] } {
  let end = items.length
  while (end > 0 && items[end - 1]!.kind === 'hook') end--
  let cut = end
  while (cut > 0 && items[cut - 1]!.kind === 'text') cut--
  return { work: [...items.slice(0, cut), ...items.slice(end)], answer: items.slice(cut, end) }
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
/** skill 도구 결과 → 지침 본문만 (이슈 #7). opencode 결과는 `<skill_content name=…>` · `# Skill: 이름` · 본문 · `Base directory…` · 파일 목록 모양이다
 *  (레거시 실측 2026-10-02). 모양이 다르면 받은 그대로 — 기록만으로 그린다(지금 스킬 목록을 다시 묻지 않는다, dsh) */
export function skillInstructions(result: string): string {
  const match = /^<skill_content[^>]*>\r?\n# Skill: [^\n]*\n\n([\s\S]*?)\n\nBase directory for this skill:/.exec(result.trim())
  return match ? match[1]!.trim() : result
}

export function toolTitle(name: string): string {
  return name ? name[0]!.toUpperCase() + name.slice(1) : '?'
}

/** 걸린 시간 — 최소 1초, 1분부터 분·초, 1시간부터 시간·분 (dsh message-chrome) */
export function formatDuration(t: Translate, ms: number): string {
  const total = Math.max(1, Math.floor(ms / 1000))
  if (total < 60) return t('chat.seconds', { s: total })
  if (total < 3600) return t('chat.minutes', { m: Math.floor(total / 60), s: total % 60 })
  return t('chat.hours', { h: Math.floor(total / 3600), m: Math.floor((total % 3600) / 60) })
}

/** 끝난 턴 머리 글 — 끊긴 턴(엔진 재시작 등)은 실패와 갈라 "중단됨" */
export function turnHeadText(t: Translate, duration: number | undefined, failed: boolean, interrupted = false, declined = false): string {
  if (interrupted) return duration === undefined ? t('chat.interrupted') : t('chat.interruptedAfter', { duration: formatDuration(t, duration) })
  if (failed) return duration === undefined ? t('chat.failed') : t('chat.failedAfter', { duration: formatDuration(t, duration) })
  // 승인·질문을 거절해 끝난 턴 — 실패가 아니다 (라운드 A)
  if (declined) return duration === undefined ? t('chat.declined') : t('chat.declinedAfter', { duration: formatDuration(t, duration) })
  return duration === undefined ? t('chat.completed') : t('chat.completedIn', { duration: formatDuration(t, duration) })
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

/** 미니맵 줄의 이름표 — 대화 칸의 `.user-turn` 닻과 순서로 짝짓는다 (Minimap.tsx). 턴 끝 훅이 이어 보낸 글은 말풍선이 아니라
 *  닻이 없으니 줄에서도 뺀다 (ChatTurn.tsx UserMessage). 글 없이 첨부만 보낸 턴은 파일 이름 */
export function minimapTurns(messages: readonly HistoryMessage[]): string[] {
  return messages
    .filter((message) => message.role === 'user' && stopFeedbackReason(message.text) === undefined)
    .map((message) => message.text || (message.attachments ?? []).map((item) => item.name).join(', '))
}
