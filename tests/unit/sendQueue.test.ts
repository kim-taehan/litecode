import { describe, expect, it } from 'vitest'
import { mergeQueued, SendQueues } from '../../src/services/sendQueue.ts'

// 답하는 중 보내기 = 대화별 대기열 (closed-code useSendQueue 방식). 엔진에는 늘 한 턴씩만 간다. 메인의 ctx.chat 이 쥔다 (이슈 #52 —
// 원래 화면의 renderer/useSendQueue.ts. 화면이 pending 을 지켜보던 observe 는 턴 끝에 부르는 next 가 됐다)

describe('mergeQueued', () => {
  it('하나면 그대로, 여럿이면 본문을 줄바꿈으로 잇는다', () => {
    expect(mergeQueued([{ text: 'a' }])).toEqual({ text: 'a' })
    expect(mergeQueued([{ text: 'a' }, { text: 'b' }])).toEqual({ text: 'a\nb' })
  })

  it('보일 글(`/` 명령)이 하나라도 있으면 보일 글도 잇는다 — 없는 것은 본문으로', () => {
    expect(mergeQueued([{ text: 'expanded', display: '/hi x' }, { text: 'plain' }])).toEqual({ text: 'expanded\nplain', display: '/hi x\nplain' })
  })

  it('필드를 골라 다시 쌓지 않는다 — 이을 수 없는 새 필드는 마지막 것이 살아남는다 (closed-code DC-1322)', () => {
    const items = [{ text: 'a', mode: 'plan' as const }, { text: 'b', mode: 'build' as const }]
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
    queues.submit('c1', { text: 'look', attachments: [image] }, true)
    expect(queues.items('c1')).toEqual([{ text: 'look', attachments: [image] }])
    expect(queues.next('c1')).toEqual({ text: 'look', attachments: [image] })
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
    expect(queues.ids().sort()).toEqual(['c1', 'c2'])
  })

  it('그 대화의 턴이 끝나면(next) 합친 것을 한 번 준다', () => {
    const queues = new SendQueues()
    queues.submit('c1', { text: 'a' }, true)
    queues.submit('c1', { text: 'b' }, true)
    expect(queues.next('c1')).toEqual({ text: 'a\nb' })
    expect(queues.items('c1')).toEqual([])
    expect(queues.next('c1')).toBeUndefined() // 같은 끝을 두 번 보지 않는다
  })

  it('다른 대화의 턴 끝은 이 대화 큐를 비우지 않는다', () => {
    const queues = new SendQueues()
    queues.submit('c1', { text: 'a' }, true)
    expect(queues.next('c2')).toBeUndefined()
    expect(queues.items('c1')).toEqual([{ text: 'a' }])
    expect(queues.next('c1')).toEqual({ text: 'a' })
  })

  it('쌓인 것 없이 끝나면 보낼 것이 없다', () => {
    expect(new SendQueues().next('c1')).toBeUndefined()
  })

  it('되돌리기(take) — 합친 것을 주고 비운다. 그 뒤 턴이 끝나도 보내지 않는다', () => {
    const queues = new SendQueues()
    queues.submit('c1', { text: 'a' }, true)
    queues.submit('c1', { text: 'b' }, true)
    expect(queues.take('c1')).toEqual({ text: 'a\nb' })
    expect(queues.take('c1')).toBeUndefined()
    expect(queues.next('c1')).toBeUndefined()
  })

  it('바뀌면 구독자에게 그 대화 id 로 알린다 (화면에 대기열을 다시 보낸다)', () => {
    const queues = new SendQueues()
    const calls: string[] = []
    const off = queues.subscribe((id) => calls.push(id))
    queues.submit('c1', { text: 'a' }, true)
    queues.take('c1')
    off()
    queues.submit('c1', { text: 'b' }, true)
    expect(calls).toEqual(['c1', 'c1'])
  })
})

describe('SendQueues — 사용자가 멈춘 턴 (이슈 #3)', () => {
  it('멈춘(hold) 대화는 턴이 끝나도 보내지 않고 쌓인 것을 남긴다 — 되돌리기(take)로 가져가면 풀린다', () => {
    const queues = new SendQueues()
    queues.submit('c1', { text: 'a' }, true)
    queues.submit('c1', { text: 'b' }, true)
    queues.hold('c1')
    expect(queues.held('c1')).toBe(true)
    expect(queues.next('c1')).toBeUndefined()
    expect(queues.items('c1').map((item) => item.text)).toEqual(['a', 'b'])
    expect(queues.take('c1')).toEqual({ text: 'a\nb' })
    expect(queues.held('c1')).toBe(false)
  })

  it('쌓인 것이 없으면 멈춰도 붙잡지 않는다 — 다음 턴 끝은 평소대로', () => {
    const queues = new SendQueues()
    queues.hold('c1')
    expect(queues.held('c1')).toBe(false)
    queues.submit('c1', { text: 'next' }, true)
    expect(queues.next('c1')).toEqual({ text: 'next' })
  })

  it('다른 대화는 붙잡지 않는다', () => {
    const queues = new SendQueues()
    queues.submit('c2', { text: 'x' }, true)
    queues.submit('c1', { text: 'y' }, true)
    queues.hold('c1')
    expect(queues.next('c2')).toEqual({ text: 'x' })
  })
})

// 출처 (이슈 #52) — 다른 대화가 보낸 지시(라운드 ③)와 사람이 친 글을 한 메시지로 이으면 출처가 사라진다
describe('SendQueues — 출처가 같은 것끼리만 합친다', () => {
  it('출처를 안 주면 user 다 — 전부 user 면 지금처럼 한 번에 합쳐 나간다', () => {
    const queues = new SendQueues()
    queues.submit('c1', { text: 'a' }, true)
    queues.submit('c1', { text: 'b', origin: 'user' }, true)
    expect(queues.next('c1')).toEqual({ text: 'a\nb', origin: 'user' })
  })

  it('출처가 바뀌는 자리에서 끊어 쌓인 순서대로 한 턴씩 준다', () => {
    const queues = new SendQueues()
    queues.submit('c1', { text: 'u1' }, true)
    queues.submit('c1', { text: 'u2' }, true)
    queues.submit('c1', { text: 's1', origin: 'session:c9' }, true)
    queues.submit('c1', { text: 'u3' }, true)
    expect(queues.next('c1')).toEqual({ text: 'u1\nu2' })
    expect(queues.next('c1')).toEqual({ text: 's1', origin: 'session:c9' })
    expect(queues.next('c1')).toEqual({ text: 'u3' })
    expect(queues.next('c1')).toBeUndefined()
  })

  it('되돌리기는 그 출처가 쌓은 것만 가져간다 — 남의 지시는 대기열에 남는다', () => {
    const queues = new SendQueues()
    queues.submit('c1', { text: 'u1' }, true)
    queues.submit('c1', { text: 's1', origin: 'session:c9' }, true)
    queues.submit('c1', { text: 'u2' }, true)
    expect(queues.take('c1')).toEqual({ text: 'u1\nu2' })
    expect(queues.items('c1')).toEqual([{ text: 's1', origin: 'session:c9' }])
  })
})

// 다른 대화가 보낸 지시 (이슈 #55) — 출처가 다르면 합치지 않고, 줄 하나를 뺄 수 있고(빼기), 붙잡기는 사람 글이 있을 때만
describe('SendQueues — 다른 대화가 보낸 지시 (이슈 #55)', () => {
  const fromA = { text: '<wrapped a>', display: '지시 a', origin: 'session:a' as const, from: { conversationId: 'a', title: 'A' } }
  const fromB = { text: '<wrapped b>', display: '지시 b', origin: 'session:b' as const, from: { conversationId: 'b', title: 'B' } }

  it('출처가 다른 것끼리는 합치지 않는다 — 쌓인 순서대로 한 턴씩, 같은 대화가 잇달아 보낸 것만 합친다', () => {
    const queues = new SendQueues()
    for (const item of [{ text: '사람 1' }, { text: '사람 2' }, fromA, fromA, fromB, { text: '사람 3' }]) queues.submit('c1', item, true)
    expect(queues.next('c1')).toEqual({ text: '사람 1\n사람 2' })
    expect(queues.next('c1')).toMatchObject({ text: '<wrapped a>\n<wrapped a>', display: '지시 a\n지시 a', origin: 'session:a', from: { conversationId: 'a' } })
    expect(queues.next('c1')).toMatchObject({ display: '지시 b', origin: 'session:b' })
    expect(queues.next('c1')).toEqual({ text: '사람 3' })
    expect(queues.next('c1')).toBeUndefined()
  })

  it('빼기(drop) — 다른 대화의 줄 하나만 뺀다. 사람이 친 줄·없는 자리는 못 뺀다', () => {
    const queues = new SendQueues()
    for (const item of [{ text: '사람' }, fromA, fromB]) queues.submit('c1', item, true)
    expect(queues.drop('c1', 0)).toBe(false)
    expect(queues.drop('c1', 9)).toBe(false)
    expect(queues.drop('c1', 1)).toBe(true)
    expect(queues.items('c1').map((item) => item.display ?? item.text)).toEqual(['사람', '지시 b'])
  })

  it('되돌리기(take)는 사람 글만 가져간다 — 다른 대화의 지시는 남는다', () => {
    const queues = new SendQueues()
    for (const item of [{ text: '사람 1' }, fromA, { text: '사람 2' }]) queues.submit('c1', item, true)
    expect(queues.take('c1')).toEqual({ text: '사람 1\n사람 2' })
    expect(queues.items('c1')).toEqual([fromA])
  })

  it('붙잡기(hold)는 사람 글이 쌓여 있을 때만 — 다른 대화의 지시만 있으면 멈춘 턴 뒤에 그대로 간다', () => {
    const queues = new SendQueues()
    queues.submit('c1', fromA, true)
    queues.hold('c1')
    expect(queues.held('c1')).toBe(false)
    expect(queues.next('c1')).toMatchObject({ origin: 'session:a' })
    queues.submit('c2', { text: '사람' }, true)
    queues.submit('c2', fromA, true)
    queues.hold('c2')
    expect(queues.held('c2')).toBe(true)
    expect(queues.next('c2')).toBeUndefined()
  })

  it('대화가 지워지면(clear) 쌓인 것도 붙잡기도 사라지고 구독자에게 알린다', () => {
    const queues = new SendQueues()
    const calls: string[] = []
    queues.submit('c1', { text: '사람' }, true)
    queues.submit('c1', fromA, true)
    queues.hold('c1')
    queues.subscribe((id) => calls.push(id))
    queues.clear('c1')
    queues.clear('nope')
    expect(queues.items('c1')).toEqual([])
    expect(queues.held('c1')).toBe(false)
    expect(calls).toEqual(['c1'])
  })
})
