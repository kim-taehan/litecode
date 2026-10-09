import { Context, Service } from 'cordis'
import './settings.ts'
import { judgeRelease, releaseUrlAllowed, updateUrlOf, type UpdateStatus } from '../../shared/updates.ts'

export type { UpdateState, UpdateStatus } from '../../shared/updates.ts'

// 새 버전 알림 (ctx.updates, 기능 `updates` — 기본 꺼짐, 이슈 #273). 알림만 한다: 받지도 설치하지도 않는다.
// 기능이 꺼져 있으면 이 서비스가 없다 → 바깥 요청 0 (폐쇄망 규칙). 켜져 있으면 앱 시작 약 10초 뒤 한 번, 그리고 "지금 확인" 때 묻는다.
// 설치본이 아니면(개발 실행 — package.json 버전이 늘 낡았다) 묻지 않는다. 오류·4xx·모양이 다른 답·시간 초과는 조용히 failed (던지지 않는다).
// Electron 을 모른다 — 현재 버전·설치본 여부·브라우저로 열기는 옵션으로 받는다 (electron/main.ts).

export const UPDATE_CHECK_DELAY_MS = 10_000
export const UPDATE_CHECK_TIMEOUT_MS = 10_000

export interface UpdatesOptions {
  /** app.getVersion() */
  currentVersion: string
  /** app.isPackaged — false 면 묻지 않는다 */
  packaged: boolean
  /** 기본 브라우저로 연다 (shell.openExternal) — 허용 주소 판정은 서비스가 먼저 한다 */
  open(url: string): Promise<void>
  /** 시험이 바꾼다 */
  fetch?: typeof fetch
  delayMs?: number
  timeoutMs?: number
}

declare module 'cordis' {
  interface Context {
    updates: UpdatesService
  }
  interface Events {
    'updates/changed'(status: UpdateStatus): void
  }
}

export class UpdatesService extends Service {
  static readonly inject = ['settings']

  private current: UpdateStatus = { state: 'idle' }
  private running?: Promise<UpdateStatus>
  private aborter = new AbortController()

  constructor(
    ctx: Context,
    private opts: UpdatesOptions,
  ) {
    super(ctx, 'updates')
    ctx.effect(() => {
      const timer = opts.packaged ? setTimeout(() => void this.check(), opts.delayMs ?? UPDATE_CHECK_DELAY_MS) : undefined
      return () => {
        clearTimeout(timer)
        this.aborter.abort()
      }
    })
  }

  status(): UpdateStatus {
    return { ...this.current }
  }

  /** 지금 묻는다 — 도는 확인이 있으면 그것을 같이 기다린다. 개발 실행이면 묻지 않고 지금 상태 */
  check(): Promise<UpdateStatus> {
    if (!this.opts.packaged) return Promise.resolve(this.status())
    this.running ??= this.run().finally(() => (this.running = undefined))
    return this.running
  }

  /** [내려받기] — 허용된 주소(https · github.com 또는 확인 주소의 호스트)만 연다 */
  async openRelease(url: unknown): Promise<boolean> {
    if (!releaseUrlAllowed(url, updateUrlOf(this.ctx.settings.get()))) return false
    await this.opts.open(url as string)
    return true
  }

  private async run(): Promise<UpdateStatus> {
    this.set({ state: 'checking' })
    const next = await this.ask(updateUrlOf(this.ctx.settings.get()))
    if (!this.aborter.signal.aborted) this.set({ ...next, checkedAt: Date.now() })
    return this.status()
  }

  private async ask(url: string): Promise<Omit<UpdateStatus, 'checkedAt'>> {
    if (!/^https?:\/\//i.test(url)) return { state: 'failed' }
    const timeout = AbortSignal.timeout(this.opts.timeoutMs ?? UPDATE_CHECK_TIMEOUT_MS)
    try {
      const response = await (this.opts.fetch ?? fetch)(url, {
        headers: { accept: 'application/vnd.github+json' },
        signal: AbortSignal.any([timeout, this.aborter.signal]),
      })
      if (!response.ok) return { state: 'failed' }
      return judgeRelease(await response.json(), this.opts.currentVersion)
    } catch (error) {
      console.warn('[updates] 새 버전을 확인하지 못했다', (error as Error)?.message)
      return { state: 'failed' }
    }
  }

  private set(next: UpdateStatus): void {
    this.current = next
    this.ctx.emit('updates/changed', this.status())
  }
}
