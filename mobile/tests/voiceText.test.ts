import { describe, expect, it } from 'vitest'
import { joinHeard, voiceProblem, VOICE_LANGUAGE } from '../src/app/voiceText.ts'
import { S } from '../src/app/strings.ts'

describe('voiceText — 음성 입력의 순수 규칙 (#271)', () => {
  it('joinHeard: 빈 입력창이면 들은 글 그대로', () => {
    expect(joinHeard('', '안녕하세요')).toBe('안녕하세요')
  })

  it('joinHeard: 이미 쓴 글 뒤에 띄어 이어 붙인다 — 끝이 공백·줄바꿈이면 그대로 붙인다', () => {
    expect(joinHeard('파일을', '열어 줘')).toBe('파일을 열어 줘')
    expect(joinHeard('파일을 ', '열어 줘')).toBe('파일을 열어 줘')
    expect(joinHeard('첫 줄\n', '둘째 줄')).toBe('첫 줄\n둘째 줄')
  })

  it('joinHeard: 아직 들은 것이 없으면(빈 부분 결과) 쓴 글을 건드리지 않는다', () => {
    expect(joinHeard('파일을', '')).toBe('파일을')
    expect(joinHeard('파일을', '  ')).toBe('파일을')
  })

  it('joinHeard: 부분 결과가 바뀌어도 시작 때의 글을 기준으로 다시 합친다 (덧붙여 쌓이지 않는다)', () => {
    const base = '메모:'
    const steps = ['오늘', '오늘 회의', '오늘 회의는 세 시'].map((heard) => joinHeard(base, heard))
    expect(steps).toEqual(['메모: 오늘', '메모: 오늘 회의', '메모: 오늘 회의는 세 시'])
  })

  it('voiceProblem: Android 오류 코드 → 문구 열쇠', () => {
    expect(voiceProblem(9)).toBe('permission') // ERROR_INSUFFICIENT_PERMISSIONS
    expect([voiceProblem(6), voiceProblem(7)]).toEqual(['no-speech', 'no-speech']) // SPEECH_TIMEOUT · NO_MATCH
    expect([1, 2, 4, 11].map(voiceProblem)).toEqual(['network', 'network', 'network', 'network'])
    expect([voiceProblem(12), voiceProblem(13)]).toEqual(['language', 'language'])
    expect(voiceProblem(8)).toBe('busy')
    expect([voiceProblem(3), voiceProblem(10), voiceProblem(99)]).toEqual(['failed', 'failed', 'failed'])
  })

  it('voiceProblem: ERROR_CLIENT(5) 는 조용히 — 우리가 멈추거나 버릴 때 오는 코드다', () => {
    expect(voiceProblem(5)).toBeUndefined()
  })

  it('모든 문구 열쇠에 글이 있다, 기본 언어는 한국어', () => {
    for (const code of [1, 2, 3, 4, 6, 7, 8, 9, 10, 11, 12, 13, 99]) {
      const key = voiceProblem(code)
      expect(key && S.voiceProblem[key]).toBeTruthy()
    }
    expect(S.voiceProblem.permission).toBe('마이크 권한이 없어 음성 입력을 쓸 수 없습니다. 설정에서 허용해 주세요.')
    expect(VOICE_LANGUAGE).toBe('ko-KR')
  })
})
