import type { AttachmentKind } from '../shared/ipc.ts'

// 첨부 칩(이슈 #44)의 화면용 순수 함수. 화면은 파일 내용을 읽지 않는다 — 경로·이름·크기만 든다

/** 칩의 크기 글자 — `512B` · `12KB` · `1.5KB` · `3MB` (소수 한 자리, 0 이면 뺀다) */
export function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  const mega = bytes >= 1024 * 1024
  return `${Math.round((bytes / (mega ? 1024 * 1024 : 1024)) * 10) / 10}${mega ? 'MB' : 'KB'}`
}

// 말풍선에 그릴 칩(chipsOf)은 shared/chat.ts — 내 말을 만드는 메인(ctx.chat)과 같이 쓴다 (이슈 #52)
export { chipsOf } from '../shared/chat.ts'

/** 그 종류가 몇 개 붙어 있나 — 상한(한 메시지 N개)은 입력 카드의 것과 대기열에 쌓인 것을 합쳐 센다 (턴 끝에 한 메시지로 합쳐 나간다) */
export function countOf(kind: AttachmentKind, ...lists: (readonly { kind: AttachmentKind }[] | undefined)[]): number {
  return lists.flatMap((list) => list ?? []).filter((item) => item.kind === kind).length
}
