import { describe, expect, it } from 'vitest'
import type { TurnItem } from '../../shared/ipc.ts'
import { answerText, clockTime, formatDuration, looksLikePath, splitTurn, thinkSummary, toolTitle, turnHeadText, upsertItem } from '../../renderer/turnView.ts'

// 답 한 턴의 화면 모양 — 진행 줄 쌓기, 작업/답 가르기, 줄 글자

const think = (id: string, text = 't', done = true): TurnItem => ({ kind: 'think', id, text, done })
const text = (id: string, value = 'x', done = true): TurnItem => ({ kind: 'text', id, text: value, done })
const tool = (id: string): TurnItem => ({ kind: 'tool', id, name: 'bash', status: 'done' })

describe('upsertItem', () => {
  it('처음 보는 id 는 끝에, 아는 id 는 그 자리에서 바꾼다', () => {
    const a = upsertItem(undefined, text('a', '1', false))
    const b = upsertItem(a, tool('b'))
    const c = upsertItem(b, text('a', '12'))
    expect(c.map((item) => item.id)).toEqual(['a', 'b'])
    expect(c[0]).toEqual(text('a', '12'))
  })
})

describe('splitTurn·answerText', () => {
  it('답은 마지막 도구·생각 뒤의 글 — 도구 앞에 쓴 글과 생각은 작업이다', () => {
    const items = [think('t1'), text('a'), tool('b'), think('t2'), text('c', 'final')]
    const { work, answer } = splitTurn(items)
    expect(work.map((item) => item.id)).toEqual(['t1', 'a', 'b', 't2'])
    expect(answer.map((item) => item.id)).toEqual(['c'])
    expect(answerText(answer, 'all')).toBe('final')
  })

  it('글만 있으면 작업이 없다. 줄이 없거나 덜 끝났으면 엔진이 준 답 전체', () => {
    expect(splitTurn([text('a')]).work).toEqual([])
    expect(answerText([], 'fallback')).toBe('fallback')
    expect(answerText([text('a', 'part', false)], 'fallback')).toBe('fallback')
  })
})

describe('thinkSummary', () => {
  it('끝났으면 첫 문단 첫 줄, ** 를 뗀다', () => {
    expect(thinkSummary('**Planning** the answer\nmore\n\nSecond paragraph', true)).toBe('Planning the answer')
  })

  it('쓰는 중이면 마지막으로 다 쓴 문단의 첫 줄, 다 쓴 문단이 없으면 지금 문단', () => {
    expect(thinkSummary('First\n\nSecond line\n\nThird is stre', false)).toBe('Second line')
    expect(thinkSummary('Only one so f', false)).toBe('Only one so f')
    expect(thinkSummary('', false)).toBe('')
  })
})

describe('글자', () => {
  it('걸린 시간은 최소 1초, 분·시간 단위', () => {
    expect(formatDuration(0)).toBe('1초')
    expect(formatDuration(2_400)).toBe('2초')
    expect(formatDuration(75_000)).toBe('1분 15초')
    expect(formatDuration(3_660_000)).toBe('1시간 1분')
  })

  it('턴 머리: 완료/실패 + 시간 (모르면 시간 없이)', () => {
    expect(turnHeadText(2_000, false)).toBe('완료 · 2초')
    expect(turnHeadText(undefined, false)).toBe('완료')
    expect(turnHeadText(1_000, true)).toBe('실패 · 1초')
    expect(turnHeadText(3_000, true, true)).toBe('중단됨 · 3초') // 끊긴 턴은 실패와 가른다
    expect(turnHeadText(undefined, true, true)).toBe('중단됨')
  })

  it('도구 이름·시각', () => {
    expect(toolTitle('bash')).toBe('Bash')
    expect(clockTime(new Date(2026, 9, 1, 7, 5).getTime())).toBe('07:05')
  })

  it('경로처럼 보이는 인라인 코드만 후보 — 공백·평범한 낱말은 아니다', () => {
    expect(looksLikePath('src/a.ts')).toBe(true)
    expect(looksLikePath('package.json')).toBe(true)
    expect(looksLikePath('npm run dev')).toBe(false)
    expect(looksLikePath('useState')).toBe(false)
  })
})
