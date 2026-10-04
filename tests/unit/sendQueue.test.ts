import { describe, expect, it } from 'vitest'
import { mergeQueued, SendQueues } from '../../renderer/useSendQueue.ts'

// 답하는 중 보내기 = 화면 큐 (closed-code useSendQueue 방식, 대화별). 엔진에는 늘 한 턴씩만 간다

describe('mergeQueued', () => {
  it('하나면 그대로, 여럿이면 본문을 줄바꿈으로 잇는다', () => {
    expect(mergeQueued([{ text: 'a' }])).toEqual({ text: 'a' })
    expect(mergeQueued([{ text: 'a' }, { text: 'b' }])).toEqual({ text: 'a\nb' })
  })

  it('보일 글(`/` 명령)이 하나라도 있으면 보일 글도 잇는다 — 없는 것은 본문으로', () => {
    expect(mergeQueued([{ text: 'expanded', display: '/hi x' }, { text: 'plain' }])).toEqual({ text: 'expanded\nplain', display: '/hi x\nplain' })
  })

  it('필드를 골라 다시 쌓지 않는다 — 이을 수 없는 새 필드는 마지막 것이 살아남는다 (closed-code DC-1322)', () => {
    const items = [{ text: 'a', mode: 'plan' }, { text: 'b', mode: 'build' }]
    expect(mergeQueued(items)).toEqual({ text: 'a\nb', mode: 'build' })
  })

  // 첨부 (이슈 #44) — 쌓인 메시지마다의 첨부를 순서대로 다 가진다 (마지막 것만 남으면 앞 메시지의 첨부가 조용히 사라진다)
  it('첨부는 쌓인 순서대로 잇는다 — 첨부가 없는 것과 섞여도', () => {
    const a = { kind: 'file' as const, path: '/w/a.md', name: 'a.md', size: 1 }
    const b = { kind: 'image' as const, path: '/w/b.png', name: 'b.png', size: 2 }
    expect(mergeQueued([{ text: 'one', attachments: [a] }, { text: 'two' }, { text: '', attachments: [b] }])).toEqual({ text: 'one\ntwo', attachments: [a, b] })
    expect(mergeQueued([{ text: 'x' }, { text: 'y' }])).not.toHaveProperty('attachments')
  })
})

describe('SendQueues — 첨부 (이슈 #44)', () => {
  const image = { kind: 'image' as const, path: '/w/shot.png', name: 'shot.png', size: 9 }

  it('턴 중 쌓인 메시지는 첨부를 그대로 갖고 턴 끝에 나간다', () => {
    const queues = new SendQueues()
    queues.observe('c1', true)
    queues.submit('c1', { text: 'look', attachments: [image] }, true)
    expect(queues.items('c1')).toEqual([{ text: 'look', attachments: [image] }])
    expect(queues.observe('c1', false)).toEqual({ text: 'look', attachments: [image] })
  })

  it('되돌리기(take)는 첨부도 돌려준다', () => {
    const queues = new SendQueues()
    queues.submit('c1', { text: '', attachments: [image] }, true)
    queues.submit('c1', { text: 'and this' }, true)
    expect(queues.take('c1')).toEqual({ text: 'and this', attachments: [image] })
    expect(queues.items('c1')).toEqual([])
  })
})

describe('SendQueues', () => {
  it('턴이 안 돌면 바로 보내라고(false), 돌면 쌓는다(true)', () => {
    const queues = new SendQueues()
    expect(queues.submit('c1', { text: 'now' }, false)).toBe(false)
    expect(queues.items('c1')).toEqual([])
    expect(queues.submit('c1', { text: 'later' }, true)).toBe(true)
    expect(queues.items('c1')).toEqual([{ text: 'later' }])
  })

  it('앞에 쌓인 것이 있으면 턴이 안 돌아도 뒤에 붙인다 — 순서가 뒤바뀌지 않게', () => {
    const queues = new SendQueues()
    queues.submit('c1', { text: 'one' }, true)
    expect(queues.submit('c1', { text: 'two' }, false)).toBe(true)
    expect(queues.items('c1').map((item) => item.text)).toEqual(['one', 'two'])
  })

  it('대화별로 따로 쌓는다', () => {
    const queues = new SendQueues()
    queues.submit('c1', { text: 'a' }, true)
    queues.submit('c2', { text: 'b' }, true)
    expect(queues.items('c1')).toEqual([{ text: 'a' }])
    expect(queues.items('c2')).toEqual([{ text: 'b' }])
  })

  it('그 대화의 턴이 끝나는 순간에만 합친 것을 한 번 준다', () => {
    const queues = new SendQueues()
    expect(queues.observe('c1', true)).toBeUndefined()
    queues.submit('c1', { text: 'a' }, true)
    queues.submit('c1', { text: 'b' }, true)
    expect(queues.observe('c1', true)).toBeUndefined() // 아직 도는 중
    expect(queues.observe('c1', false)).toEqual({ text: 'a\nb' })
    expect(queues.items('c1')).toEqual([])
    expect(queues.observe('c1', false)).toBeUndefined() // 같은 끝을 두 번 보지 않는다 (StrictMode·다시 그리기)
  })

  it('다른 대화의 턴 끝은 이 대화 큐를 비우지 않는다', () => {
    const queues = new SendQueues()
    queues.observe('c1', true)
    queues.observe('c2', true)
    queues.submit('c1', { text: 'a' }, true)
    expect(queues.observe('c2', false)).toBeUndefined()
    expect(queues.items('c1')).toEqual([{ text: 'a' }])
    expect(queues.observe('c1', false)).toEqual({ text: 'a' })
  })

  it('쌓인 것 없이 끝나면 보낼 것이 없다', () => {
    const queues = new SendQueues()
    queues.observe('c1', true)
    expect(queues.observe('c1', false)).toBeUndefined()
  })

  it('되돌리기(take) — 합친 것을 주고 비운다. 그 뒤 턴이 끝나도 보내지 않는다', () => {
    const queues = new SendQueues()
    queues.observe('c1', true)
    queues.submit('c1', { text: 'a' }, true)
    queues.submit('c1', { text: 'b' }, true)
    expect(queues.take('c1')).toEqual({ text: 'a\nb' })
    expect(queues.take('c1')).toBeUndefined()
    expect(queues.observe('c1', false)).toBeUndefined()
  })

  it('바뀌면 구독자에게 알린다 (화면 다시 그리기)', () => {
    const queues = new SendQueues()
    let calls = 0
    const off = queues.subscribe(() => calls++)
    queues.submit('c1', { text: 'a' }, true)
    queues.take('c1')
    off()
    queues.submit('c1', { text: 'b' }, true)
    expect(calls).toBe(2)
  })
})

describe('SendQueues — 사용자가 멈춘 턴 (이슈 #3)', () => {
  it('멈춘(hold) 대화는 턴이 끝나도 보내지 않고 쌓인 것을 남긴다 — 되돌리기(take)로 가져가면 풀린다', () => {
    const queues = new SendQueues()
    queues.observe('c1', true)
    queues.submit('c1', { text: 'a' }, true)
    queues.submit('c1', { text: 'b' }, true)
    queues.hold('c1')
    expect(queues.held('c1')).toBe(true)
    expect(queues.observe('c1', false)).toBeUndefined()
    expect(queues.items('c1').map((item) => item.text)).toEqual(['a', 'b'])
    expect(queues.take('c1')).toEqual({ text: 'a\nb' })
    expect(queues.held('c1')).toBe(false)
  })

  it('쌓인 것이 없으면 멈춰도 붙잡지 않는다 — 다음 턴 끝은 평소대로', () => {
    const queues = new SendQueues()
    queues.observe('c1', true)
    queues.hold('c1')
    expect(queues.held('c1')).toBe(false)
    queues.observe('c1', false)
    queues.observe('c1', true)
    queues.submit('c1', { text: 'next' }, true)
    expect(queues.observe('c1', false)).toEqual({ text: 'next' })
  })

  it('다른 대화는 붙잡지 않는다', () => {
    const queues = new SendQueues()
    queues.observe('c2', true)
    queues.submit('c2', { text: 'x' }, true)
    queues.submit('c1', { text: 'y' }, true)
    queues.hold('c1')
    expect(queues.observe('c2', false)).toEqual({ text: 'x' })
  })
})
