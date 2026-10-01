// 앱 밖 브라우저로 열어도 되는 주소 — 절대 http(s) 만. 렌더러(답 말풍선 링크)와 메인(shell.openExternal 직전)이 같은 규칙을 쓴다.
// file:·javascript:·mailto:·상대 경로는 열지 않는다 — 답은 모델이 쓴 글이라 프롬프트 인젝션으로 아무 주소나 올 수 있다.
export function isWebUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value)
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false // 절대 URL 이 아님
  }
}
