import { describe, expect, it } from 'vitest'
import { triggerOpen } from '../../renderer/useTriggers.ts'
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
