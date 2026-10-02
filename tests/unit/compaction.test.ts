import { describe, expect, it } from 'vitest'
import { TurnTracker } from '../../src/services/turnProgress.ts'
import { historyMessages } from '../../src/services/llm.ts'
import { isContextOverflow, turnError } from '../../src/services/contextOverflow.ts'
import { compactionThreshold, isLowContext, takeCompactions } from '../../renderer/compaction.ts'
import { translate } from '../../shared/i18n/index.ts'

// 자동 요약(압축) — 이벤트·기록 모양은 01o 실측 그대로 (opencode 1.18.18): 세션 SSE 에 compaction.started → .ended(같은 messageID),
// 요약 요청이 실패하면 ended 없이 step.started. /message 엔 {type:"compaction", reason:"auto", summary, recent} 가 그 턴 user 뒤에 낀다

const ev = (type: string, data: Record<string, unknown> = {}) => [`session.next.${type}`, { sessionID: 'ses', timestamp: 1, ...data }] as const

describe('TurnTracker — 압축 줄', () => {
  it('started 는 요약 중, ended 는 끝남 (같은 줄)', () => {
    const tracker = new TurnTracker()
    expect(tracker.observe(...ev('compaction.started', { messageID: 'msg_c', reason: 'auto' }))).toEqual({ kind: 'compaction', id: 'compaction:msg_c', status: 'running' })
    expect(tracker.observe(...ev('compaction.ended', { messageID: 'msg_c', reason: 'auto', text: '## Objective', recent: '[User]: x' }))).toEqual({
      kind: 'compaction',
      id: 'compaction:msg_c',
      status: 'done',
    })
    expect(tracker.observe(...ev('step.started', { assistantMessageID: 'm1' }))).toBeUndefined() // 끝난 요약은 다시 안 건드린다
  })

  it('ended 없이 스텝이 이어지면(요약 실패) 그 줄을 failed 로 — 화면에서 지운다', () => {
    const tracker = new TurnTracker()
    tracker.observe(...ev('compaction.started', { messageID: 'msg_c' }))
    expect(tracker.observe(...ev('step.started', { assistantMessageID: 'm1' }))).toEqual({ kind: 'compaction', id: 'compaction:msg_c', status: 'failed' })
    expect(tracker.observe(...ev('text.started', { assistantMessageID: 'm1', textID: 'text-0' }))).toMatchObject({ kind: 'text' })
  })
})

describe('historyMessages — 압축 기록', () => {
  it('compaction 메시지는 말풍선이 아니라 다음 답의 진행 줄 맨 앞에 (실시간 턴과 같은 자리)', () => {
    const messages = historyMessages(
      [
        { type: 'user', text: 'u1', time: { created: 1 } },
        { type: 'compaction', id: 'msg_c', reason: 'auto', summary: '## Objective', recent: '[User]: u1', time: { created: 2 } } as never,
        { type: 'assistant', id: 'msg_a', time: { created: 3, completed: 4 }, content: [{ type: 'text', id: 'text-0', text: 'echo' }] },
      ],
      false,
    )
    expect(messages).toHaveLength(2)
    expect(messages[1]!.items?.[0]).toEqual({ kind: 'compaction', id: 'compaction:msg_c', status: 'done' })
    expect(messages[1]!.text).toBe('echo')
  })

  it('한도 초과로 실패한 답은 다시 열어도 안내 문장', () => {
    const [, reply] = historyMessages(
      [
        { type: 'user', text: 'u1', time: { created: 1 } },
        { type: 'assistant', time: { created: 2, completed: 3 }, content: [], error: { message: "Provider request failed with HTTP 400: This model's maximum context length is 8000 tokens" } },
      ],
      false,
    )
    expect(reply!.error).toBe(turnError('maximum context length is 8000 tokens'))
    expect(reply!.error).not.toContain('HTTP 400')
  })
})

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
  it('문턱 = (한도 − 20000) / 한도 — 32K 면 12K·38%, 128K 면 84%. 한도를 모르거나 20000 이하면 없다', () => {
    expect(compactionThreshold(32_000)).toEqual({ tokens: 12_000, percent: 38 })
    expect(compactionThreshold(128_000)?.percent).toBe(84)
    expect(compactionThreshold(undefined)).toBeUndefined()
    expect(compactionThreshold(8_000)).toBeUndefined()
  })

  it('24000 미만만 경고 — 빈 칸은 경고하지 않는다(요약이 꺼질 뿐)', () => {
    expect(isLowContext(undefined)).toBe(false)
    expect(isLowContext(8_000)).toBe(true)
    expect(isLowContext(23_999)).toBe(true)
    expect(isLowContext(24_000)).toBe(false)
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
