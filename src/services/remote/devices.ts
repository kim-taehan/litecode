import { createHash, randomBytes } from 'node:crypto'
import { readJsonFile, writeJsonFile } from '../jsonFile.ts'

// 짝지은 기기 (userData/remote-devices.json) — 토큰은 **해시(SHA-256)만** 둔다. 파일이 새도 토큰을 되살릴 수 없다.
// 데스크탑 id(폰이 "어느 PC 인가" 를 가리는 값 — 비밀이 아니다)도 같은 파일에 있다. 옛 파일의 `enabled`(설정 > 모바일의 스위치, #124 로 없어졌다)는
// 읽지 않고 다음 쓰기 때 사라진다 — 켜짐은 기능 `remote` 하나다.
// 파일은 올라올 때 한 번 읽고, 그 뒤 정본은 메모리다. 쓰기는 한 줄로 세운다(임시 파일 + rename).

export type DevicePlatform = 'android' | 'ios'

export interface StoredDevice {
  id: string
  name: string
  platform: DevicePlatform
  /** 기기 토큰의 SHA-256 (hex) */
  tokenHash: string
  pairedAt: number
  lastSeenAt?: number
}

interface Stored {
  version: 1
  desktopId: string
  devices: StoredDevice[]
}

/** 마지막 접속 시각은 이 간격으로만 파일에 적는다 — 요청마다 쓰지 않는다 */
const SEEN_WRITE_INTERVAL_MS = 60_000

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export class DeviceStore {
  private stored: Stored = { version: 1, desktopId: randomBytes(8).toString('hex'), devices: [] }
  private queue: Promise<unknown> = Promise.resolve()
  private seenWritten = new Map<string, number>()

  constructor(
    private file: string,
    private now: () => number = Date.now,
  ) {}

  /** 파일이 없거나 손상됐으면 빈 목록 — 앱 시작을 막지 않는다 (기기는 다시 짝지으면 된다). 손상된 파일은 옆에 옮겨 둔다 (jsonFile.ts) */
  async load(): Promise<void> {
    try {
      const parsed = (await readJsonFile(this.file, 'object')) as Partial<Stored> | undefined
      if (!parsed) return // 처음이다 (또는 방금 옮겼다)
      this.stored = {
        version: 1,
        desktopId: typeof parsed?.desktopId === 'string' && parsed.desktopId ? parsed.desktopId : this.stored.desktopId,
        devices: Array.isArray(parsed?.devices) ? parsed.devices.filter(isDevice) : [],
      }
    } catch {
      // 처음이거나 못 읽는 파일
    }
  }

  get desktopId(): string {
    return this.stored.desktopId
  }

  list(): StoredDevice[] {
    return this.stored.devices
  }

  /** 새 기기 — 256bit 토큰을 만들어 해시만 저장하고, 토큰은 이 한 번만 돌려준다 */
  async add(name: string, platform: DevicePlatform): Promise<{ device: StoredDevice; token: string }> {
    const token = randomBytes(32).toString('base64url')
    const device: StoredDevice = { id: `dev_${randomBytes(8).toString('hex')}`, name, platform, tokenHash: hashToken(token), pairedAt: this.now() }
    this.stored = { ...this.stored, devices: [...this.stored.devices, device] }
    await this.write()
    return { device, token }
  }

  /** 해제 — 그 토큰은 곧바로 401 이다. 없는 id 면 false */
  async remove(id: string): Promise<boolean> {
    if (!this.stored.devices.some((device) => device.id === id)) return false
    this.stored = { ...this.stored, devices: this.stored.devices.filter((device) => device.id !== id) }
    await this.write()
    return true
  }

  /** `Authorization` 헤더의 기기 — 토큰 해시로 찾는다 */
  authenticate(header: string | undefined): StoredDevice | undefined {
    const token = /^Bearer (\S+)$/.exec(header ?? '')?.[1]
    if (!token) return undefined
    const hash = hashToken(token)
    return this.stored.devices.find((device) => device.tokenHash === hash)
  }

  /** 그 기기가 지금 접속했다 */
  seen(id: string): void {
    const at = this.now()
    this.stored = { ...this.stored, devices: this.stored.devices.map((device) => (device.id === id ? { ...device, lastSeenAt: at } : device)) }
    if (at - (this.seenWritten.get(id) ?? 0) < SEEN_WRITE_INTERVAL_MS) return
    this.seenWritten.set(id, at)
    void this.write().catch(() => {})
  }

  /** 밀린 쓰기가 끝날 때까지 */
  idle(): Promise<unknown> {
    return this.queue
  }

  private write(): Promise<void> {
    const next = this.queue.then(async () => {
      await writeJsonFile(this.file, this.stored, { mode: 0o600 }) // 쓰다 죽어도 이전 파일이 남게
    })
    this.queue = next.catch(() => {}) // 한 번 실패해도 다음 쓰기는 돈다
    return next
  }
}

function isDevice(value: unknown): value is StoredDevice {
  const entry = value as Partial<StoredDevice> | null
  return (
    typeof entry?.id === 'string' &&
    typeof entry.name === 'string' &&
    (entry.platform === 'android' || entry.platform === 'ios') &&
    typeof entry.tokenHash === 'string' &&
    /^[0-9a-f]{64}$/.test(entry.tokenHash) &&
    typeof entry.pairedAt === 'number' &&
    (entry.lastSeenAt === undefined || typeof entry.lastSeenAt === 'number')
  )
}

/** IP 당 인증 실패 제한 (01t 3절) — 1분에 10회를 넘으면 5분 차단 */
export class FailureLimiter {
  private failures = new Map<string, number[]>()
  private blockedUntil = new Map<string, number>()

  constructor(
    private now: () => number = Date.now,
    private max = 10,
    private windowMs = 60_000,
    private blockMs = 5 * 60_000,
  ) {}

  /** 차단 중이면 남은 시간(ms) */
  blocked(ip: string): number | undefined {
    const until = this.blockedUntil.get(ip)
    if (until === undefined) return undefined
    if (until > this.now()) return until - this.now()
    this.blockedUntil.delete(ip)
    return undefined
  }

  fail(ip: string): void {
    const at = this.now()
    const recent = [...(this.failures.get(ip) ?? []).filter((time) => at - time < this.windowMs), at]
    if (recent.length < this.max) {
      this.failures.set(ip, recent)
      return
    }
    this.failures.delete(ip)
    this.blockedUntil.set(ip, at + this.blockMs)
  }
}
