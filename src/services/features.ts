import { Context, Service, type Fiber } from 'cordis'
import os from 'node:os'
import { FEATURES, featureOn, type FeatureId, type FeatureReason, type FeatureStatus, type FeatureStatuses } from '../../shared/features.ts'
import { redactSecrets } from './logFile.ts'
import './settings.ts'

// 기능 레지스트리 (ctx.features, 이슈 #8) — settings 의 기능별 켜기 값을 보고 기능 묶음(서비스 + 그 IPC 연결)을 ctx.plugin 으로 올리고
// fiber dispose 로 내린다. 재시작 없이 — 묶음 안의 IPC 핸들러·이벤트 구독은 effect 라 내릴 때 같이 걷힌다.
// 묶음이 무엇인지는 모른다(electron/main.ts 가 넘긴다) — 그래서 Electron 없이 단위 테스트한다.
// 올리고 내리기는 한 줄로 세운다: 끄자마자 다시 켜도 옛 핸들러가 다 걷힌 뒤 새로 건다 (ipcMain.handle 은 같은 채널 두 번을 거절한다).
// 기능 상태 (이슈 #224) — 켜진 기능마다 mounting/on/failed 를 쥔다(꺼진 기능은 상태 없음). 묶음 아래 어느 fiber 가 던져도 그 기능의 failed 다:
// main.ts 의 묶음은 안에서 ctx.plugin(Service) 를 해서, 안쪽이 던져도 바깥 fiber 는 멀쩡히 끝난다(cordis 4 실측 2026-10-07) — 그래서
// internal/status 로 FAILED 가 된 fiber 를 받아 위로 올라가며 어느 묶음 것인지 찾는다. 묶음은 스스로 문제를 알릴 수도 있다(problem —
// 블루투스 꺼짐·권한 없음, 음성 엔진 파일 없음). 사유는 한 줄·길이 상한·비밀 가림(failureReason). 끄면 지우고, 다시 켜면 다시 시도한다.

declare module 'cordis' {
  interface Context {
    features: FeaturesService
  }
  interface Events {
    /** 켜진 기능 목록이 바뀌었다 — 묶음을 다 올리고 내린 뒤에 낸다 */
    'features/changed'(enabled: FeatureId[]): void
    /** 기능 상태가 바뀌었다 (이슈 #224) — 켜진 기능만 담는다. 같은 값이면 다시 내지 않는다 */
    'features/status'(statuses: FeatureStatuses): void
  }
}

export interface FeatureDefinition {
  id: FeatureId
  /** 이 기능의 묶음 — 서비스와 그 연결을 올리는 플러그인 */
  plugin: (ctx: Context) => void
  /** 묶음이 올리는 서비스의 ctx 키 (있으면) — 부팅 진단이 켜진 기능의 서비스가 떴는지 본다 */
  service?: string
}

export class FeaturesService extends Service {
  static readonly inject = ['settings']

  private fibers = new Map<FeatureId, Fiber>()
  private queue: Promise<void> = Promise.resolve()
  private published = ''
  /** 올리는 중인 기능 */
  private mounting = new Set<FeatureId>()
  /** 묶음이 던진 사유 — 끄면 지운다 */
  private failures = new Map<FeatureId, string>()
  /** 묶음이 스스로 알린 문제 — 끄면 지운다 */
  private problems = new Map<FeatureId, FeatureReason>()
  private publishedStatus = ''

  constructor(
    ctx: Context,
    private definitions: FeatureDefinition[],
  ) {
    super(ctx, 'features')
    ctx.on('settings/changed', () => this.sync())
    ctx.on('internal/status', (fiber) => {
      if (fiber.state !== FIBER_FAILED) return
      const id = this.owner(fiber)
      if (id) fiber.await().catch((error: unknown) => this.fail(id, error))
    })
    this.sync()
  }

  /** 켜진 기능의 상태 — 꺼졌으면 없다 */
  status(feature: FeatureId): FeatureStatus | undefined {
    if (!this.isEnabled(feature)) return undefined
    const reason = this.failures.get(feature) ?? this.problems.get(feature)
    if (reason !== undefined) return { state: 'failed', reason }
    if (this.mounting.has(feature)) return { state: 'mounting' }
    return { state: 'on' }
  }

  /** 켜진 기능의 상태 (FEATURES 순서) — 화면(설정 > 기능)이 failed 를 그린다 */
  statuses(): FeatureStatuses {
    return Object.fromEntries(this.enabled().map((feature) => [feature, this.status(feature)]))
  }

  /** 묶음이 스스로 문제를 알린다 (undefined 면 풀린다) — 꺼진 기능의 알림은 버린다. 글(과 문구 키의 글 변수)은 failureReason 으로 한 줄로 정리한다 */
  problem(feature: FeatureId, reason: FeatureReason | undefined): void {
    if (reason === undefined) this.problems.delete(feature)
    else if (this.fibers.has(feature)) this.problems.set(feature, tidyReason(reason))
    this.publishStatus()
  }

  /** 그 기능이 켜졌나. directory 는 "전역 켜짐 + 프로젝트별 덮어쓰기" 의 자리 — 아직 프로젝트별 값이 없어 전역 값만 본다 */
  isEnabled(feature: FeatureId, _directory?: string): boolean {
    return featureOn(this.ctx.settings.get().features, feature)
  }

  /** 켜진 기능 (FEATURES 순서) — 화면이 이것을 보고 그린다 */
  enabled(): FeatureId[] {
    return FEATURES.filter((feature) => this.isEnabled(feature))
  }

  /** 켜진 묶음이 올리는 서비스 키 — 떴는지는 모른다 (부팅 진단이 ctx.get 으로 본다) */
  services(): string[] {
    return this.definitions.flatMap(({ id, service }) => (service && this.isEnabled(id) ? [service] : []))
  }

  /** 밀린 올리고 내리기가 다 끝날 때까지 (테스트용) */
  idle(): Promise<void> {
    return this.queue
  }

  private sync(): void {
    this.queue = this.queue
      .then(async () => {
        for (const { id, plugin } of this.definitions) {
          // 묶음 하나가 못 떠도 나머지 묶음과 features/changed(ctx.engine 이 듣는다)는 간다
          try {
            const fiber = this.fibers.get(id)
            if (this.isEnabled(id) && !fiber) {
              this.failures.delete(id)
              this.mounting.add(id)
              this.publishStatus()
              const mounted = this.ctx.plugin(plugin)
              this.fibers.set(id, mounted)
              try {
                await mounted
              } finally {
                this.mounting.delete(id)
              }
            } else if (!this.isEnabled(id) && fiber) {
              this.fibers.delete(id)
              this.failures.delete(id)
              this.problems.delete(id)
              await fiber.dispose()
            }
          } catch (error) {
            console.error(`[features] ${id} 올리고 내리기 실패`, error)
            if (this.fibers.has(id)) this.fail(id, error)
          }
        }
        this.publishStatus()
        const enabled = this.enabled()
        if (enabled.join() === this.published) return
        this.published = enabled.join()
        this.ctx.emit('features/changed', enabled)
      })
      .catch((error: unknown) => console.error('[features] 기능 올리고 내리기 실패', error))
  }

  /** 그 fiber 가 어느 묶음 아래인가 — 위로 올라가며 묶음 fiber 의 uid 와 맞춘다 (ctx 프록시라 fiber 객체끼리 === 는 안 맞는다) */
  private owner(fiber: Fiber): FeatureId | undefined {
    const bundles = new Map([...this.fibers].flatMap(([id, bundle]) => (bundle.uid === null ? [] : [[bundle.uid, id] as const])))
    let current: Fiber | undefined = fiber
    for (let depth = 0; current && current.uid !== null && depth < 64; depth++) {
      const id = bundles.get(current.uid)
      if (id) return id
      if (current.uid === 0) return undefined // 뿌리
      current = current.parent?.fiber
    }
    return undefined
  }

  private fail(feature: FeatureId, error: unknown): void {
    if (!this.fibers.has(feature)) return // 그새 껐다
    this.failures.set(feature, failureReason(error))
    this.publishStatus()
  }

  private publishStatus(): void {
    const statuses = this.statuses()
    const key = JSON.stringify(statuses)
    if (key === this.publishedStatus) return
    this.publishedStatus = key
    this.ctx.emit('features/status', statuses)
  }
}

/** cordis FiberState.FAILED — const enum 이라 값으로 가져오지 못한다 */
const FIBER_FAILED = 3
/** 사유 글 상한 (글자) — 줄 하나에 들어갈 만큼 */
const REASON_MAX = 160

function tidyReason(reason: FeatureReason): FeatureReason {
  if (typeof reason === 'string') return failureReason(reason)
  if (!reason.vars) return reason
  return { key: reason.key, vars: Object.fromEntries(Object.entries(reason.vars).map(([name, value]) => [name, typeof value === 'string' ? failureReason(value) : value])) }
}

/** 오류를 화면에 보일 사유 한 줄로 — 첫 줄만(스택 제외), 홈 경로는 ~, 비밀처럼 보이는 값은 가리고, 길면 자른다 */
export function failureReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  const home = os.homedir()
  let line = (message.split('\n').find((part) => part.trim()) ?? '').trim().replace(/\s+/g, ' ')
  if (home.length > 1) line = line.split(home).join('~')
  line = redactSecrets(line) || (error instanceof Error ? error.name : '')
  return line.length > REASON_MAX ? `${line.slice(0, REASON_MAX - 1)}…` : line
}
