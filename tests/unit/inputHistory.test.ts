import { describe, expect, it } from 'vitest'
import { browseHistory, sentTexts } from '../../renderer/inputHistory.ts'

// 입력 기록 ↑/↓ (closed-code useInputHistory 의 동작) — 빈 입력창에서 ↑ 로 그 대화에 보낸 이전 글, ↓ 로 되돌아온다.
// 쓰던 글이 있거나 불러온 글을 고쳤으면 끼어들지 않는다 (화살표는 커서 이동)

const entries = ['첫째', '둘째', '셋째']
const at = (text: string, caret = text.length) => ({ text, start: caret, end: caret })

describe('browseHistory', () => {
  it('빈 입력에서 ↑ 는 가장 최근 글, 다시 ↑ 는 그 앞 글', () => {
    const first = browseHistory(entries, undefined, 'up', at(''))
    expect(first).toEqual({ text: '셋째', index: 2 })
    expect(browseHistory(entries, first!.index, 'up', at('셋째'))).toEqual({ text: '둘째', index: 1 })
  })

  it('맨 처음 글에서 ↑ 는 아무것도 안 한다', () => {
    expect(browseHistory(entries, 0, 'up', at('첫째'))).toBeUndefined()
  })

  it('↓ 는 더 최근 글로, 가장 최근 글에서는 빈 입력으로 돌아온다', () => {
    expect(browseHistory(entries, 1, 'down', at('둘째'))).toEqual({ text: '셋째', index: 2 })
    expect(browseHistory(entries, 2, 'down', at('셋째'))).toEqual({ text: '', index: undefined })
  })

  it('쓰던 글이 있으면 끼어들지 않는다', () => {
    expect(browseHistory(entries, undefined, 'up', at('쓰는 중'))).toBeUndefined()
    expect(browseHistory(entries, undefined, 'down', at(''))).toBeUndefined()
  })

  it('불러온 글을 고쳤으면 기록 이동이 아니다', () => {
    expect(browseHistory(entries, 2, 'up', at('셋째 고침'))).toBeUndefined()
    expect(browseHistory(entries, 2, 'down', at('셋째 고침'))).toBeUndefined()
  })

  it('글을 골라 둔 상태(선택 영역)에서는 끼어들지 않는다', () => {
    expect(browseHistory(entries, 2, 'up', { text: '셋째', start: 0, end: 2 })).toBeUndefined()
  })

  it('여러 줄 글 안에서는 커서 이동이 먼저다 — 첫 줄에서만 ↑, 마지막 줄에서만 ↓', () => {
    const lines = ['앞 글', '한 줄\n두 줄', '뒷 글']
    expect(browseHistory(lines, 1, 'up', at('한 줄\n두 줄'))).toBeUndefined() // 커서가 둘째 줄
    expect(browseHistory(lines, 1, 'up', at('한 줄\n두 줄', 2))).toEqual({ text: '앞 글', index: 0 })
    expect(browseHistory(lines, 1, 'down', at('한 줄\n두 줄', 2))).toBeUndefined() // 커서가 첫 줄
    expect(browseHistory(lines, 1, 'down', at('한 줄\n두 줄'))).toEqual({ text: '뒷 글', index: 2 })
  })

  it('보낸 글이 없으면 아무것도 안 한다', () => {
    expect(browseHistory([], undefined, 'up', at(''))).toBeUndefined()
  })
})

describe('sentTexts', () => {
  it('그 대화에서 내가 친 글만 — 답·다른 대화가 보낸 지시·빈 글(첨부만)·바로 앞과 같은 글은 뺀다', () => {
    expect(
      sentTexts([
        { role: 'user', text: '하나' },
        { role: 'assistant', text: '답' },
        { role: 'user', text: '하나' },
        { role: 'user', text: '지시', origin: { conversationId: 'c', title: 't' } },
        { role: 'user', text: '  ' },
        { role: 'user', text: '둘' },
        { role: 'user', text: '하나' },
      ]),
    ).toEqual(['하나', '둘', '하나'])
  })
})
