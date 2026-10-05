import { Context, Service } from 'cordis'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SettingsService } from '../../src/services/settings.ts'
import { FeaturesService, type FeatureDefinition } from '../../src/services/features.ts'
import { CHOOSABLE_FEATURES, FEATURES, featureOn, type FeatureId } from '../../shared/features.ts'

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

/** 기본 켜짐인 기능 — 웹 도구(web)는 늘 꺼짐(고정), 알림·모바일 연결(remote)·훅(hooks, 이슈 #102)·음성 입력(voice)은 고르는 기능 중 기본 꺼짐 (사용자 결정 2026-10-03, 이슈 #56) */
const DEFAULT_ON = FEATURES.filter((feature) => feature !== 'web' && feature !== 'notifications' && feature !== 'remote' && feature !== 'hooks' && feature !== 'voice')
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

async function start(): Promise<{ ctx: Context; settings: SettingsService; features: FeaturesService; seen: FeatureId[][]; fiber: { dispose(): Promise<void> } }> {
  const ctx = new Context()
  const seen: FeatureId[][] = []
  ctx.on('features/changed', (enabled) => void seen.push(enabled))
  ctx.plugin(SettingsService, { file })
  const fiber = ctx.plugin(FeaturesService, definitions())
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

  it('레지스트리를 내리면 켜진 묶음이 다 내려간다 (앱 종료)', async () => {
    const { fiber } = await start()
    await fiber.dispose()
    expect(channels()).toEqual([])
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
    expect(CHOOSABLE_FEATURES).toEqual(['terminal', 'trajectory', 'notifications', 'openIn', 'web', 'remote', 'appMcp', 'hooks', 'voice'])
    expect(featureOn(undefined, 'voice')).toBe(false) // 음성 입력은 기본 꺼짐 — 마이크 권한을 묻는 기능
    expect(featureOn({ voice: true }, 'voice')).toBe(true)
    expect(featureOn(undefined, 'hooks')).toBe(false) // 훅은 기본 꺼짐 (이슈 #102)
    expect(featureOn({ hooks: true }, 'hooks')).toBe(true)
    expect(featureOn(undefined, 'remote')).toBe(false)
    expect(featureOn({ remote: true }, 'remote')).toBe(true)
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
