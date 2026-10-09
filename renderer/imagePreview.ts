import { useEffect, useSyncExternalStore } from 'react'
import type { Attachment } from '../shared/ipc.ts'

// 이미지 칩의 미리보기 주소 (이슈 #214). 화면은 파일을 읽지 않는다 — 입력 카드의 칩(경로가 있다)이 메인에 묻고(attachmentPreview: 메인이 칩으로
// 내준 경로만 data: 주소로 준다) 여기에 둔다. 보낸 뒤의 말풍선 칩은 경로가 없어 보낼 때의 이름·크기로 같은 주소를 찾는다
// (dsh ui-attachment MessageImage 의 "submission echo's local preview" 와 같은 생각). 다시 연 대화의 이미지 칩은 크기가 없어 자리만 남는다 —
// 원본은 엔진 기록에만 있다. 앱을 끄면 사라지는 메모리 캐시이고, 열쇠가 MAX 개를 넘거나 주소 글자 합이 MAX_CHARS 를 넘으면 오래된 것부터 버린다
// (한 장이 첨부 상한 20MB 면 base64 로 ~27M 글자다)

const MAX = 40
const MAX_CHARS = 120_000_000
const cache = new Map<string, string>()
const pending = new Set<string>()
const listeners = new Set<() => void>()

type ImageItem = Pick<Attachment, 'kind' | 'name' | 'size'> & { path?: string }

/** 보낼 때의 이름·크기 — 말풍선 칩이 입력 카드 칩을 찾는 열쇠. 크기가 없으면 찾지 않는다 */
function echoKey(item: ImageItem): string | undefined {
  return item.size === undefined ? undefined : `echo:${item.name}\u0000${item.size}`
}

function keysOf(item: ImageItem): string[] {
  if (item.kind !== 'image') return []
  const echo = echoKey(item)
  return [...(item.path ? [`path:${item.path}`] : []), ...(echo ? [echo] : [])]
}

export function previewOf(item: ImageItem): string | undefined {
  for (const key of keysOf(item)) {
    const url = cache.get(key)
    if (url) return url
  }
  return undefined
}

export function rememberPreview(item: ImageItem, url: string): void {
  for (const key of keysOf(item)) {
    cache.delete(key) // 다시 넣으면 맨 뒤(가장 새것)로
    cache.set(key, url)
  }
  const chars = () => [...new Set(cache.values())].reduce((sum, value) => sum + value.length, 0)
  while (cache.size > MAX || (cache.size > keysOf(item).length && chars() > MAX_CHARS)) cache.delete(cache.keys().next().value!)
  for (const listener of listeners) listener()
}

/** 테스트용 — 캐시를 비운다 */
export function forgetPreviews(): void {
  cache.clear()
  pending.clear()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** 그 칩의 미리보기 주소 — 경로가 있는 이미지 칩이면 아직 없을 때 메인에 한 번 묻는다 */
export function useAttachmentPreview(item: ImageItem): string | undefined {
  const snapshot = () => previewOf(item)
  const url = useSyncExternalStore(subscribe, snapshot, snapshot)
  const { kind, path } = item
  useEffect(() => {
    if (kind !== 'image' || !path || previewOf(item) || pending.has(path)) return
    pending.add(path)
    window.litecode.attachmentPreview(path).then(
      (found) => {
        pending.delete(path)
        if (found) rememberPreview(item, found)
      },
      () => pending.delete(path),
    )
  }, [kind, path])
  return url
}
