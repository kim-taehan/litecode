// 앱 설정 (설정 화면의 스위치) — 순수 TS. 저장소는 글 하나를 읽고 쓰는 것이면 된다 (앱에서는 platform.ts 가 준다).

import type { Carrier } from './session.ts'

export interface Prefs {
  /** 알림 — 끄면 띠도 시스템 알림도 없다 */
  notifications: boolean
  /** 연결 유지 — 앱이 뒤로 가도 포그라운드 서비스로 연결을 붙들어 알림을 받는다 (상시 알림이 뜬다) */
  keepAlive: boolean
  /** 마지막으로 고른 연결 방법 — 다음에 켤 때 이 길로만 붙는다 (기본 Wi-Fi) */
  carrier: Carrier
}

export const DEFAULT_PREFS: Prefs = { notifications: true, keepAlive: false, carrier: 'wifi' }

export interface PrefsStore {
  load(): Promise<string | undefined | null>
  save(raw: string): Promise<void>
}

export class Preferences {
  private current: Prefs = DEFAULT_PREFS
  private readonly listeners = new Set<() => void>()

  constructor(private readonly store: PrefsStore) {}

  get value(): Prefs {
    return this.current
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** 저장된 값을 읽는다 — 깨졌거나 모르는 값은 기본값 */
  async restore(): Promise<void> {
    let parsed: Partial<Record<keyof Prefs, unknown>> | null = null
    try {
      parsed = JSON.parse((await this.store.load()) ?? 'null')
    } catch {
      parsed = null
    }
    const pick = (key: 'notifications' | 'keepAlive'): boolean => (typeof parsed?.[key] === 'boolean' ? (parsed[key] as boolean) : DEFAULT_PREFS[key])
    const carrier = parsed?.carrier === 'bluetooth' || parsed?.carrier === 'wifi' ? parsed.carrier : DEFAULT_PREFS.carrier
    this.current = { notifications: pick('notifications'), keepAlive: pick('keepAlive'), carrier }
    this.notify()
  }

  set(change: Partial<Prefs>): void {
    this.current = { ...this.current, ...change }
    this.notify()
    void this.store.save(JSON.stringify(this.current)).catch(() => undefined)
  }

  private notify(): void {
    for (const listener of this.listeners) listener()
  }
}
