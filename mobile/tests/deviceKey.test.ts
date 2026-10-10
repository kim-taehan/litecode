import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { DEVICE_KEY_PATTERN } from '../../shared/remote.ts'
import { deviceKeyOf } from '../src/app/deviceKey.ts'

// 짝짓기의 기기 키 (이슈 #275) — Android ID 를 그대로 보내지 않고 sha256("litecode-device/1:" + 값) 앞 32자(hex)

describe('기기 키', () => {
  it('같은 입력이면 같은 값, 다른 입력이면 다른 값 — 데스크탑이 받는 모양(hex 32자)이고 Node sha256 과 같다', () => {
    const key = deviceKeyOf('9774d56d682e549c')!
    expect(key).toMatch(DEVICE_KEY_PATTERN)
    expect(deviceKeyOf('9774d56d682e549c')).toBe(key)
    expect(key).toBe(createHash('sha256').update('litecode-device/1:9774d56d682e549c').digest('hex').slice(0, 32))
    expect(deviceKeyOf('9774d56d682e549d')).not.toBe(key)
    expect(key).not.toContain('9774d56d682e549c')
  })

  it('값이 없으면(네이티브 없음·옛 빌드) 키도 없다', () => {
    expect(deviceKeyOf(undefined)).toBeUndefined()
    expect(deviceKeyOf('')).toBeUndefined()
  })
})
