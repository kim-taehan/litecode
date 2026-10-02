import { describe, expect, it } from 'vitest'
import { isContextOverflow, turnError } from '../../src/services/contextOverflow.ts'
import { compactionThreshold, isLowContext, takeCompactions } from '../../renderer/compaction.ts'
import { translate } from '../../shared/i18n/index.ts'

// 자동 요약(압축) 화면 계산. 레거시 경로의 이벤트·기록(요약 user·summary 답·합성 Continue)은 turnProgress.test.ts(진행 줄)·history.test.ts(다시 열기)·
// turnEvents.test.ts(턴 끝) — 이슈 #20 L2. 한도 초과 사유는 history.test.ts

describe('한도 초과 알아보기', () => {
  it('opencode 가 overflow 로 보는 게이트웨이 문장', () => {
    for (const message of [
      "Provider request failed with HTTP 400: This model's maximum context length is 8000 tokens. However, you requested 9000 tokens",
      'context_length_exceeded',
      'Input exceeds the context window of this model',
      'prompt is too long: 210000 tokens > 200000 maximum',
    ]) {
      expect(isContextOverflow(message), message).toBe(true)
    }
  })

  it('속도 제한·그 밖의 실패는 그대로 둔다', () => {
    expect(isContextOverflow('Rate limit reached: too many tokens per minute')).toBe(false)
    expect(isContextOverflow('fake-llm: 요청된 실패')).toBe(false)
    expect(turnError('Provider request failed with HTTP 500')).toBe('Provider request failed with HTTP 500')
  })

  it('안내 문장 (ko)', () => {
    expect(translate('ko', 'error.contextOverflow')).toBe('대화가 모델 한도를 넘었습니다 — 새 대화로 시작해 주세요')
  })
})

describe('화면 계산', () => {
  it('문턱 = (한도 − 32000) / 한도 — 레거시는 출력 한도(우리 설정은 0 = 모름 → 32000)를 뺀다. 60K 면 28K·47%, 128K 면 75%. 한도를 모르거나 32000 이하면 없다', () => {
    expect(compactionThreshold(60_000)).toEqual({ tokens: 28_000, percent: 47 })
    expect(compactionThreshold(128_000)?.percent).toBe(75)
    expect(compactionThreshold(undefined)).toBeUndefined()
    expect(compactionThreshold(32_000)).toBeUndefined()
  })

  it('48000 미만만 경고 (문턱이 시스템 프롬프트·도구 정의보다 작으면 요약이 끝없이 돈다) — 빈 칸은 경고하지 않는다', () => {
    expect(isLowContext(undefined)).toBe(false)
    expect(isLowContext(32_000)).toBe(true)
    expect(isLowContext(47_999)).toBe(true)
    expect(isLowContext(48_000)).toBe(false)
  })

  it('끝난 턴: 끝난 압축은 구분선으로 따로, 실패한 압축은 버리고, 나머지 줄 순서는 그대로', () => {
    const text = { kind: 'text', id: 't', text: 'a', done: true } as const
    const { compactions, rest } = takeCompactions([
      { kind: 'compaction', id: 'c1', status: 'done' },
      { kind: 'compaction', id: 'c2', status: 'failed' },
      text,
    ])
    expect(compactions.map((item) => item.id)).toEqual(['c1'])
    expect(rest).toEqual([text])
  })
})
