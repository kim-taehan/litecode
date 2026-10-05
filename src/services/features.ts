import { Context, Service, type Fiber } from 'cordis'
import { FEATURES, featureOn, type FeatureId } from '../../shared/features.ts'
import './settings.ts'

// 기능 레지스트리 (ctx.features, 이슈 #8) — settings 의 기능별 켜기 값을 보고 기능 묶음(서비스 + 그 IPC 연결)을 ctx.plugin 으로 올리고
// fiber dispose 로 내린다. 재시작 없이 — 묶음 안의 IPC 핸들러·이벤트 구독은 effect 라 내릴 때 같이 걷힌다.
// 묶음이 무엇인지는 모른다(electron/main.ts 가 넘긴다) — 그래서 Electron 없이 단위 테스트한다.
// 올리고 내리기는 한 줄로 세운다: 끄자마자 다시 켜도 옛 핸들러가 다 걷힌 뒤 새로 건다 (ipcMain.handle 은 같은 채널 두 번을 거절한다).

declare module 'cordis' {
  interface Context {
    features: FeaturesService
  }
  interface Events {
    /** 켜진 기능 목록이 바뀌었다 — 묶음을 다 올리고 내린 뒤에 낸다 */
    'features/changed'(enabled: FeatureId[]): void
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

  constructor(
    ctx: Context,
    private definitions: FeatureDefinition[],
  ) {
    super(ctx, 'features')
    ctx.on('settings/changed', () => this.sync())
    this.sync()
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
              const mounted = this.ctx.plugin(plugin)
              this.fibers.set(id, mounted)
              await mounted
            } else if (!this.isEnabled(id) && fiber) {
              this.fibers.delete(id)
              await fiber.dispose()
            }
          } catch (error) {
            console.error(`[features] ${id} 올리고 내리기 실패`, error)
          }
        }
        const enabled = this.enabled()
        if (enabled.join() === this.published) return
        this.published = enabled.join()
        this.ctx.emit('features/changed', enabled)
      })
      .catch((error: unknown) => console.error('[features] 기능 올리고 내리기 실패', error))
  }
}
