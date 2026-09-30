import { describe, expect, it } from 'vitest'
import { BADGE_COLORS, badgeColor, badgeLetters } from '../../renderer/badge.ts'

// 프로젝트 배지 — 앞 두 글자만 쓰면 davis-code·davis-frontend 가 둘 다 "DA" 로 겹쳤다 (00_request 추가 요구 A1)

describe('badgeLetters', () => {
  it('여러 낱말 이름은 앞 두 낱말의 첫 글자다 (구분자·camelCase)', () => {
    expect(badgeLetters('davis-code')).toBe('DC')
    expect(badgeLetters('davis-frontend')).toBe('DF')
    expect(badgeLetters('closed_code')).toBe('CC')
    expect(badgeLetters('gateWay')).toBe('GW')
    expect(badgeLetters('deepseek harness')).toBe('DH')
  })

  it('한 낱말 이름은 앞 두 글자다', () => {
    expect(badgeLetters('litecode')).toBe('LI')
    expect(badgeLetters('x')).toBe('X')
    expect(badgeLetters('프로젝트')).toBe('프로')
  })
})

describe('badgeColor', () => {
  it('경로로 결정되고 팔레트 안의 색이다', () => {
    const color = badgeColor('/Users/me/davis-code')
    expect(badgeColor('/Users/me/davis-code')).toBe(color)
    expect(BADGE_COLORS).toContain(color)
  })

  it('경로가 다르면 여러 색으로 퍼진다', () => {
    const colors = new Set(Array.from({ length: 40 }, (_, i) => badgeColor(`/Users/me/project-${i}`)))
    expect(colors.size).toBe(BADGE_COLORS.length)
  })
})
