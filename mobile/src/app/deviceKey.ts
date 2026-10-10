// 이 폰의 고정 키 (이슈 #275) — 짝짓기 요청(shared/remote.ts PairRequest.deviceKey)에 실어, 같은 폰이 다시 짝지으면 데스크탑이 옛 짝을 교체하게 한다.
// 앱 저장소의 값은 재설치로 사라지므로 Android ID(API 26+ 에서 앱 서명 키·사용자·기기별로 고정, 재설치에도 같다)에서 만든다.
// 기기 고유값을 그대로 보내지 않는다 — sha256("litecode-device/1:" + 값) 의 앞 32자(hex)만. 값이 없으면(네이티브 없음·옛 빌드) 키도 없다(교체 안 함)

import { sha256 } from '../../../shared/remotePairing.ts'

export function deviceKeyOf(androidId: string | undefined): string | undefined {
  if (!androidId) return undefined
  return Array.from(sha256(`litecode-device/1:${androidId}`).subarray(0, 16), (byte) => byte.toString(16).padStart(2, '0')).join('')
}
