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
    // 상태 코드가 있는 실패는 문구가 앞에 붙고 원문은 괄호에 남는다 (httpError.test.ts)
    expect(turnError('Provider request failed with HTTP 500')).toContain('(Provider request failed with HTTP 500)')
  })

  it('안내 문장 (ko)', () => {
    expect(translate('ko', 'error.contextOverflow')).toBe('대화가 모델 한도를 넘었습니다 — 새 대화로 시작해 주세요')
  })
})

describe('화면 계산', () => {
  // 이슈 #27 실측(opencode 1.18.18 레거시): 문턱 = context − (min(limit.output, 32000) || 32000), 앱은 최대 출력을 비우면 context/4(최대 32000)를 넣는다
  it('문턱 = 한도 − 출력 한도 — 최대 출력을 비우면 한도의 1/4(최대 32000)라 75%. 적으면 그 값, 32000 을 넘으면 32000. 한도를 모르거나 문턱이 0 이하면 없다', () => {
    expect(compactionThreshold(60_000)).toEqual({ tokens: 45_000, percent: 75 })
    expect(compactionThreshold(24_000)).toEqual({ tokens: 18_000, percent: 75 })
    expect(compactionThreshold(200_000)).toEqual({ tokens: 168_000, percent: 84 })
    expect(compactionThreshold(24_000, 4_000)).toEqual({ tokens: 20_000, percent: 83 })
    expect(compactionThreshold(100_000, 64_000)).toEqual({ tokens: 68_000, percent: 68 })
    expect(compactionThreshold(undefined)).toBeUndefined()
    expect(compactionThreshold(undefined, 8_000)).toBeUndefined()
    expect(compactionThreshold(24_000, 24_000)).toBeUndefined()
  })

  it('문턱(한도 − 출력 한도)이 16000 미만만 경고 (시스템 프롬프트·도구 정의보다 작으면 요약이 끝없이 돈다) — 빈 칸은 경고하지 않는다', () => {
    expect(isLowContext({})).toBe(false)
    expect(isLowContext({ maxOutput: 8_000 })).toBe(false)
    expect(isLowContext({ contextLength: 24_000 })).toBe(false) // 기본 출력 6000 → 문턱 18000
    expect(isLowContext({ contextLength: 21_000 })).toBe(true) // 5250 → 15750
    expect(isLowContext({ contextLength: 24_000, maxOutput: 8_001 })).toBe(true)
    expect(isLowContext({ contextLength: 48_000, maxOutput: 32_000 })).toBe(false)
    expect(isLowContext({ contextLength: 47_999, maxOutput: 64_000 })).toBe(true) // opencode 가 32000 으로 자른다
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
