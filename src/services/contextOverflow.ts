import { tr } from '../i18n.ts'

// 대화가 모델 컨텍스트 한도를 넘은 실패 알아보기 (01o 결론 1·4). 게이트웨이의 overflow 오류는 step.failed 의 error.message 에
// "Provider request failed with HTTP 400: …" 로 실려 온다. 기록은 줄지 않으므로 그 대화는 이후 모든 턴이 같은 오류로 실패한다 —
// 새 대화 말고는 복구 길이 없어서 그렇게 안내한다.
// 패턴은 opencode 1.18.18 이 overflow 로 분류하는 목록(바이너리 문자열)에서 가져왔다. 속도 제한 오류는 overflow 가 아니다

const OVERFLOW = [
  /prompt is too long/i,
  /request_too_large/i,
  /input is too long for requested model/i,
  /exceeds the context window/i,
  /maximum context length/i,
  /input token count.*exceeds the maximum/i,
  /tokens in request more than max tokens allowed/i,
  /maximum prompt length is \d+/i,
  /reduce the length of the messages/i,
  /exceeds (?:the )?maximum allowed input length/i,
  /is longer than the model'?s context length/i,
  /exceeds the available context size/i,
  /greater than the context length/i,
  /context window exceeds limit/i,
  /exceeded model token limit/i,
  /context[_ ]length[_ ]exceeded/i,
  /context length is only \d+ tokens/i,
  /input length.*exceeds.*context length/i,
  /prompt too long; exceeded (?:max )?context length/i,
  /but the configured context size is/i,
  /model_context_window_exceeded/i,
  /too many tokens/i,
  /token limit exceeded/i,
]
const NOT_OVERFLOW = [/rate limit/i, /too many requests/i]

export function isContextOverflow(message: string): boolean {
  return !NOT_OVERFLOW.some((pattern) => pattern.test(message)) && OVERFLOW.some((pattern) => pattern.test(message))
}

/** 턴 실패 사유 — 한도 초과면 안내 문장으로 바꾸고, 아니면 그대로 */
export function turnError(message: string): string {
  return isContextOverflow(message) ? tr('error.contextOverflow') : message
}
