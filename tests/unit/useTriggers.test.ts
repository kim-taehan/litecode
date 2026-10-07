import { describe, expect, it } from 'vitest'
import { queryFresh, replaceSpan, triggerOpen, type AskedQuery } from '../../renderer/useTriggers.ts'
import { slashName } from '../../renderer/TriggerPopup.tsx'
import type { TriggerQuery } from '../../shared/ipc.ts'

// 감사 E10 — 후보 메뉴는 입력창에 포커스가 있을 때만 열린다 (초안이 `/he` 로 끝난 대화로 돌아오기만 해서는 뜨지 않는다)

const query = (candidates: number, start = 0, text = 'he'): TriggerQuery =>
  ({
    span: { char: '/', start, end: start + text.length + 1, query: text },
    candidates: Array.from({ length: candidates }, (_, index) => ({ id: String(index), label: String(index) })),
  }) as unknown as TriggerQuery

describe('triggerOpen', () => {
  it('후보가 있고 입력창에 포커스가 있으면 열린다', () => {
    expect(triggerOpen(query(2), undefined, true)).toBe(true)
  })

  it('입력창에 포커스가 없으면 열리지 않는다', () => {
    expect(triggerOpen(query(2), undefined, false)).toBe(false)
  })

  it('후보가 없거나 질의가 없으면 열리지 않는다', () => {
    expect(triggerOpen(query(0), undefined, true)).toBe(false)
    expect(triggerOpen(null, undefined, true)).toBe(false)
  })

  it('같은 자리·같은 질의로 닫은 메뉴는 다시 열지 않고, 질의나 자리가 달라지면 다시 연다', () => {
    expect(triggerOpen(query(2), '0:he', true)).toBe(false)
    expect(triggerOpen(query(2, 0, 'hel'), '0:he', true)).toBe(true)
    expect(triggerOpen(query(2, 3), '0:he', true)).toBe(true)
  })
})

// 이슈 #196 (B6) — 후보는 물은 입력의 구간으로 온다. 새 후보가 오기 전에 바뀐 입력을 옛 구간으로 자르면
// 바꿔 친 글자가 남거나(`@ab` → `c` → Enter → `@src/ab.ts c`), 고르는 IPC 사이에 친 글자가 지워진다
describe('낡은 후보 (B6)', () => {
  const asked = (draft: string, caret = draft.length, start = draft.lastIndexOf('@')) =>
    ({
      span: { char: '@', start, end: caret, query: draft.slice(start + 1, caret) },
      candidates: [{ id: 'src/ab.ts', label: 'ab.ts', icon: 'file' }],
      asked: { draft, caret },
    }) as AskedQuery

  it('물은 입력 그대로면 구간을 바꾸고 캐럿을 넣은 글 뒤에 둔다', () => {
    expect(replaceSpan(asked('보자 @ab'), '보자 @ab', '@src/ab.ts ')).toEqual({ draft: '보자 @src/ab.ts ', caret: 14 })
    expect(replaceSpan(asked('@ab 뒤', 3, 0), '@ab 뒤', '@src/ab.ts ')).toEqual({ draft: '@src/ab.ts  뒤', caret: 11 })
  })

  it('물은 뒤 글자를 더 쳤으면 옛 구간으로 바꾸지 않는다 (끝 글자가 남지 않게)', () => {
    expect(replaceSpan(asked('@ab'), '@abc', '@src/ab.ts ')).toBeNull()
  })

  it('물은 뒤 글자를 지웠거나 구간 앞을 고쳤으면 바꾸지 않는다 (친 글이 사라지지 않게)', () => {
    expect(replaceSpan(asked('@ab'), '@a', '@src/ab.ts ')).toBeNull()
    expect(replaceSpan(asked('x @ab'), 'xy @ab', '@src/ab.ts ')).toBeNull()
  })

  it('후보는 물은 입력·캐럿과 지금이 같을 때만 고를 수 있다 (한글 조합으로 바뀐 입력도 낡음)', () => {
    expect(queryFresh(asked('@ab'), '@ab', 3)).toBe(true)
    expect(queryFresh(asked('@ab'), '@abc', 4)).toBe(false)
    expect(queryFresh(asked('@ab'), '@ab한', 4)).toBe(false)
    expect(queryFresh(asked('@ab'), '@ab', 2)).toBe(false)
  })
})

// `/` 메뉴 줄 (이슈 #144 시안 B): 아이콘이 종류를 말하므로 보이는 이름에서 `/` 를 뺀다 — 넣는 글·읽히는 이름은 `/이름` 그대로
describe('slashName', () => {
  it('앱·명령·스킬 줄은 앞의 / 를 빼고, 파일·폴더 줄은 그대로다', () => {
    expect(slashName({ icon: 'app', label: '/compact' })).toBe('compact')
    expect(slashName({ icon: 'command', label: '/init' })).toBe('init')
    expect(slashName({ icon: 'skill', label: '/review-pr' })).toBe('review-pr')
    expect(slashName({ icon: 'file', label: 'README.md' })).toBe('README.md')
    expect(slashName({ icon: 'folder', label: '/odd/' })).toBe('/odd/')
  })
})
