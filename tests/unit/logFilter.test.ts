import { describe, expect, it } from 'vitest'
import { buildLogQuery, defaultLogFilter, isHashLike, isLogFilterActive, localStamp, logDateRange } from '../../renderer/logFilter.ts'

// 기록 필터 (#400 #409) — 순수: 쿼리 변환·해시 판정·날짜 범위

describe('logFilter — 순수 규칙', () => {
  it('isHashLike — 16진 4~40자(앞뒤 공백 포함), 3자 이하는 아님', () => {
    expect(isHashLike('abc123')).toBe(true)
    expect(isHashLike('ABC123')).toBe(true)
    expect(isHashLike(' abc123 ')).toBe(true)
    expect(isHashLike('abc')).toBe(false)
    expect(isHashLike('abc!')).toBe(false)
    expect(isHashLike('a'.repeat(41))).toBe(false)
    expect(isHashLike('')).toBe(false)
  })

  it('isLogFilterActive — 기본(빈 것)은 꺼져 있고, 하나만 있어도 켜짐', () => {
    expect(isLogFilterActive(defaultLogFilter())).toBe(false)
    expect(isLogFilterActive({ ...defaultLogFilter(), text: 'abc' })).toBe(true)
    expect(isLogFilterActive({ ...defaultLogFilter(), text: '   ' })).toBe(false)
    expect(isLogFilterActive({ ...defaultLogFilter(), branch: 'all' })).toBe(true)
    expect(isLogFilterActive({ ...defaultLogFilter(), branch: 'dev' })).toBe(true)
    expect(isLogFilterActive({ ...defaultLogFilter(), author: 'kim' })).toBe(true)
    expect(isLogFilterActive({ ...defaultLogFilter(), date: 'today' })).toBe(true)
    expect(isLogFilterActive({ ...defaultLogFilter(), paths: ['a.ts'] })).toBe(true)
  })

  it('buildLogQuery — skip·검색(고정 기본)·정규식·Cc·브랜치·작성자·날짜·경로', () => {
    expect(buildLogQuery(defaultLogFilter(), 200)).toEqual({ skip: 200 })
    expect(buildLogQuery({ ...defaultLogFilter(), text: 'hello' }, 0)).toEqual({ skip: 0, text: 'hello', regex: false, caseSensitive: true })
    expect(buildLogQuery({ ...defaultLogFilter(), text: 'hello', regex: true }, 0)).toEqual({ skip: 0, text: 'hello', regex: true, caseSensitive: true })
    expect(buildLogQuery({ ...defaultLogFilter(), text: 'abc123' }, 0)).toEqual({ skip: 0, text: 'abc123' }) // 해시 — 플래그 없음(해석 실패하면 서비스 쪽이 고정으로)
    expect(buildLogQuery({ ...defaultLogFilter(), text: 'abc123', regex: true }, 0)).toEqual({ skip: 0, text: 'abc123', regex: true, caseSensitive: true })
    expect(buildLogQuery({ ...defaultLogFilter(), text: 'a', caseSensitive: false }, 10)).toEqual({ skip: 10, text: 'a', regex: false, caseSensitive: false })
    const full = buildLogQuery({ ...defaultLogFilter(), text: 'x', branch: 'all', author: ' Kim ', date: 'week', paths: ['a.ts', ' b.ts '] }, 0)
    expect(full).toMatchObject({ text: 'x', branch: 'all', author: 'Kim', paths: ['a.ts', 'b.ts'] })
    expect(full.since).toBeDefined()
    expect(full.until).toBeUndefined()
  })

  it('logDateRange — 오늘/이번 주/지난 30일 은 로컬 자정 기준, 전체면 없음', () => {
    const now = new Date(2026, 9, 14, 13, 30).getTime() // 2026. 10. 14 (수)
    expect(logDateRange('all', now)).toEqual({})
    expect(logDateRange('today', now)).toEqual({ since: '2026-10-14 00:00:00', until: '2026-10-15 00:00:00' })
    expect(logDateRange('week', now)).toEqual({ since: '2026-10-08 00:00:00' })
    expect(logDateRange('month', now)).toEqual({ since: '2026-09-15 00:00:00' })
  })

  it('localStamp — 10진 자리 보전', () => {
    expect(localStamp(new Date(2026, 0, 5, 7, 4, 9))).toBe('2026-01-05 07:04:09')
  })
})
