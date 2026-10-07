import { Context, Service } from 'cordis'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SettingsService } from '../../src/services/settings.ts'
import { FeaturesService, type FeatureDefinition } from '../../src/services/features.ts'
import { missingServices } from '../../electron/resilience.ts'
import { CHOOSABLE_FEATURES, FEATURE_GROUPS, FEATURES, featureOn, type FeatureId } from '../../shared/features.ts'
import { bluetoothProblem } from '../../src/services/remote/bluetooth.ts'
import { speechProblem } from '../../src/services/speech.ts'

// ctx.features — 기능 묶음을 settings 값으로 올리고 내린다 (이슈 #8). IPC 는 가짜 등록소로 흉내 낸다: ipcMain.handle 처럼
// 같은 채널을 두 번 걸면 던진다 — 끄고 바로 켤 때 옛 핸들러가 다 걷힌 뒤 새로 거는지 본다.

/** 가짜 ipcMain — 채널 → 핸들러 */
class FakeIpc {
  handlers = new Map<string, () => unknown>()
  handle(channel: string, listener: () => unknown): void {
    if (this.handlers.has(channel)) throw new Error(`second handler for ${channel}`)
    this.handlers.set(channel, listener)
  }
  removeHandler(channel: string): void {
    this.handlers.delete(channel)
  }
}

declare module 'cordis' {
  interface Context {
    fakeTrajectory: FakeTrajectory
  }
}

/** 묶음 안의 기능 서비스 흉내 */
class FakeTrajectory extends Service {
  constructor(ctx: Context) {
    super(ctx, 'fakeTrajectory')
  }
  read(): string {
    return 'steps'
  }
}

let ipc: FakeIpc
let tmp: string
let file: string

/** 기본 켜짐인 기능 — 웹 도구(web)는 늘 꺼짐(고정), 알림·모바일 연결(remote)·훅(hooks, 이슈 #102)·음성 입력(voice)은 고르는 기능 중 기본 꺼짐 (사용자 결정 2026-10-03, 이슈 #56).
 *  사내망 연결(lan)은 기본 켜짐이지만 모바일 연결이 꺼져 있어 같이 꺼진다, 블루투스 연결(bluetooth)은 기본 꺼짐 (이슈 #210) */
const DEFAULT_ON = FEATURES.filter(
  (feature) => !['web', 'notifications', 'remote', 'lan', 'bluetooth', 'hooks', 'voice', 'browser'].includes(feature),
)
/** 묶음이 있는 기능 (web 은 없다) */
const BUNDLED = FEATURES.filter((feature) => feature !== 'web')

/** 기능마다 채널 하나를 거는 묶음. trajectory 는 실제처럼 서비스 + 그 서비스를 inject 한 연결. web 은 실제처럼 묶음이 없다 (ctx.engine 이 듣는다) */
function definitions(): FeatureDefinition[] {
  return BUNDLED.map((id) => {
    if (id === 'trajectory') {
      function bridge(ctx: Context): void {
        ctx.effect(() => {
          ipc.handle('trajectory:load', () => ctx.fakeTrajectory.read())
          return () => ipc.removeHandler('trajectory:load')
        })
      }
      bridge.inject = ['fakeTrajectory']
      return {
        id,
        service: 'fakeTrajectory',
        plugin: (ctx: Context) => {
          ctx.plugin(FakeTrajectory)
          ctx.plugin(bridge)
        },
      }
    }
    return {
      id,
      plugin: (ctx: Context) =>
        void ctx.effect(() => {
          ipc.handle(`${id}:x`, () => id)
          return () => ipc.removeHandler(`${id}:x`)
        }),
    }
  })
}

async function start(bundles: FeatureDefinition[] = definitions()): Promise<{ ctx: Context; settings: SettingsService; features: FeaturesService; seen: FeatureId[][]; fiber: { dispose(): Promise<void> } }> {
  const ctx = new Context()
  const seen: FeatureId[][] = []
  ctx.on('features/changed', (enabled) => void seen.push(enabled))
  ctx.plugin(SettingsService, { file })
  const fiber = ctx.plugin(FeaturesService, bundles)
  const ready = await new Promise<Context>((resolve) => ctx.inject(['settings', 'features'], resolve))
  await ready.features.idle()
  return { ctx, settings: ready.settings, features: ready.features, seen, fiber }
}

/** 걸린 채널 (정렬) */
const channels = () => [...ipc.handlers.keys()].sort()
/** 기본으로 걸리는 채널 — 알림은 기본 꺼짐 */
const ALL = ['appMcp:x', 'at:x', 'bang:x', 'mcp:x', 'openIn:x', 'shell:x', 'skills:x', 'slash:x', 'terminal:x', 'trajectory:load']

beforeEach(async () => {
  ipc = new FakeIpc()
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'litecode-features-'))
  file = path.join(tmp, 'settings.json')
})
afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true })
})

describe('FeaturesService', () => {
  it('기본 — 알림·웹 도구만 빼고 묶음이 올라와 채널이 걸리고, 켜진 목록을 한 번 알린다', async () => {
    const { ctx, features, seen } = await start()
    expect(channels()).toEqual(ALL)
    expect(features.enabled()).toEqual(DEFAULT_ON)
    expect(seen).toEqual([DEFAULT_ON])
    expect(ctx.get('fakeTrajectory')?.read()).toBe('steps')
  })

  it('끄면 재시작 없이 그 묶음만 내려간다 — 서비스·IPC 핸들러가 걷히고 나머지는 그대로', async () => {
    const { ctx, settings, features, seen } = await start()
    settings.set({ features: { trajectory: false } })
    await features.idle()
    expect(channels()).toEqual(ALL.filter((channel) => channel !== 'trajectory:load'))
    expect(ctx.get('fakeTrajectory')).toBeUndefined()
    expect(features.isEnabled('trajectory')).toBe(false)
    expect(seen.at(-1)).toEqual(DEFAULT_ON.filter((feature) => feature !== 'trajectory'))
  })

  it('끄고 바로 다시 켜도 핸들러가 겹치지 않고 돌아온다', async () => {
    const { ctx, settings, features } = await start()
    settings.set({ features: { trajectory: false, openIn: false } })
    settings.set({ features: {} })
    await features.idle()
    expect(channels()).toEqual(ALL)
    expect(ctx.get('fakeTrajectory')?.read()).toBe('steps')
    expect(features.enabled()).toEqual(DEFAULT_ON)
  })

  it('다른 설정이 바뀌면 묶음을 건드리지 않고 목록도 다시 알리지 않는다', async () => {
    const { settings, features, seen } = await start()
    settings.set({ fontSize: 15 })
    await features.idle()
    expect(seen).toHaveLength(1)
    expect(channels()).toEqual(ALL)
  })

  // 사용자 결정 2026-10-03 — 입력 트리거(@ · / · !)·!명령 실행·스킬·MCP 는 필수. 웹 가져오기는 고르는 기능(기본 꺼짐, #103) — 묶음은 없다
  it('고정된 기능은 저장된 값과 무관하다 — 필수는 꺼도 켜져 있다. 웹 가져오기는 켜면 켜진다(묶음 없이 목록만)', async () => {
    const { settings, features, seen } = await start()
    settings.set({ features: { at: false, shell: false, skills: false, mcp: false, web: true } })
    await features.idle()
    expect(channels()).toEqual(ALL)
    expect(features.isEnabled('web')).toBe(true)
    expect(features.enabled().filter((feature) => feature !== 'web')).toEqual(DEFAULT_ON)
    expect(seen).toHaveLength(2)
  })

  it('끈 값은 파일에 남아 다시 띄워도 꺼진 채로 뜬다', async () => {
    const first = await start()
    first.settings.set({ features: { openIn: false } })
    await first.features.idle()
    await first.fiber.dispose()
    ipc = new FakeIpc()

    const again = await start()
    expect(channels()).toEqual(ALL.filter((channel) => channel !== 'openIn:x'))
    expect(again.seen).toEqual([DEFAULT_ON.filter((feature) => feature !== 'openIn')])
  })

  it('프로젝트 자리(directory)는 받지만 아직 전역 값을 따른다', async () => {
    const { settings, features } = await start()
    settings.set({ features: { terminal: false } })
    expect(features.isEnabled('terminal', '/some/project')).toBe(false)
    expect(features.isEnabled('at', '/some/project')).toBe(true)
  })

  it('알림은 기본 꺼짐 — true 로 적어야 켜지고, 켜고 끄면 묶음이 오르내린다', async () => {
    const { settings, features, seen } = await start()
    expect(features.isEnabled('notifications')).toBe(false)
    settings.set({ features: { notifications: true } })
    await features.idle()
    expect(features.isEnabled('notifications')).toBe(true)
    expect(channels()).toEqual([...ALL, 'notifications:x'].sort())
    settings.set({ features: {} })
    await features.idle()
    expect(seen.at(-1)).toEqual(DEFAULT_ON)
    expect(channels()).toEqual(ALL)
  })

  // 전수 검사 #126 오류 4 — 묶음 하나가 못 떠도 뒤 묶음과 features/changed(엔진이 듣는다)는 간다
  it('묶음 하나가 올라오다 던져도 나머지 묶음은 올라오고 켜진 목록을 알린다 — 실패는 기능 이름과 함께 로그에', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const broken = (): void => {
        throw new Error('boom')
      }
      const bundles = definitions().map((definition) => (definition.id === 'at' ? { ...definition, plugin: broken } : definition))
      const { settings, features, seen } = await start(bundles)
      expect(channels()).toEqual(ALL.filter((channel) => channel !== 'at:x'))
      expect(seen).toEqual([DEFAULT_ON])
      expect(logged.mock.calls.some((call) => String(call[0]).includes('at'))).toBe(true)
      // 그 뒤의 켜고 끄기도 그대로 돈다
      settings.set({ features: { openIn: false } })
      await features.idle()
      expect(channels()).toEqual(ALL.filter((channel) => channel !== 'at:x' && channel !== 'openIn:x'))
      expect(seen).toHaveLength(2)
    } finally {
      logged.mockRestore()
    }
  })

  // 전수 검사 #126 오류 5 — 부팅 진단(electron/main.ts checkBoot)이 켜진 기능의 서비스도 본다
  it('켜진 묶음의 서비스 키를 알려 준다 — 꺼진 묶음·서비스 없는 묶음은 빠지고, 못 뜬 서비스는 부팅 진단에 이름이 남는다', async () => {
    const bundles = definitions().map((definition) => (definition.id === 'notifications' ? { ...definition, service: 'neverComes' } : definition))
    const { ctx, settings, features } = await start(bundles)
    expect(features.services()).toEqual(['fakeTrajectory']) // 알림은 기본 꺼짐
    settings.set({ features: { notifications: true, trajectory: false } })
    await features.idle()
    expect(features.services()).toEqual(['neverComes'])
    settings.set({ features: { notifications: true } })
    await features.idle()
    expect(features.services()).toEqual(['fakeTrajectory', 'neverComes'])
    expect(missingServices(features.services(), (name) => ctx.get(name))).toEqual(['neverComes'])
  })

  it('레지스트리를 내리면 켜진 묶음이 다 내려간다 (앱 종료)', async () => {
    const { fiber } = await start()
    await fiber.dispose()
    expect(channels()).toEqual([])
  })
})

// 이슈 #224 — 켰는데 못 뜬 기능을 설정 > 기능 줄에 "켜지 못함" + 사유로 보인다. 상태가 없는 기능 = 꺼짐
describe('FeaturesService — 기능 상태', () => {
  /** at 묶음이 던지는 정의 — 메시지에 둘째 줄(스택 흉내)·홈 경로·키가 섞여 있다 */
  function brokenAt(message: string): FeatureDefinition[] {
    return definitions().map((definition) =>
      definition.id === 'at'
        ? {
            ...definition,
            plugin: () => {
              throw new Error(message)
            },
          }
        : definition,
    )
  }

  async function quiet<T>(run: () => Promise<T>): Promise<T> {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      return await run()
    } finally {
      logged.mockRestore()
    }
  }

  it('켜진 묶음은 on, 꺼진 기능은 상태가 없다', async () => {
    const { features } = await start()
    expect(features.status('terminal')).toEqual({ state: 'on' })
    expect(features.status('notifications')).toBeUndefined()
    expect(features.statuses().terminal).toEqual({ state: 'on' })
    expect('notifications' in features.statuses()).toBe(false)
  })

  it('묶음이 던지면 failed + 사유 한 줄 — 나머지 묶음은 뜬다', async () => {
    const { features } = await quiet(() => start(brokenAt('rg 를 못 찾았다\n    at Object.<anonymous> (/x/y.js:1:2)')))
    expect(features.status('at')).toEqual({ state: 'failed', reason: 'rg 를 못 찾았다' })
    expect(features.status('terminal')).toEqual({ state: 'on' })
    expect(channels()).toEqual(ALL.filter((channel) => channel !== 'at:x'))
  })

  // electron/main.ts 의 묶음은 안에서 ctx.plugin(Service) 를 한다 — 안쪽이 던지면 바깥 fiber 는 멀쩡히 끝난다 (cordis 4 실측 2026-10-07).
  // 그래서 묶음 아래 어느 fiber 가 실패해도 그 기능의 실패로 본다
  it('묶음 안쪽 플러그인(서비스 생성자)이 던져도 그 기능이 failed 가 된다', async () => {
    class Broken extends Service {
      constructor(ctx: Context) {
        super(ctx, 'brokenService')
        throw new Error('service ctor failed')
      }
    }
    const bundles = definitions().map((definition) =>
      definition.id === 'openIn' ? { ...definition, plugin: (ctx: Context) => void ctx.plugin(Broken) } : definition,
    )
    const { features } = await quiet(async () => {
      const started = await start(bundles)
      await vi.waitFor(() => expect(started.features.status('openIn')?.state).toBe('failed'))
      return started
    })
    expect(features.status('openIn')).toEqual({ state: 'failed', reason: 'service ctor failed' })
    expect(features.status('terminal')).toEqual({ state: 'on' })
  })

  it('사유는 한 줄·길이 상한, 홈 경로는 ~ 로, 키처럼 보이는 값은 가린다', async () => {
    const home = os.homedir()
    const long = `${home}/secret/project 에서 실패 key=sk-abcdefghijklmnopqrstuvwxyz0123456789 Bearer abc.def.ghi ${'가'.repeat(400)}`
    const { features } = await quiet(() => start(brokenAt(long)))
    const status = features.status('at')
    expect(status?.state).toBe('failed')
    const reason = status?.state === 'failed' ? String(status.reason) : ''
    expect(reason).not.toContain('\n')
    expect(reason.length).toBeLessThanOrEqual(160)
    expect(reason).not.toContain(home)
    expect(reason).toContain('~/secret/project')
    expect(reason).not.toContain('sk-abcdefghijklmnopqrstuvwxyz0123456789')
    expect(reason).not.toContain('abc.def.ghi')
    expect(reason.endsWith('…')).toBe(true)
  })

  it('던진 묶음을 끄면 상태가 지워지고, 다시 켜면 다시 시도한다', async () => {
    let fail = true
    const bundles = definitions().map((definition) =>
      definition.id === 'terminal'
        ? {
            ...definition,
            plugin: (ctx: Context) => {
              if (fail) throw new Error('boom')
              definition.plugin(ctx)
            },
          }
        : definition,
    )
    const { settings, features } = await quiet(() => start(bundles))
    expect(features.status('terminal')).toEqual({ state: 'failed', reason: 'boom' })
    settings.set({ features: { terminal: false } })
    await features.idle()
    expect(features.status('terminal')).toBeUndefined()
    fail = false
    settings.set({ features: {} })
    await features.idle()
    expect(features.status('terminal')).toEqual({ state: 'on' })
    expect(channels()).toEqual(ALL)
  })

  it('묶음이 스스로 문제를 알리고(problem) 풀 수 있다 — 꺼진 기능의 알림은 버리고, 끄면 문제도 지운다', async () => {
    const { settings, features } = await start()
    features.problem('terminal', { key: 'remote.bluetooth.unauthorized' })
    expect(features.status('terminal')).toEqual({ state: 'failed', reason: { key: 'remote.bluetooth.unauthorized' } })
    features.problem('terminal', undefined)
    expect(features.status('terminal')).toEqual({ state: 'on' })
    features.problem('notifications', 'x') // 꺼진 기능
    expect(features.status('notifications')).toBeUndefined()
    features.problem('terminal', 'line one\nline two')
    expect(features.status('terminal')).toEqual({ state: 'failed', reason: 'line one' })
    settings.set({ features: { terminal: false } })
    await features.idle()
    settings.set({ features: {} })
    await features.idle()
    expect(features.status('terminal')).toEqual({ state: 'on' })
  })

  it('상태가 바뀌면 features/status 로 알린다 — 같은 값이면 다시 알리지 않는다', async () => {
    const ctx = new Context()
    const seen: unknown[] = []
    ctx.on('features/status', (statuses) => void seen.push(statuses))
    ctx.plugin(SettingsService, { file })
    ctx.plugin(FeaturesService, definitions())
    const ready = await new Promise<Context>((resolve) => ctx.inject(['settings', 'features'], resolve))
    await ready.features.idle()
    expect(seen.length).toBeGreaterThan(0)
    expect((seen.at(-1) as Record<string, unknown>).terminal).toEqual({ state: 'on' })
    const before = seen.length
    ready.features.problem('terminal', 'no radio')
    expect(seen).toHaveLength(before + 1)
    expect((seen.at(-1) as Record<string, unknown>).terminal).toEqual({ state: 'failed', reason: 'no radio' })
    ready.features.problem('terminal', 'no radio')
    expect(seen).toHaveLength(before + 1)
    ready.settings.set({ features: { terminal: false } })
    await ready.features.idle()
    expect('terminal' in (seen.at(-1) as Record<string, unknown>)).toBe(false)
  })
})

describe('featureProblem 매핑 — 묶음이 알리는 문제', () => {
  it('블루투스 라디오: 광고·켜는 중은 문제가 아니고, 꺼짐·권한·미지원·실패는 문제다', () => {
    expect(bluetoothProblem(undefined)).toBeUndefined()
    expect(bluetoothProblem({ state: 'starting', links: 0 })).toBeUndefined()
    expect(bluetoothProblem({ state: 'advertising', links: 1 })).toBeUndefined()
    expect(bluetoothProblem({ state: 'poweredOff', links: 0 })).toEqual({ key: 'remote.bluetooth.poweredOff' })
    expect(bluetoothProblem({ state: 'unauthorized', links: 0 })).toEqual({ key: 'remote.bluetooth.unauthorized' })
    expect(bluetoothProblem({ state: 'unsupported', links: 0 })).toEqual({ key: 'remote.bluetooth.unsupported' })
    expect(bluetoothProblem({ state: 'unsupported', reason: 'no prebuild', links: 0 })).toEqual({ key: 'remote.bluetooth.unsupportedReason', vars: { reason: 'no prebuild' } })
    expect(bluetoothProblem({ state: 'failed', reason: 'key', links: 0 })).toEqual({ key: 'remote.bluetooth.failed', vars: { reason: 'key' } })
  })

  it('음성: 확인 중·준비됨·뜨는 중은 문제가 아니고, 엔진·모델 파일이 없거나 손상되면 문제다', () => {
    expect(speechProblem({ state: 'unavailable', reason: 'checking', language: 'ko' })).toBeUndefined()
    expect(speechProblem({ state: 'ready', language: 'ko' })).toBeUndefined()
    expect(speechProblem({ state: 'starting', language: 'ko' })).toBeUndefined()
    expect(speechProblem({ state: 'unavailable', reason: 'missing', language: 'ko' })).toEqual({ key: 'speech.error.unavailable' })
    expect(speechProblem({ state: 'unavailable', reason: 'mismatch', language: 'ko' })).toEqual({ key: 'speech.error.unavailable' })
  })
})

describe('featureOn', () => {
  it('고정된 기능은 고정 값, 고르는 기능은 없는 키면 기본값(알림만 꺼짐)', () => {
    expect(featureOn(undefined, 'web')).toBe(false)
    expect(featureOn({ web: true }, 'web')).toBe(true)
    expect(featureOn({ at: false }, 'at')).toBe(true)
    expect(featureOn({ shell: false }, 'bang')).toBe(true)
    expect(featureOn(undefined, 'notifications')).toBe(false)
    expect(featureOn({ notifications: true }, 'notifications')).toBe(true)
    expect(featureOn({}, 'terminal')).toBe(true)
    expect(featureOn({ terminal: false }, 'terminal')).toBe(false)
    expect(CHOOSABLE_FEATURES).toEqual(['terminal', 'trajectory', 'notifications', 'openIn', 'web', 'remote', 'lan', 'bluetooth', 'appMcp', 'hooks', 'voice', 'browser'])
    expect(featureOn(undefined, 'voice')).toBe(false) // 음성 입력은 기본 꺼짐 — 마이크 권한을 묻는 기능
    expect(featureOn({ voice: true }, 'voice')).toBe(true)
    expect(featureOn(undefined, 'hooks')).toBe(false) // 훅은 기본 꺼짐 (이슈 #102)
    expect(featureOn({ hooks: true }, 'hooks')).toBe(true)
    expect(featureOn(undefined, 'remote')).toBe(false)
    expect(featureOn({ remote: true }, 'remote')).toBe(true)
    // 모바일 연결의 길 (이슈 #210) — 사내망은 모바일 연결을 켜면 같이 켜지고(끌 수 있다), 블루투스는 따로 켜야 한다. 둘 다 모바일 연결이 꺼지면 꺼진다
    expect(featureOn(undefined, 'lan')).toBe(false)
    expect(featureOn({ remote: true }, 'lan')).toBe(true)
    expect(featureOn({ remote: true, lan: false }, 'lan')).toBe(false)
    expect(featureOn({ remote: true }, 'bluetooth')).toBe(false)
    expect(featureOn({ remote: true, bluetooth: true }, 'bluetooth')).toBe(true)
    expect(featureOn({ bluetooth: true }, 'bluetooth')).toBe(false)
  })
})

describe('settings.features', () => {
  it('없는 기능 이름·불린 아닌 값은 거절한다', async () => {
    const { settings } = await start()
    expect(() => settings.set({ features: { nope: false } as never })).toThrow()
    expect(() => settings.set({ features: { at: 'off' } as never })).toThrow()
    expect(() => settings.set({ features: [] as never })).toThrow()
  })

  it('손으로 잘못 고친 값은 그 값만 기본(웹 도구 말고 모두 켜짐)으로', async () => {
    await fs.writeFile(file, JSON.stringify({ language: 'ko', features: { at: 'no' } }))
    const { settings, features } = await start()
    expect(settings.get().language).toBe('ko')
    expect(settings.get().features).toBeUndefined()
    expect(features.enabled()).toEqual(DEFAULT_ON)
  })
})

describe('FEATURE_GROUPS — 설정 > 기능의 중분류', () => {
  it('고르는 기능을 빠짐없이 한 번씩 담는다 — 새 기능을 더하면 묶음에도 넣어야 한다', () => {
    const grouped = FEATURE_GROUPS.flatMap((group) => group.features)
    expect([...grouped].sort()).toEqual([...CHOOSABLE_FEATURES].sort())
    expect(new Set(grouped).size).toBe(grouped.length)
  })
})
