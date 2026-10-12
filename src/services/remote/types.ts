import type { KeyCipher } from '../providers.ts'
import type { RemoteRadioStatus } from './carrier.ts'
import type { DevicePlatform, StoredDevice } from './devices.ts'
import type { StreamQueue } from './streamQueue.ts'

// ctx.remote 의 모양 (이슈 #298 에서 remote.ts 에서 옮김). 바깥에 내보내는 것(RemoteServiceOptions·RemotePairRequest·RemoteDeviceInfo·RemoteStatus)은
// remote.ts 가 다시 내보낸다 — 그 밖은 remote/ 안에서만 쓴다

export interface RemoteServiceOptions {
  /** 기기 목록 JSON 파일 (앱에서는 userData/remote-devices.json) */
  file: string
  /** hello.name — 기본은 PC 이름 */
  name?: string
  appVersion?: string
  pingMs?: number
  /** 데스크탑 [허용] 을 기다리는 시간 */
  pairWaitMs?: number
  now?: () => number
  /** 블루투스 Noise 정적 키 파일 (앱에서는 userData/remote-noise-key.json, 이슈 #171) — noiseIdentity() 가 처음 불릴 때 만든다 */
  noiseKeyFile?: string
  /** noiseKeyFile 의 비밀키를 봉하는 수단 (safeStorage) */
  cipher?: KeyCipher
}

/** 데스크탑 [허용] 을 기다리는 짝짓기 요청 */
export interface RemotePairRequest {
  id: string
  deviceName: string
  platform: DevicePlatform
  /** 확인 코드 8자 (`ABCD-EFGH`) — 폰 화면과 같아야 한다. pinned 면 TLS 인증서 지문 앞 8자다 */
  confirm: string
  /** 사내망(TLS)으로 왔다 — confirm 이 지문 앞 8자 */
  pinned?: true
}

export interface RemoteDeviceInfo {
  id: string
  name: string
  platform: DevicePlatform
  pairedAt: number
  lastSeenAt?: number
  /** 지금 이벤트 스트림이 붙어 있다 */
  connected: boolean
  /** 지금(붙어 있으면 그 스트림의, 아니면 이 실행에서 마지막 요청의) 운반 id — 'http'·'https'·'bluetooth'. 이 실행에서 요청이 없었으면 없다 (이슈 #210 — 기기 줄의 연결 방법 배지) */
  via?: string
}

/** 설정 > 모바일이 그리는 상태 */
export interface RemoteStatus {
  port: number
  /** 듣고 있는 주소 (`ip:port`) — 못 떴으면 빈 목록 */
  addresses: string[]
  /** 운반이 못 뜬 사유 (code: EADDRINUSE 등). keyStore: 키 저장소가 봉한 키를 안 풀어 줬다 (이슈 #231) */
  error?: { code?: string; message: string; keyStore?: true }
  /** 사내망(TLS) 리스너의 인증서 지문 (SPKI SHA-256 base64url) — TLS 운반이 없거나 못 떴으면 없다 */
  fingerprint?: string
  /** 지문 앞 8자 (`ABCD-EFGH`, shared/remotePairing.ts fingerprintCode) — 직접 입력 화면과 [허용] 확인에 보인다 */
  fingerprintCode?: string
  /** 마지막으로 바깥(사내망 리스너)에서 접속이 들어온 시각 — 막힌 접속도 센다. 한 번도 없으면 없다 (진단: 클라이언트 격리·방화벽) */
  lastAttemptAt?: number
  /** 지금 쓸 수 있는 짝짓기 코드. code 는 긴 코드(QR·옛 폰), shortCode 는 직접 입력용 숫자 2자리 — 한 세션이다.
   *  uri 는 QR 에 실을 문자열(`litecode://pair?…`) — 사내망(TLS) 주소나 블루투스가 있을 때만 (블루투스만이면 a·fp 없는 블루투스 단독 QR, 이슈 #229) */
  pairing?: { code: string; shortCode: string; expiresAt: number; uri?: string }
  requests: RemotePairRequest[]
  devices: RemoteDeviceInfo[]
  /** 블루투스 운반이 올라와 있을 때만(기능 bluetooth, 이슈 #210) — 라디오 상태와 지금 블루투스로 이벤트 스트림이 붙은 기기 이름 */
  bluetooth?: RemoteRadioStatus & { devices: string[] }
}

export interface ActiveCode {
  code: string
  /** 직접 입력용 숫자 2자리 — code 와 같은 세션(만료·1회용·틀린 시도) */
  shortCode: string
  expiresAt: number
  failures: number
}

export interface PendingPair extends RemotePairRequest {
  settle(result: 'allow' | 'deny' | 'timeout' | 'gone'): void
}

export interface Stream {
  queue: StreamQueue
  deviceId: string
  /** 이 스트림이 붙은 운반 id */
  carrier: string
}

export type Reply = [status: number, body: unknown]

export interface RouteInput {
  params: string[]
  query: URLSearchParams
  body: unknown
  device: StoredDevice
}
