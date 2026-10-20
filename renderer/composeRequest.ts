// 확장이 연 "새 대화 + 입력창 채우기" (이슈 #557, chat.compose) — 확장 탭(FilePreview)이 알리고 App 이 받는다.
// send 면 새 대화를 열고 곧바로 보낸다(#559 — 사용자 결정: [수정 요청] 을 누르면 바로 수정, 덧붙일 말은 그 대화에서 이어서), 아니면 입력창만 채운다

export interface ComposeRequest {
  /** 그 확장 탭이 열린 프로젝트 — 지금 열린 프로젝트와 다르면 App 이 무시한다 */
  directory: string
  text: string
  send: boolean
}

const listeners = new Set<(request: ComposeRequest) => void>()

export function requestCompose(directory: string, text: string, send = false): void {
  for (const listener of listeners) listener({ directory, text, send })
}

/** 받기 — 그만 받는 함수를 준다 */
export function onCompose(listener: (request: ComposeRequest) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
