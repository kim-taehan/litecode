import { Context } from 'cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SettingsService } from '../../src/services/settings.ts'
import { FeaturesService } from '../../src/services/features.ts'
import { UpdatesService, type UpdatesOptions, type UpdateStatus } from '../../src/services/updates.ts'
import { DEFAULT_UPDATE_URL, compareVersions, isUpdateUrl, judgeRelease, parseVersion, releaseUrlAllowed, updateUrlOf } from '../../shared/updates.ts'
import { showUpdateNotice, updateResult } from '../../renderer/updates.ts'

// 새 버전 알림 (기능 `updates`, 이슈 #273) — 알림만. 기능이 꺼져 있으면 바깥 요청 0, 개발 실행은 묻지 않는다,
// 오류·모양이 다른 답은 던지지 않고 failed, [내려받기] 는 https · github.com 또는 확인 주소의 호스트만

const RELEASE = { tag_name: 'v0.1.3', html_url: 'https://github.com/kim-taehan/litecode/releases/tag/v0.1.3', draft: false, prerelease: false }

describe('버전 비교 (순수)', () => {
  it('v 머리는 있어도 없어도 된다, 꼬리표·다른 모양은 못 읽는다', () => {
    expect(parseVersion('v0.1.3')).toEqual([0, 1, 3])
    expect(parseVersion('10.20.30')).toEqual([10, 20, 30])
    expect(parseVersion('v0.1.3-beta')).toBeUndefined()
    expect(parseVersion('nightly')).toBeUndefined()
    expect(parseVersion('1.2')).toBeUndefined()
  })

  it('메이저 → 마이너 → 패치 순 숫자 비교 (글자 비교가 아니다)', () => {
    expect(compareVersions('v0.1.3', '0.1.2')).toBeGreaterThan(0)
    expect(compareVersions('v0.1.2', '0.1.2')).toBe(0)
    expect(compareVersions('v0.1.10', '0.1.9')).toBeGreaterThan(0)
    expect(compareVersions('v0.2.0', '0.1.99')).toBeGreaterThan(0)
    expect(compareVersions('v1.0.0', '0.99.99')).toBeGreaterThan(0)
    expect(compareVersions('v0.1.2', '0.1.3')).toBeLessThan(0)
    expect(compareVersions('vX', '0.1.3')).toBeUndefined()
  })
})

describe('judgeRelease (순수)', () => {
  it('새것이면 available + 태그 + 페이지, 같거나 낡았으면 up-to-date', () => {
    expect(judgeRelease(RELEASE, '0.1.2')).toEqual({ state: 'available', latest: 'v0.1.3', url: RELEASE.html_url })
    expect(judgeRelease(RELEASE, '0.1.3')).toEqual({ state: 'up-to-date', latest: 'v0.1.3' })
    expect(judgeRelease(RELEASE, '0.2.0')).toEqual({ state: 'up-to-date', latest: 'v0.1.3' })
  })

  it('draft·prerelease 는 무시한다 — 새 버전으로 보지 않는다', () => {
    expect(judgeRelease({ ...RELEASE, draft: true }, '0.1.2').state).toBe('up-to-date')
    expect(judgeRelease({ ...RELEASE, prerelease: true }, '0.1.2').state).toBe('up-to-date')
  })

  it('모양이 다른 답은 failed', () => {
    for (const body of [null, 'text', [], {}, { tag_name: 'v0.1.3' }, { html_url: RELEASE.html_url }, { ...RELEASE, tag_name: 'nightly' }, { ...RELEASE, tag_name: 3 }]) {
      expect(judgeRelease(body, '0.1.2')).toEqual({ state: 'failed' })
    }
  })
})

describe('주소 (순수)', () => {
  it('확인 주소 — 비었거나 공백이면 기본값', () => {
    expect(updateUrlOf({})).toBe(DEFAULT_UPDATE_URL)
    expect(updateUrlOf({ updateUrl: '  ' })).toBe(DEFAULT_UPDATE_URL)
    expect(updateUrlOf({ updateUrl: 'https://mirror.corp/latest' })).toBe('https://mirror.corp/latest')
    expect(DEFAULT_UPDATE_URL).toBe('https://api.github.com/repos/kim-taehan/litecode/releases/latest')
  })

  it('설정에 넣을 수 있는 주소 — 빈 글 또는 http(s)', () => {
    expect(isUpdateUrl('')).toBe(true)
    expect(isUpdateUrl('https://mirror.corp/latest')).toBe(true)
    expect(isUpdateUrl('http://mirror.corp/latest')).toBe(true)
    expect(isUpdateUrl('file:///etc/passwd')).toBe(false)
    expect(isUpdateUrl('not a url')).toBe(false)
    expect(isUpdateUrl(3)).toBe(false)
  })

  it('[내려받기] 허용 — https 이고 github.com 이거나 확인 주소의 호스트만', () => {
    expect(releaseUrlAllowed(RELEASE.html_url, DEFAULT_UPDATE_URL)).toBe(true)
    expect(releaseUrlAllowed('https://mirror.corp/releases/v0.1.3', 'https://mirror.corp/api/latest')).toBe(true)
    expect(releaseUrlAllowed('https://mirror.corp/releases/v0.1.3', DEFAULT_UPDATE_URL)).toBe(false)
    expect(releaseUrlAllowed('https://evil.example/x', DEFAULT_UPDATE_URL)).toBe(false)
    expect(releaseUrlAllowed('https://github.com.evil.example/x', DEFAULT_UPDATE_URL)).toBe(false)
    expect(releaseUrlAllowed('http://github.com/kim-taehan/litecode', DEFAULT_UPDATE_URL)).toBe(false)
    expect(releaseUrlAllowed('javascript:alert(1)', DEFAULT_UPDATE_URL)).toBe(false)
    expect(releaseUrlAllowed('file:///Applications', DEFAULT_UPDATE_URL)).toBe(false)
    expect(releaseUrlAllowed('not a url', DEFAULT_UPDATE_URL)).toBe(false)
    expect(releaseUrlAllowed(undefined, DEFAULT_UPDATE_URL)).toBe(false)
  })
})

// ── 서비스

const fibers: { dispose(): Promise<unknown> | undefined }[] = []
afterEach(async () => {
  for (const fiber of fibers.splice(0).reverse()) await Promise.resolve(fiber.dispose()).catch(() => {}) // 이미 내린 fiber 는 undefined 를 준다
})

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

/** 가짜 fetch — 부른 주소를 적는다 */
function fakeFetch(reply: (url: string, init?: RequestInit) => Promise<Response> | Response = () => json(RELEASE)) {
  const calls: string[] = []
  const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push(String(url))
    return reply(String(url), init)
  }) as unknown as typeof fetch
  return { fn, calls }
}

async function start(options: Partial<UpdatesOptions> = {}, settings: { updateUrl?: string } = {}) {
  const ctx = new Context()
  const seen: UpdateStatus[] = []
  ctx.on('updates/changed', (status) => void seen.push(status))
  const opened: string[] = []
  fibers.push(ctx.plugin(SettingsService, { defaults: settings }))
  const fiber = ctx.plugin(UpdatesService, {
    currentVersion: '0.1.2',
    packaged: true,
    delayMs: 60_000,
    open: async (url: string) => void opened.push(url),
    ...options,
  })
  fibers.push(fiber)
  const ready = await new Promise<Context>((resolve) => ctx.inject(['updates', 'settings'], resolve))
  return { updates: ready.updates, settings: ready.settings, seen, opened, fiber }
}

describe('UpdatesService', () => {
  it('지금 확인 — idle → checking → available, 상태마다 알린다. 주소는 기본값', async () => {
    const { fn, calls } = fakeFetch()
    const { updates, seen } = await start({ fetch: fn })
    expect(updates.status()).toEqual({ state: 'idle' })
    const done = await updates.check()
    expect(calls).toEqual([DEFAULT_UPDATE_URL])
    expect(done).toMatchObject({ state: 'available', latest: 'v0.1.3', url: RELEASE.html_url })
    expect(typeof done.checkedAt).toBe('number')
    expect(seen.map((status) => status.state)).toEqual(['checking', 'available'])
    expect(updates.status()).toEqual(done)
  })

  it('최신이면 up-to-date', async () => {
    const { fn } = fakeFetch(() => json({ ...RELEASE, tag_name: 'v0.1.2' }))
    const { updates } = await start({ fetch: fn })
    expect(await updates.check()).toMatchObject({ state: 'up-to-date', latest: 'v0.1.2' })
  })

  it('설정의 확인 주소가 있으면 그것에 묻는다', async () => {
    const { fn, calls } = fakeFetch()
    const { updates } = await start({ fetch: fn }, { updateUrl: 'https://mirror.corp/latest' })
    await updates.check()
    expect(calls).toEqual(['https://mirror.corp/latest'])
  })

  it('앱 시작 뒤 delay 가 지나면 한 번 묻는다', async () => {
    const { fn, calls } = fakeFetch()
    const { updates } = await start({ fetch: fn, delayMs: 10 })
    expect(calls).toHaveLength(0)
    await wait(60)
    expect(calls).toHaveLength(1)
    expect(updates.status().state).toBe('available')
  })

  it('개발 실행(설치본 아님)은 묻지 않는다 — 시작 뒤에도, 지금 확인에도', async () => {
    const { fn, calls } = fakeFetch()
    const { updates, seen } = await start({ fetch: fn, packaged: false, delayMs: 5 })
    await wait(40)
    expect(await updates.check()).toEqual({ state: 'idle' })
    expect(calls).toHaveLength(0)
    expect(seen).toEqual([])
  })

  it('내리면 기다리던 확인이 취소된다 — 묻지 않는다', async () => {
    const { fn, calls } = fakeFetch()
    const { fiber } = await start({ fetch: fn, delayMs: 20 })
    await fiber.dispose()
    await wait(60)
    expect(calls).toHaveLength(0)
  })

  it('동시에 누른 확인은 요청 하나를 같이 기다린다', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    const { fn, calls } = fakeFetch(async () => {
      await gate
      return json(RELEASE)
    })
    const { updates } = await start({ fetch: fn })
    const a = updates.check()
    const b = updates.check()
    release()
    expect(await a).toEqual(await b)
    expect(calls).toHaveLength(1)
  })

  it('네트워크 오류·4xx·5xx·JSON 아님·모양이 다른 답은 던지지 않고 failed', async () => {
    const replies: (() => Response | Promise<Response>)[] = [
      () => Promise.reject(new TypeError('fetch failed')),
      () => json({ message: 'Not Found' }, 404),
      () => json({ message: 'rate limited' }, 403),
      () => json({}, 500),
      () => new Response('<html>', { status: 200 }),
      () => json({ unexpected: true }),
      () => json([RELEASE]),
    ]
    for (const reply of replies) {
      const { fn } = fakeFetch(reply)
      const { updates } = await start({ fetch: fn })
      await expect(updates.check()).resolves.toMatchObject({ state: 'failed' })
    }
  })

  it('시간이 넘으면 failed', async () => {
    const { fn } = fakeFetch((_url, init) => new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal!.reason))))
    const { updates } = await start({ fetch: fn, timeoutMs: 20 })
    await expect(updates.check()).resolves.toMatchObject({ state: 'failed' })
  })

  it('http(s) 가 아닌 확인 주소는 묻지 않고 failed', async () => {
    const { fn, calls } = fakeFetch()
    const { updates } = await start({ fetch: fn })
    // 설정 검증을 지나온 값만 오지만, 손으로 고친 파일의 값을 흉내 낸다
    ;(updates as unknown as { ctx: Context }).ctx.settings.get = () => ({ updateUrl: 'file:///etc/passwd' }) as never
    await expect(updates.check()).resolves.toMatchObject({ state: 'failed' })
    expect(calls).toHaveLength(0)
  })

  it('[내려받기] — 허용 주소만 연다', async () => {
    const { updates, opened } = await start({ fetch: fakeFetch().fn })
    expect(await updates.openRelease(RELEASE.html_url)).toBe(true)
    expect(await updates.openRelease('javascript:alert(1)')).toBe(false)
    expect(await updates.openRelease('https://evil.example/x')).toBe(false)
    expect(await updates.openRelease(42)).toBe(false)
    expect(opened).toEqual([RELEASE.html_url])
  })

  it('설정 — updateUrl 은 빈 글 또는 http(s), dismissedUpdate 는 글', async () => {
    const { settings } = await start({ fetch: fakeFetch().fn })
    expect(settings.set({ updateUrl: '' }).updateUrl).toBe('')
    expect(settings.set({ updateUrl: 'https://mirror.corp/latest' }).updateUrl).toBe('https://mirror.corp/latest')
    expect(() => settings.set({ updateUrl: 'javascript:alert(1)' })).toThrow()
    expect(settings.set({ dismissedUpdate: 'v0.1.3' }).dismissedUpdate).toBe('v0.1.3')
  })
})

describe('기능 묶음 updates — 꺼져 있으면 바깥 요청 0', () => {
  it('기본(꺼짐)이면 서비스가 없고 묻지 않는다 — 켜면 그때 묻는다', async () => {
    const { fn, calls } = fakeFetch()
    const ctx = new Context()
    fibers.push(ctx.plugin(SettingsService, {}))
    fibers.push(
      ctx.plugin(FeaturesService, [
        { id: 'updates', service: 'updates', plugin: (inner: Context) => void inner.plugin(UpdatesService, { currentVersion: '0.1.2', packaged: true, delayMs: 5, fetch: fn, open: async () => {} }) },
      ]),
    )
    const ready = await new Promise<Context>((resolve) => ctx.inject(['settings', 'features'], resolve))
    await ready.features.idle()
    await wait(40)
    expect(ready.features.isEnabled('updates')).toBe(false)
    expect(ctx.get('updates')).toBeUndefined()
    expect(calls).toHaveLength(0)

    ready.settings.set({ features: { updates: true } })
    await ready.features.idle()
    await wait(40)
    expect(calls).toEqual([DEFAULT_UPDATE_URL])
  })
})

describe('화면 — 결과 한 줄과 사이드바 알림 (순수)', () => {
  it('결과 한 줄 — 아직 안 물었으면 없다', () => {
    expect(updateResult({ state: 'idle' })).toBeUndefined()
    expect(updateResult({ state: 'checking' })).toEqual({ key: 'settings.updateCheck.checking' })
    expect(updateResult({ state: 'up-to-date', latest: 'v0.1.2' })).toEqual({ key: 'settings.updateCheck.upToDate', vars: { version: 'v0.1.2' } })
    expect(updateResult({ state: 'available', latest: 'v0.1.3', url: RELEASE.html_url })).toEqual({ key: 'settings.updateCheck.available', vars: { version: 'v0.1.3' } })
    expect(updateResult({ state: 'failed' })).toEqual({ key: 'settings.updateCheck.failed' })
  })

  it('알림은 새 버전이 있고 그 버전을 닫은 적이 없을 때만', () => {
    const available: UpdateStatus = { state: 'available', latest: 'v0.1.3', url: RELEASE.html_url }
    expect(showUpdateNotice(available, undefined)).toBe(true)
    expect(showUpdateNotice(available, 'v0.1.2')).toBe(true)
    expect(showUpdateNotice(available, 'v0.1.3')).toBe(false)
    expect(showUpdateNotice({ state: 'up-to-date', latest: 'v0.1.3' }, undefined)).toBe(false)
    expect(showUpdateNotice({ state: 'failed' }, undefined)).toBe(false)
  })
})
