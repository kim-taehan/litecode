import { describe, expect, it } from 'vitest'
import { SseParser } from '../src/core/sse.ts'

describe('SseParser', () => {
  it('id·event·data 를 메시지 하나로 묶는다', () => {
    expect(new SseParser().feed('id: 7\nevent: turn.progress\ndata: {"a":1}\n\n')).toEqual([{ id: '7', event: 'turn.progress', data: '{"a":1}' }])
  })

  it('조각이 줄 중간에서 잘려 와도 이어 붙인다', () => {
    const parser = new SseParser()
    expect(parser.feed('id: 1\neve')).toEqual([])
    expect(parser.feed('nt: ready\ndata: {"x"')).toEqual([])
    expect(parser.feed(':2}\n')).toEqual([])
    expect(parser.feed('\nevent: reset\ndata: {}\n\n')).toEqual([
      { id: '1', event: 'ready', data: '{"x":2}' },
      { id: undefined, event: 'reset', data: '{}' },
    ])
  })

  it('주석 줄(ping)은 메시지가 아니다', () => {
    expect(new SseParser().feed(': ping\n\n: ping\n\n')).toEqual([])
  })

  it('id 는 다음 메시지로 넘어가지 않는다 — id 없는 이벤트(ready·reset)를 seq 있는 것으로 읽지 않는다', () => {
    const [first, second] = new SseParser().feed('id: 3\nevent: a\ndata: 1\n\nevent: b\ndata: 2\n\n')
    expect(first?.id).toBe('3')
    expect(second?.id).toBeUndefined()
  })

  it('여러 data 줄은 줄바꿈으로 잇고, CRLF 도 읽는다', () => {
    expect(new SseParser().feed('event: a\r\ndata: 1\r\ndata: 2\r\n\r\n')).toEqual([{ id: undefined, event: 'a', data: '1\n2' }])
  })
})
