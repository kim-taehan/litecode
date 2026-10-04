import type { Attachment, AttachmentKind, PickedAttachment } from '../shared/ipc.ts'

// 첨부 칩(이슈 #44)의 화면용 순수 함수. 화면은 파일 내용을 읽지 않는다 — 경로·이름·크기만 든다

/** 칩의 크기 글자 — `512B` · `12KB` · `1.5KB` · `3MB` (소수 한 자리, 0 이면 뺀다) */
export function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  const mega = bytes >= 1024 * 1024
  return `${Math.round((bytes / (mega ? 1024 * 1024 : 1024)) * 10) / 10}${mega ? 'MB' : 'KB'}`
}

/** 말풍선에 그릴 칩 — 경로 없이, 파일 먼저 이미지 나중. 다시 연 대화(메인이 적어 둔 파일 칩 + 엔진 기록의 이미지 칩)와 같은 순서 */
export function chipsOf(picked: readonly PickedAttachment[]): Attachment[] {
  const chip = ({ kind, name, size }: PickedAttachment): Attachment => ({ kind, name, size })
  return [...picked.filter((item) => item.kind !== 'image').map(chip), ...picked.filter((item) => item.kind === 'image').map(chip)]
}

/** 그 종류가 몇 개 붙어 있나 — 상한(한 메시지 N개)은 입력 카드의 것과 대기열에 쌓인 것을 합쳐 센다 (턴 끝에 한 메시지로 합쳐 나간다) */
export function countOf(kind: AttachmentKind, ...lists: (readonly PickedAttachment[] | undefined)[]): number {
  return lists.flatMap((list) => list ?? []).filter((item) => item.kind === kind).length
}
