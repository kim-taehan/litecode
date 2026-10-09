import { describe, expect, it } from 'vitest'
import { BLUETOOTH_RX_UUID, BLUETOOTH_TX_UUID, bluetoothServiceUuid } from '../../shared/bluetooth.ts'

// 데스크탑(광고)과 폰(찾기)이 같은 UUID 를 만드는지 — 값이 어긋나면 서로를 못 찾는다 (이슈 #171)
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

describe('블루투스 약속 — shared/bluetooth.ts', () => {
  it('서비스 UUID 는 desktopId 에서 정해지고 UUID 꼴이다', () => {
    const uuid = bluetoothServiceUuid('desk-1')
    expect(uuid).toMatch(UUID)
    expect(bluetoothServiceUuid('desk-1')).toBe(uuid)
  })

  it('다른 desktopId 는 다른 UUID — 사무실의 다른 데스크탑을 잘못 찾지 않는다', () => {
    expect(bluetoothServiceUuid('desk-1')).not.toBe(bluetoothServiceUuid('desk-2'))
  })

  it('값을 고정한다 — 바뀌면 이미 짝지은 폰이 데스크탑을 못 찾는다', () => {
    expect(bluetoothServiceUuid('desk-1')).toBe('e925ed73-86a9-c11c-f6ed-0cb0109914bc')
  })

  it('특성 UUID 는 서비스와 달라야 하고 서로 달라야 한다', () => {
    expect(BLUETOOTH_RX_UUID).toMatch(UUID)
    expect(BLUETOOTH_TX_UUID).toMatch(UUID)
    expect(BLUETOOTH_RX_UUID).not.toBe(BLUETOOTH_TX_UUID)
    expect([BLUETOOTH_RX_UUID, BLUETOOTH_TX_UUID]).not.toContain(bluetoothServiceUuid('desk-1'))
  })
})
