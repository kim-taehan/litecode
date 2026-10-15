import { describe, expect, it } from 'vitest'
import type { TurnItem } from '../../shared/ipc.ts'
import { feedTurnEnded, feedTurnItem, feedTurnSnapshot, feedTurnStarted, turnDetail } from '../../renderer/turnDetailStore.ts'

const item = (id: string, patch: Partial<Pick<TurnItem & { kind: 'think' }, 'text' | 'done'>> = {}): TurnItem => ({ kind: 'think', id, text: id, done: true, ...patch })

// (대화, 보낸 시각) 마다 턴 기록을 이어 붙인다 — 채팅의 진행 줄과 같은 데이터 (이슈 #416)
describe('feedTurnStarted·feedTurnItem', () => {
  it('시작은 빈 기록, 진행 줄은 같은 id 로 바꿔 끼우고 순서대로', () => {
    const cid = 'c1'
    feedTurnStarted(cid, 1000)
    const atStart = turnDetail(cid, 1000)
    expect(atStart?.items).toEqual([])
    expect(atStart?.startedAt).toBe(1000)
    expect(atStart?.endedAt).toBeUndefined()

    feedTurnItem(cid, item('t1'))
    feedTurnItem(cid, item('t2', { text: 't2 첫 조각' }))
    feedTurnItem(cid, item('t2', { text: 't2 완성', done: true }))
    const atTwo = turnDetail(cid, 1000)
    expect(atTwo?.items.map((line) => line.id)).toEqual(['t1', 't2'])
    expect(atTwo?.items[1]?.kind === 'think' ? atTwo.items[1].text : '').toBe('t2 완성')
  })

  it('끝난 턴 뒤(또는 시작 전)의 진행 줄은 버린다', () => {
    const cid = 'c-late'
    feedTurnItem(cid, item('t0')) // 시작 이벤트 전
    expect(turnDetail(cid, 500)).toBeUndefined()
    feedTurnStarted(cid, 500)
    feedTurnEnded(cid, { items: [] })
    feedTurnItem(cid, item('t1')) // 끝난 뒤 늦게 온 것
    expect(turnDetail(cid, 500)?.items).toEqual([])
  })

  it('대화는 따로 — 같은 진행 줄이 다른 대화에 닿지 않는다', () => {
    feedTurnStarted('cA', 2000)
    feedTurnStarted('cB', 2000)
    feedTurnItem('cA', item('a'))
    expect(turnDetail('cA', 2000)?.items.map((line) => line.id)).toEqual(['a'])
    expect(turnDetail('cB', 2000)?.items).toEqual([])
  })
})

describe('feedTurnEnded', () => {
  it('끝난 답의 items 로 바꾸고 소요·실패 표식을 남긴다', () => {
    const cid = 'c-end'
    feedTurnStarted(cid, 3000)
    feedTurnItem(cid, item('t1'))
    feedTurnEnded(cid, { items: [item('t1'), item('t2')], duration: 12_000 })
    const detail = turnDetail(cid, 3000)
    expect(detail?.items.map((line) => line.id)).toEqual(['t1', 't2'])
    expect(detail?.endedAt).toBeTypeOf('number')
    expect(detail?.duration).toBe(12_000)
    expect(detail?.failed).toBeUndefined()
  })

  it('답에 items 가 없으면 지금 것을 남기고, 실패·중단 표식을 옮긴다', () => {
    const cid = 'c-fail'
    feedTurnStarted(cid, 4000)
    feedTurnItem(cid, item('t1'))
    feedTurnEnded(cid, { error: 'boom', interrupted: true })
    const detail = turnDetail(cid, 4000)
    expect(detail?.items.map((line) => line.id)).toEqual(['t1'])
    expect(detail?.failed).toBe(true)
    expect(detail?.interrupted).toBe(true)
  })

  it('같은 대화가 다시 도면(새 보낸 시각) 새 기록부터 — 옛 기록은 그대로', () => {
    const cid = 'c-again'
    feedTurnStarted(cid, 5000)
    feedTurnItem(cid, item('old'))
    feedTurnEnded(cid, { items: [item('old')] })
    feedTurnStarted(cid, 6000)
    feedTurnItem(cid, item('new'))
    expect(turnDetail(cid, 5000)?.items.map((line) => line.id)).toEqual(['old'])
    expect(turnDetail(cid, 6000)?.items.map((line) => line.id)).toEqual(['new'])
    expect(turnDetail(cid, 6000)?.endedAt).toBeUndefined()
  })
})

describe('feedTurnSnapshot — 화면이 (재)뜰 때 메인이 쥔 도는 턴', () => {
  it('진행 줄을 통째로 넣어 주고 그 뒤 진행 줄은 이어 붙는다', () => {
    const cid = 'c-snap'
    feedTurnSnapshot(cid, 7000, [item('s1'), item('s2')])
    expect(turnDetail(cid, 7000)?.items.map((line) => line.id)).toEqual(['s1', 's2'])
    feedTurnItem(cid, item('s3'))
    expect(turnDetail(cid, 7000)?.items.map((line) => line.id)).toEqual(['s1', 's2', 's3'])
  })
})

describe('상한 — 오래된 기록은 걷는다', () => {
  it('50개를 넘으면 가장 오래된 턴부터 지운다', () => {
    const cid = 'c-cap'
    for (let n = 0; n < 52; n++) {
      feedTurnStarted(cid, 8000 + n)
      feedTurnItem(cid, item(`n${n}`))
      feedTurnEnded(cid, { items: [] })
    }
    expect(turnDetail(cid, 8000)).toBeUndefined()
    expect(turnDetail(cid, 8001)).toBeUndefined()
    expect(turnDetail(cid, 8002)?.items.map((line) => line.id)).toEqual(['n2'])
    expect(turnDetail(cid, 8051)?.items.map((line) => line.id)).toEqual(['n51'])
  })
})
