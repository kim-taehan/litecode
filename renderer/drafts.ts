import type { PickedAttachment, QueuedSend } from '../shared/ipc.ts'

// 대화별 초안 — 입력창의 글과 붙여 둔 칩을 대화 id 마다 따로 둔다 (dsh ui-conversation "대화마다 편집기 하나").
// 전에는 창 전체에 하나라 대화를 바꾸면 쓰던 글이 따라가 엉뚱한 대화에 보낼 수 있었다. 아직 안 보낸 "새 대화" 도 제 id 가 있다.
// 메모리에만 둔다 (dsh 도 디스크에 남기지 않는다). 순수 함수다

export interface Draft {
  text: string
  /** 입력 카드에 붙여 둔 파일·이미지 (이슈 #44) — 경로만 든다(읽기는 보낼 때 메인) */
  attached: PickedAttachment[]
}

export type Drafts = Readonly<Record<string, Draft>>

const EMPTY: Draft = { text: '', attached: [] }

export function draftOf(drafts: Drafts, id: string | undefined): Draft {
  return (id !== undefined && drafts[id]) || EMPTY
}

/** 그 대화의 초안을 바꾼다. 비면 맵에서 뺀다. 바뀐 게 없으면 같은 맵 */
export function changeDraft(drafts: Drafts, id: string, change: (draft: Draft) => Draft): Drafts {
  const before = draftOf(drafts, id)
  const after = change(before)
  if (after === before) return drafts
  if (after.text === '' && after.attached.length === 0) return withoutDrafts(drafts, [id])
  return { ...drafts, [id]: after }
}

/** 지운 대화의 초안을 버린다 */
export function withoutDrafts(drafts: Drafts, ids: readonly string[]): Drafts {
  if (!ids.some((id) => id in drafts)) return drafts
  return Object.fromEntries(Object.entries(drafts).filter(([id]) => !ids.includes(id)))
}

/** 대기열에서 꺼낸 것(되돌리기·멈춘 턴)을 초안에 — 글은 쓰던 글 앞에, 첨부 칩도 겹치지 않게 앞에 */
export function restoreInto(draft: Draft, taken: Pick<QueuedSend, 'text' | 'display' | 'attachments'>): Draft {
  const files = taken.attachments ?? []
  return {
    text: [taken.display ?? taken.text, draft.text.trim()].filter(Boolean).join('\n'),
    attached: [...files, ...draft.attached.filter((item) => !files.some((file) => file.path === item.path && file.kind === item.kind))],
  }
}
