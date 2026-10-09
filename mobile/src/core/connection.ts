// 연결 — 클라이언트 하나와 상태(state.ts) 하나를 쥐고, 이벤트 스트림을 붙여 두며 끊기면 다시 붙인다. 화면·React 를 모른다.
//
// 상태 (01t 4·8절 상단 상태줄):
//   idle → connecting → connected
//   스트림이 끝남·연결 실패 → reconnecting(attempt, retryAt) — 1초·2초·4초…30초 지수 백오프, 붙으면 connected
//   30초 동안 아무 바이트도 안 옴(ping 도) → unresponsive ("데스크탑 응답 없음(잠자기?)") — 뒤에서 같은 백오프로 계속 붙어 본다
//   `device.revoked` 이벤트 또는 401 → revoked — 다시 붙지 않는다 (다시 짝지어야 한다)
//   지금 주소의 서버 지문이 다르고 다른 후보에도 닿지 못했다 → fingerprint-changed (옛 후보의 다른 지문은 닿지 않음으로 — roaming.ts) — 자동으로 믿지 않는다, 다시 붙지 않는다 (다시 짝지어야 한다)
//   블루투스 권한 없음·꺼짐·키 없음(BluetoothError.needsUser) → needs-action — 저절로 다시 시도하지 않는다(권한 창을 되풀이하지 않는다). retry() 로 다시
//   단 꺼짐(bluetooth-off)은 needs-action 을 보이면서 블루투스가 켜지기를 듣고(whenBluetoothOn — 폴링 없음), 켜지면 retry() 처럼 곧바로 다시 붙는다 (이슈 #270)
// 다시 붙을 때: hello(runId 대조) → events?run=&after=<적용한 마지막 seq>. 이을 수 없으면 리듀서가 resync 를 올리고, 여기서 목록과
// 열린 대화의 스냅샷을 다시 받는다.

import { REMOTE_SILENCE_TIMEOUT_MS, type RemoteEvent } from '../../../shared/remote.ts'
import { BluetoothError } from './bluetoothLink.ts'
import { RemoteError, type RemoteClient } from './client.ts'
import { NetError } from './net.ts'
import { initialState, reduce, type RemoteAction, type RemoteState } from './state.ts'

export type ConnectionStatus =
  | { kind: 'idle' }
  | { kind: 'connecting' }
  | { kind: 'connected' }
  /** attempt 번째 재시도를 retryAt(ms, Date.now 기준)에 한다 — 화면이 남은 초를 센다 */
  | { kind: 'reconnecting'; attempt: number; retryAt: number }
  | { kind: 'unresponsive'; attempt: number; retryAt: number }
  | { kind: 'revoked' }
  /** 데스크탑 인증서 지문이 짝지을 때와 다르다 (다시 설치했거나 다른 PC) */
  | { kind: 'fingerprint-changed' }
  /** 사람이 무엇을 해야 붙는다(블루투스 권한·꺼짐·키 없음 — BluetoothError.needsUser). 저절로 다시 시도하지 않는다 — retry() 를 기다린다 (꺼짐만은 켜지면 저절로) */
  | { kind: 'needs-action' }

const BACKOFF_BASE_MS = 1_000
const BACKOFF_MAX_MS = 30_000

/** attempt(1부터) 번째 재시도 전에 기다릴 시간 — 1초, 2초, 4초 … 최대 30초 */
export function backoffMs(attempt: number): number {
  return Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, attempt - 1))
}

export interface ConnectionOptions {
  /** 블루투스가 켜지면 listener (구독할 때 이미 켜져 있으면 곧바로). 돌려준 함수로 그만 듣는다 — 블루투스 세션만 준다 (BleDriver.onBluetoothOn) */
  whenBluetoothOn?(listener: () => void): () => void
}

export class Connection {
  readonly client: RemoteClient
  private readonly options: ConnectionOptions
  private current: RemoteState = initialState
  private currentStatus: ConnectionStatus = { kind: 'idle' }
  private readonly listeners = new Set<() => void>()
  private readonly eventListeners = new Set<(event: RemoteEvent) => void>()
  /** 연결 시도마다 오른다 — 늦게 돌아온 옛 시도의 콜백을 버린다 */
  private generation = 0
  private attempt = 0
  private silent = false
  private closeStream: (() => void) | undefined
  private retryTimer: ReturnType<typeof setTimeout> | undefined
  private silenceTimer: ReturnType<typeof setTimeout> | undefined
  /** bluetooth-off 로 멈춘 동안 켜짐을 듣는 구독 — teardown 이 거둔다 */
  private offBluetooth: (() => void) | undefined
  private syncing = false
  /** 스냅샷을 다 받아 둔 resync 번호 */
  private synced = 0
  /** 마지막으로 붙지 못한 까닭 — 붙으면 지운다 */
  private lastFailure: unknown

  constructor(client: RemoteClient, options: ConnectionOptions = {}) {
    this.client = client
    this.options = options
  }

  get state(): RemoteState {
    return this.current
  }

  get status(): ConnectionStatus {
    return this.currentStatus
  }

  /** 마지막으로 붙지 못했거나 끊긴 까닭(운반이 던진 것 그대로) — 붙어 있으면 undefined. 화면이 사유 문구를 고른다 */
  get failure(): unknown {
    return this.lastFailure
  }

  /** 상태(state·status)가 바뀔 때마다 부른다. 돌려준 함수로 그만 듣는다 */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /**
   * 데스크탑이 낸 이벤트를 **한 번씩** 듣는다 (알림용 — 상태에 반영된 뒤에 부른다). 이미 본 seq 의 재생분은 오지 않는다.
   * 열어 두지 않은 대화의 것도 온다 — 리듀서는 그런 이벤트를 버리지만 알림은 다른 대화의 일을 알려야 한다.
   */
  onEvent(listener: (event: RemoteEvent) => void): () => void {
    this.eventListeners.add(listener)
    return () => this.eventListeners.delete(listener)
  }

  start(): void {
    if (this.currentStatus.kind !== 'idle') return
    this.setStatus({ kind: 'connecting' })
    void this.connect()
  }

  /** 스트림·타이머를 다 거둔다 (받아 둔 상태는 남는다) */
  stop(): void {
    this.teardown()
    this.attempt = 0
    this.silent = false
    this.setStatus({ kind: 'idle' })
  }

  /** 앱이 앞으로 돌아왔다 — 기다리던 재시도를 지금 한다 */
  wake(): void {
    if (this.currentStatus.kind !== 'reconnecting' && this.currentStatus.kind !== 'unresponsive') return
    void this.connect()
  }

  /** 사용자가 [다시 시도] 를 눌렀다 — 기다리던 재시도든, 사람을 기다리며 멈춘 것(needs-action)이든 지금 처음부터 붙어 본다 */
  retry(): void {
    const kind = this.currentStatus.kind
    if (kind !== 'reconnecting' && kind !== 'unresponsive' && kind !== 'needs-action') return
    this.attempt = 0
    this.silent = false
    this.setStatus({ kind: 'connecting' })
    void this.connect()
  }

  async loadProjects(): Promise<void> {
    this.dispatch({ type: 'projects.loaded', projects: await this.client.projects() })
  }

  async loadConversations(project: string): Promise<void> {
    this.dispatch({ type: 'conversations.loaded', project, conversations: await this.client.conversations(project) })
  }

  /** 대화를 연다(또는 다시 받는다) — 받는 동안 온 이벤트는 리듀서가 스냅샷 위에 다시 얹는다 */
  async openConversation(cid: string): Promise<void> {
    this.dispatch({ type: 'conversation.loading', cid })
    try {
      this.dispatch({ type: 'conversation.loaded', cid, snapshot: await this.client.conversation(cid) })
    } catch (error) {
      this.dispatch({ type: 'conversation.failed', cid })
      throw error
    }
  }

  closeConversation(cid: string): void {
    this.dispatch({ type: 'conversation.closed', cid })
  }

  private async connect(): Promise<void> {
    this.teardown()
    const generation = this.generation
    const stale = (): boolean => generation !== this.generation
    let hello
    try {
      hello = await this.client.hello()
    } catch (error) {
      if (!stale()) this.failed(error)
      return
    }
    if (stale()) return
    this.dispatch({ type: 'hello', hello })
    this.armSilence()
    this.closeStream = this.client.events(
      { run: this.current.runId, after: this.current.seq },
      {
        onOpen: () => {
          if (stale()) return
          this.attempt = 0
          this.silent = false
          this.lastFailure = undefined
          this.setStatus({ kind: 'connected' })
          void this.sync()
        },
        onActivity: () => {
          if (!stale()) this.armSilence()
        },
        onEvent: (event) => {
          if (stale()) return
          if (event.event === 'device.revoked') return this.revoked()
          const fresh = event.seq === undefined || event.seq > this.current.seq
          this.dispatch({ type: 'event', event })
          if (fresh) for (const listener of this.eventListeners) listener(event)
          void this.sync()
        },
        onEnd: (error) => {
          if (!stale()) this.failed(error)
        },
      },
    )
  }

  /** 붙지 못했거나 끊겼다 — 백오프 뒤 다시 */
  private failed(error?: unknown): void {
    this.lastFailure = error
    if (error instanceof RemoteError && error.status === 401) return this.revoked()
    if (error instanceof NetError && error.kind === 'pin-mismatch') return this.halt({ kind: 'fingerprint-changed' })
    if (error instanceof BluetoothError && error.needsUser) {
      this.halt({ kind: 'needs-action' })
      if (error.reason === 'bluetooth-off') this.waitForBluetooth()
      return
    }
    this.teardown()
    this.attempt += 1
    const delay = backoffMs(this.attempt)
    this.setStatus({ kind: this.silent ? 'unresponsive' : 'reconnecting', attempt: this.attempt, retryAt: Date.now() + delay })
    this.retryTimer = setTimeout(() => void this.connect(), delay)
  }

  private revoked(): void {
    this.halt({ kind: 'revoked' })
  }

  /** 저절로는 다시 붙지 않는다 — 다시 짝지어야 한다(revoked·fingerprint-changed) 또는 사람이 고친 뒤 retry() (needs-action) */
  private halt(status: Extract<ConnectionStatus, { kind: 'revoked' | 'fingerprint-changed' | 'needs-action' }>): void {
    this.teardown()
    this.setStatus(status)
  }

  /** 사람이 블루투스를 켜면 곧바로 다시 붙는다. 그사이 [다시 시도]·stop 이 먼저 오면 teardown 이 구독을 거둔다 */
  private waitForBluetooth(): void {
    const generation = this.generation
    this.offBluetooth = this.options.whenBluetoothOn?.(() => {
      if (generation === this.generation) this.retry()
    })
    // 구독하는 자리에서 곧바로 불려 이미 다시 붙기 시작했다 — 이 구독은 남길 까닭이 없다
    if (generation !== this.generation) {
      this.offBluetooth?.()
      this.offBluetooth = undefined
    }
  }

  private armSilence(): void {
    clearTimeout(this.silenceTimer)
    this.silenceTimer = setTimeout(() => {
      this.silent = true
      this.failed()
    }, REMOTE_SILENCE_TIMEOUT_MS)
  }

  private teardown(): void {
    this.generation += 1
    this.closeStream?.()
    this.closeStream = undefined
    clearTimeout(this.retryTimer)
    clearTimeout(this.silenceTimer)
    this.offBluetooth?.()
    this.offBluetooth = undefined
  }

  /** 리듀서가 "다시 받아라" 고 적어 둔 것을 받는다. 실패하면 그대로 두고, 다음 이벤트·다시 붙을 때 또 한다 */
  private async sync(): Promise<void> {
    if (this.syncing) return
    this.syncing = true
    try {
      while (this.current.resync !== this.synced || this.current.staleProjects.length > 0) {
        if (this.current.resync !== this.synced) {
          const target = this.current.resync
          await Promise.all([
            this.loadProjects(),
            ...Object.keys(this.current.conversations).map((project) => this.loadConversations(project)),
            ...Object.keys(this.current.views).map((cid) => this.reopenConversation(cid)),
          ])
          this.synced = target
        } else {
          await this.loadConversations(this.current.staleProjects[0]!)
        }
      }
    } catch {
      // 끊긴 것이다 — 연결이 다시 붙으면(onOpen) 이어서 한다
    } finally {
      this.syncing = false
    }
  }

  /** 다시 받기의 열린 대화 하나. 404(데스크탑에서 지웠다)는 다시 해도 404 다 — 닫고 받은 것으로 친다.
   *  안 그러면 다시 받기가 끝나지 않아 그 뒤 이벤트마다 목록·모든 열린 대화를 또 부른다 (#187) */
  private async reopenConversation(cid: string): Promise<void> {
    try {
      await this.openConversation(cid)
    } catch (error) {
      if (!(error instanceof RemoteError && error.status === 404)) throw error
      this.closeConversation(cid)
    }
  }

  private dispatch(action: RemoteAction): void {
    const next = reduce(this.current, action)
    if (next === this.current) return
    this.current = next
    this.notify()
  }

  private setStatus(status: ConnectionStatus): void {
    this.currentStatus = status
    this.notify()
  }

  private notify(): void {
    for (const listener of this.listeners) listener()
  }
}
