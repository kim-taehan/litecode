// 블루투스 운반의 약속 (이슈 #171, 설계 _workspace/01ab_mobile_bluetooth.md 5절). 데스크탑(광고하는 쪽, bleno)과 폰(찾아 붙는 쪽, ble-manager)이
// 이 파일 하나를 같이 읽는다 — 서비스·특성 UUID 와 한도가 양쪽에서 어긋나면 서로를 못 찾는다. 라디오도 플랫폼 API 도 쓰지 않는 순수 값이다.
//
// 링크 모양: GATT 서비스 하나(UUID 는 desktopId 에서 나온다 — 사무실에 데스크탑이 여럿이어도 QR 의 `d` 로 자기 것만 찾는다. 광고에는 이 UUID 만
// 싣고 PC 이름은 싣지 않는다), 특성 둘: `rx`(폰 → PC, write without response)·`tx`(PC → 폰, notify). 그 위는 ByteLink → Noise NK(noiseRecord.ts) →
// FrameChannel(remoteFraming.ts) → ctx.remote.handle — 글자 그대로 HTTPS 와 같은 `/v1`.

import { sha256 } from '@noble/hashes/sha2.js'

/** 서비스 UUID 와 Noise 프롤로그(bluetoothPrologue)가 같이 쓰는 이름표 */
export const BLUETOOTH_PROTOCOL = 'litecode-bt/1'

/** 폰 → PC 특성 (write without response) */
export const BLUETOOTH_RX_UUID = '6c697465-6272-4000-8000-000000000001'
/** PC → 폰 특성 (notify) */
export const BLUETOOTH_TX_UUID = '6c697465-6272-4000-8000-000000000002'

/** 폰이 요청하는 MTU (Android 14+ 기본 요청값 — 상대가 낮게 답하면 그 값). 한 번에 보내는 조각은 협상된 MTU − 3 이다 */
export const BLUETOOTH_REQUESTED_MTU = 517
/** MTU 협상이 안 됐을 때 한 번에 보내는 조각 (기본 ATT MTU 23 − 3) */
export const BLUETOOTH_DEFAULT_CHUNK = 20
/** 핸드셰이크가 이 안에 안 끝나면 연결을 끊는다 (연결 자리를 차지하는 방해를 줄인다) */
export const BLUETOOTH_HANDSHAKE_TIMEOUT_MS = 10_000
/** 동시에 받는 폰 수 — 나머지는 연결 직후 끊는다 */
export const BLUETOOTH_MAX_CENTRALS = 2

/**
 * 이 데스크탑의 서비스 UUID — SHA-256("litecode-bt/1" ‖ desktopId) 앞 16바이트를 UUID 꼴(소문자)로.
 * desktopId 는 QR 의 `d`(데스크탑 식별자) 그대로다.
 */
export function bluetoothServiceUuid(desktopId: string): string {
  const digest = sha256(new TextEncoder().encode(BLUETOOTH_PROTOCOL + desktopId)).slice(0, 16)
  const hex = Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
