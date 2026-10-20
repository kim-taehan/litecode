// 확장이 연 "새 대화 + 입력창 채우기" (이슈 #557, chat.compose) — 확장 탭(FilePreview)이 알리고 App 이 받는다.
// 보내지 않는다: 새 대화를 열고 입력창에 글만 넣는다 — 확장이 AI 에게 직접 지시하지 못하게, 보내기는 사용자가 누른다

export interface ComposeRequest {
  /** 그 확장 탭이 열린 프로젝트 — 지금 열린 프로젝트와 다르면 App 이 무시한다 */
  directory: string
  text: string
}

const listeners = new Set<(request: ComposeRequest) => void>()

export function requestCompose(directory: string, text: string): void {
  for (const listener of listeners) listener({ directory, text })
}

/** 받기 — 그만 받는 함수를 준다 */
export function onCompose(listener: (request: ComposeRequest) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
