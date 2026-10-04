import type { MessageKey } from './i18n/index.ts'

// HTTP 실패를 사람이 읽는 문구로 — 상태 코드만 말하던 턴 실패(게이트웨이가 거절)·설정의 "모델 가져오기" 가 쓴다.
// closed-code `httpError.ts`(본문에서 사유 꺼내기)와 사내 게이트웨이 오류 체계(401 사유 4종·429 3종·403·503·413·502/504 —
// _workspace/02x_closed_F_rest.md)를 따른다. **원문 사유는 숨기지 않는다** — 문구 뒤 괄호에 그대로 남긴다.
// 순수 함수다 (번역 함수는 받는다 — 메인은 tr, 화면은 useT)

type Translate = (key: MessageKey, vars?: Record<string, string | number>) => string

const DETAIL_MAX = 300

/** 실패 응답 본문에서 사유 문장 — OpenAI 호환 `error.message`(+`type`), opencode `data.message`, `message`. 모르는 모양이면 원문(한 줄, 300자까지) */
export function errorDetail(body: string): string {
  const raw = body.replace(/\s+/g, ' ').trim()
  try {
    const parsed = JSON.parse(raw) as { error?: unknown; data?: { message?: unknown }; message?: unknown }
    const error = parsed.error
    if (typeof error === 'string' && error) return error.slice(0, DETAIL_MAX)
    const nested = error as { message?: unknown; type?: unknown } | undefined
    const message = [nested?.message, parsed.data?.message, parsed.message].find((value): value is string => typeof value === 'string' && value !== '')
    if (message) return [typeof nested?.type === 'string' ? nested.type : '', message].filter(Boolean).join(': ').slice(0, DETAIL_MAX)
  } catch {
    // JSON 이 아니다 — 원문 그대로
  }
  return raw.slice(0, DETAIL_MAX)
}

/** 오류 글 안의 HTTP 상태 코드 (4xx·5xx) — "… HTTP 429: …", "status code 503" */
export function httpStatusOf(message: string): number | undefined {
  const found = /\bHTTP (\d{3})\b/.exec(message) ?? /\bstatus(?: code)?:? (\d{3})\b/i.exec(message)
  const status = Number(found?.[1])
  return status >= 400 && status <= 599 ? status : undefined
}

/** 상태 + 원문의 낱말(만료·분당·하루 등)로 고른 문구. 모르는 상태는 undefined */
function messageKey(status: number, detail: string): MessageKey | undefined {
  switch (status) {
    case 401:
      if (/expired|revoked|만료|폐기/i.test(detail)) return 'httpError.401.expired'
      if (/missing|not provided|no (?:api[ -]?key|auth|token)|키가 없|누락/i.test(detail)) return 'httpError.401.missing'
      return 'httpError.401'
    case 403:
      return 'httpError.403'
    case 404:
      return 'httpError.404'
    case 408:
    case 504:
      return 'httpError.timeout'
    case 413:
      return 'httpError.413'
    case 429:
      if (/per day|daily|\bday\b|하루|일일|일간/i.test(detail)) return 'httpError.429.daily'
      if (/per minute|minute|\brpm\b|\btpm\b|분당/i.test(detail)) return 'httpError.429.minute'
      return 'httpError.429'
    case 500:
      return 'httpError.500'
    case 502:
      return 'httpError.502'
    case 503:
      return 'httpError.503'
    default:
      return undefined
  }
}

/** `문구 (원문)` — 원문에 상태 코드가 없으면 `HTTP 429: 원문`. 모르는 상태는 원문만 */
export function describeHttpError(t: Translate, status: number, detail = ''): string {
  const reason = detail.trim()
  const raw = !reason ? `HTTP ${status}` : httpStatusOf(reason) === status ? reason : `HTTP ${status}: ${reason}`
  const key = messageKey(status, reason)
  return key ? `${t(key)} (${raw})` : raw
}
