import { stopFeedbackReason } from '../shared/hooks.ts'
import type { HistoryMessage } from '../shared/ipc.ts'

// 입력 기록 ↑/↓ (closed-code useInputHistory 의 동작, 셸의 기록처럼) — 빈 입력창에서 ↑ 로 그 대화에 내가 보낸 이전 글을 불러오고
// ↓ 로 되돌아온다. 끼어들지 않는 때: 쓰던 글이 있다 · 불러온 글을 고쳤다 · 글을 골라 뒀다 · 여러 줄 글 안에서 커서가 옮겨 갈 줄이 남았다
// (첫 줄에서만 ↑, 마지막 줄에서만 ↓). 한글 조합 중·후보 팝업(@ · /)은 입력창의 키 처리가 먼저 거른다. 순수 함수다

/** 그 대화에서 내가 친 글 (오래된 것부터) — 다른 대화가 보낸 지시·턴 끝 훅이 이어 보낸 글(이슈 #102)·글 없이 첨부만 보낸 것·바로 앞과 같은 글은 뺀다 */
export function sentTexts(messages: readonly Pick<HistoryMessage, 'role' | 'text' | 'origin'>[]): string[] {
  const texts: string[] = []
  for (const message of messages) {
    const text = message.text.trim()
    if (message.role === 'user' && !message.origin && text && stopFeedbackReason(text) === undefined && texts.at(-1) !== text) texts.push(text)
  }
  return texts
}

export interface InputState {
  text: string
  /** 선택 영역 (selectionStart·selectionEnd) */
  start: number
  end: number
}

/**
 * ↑/↓ 한 번 — 입력창에 넣을 글과 새 자리를 준다. 기록 이동이 아니면 undefined (키를 브라우저에 맡긴다).
 * index: 지금 불러와 있는 글의 자리 (entries 안, 없으면 기록을 보고 있지 않다). 돌려준 index 가 undefined 면 기록에서 나왔다(빈 입력)
 */
export function browseHistory(
  entries: readonly string[],
  index: number | undefined,
  key: 'up' | 'down',
  input: InputState,
): { text: string; index: number | undefined } | undefined {
  if (input.start !== input.end) return undefined
  const browsing = index !== undefined && entries[index] === input.text
  if (!browsing) {
    if (key === 'down' || input.text !== '' || entries.length === 0) return undefined
    return { text: entries.at(-1)!, index: entries.length - 1 }
  }
  if (key === 'up') {
    if (index === 0 || input.text.slice(0, input.start).includes('\n')) return undefined
    return { text: entries[index - 1]!, index: index - 1 }
  }
  if (input.text.slice(input.end).includes('\n')) return undefined
  return index < entries.length - 1 ? { text: entries[index + 1]!, index: index + 1 } : { text: '', index: undefined }
}
