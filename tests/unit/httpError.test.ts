import { describe, expect, it } from 'vitest'
import { describeHttpError, errorDetail, httpStatusOf } from '../../shared/httpError.ts'
import { turnError } from '../../src/services/contextOverflow.ts'
import { failureText } from '../../src/services/history.ts'
import { translate, type MessageKey } from '../../shared/i18n/index.ts'

// HTTP 실패를 사람이 읽는 문구로 (closed-code httpError + 게이트웨이 오류 체계 — 02x_closed_F). 상태 코드만 말하던 곳:
// 턴 실패(게이트웨이가 거절)·설정의 "모델 가져오기". 원문 사유는 숨기지 않고 괄호로 남긴다

const ko = (key: MessageKey, vars?: Record<string, string | number>) => translate('ko', key, vars)
const en = (key: MessageKey, vars?: Record<string, string | number>) => translate('en', key, vars)

describe('describeHttpError', () => {
  it('401 — 키가 틀림·만료·없음을 가른다', () => {
    expect(describeHttpError(ko, 401, 'Invalid API key')).toBe('API 키가 맞지 않습니다 — 설정 > 모델에서 키를 확인하세요 (HTTP 401: Invalid API key)')
    expect(describeHttpError(ko, 401, '만료된 키입니다')).toContain('API 키가 만료됐거나 폐기됐습니다')
    expect(describeHttpError(ko, 401, 'The key has been revoked')).toContain('API 키가 만료됐거나 폐기됐습니다')
    expect(describeHttpError(ko, 401, 'Missing Authorization header')).toContain('API 키가 없습니다')
  })

  it('403·404·시간 초과(408·504)', () => {
    expect(describeHttpError(ko, 403)).toBe('이 요청은 허용되지 않습니다 (권한·정책) — 관리자에게 문의하세요 (HTTP 403)')
    expect(describeHttpError(ko, 404, 'model not found')).toContain('주소나 모델 이름을 찾지 못했습니다')
    expect(describeHttpError(ko, 408)).toContain('응답 시간이 초과됐습니다')
    expect(describeHttpError(ko, 504)).toContain('응답 시간이 초과됐습니다')
  })

  it('413 은 "요청이 너무 큼" 이다 — 컨텍스트 초과 안내(새 대화로)와 다른 문장', () => {
    const text = describeHttpError(ko, 413, 'request_too_large')
    expect(text).toContain('요청이 너무 큽니다')
    expect(text).not.toContain(ko('error.contextOverflow'))
  })

  it('429 — 응답에 분당/하루가 있으면 가른다', () => {
    expect(describeHttpError(ko, 429, 'Too Many Requests')).toContain('요청 한도를 넘었습니다')
    expect(describeHttpError(ko, 429, 'RPM limit exceeded')).toContain('분당 요청 한도를 넘었습니다')
    expect(describeHttpError(ko, 429, '분당 토큰 한도 초과')).toContain('분당 요청 한도를 넘었습니다')
    expect(describeHttpError(ko, 429, '하루 한도를 넘었습니다')).toContain('하루 사용 한도를 넘었습니다')
    expect(describeHttpError(ko, 429, 'daily quota exceeded')).toContain('하루 사용 한도를 넘었습니다')
  })

  it('500·502·503', () => {
    expect(describeHttpError(ko, 500)).toContain('모델 서버에 오류가 났습니다')
    expect(describeHttpError(ko, 502)).toContain('게이트웨이가 모델 서버에서 올바른 응답을 받지 못했습니다')
    expect(describeHttpError(ko, 503)).toContain('모델 서버를 지금 쓸 수 없습니다')
  })

  it('원문에 이미 상태 코드가 있으면 다시 붙이지 않고, 모르는 상태는 원문만', () => {
    expect(describeHttpError(ko, 500, 'Provider request failed with HTTP 500')).toBe(
      '모델 서버에 오류가 났습니다 — 잠시 뒤 다시 시도하세요 (Provider request failed with HTTP 500)',
    )
    expect(describeHttpError(ko, 418, "I'm a teapot")).toBe("HTTP 418: I'm a teapot")
    expect(describeHttpError(ko, 418)).toBe('HTTP 418')
  })

  it('영어 문구', () => {
    expect(describeHttpError(en, 401, 'Invalid API key')).toBe('The API key was rejected — check the key in Settings > Models (HTTP 401: Invalid API key)')
    expect(describeHttpError(en, 429, 'requests per day')).toContain('daily usage limit')
  })
})

describe('errorDetail — 실패 응답 본문에서 사유 꺼내기', () => {
  it('OpenAI 호환 error.message (+type), opencode data.message, message', () => {
    expect(errorDetail('{"error":{"message":"하루 한도를 넘었습니다","type":"daily_limit"}}')).toBe('daily_limit: 하루 한도를 넘었습니다')
    expect(errorDetail('{"error":{"message":"Invalid API key"}}')).toBe('Invalid API key')
    expect(errorDetail('{"error":"plain"}')).toBe('plain')
    expect(errorDetail('{"data":{"message":"from opencode"}}')).toBe('from opencode')
    expect(errorDetail('{"message":"top"}')).toBe('top')
  })

  it('모르는 모양·JSON 이 아닌 본문은 원문(한 줄, 300자까지), 빈 본문은 빈 글', () => {
    expect(errorDetail('<html>\n  Bad Gateway\n</html>')).toBe('<html> Bad Gateway </html>')
    expect(errorDetail('x'.repeat(500))).toHaveLength(300)
    expect(errorDetail('  ')).toBe('')
  })
})

describe('httpStatusOf — 오류 글 안의 상태 코드', () => {
  it('"HTTP 429"·"status code 503" 을 읽는다. 없으면 undefined', () => {
    expect(httpStatusOf('Provider request failed with HTTP 429: slow down')).toBe(429)
    expect(httpStatusOf('Request failed with status code 503')).toBe(503)
    expect(httpStatusOf('fake-llm: 요청된 실패')).toBeUndefined()
    expect(httpStatusOf('HTTP 200 OK')).toBeUndefined()
  })
})

describe('턴 실패 사유', () => {
  it('상태 코드가 있는 실패는 문구 + 원문', () => {
    expect(turnError('Provider request failed with HTTP 401: Invalid API key')).toBe(
      'API 키가 맞지 않습니다 — 설정 > 모델에서 키를 확인하세요 (Provider request failed with HTTP 401: Invalid API key)',
    )
  })

  it('상태 코드가 없는 실패는 그대로', () => {
    expect(turnError('fake-llm: 요청된 실패')).toBe('fake-llm: 요청된 실패')
  })

  it('컨텍스트 초과(400)는 여전히 "새 대화로" 안내', () => {
    expect(turnError("Provider request failed with HTTP 400: This model's maximum context length is 8000 tokens")).toBe(ko('error.contextOverflow'))
  })

  it('413 request_too_large 는 컨텍스트 초과로 안내하지 않는다 (게이트웨이의 요청 본문 상한)', () => {
    const text = turnError('Provider request failed with HTTP 413: request_too_large')
    expect(text).toContain('요청이 너무 큽니다')
    expect(text).not.toBe(ko('error.contextOverflow'))
  })

  it('엔진이 상태 코드를 따로 주면(레거시 APIError.data.statusCode — 01w) 그것으로 가른다', () => {
    expect(failureText({ name: 'APIError', data: { message: '하루 한도를 넘었습니다', statusCode: 429 } })).toBe(
      '하루 사용 한도를 넘었습니다 — 내일 다시 시도하거나 관리자에게 문의하세요 (HTTP 429: 하루 한도를 넘었습니다)',
    )
    expect(failureText({ name: 'ContextOverflowError', data: { message: 'request_too_large', statusCode: 413 } })).toContain('요청이 너무 큽니다')
    expect(failureText({ name: 'ContextOverflowError' })).toBe(ko('error.contextOverflow'))
  })
})
