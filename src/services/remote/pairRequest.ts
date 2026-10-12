import { randomBytes } from 'node:crypto'
import { sameSecret } from '../httpUtil.ts'
import { fingerprintCode } from '../../../shared/remotePairing.ts'
import { DEVICE_KEY_PATTERN, type PairRejected, type PairResponse } from '../../../shared/remote.ts'
import type { RemoteReply } from './carrier.ts'
import type { DeviceStore } from './devices.ts'
import { DEVICE_NAME_MAX, PAIR_MAX_FAILURES, PAIR_WAIT_MS } from './limits.ts'
import { confirmCode, normalizePairCode } from './pairing.ts'
import type { ActiveCode, PendingPair, RemoteStatus } from './types.ts'

// POST /v1/pair — 짝짓기 요청 하나 (이슈 #298 에서 remote.ts 의 RemoteService.pair 를 옮김, 동작 그대로).
// 코드 세션(발급·만료)·[허용] 대기 목록은 서비스가 쥐고, 여기는 그것을 host 로 받아 쓴다

/** 짝짓기 요청에 쓰는 서비스의 상태 — 같은 Map·저장소를 그대로 넘긴다. 바뀌는 값(코드·내려감)은 함수로 그때그때 읽는다 */
export interface PairHost {
  store: DeviceStore
  pending: Map<string, PendingPair>
  /** 데스크탑 [허용] 을 기다리는 시간 (RemoteServiceOptions.pairWaitMs) */
  pairWaitMs?: number
  /** 지금 쓸 수 있는 코드 세션 — 만료됐으면 버리고 없다 */
  activeCode(): ActiveCode | undefined
  /** 코드 세션을 버린다 (this.code = undefined) */
  dropCode(): void
  disposed(): boolean
  changed(): RemoteStatus
  revoke(deviceId: string): Promise<RemoteStatus>
  loadBluetoothKey(): Promise<string | undefined>
}

/** POST /v1/pair — 코드가 맞으면 그 코드를 쓰고(1회용) 데스크탑 [허용] 을 기다린다. 응답은 사용자가 답하거나 시간이 다 됐을 때.
 *  gone: 폰이 기다리다 떠났다. fingerprint: 요청이 지문으로 고정되는 운반(TLS)으로 왔으면 그 지문 — 확인 코드가 지문 앞 8자가 된다 */
export function pairRequest(host: PairHost, body: unknown, gone: AbortSignal, fingerprint?: string): RemoteReply | Promise<RemoteReply> {
  const input = body as { code?: unknown; deviceName?: unknown; platform?: unknown; deviceKey?: unknown } | undefined
  // 이름은 데스크탑 확인 창·기기 목록에 그대로 보인다 — 제어 문자는 빼고 길이를 자른다
  const deviceName = typeof input?.deviceName === 'string' ? input.deviceName.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, DEVICE_NAME_MAX) : ''
  const platform = input?.platform
  if (typeof input?.code !== 'string' || !deviceName || (platform !== 'android' && platform !== 'ios')) {
    return { status: 400, body: { error: 'code, deviceName and platform are required' } }
  }
  const active = host.activeCode()
  if (!active) return { status: 403, body: { error: 'no pairing in progress', reason: 'no-code' } satisfies PairRejected }
  // 긴 코드(QR)든 짧은 코드(직접 입력)든 — 둘은 한 세션이다
  const given = normalizePairCode(input.code)
  if (!sameSecret(given, active.code) && !sameSecret(given, active.shortCode)) {
    if (++active.failures >= PAIR_MAX_FAILURES) host.dropCode() // 3회째 — 세션을 버린다(긴 코드·짧은 코드 모두). 새로 [기기 연결] 을 눌러야 한다
    host.changed()
    return { status: 403, body: { error: 'wrong pairing code', reason: 'wrong-code' } satisfies PairRejected }
  }
  host.dropCode() // 1회용
  // 폰의 고정 키 (이슈 #275) — 모양이 다르면 없는 것으로(교체하지 않는다)
  const deviceKey = typeof input.deviceKey === 'string' && DEVICE_KEY_PATTERN.test(input.deviceKey) ? input.deviceKey : undefined

  return new Promise<RemoteReply>((resolve) => {
    const id = randomBytes(8).toString('hex')
    let settled = false
    const timer = setTimeout(() => entry.settle('timeout'), host.pairWaitMs ?? PAIR_WAIT_MS)
    const entry: PendingPair = {
      id,
      deviceName,
      platform,
      // TLS 면 폰이 고정한 인증서의 지문 앞 8자, 루프백 평문이면 요청에서 만든 확인 코드 (shared/remotePairing.ts)
      // 확인 코드는 폰이 친 코드로 만든다 — 폰은 자기가 친 것밖에 모른다 (긴 코드면 전과 같다)
      confirm: fingerprint ? fingerprintCode(fingerprint) : confirmCode(given, deviceName, platform),
      ...(fingerprint && { pinned: true as const }),
      settle: (result) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        host.pending.delete(id)
        if (result === 'deny') resolve({ status: 403, body: { error: 'denied on the desktop', reason: 'denied' } satisfies PairRejected })
        else if (result === 'timeout') resolve({ status: 408, body: { error: 'nobody answered on the desktop' } })
        // 받을 상대가 없다 (폰이 떠났거나, 연결을 꺼서 운반이 곧 닫힌다)
        else if (result === 'gone') resolve({ status: 503, body: { error: 'pairing was abandoned' } })
        if (result !== 'allow') {
          if (!host.disposed()) host.changed()
          return
        }
        // 같은 키의 옛 짝 — [허용] 으로 새 짝이 확정되는 지금 교체한다 (거절·시간 초과·틀린 코드면 그대로). 키가 없으면 건드리지 않는다
        const replaced = deviceKey ? host.store.list().filter((device) => device.deviceKey === deviceKey).map((device) => device.id) : []
        void Promise.all([host.store.add(deviceName, platform, deviceKey), host.loadBluetoothKey()]).then(
          async ([{ device, token }, bluetoothKey]) => {
            // 해제와 같은 길 — 옛 토큰은 401, 옛 스트림은 device.revoked 뒤 끊김
            for (const id of replaced) await host.revoke(id).catch((error: unknown) => console.warn('[remote] 옛 짝 교체 실패', (error as Error).message))
            resolve({ status: 200, body: { deviceId: device.id, token, ...(bluetoothKey && { bluetoothKey }) } satisfies PairResponse })
            host.changed()
          },
          (error: unknown) => {
            resolve({ status: 500, body: { error: (error as Error).message } })
            host.changed()
          },
        )
      },
    }
    host.pending.set(id, entry)
    // 폰이 기다리다 끊었다 — 확인 창을 거둔다
    gone.addEventListener('abort', () => entry.settle('gone'), { once: true })
    host.changed()
  })
}
