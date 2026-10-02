import { useSyncExternalStore } from 'react'

// 파일 미리보기 패널이 보여 줄 파일 — 답의 파일 칩(Markdown.tsx)이 열고, 패널(FilePreview.tsx)이 그린다. 둘이 멀리 떨어져 있어
// (칩은 답 깊숙이, 패널은 앱 틀 오른쪽) props 로 잇지 않고 작은 저장소 하나로 잇는다. 경로가 아니라 칩과 같은 (프로젝트, 답의 글자) 만 쥔다.

export interface PreviewTarget {
  directory: string
  token: string
}

let current: PreviewTarget | undefined
const listeners = new Set<() => void>()

function set(next: PreviewTarget | undefined): void {
  current = next
  for (const listener of listeners) listener()
}

/** 같은 칩을 다시 눌러도 새 값 — 패널이 다시 포커스를 잡는다(Esc 로 닫히게). 내용은 (directory, token) 이 같으면 다시 읽지 않는다 */
export function openFilePreview(directory: string, token: string): void {
  set({ directory, token })
}

export function closeFilePreview(): void {
  if (current) set(undefined)
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function usePreviewTarget(): PreviewTarget | undefined {
  return useSyncExternalStore(subscribe, () => current)
}
