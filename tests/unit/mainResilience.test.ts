import { Context, Service } from 'cordis'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { allowPermission, grantPermission, missingServices, reloadGuard, withDeadline } from '../../electron/resilience.ts'
import { restorableBounds, windowMode } from '../../electron/windowBounds.ts'
import { readJsonFile, readJsonFileSync, writeJsonFileSync } from '../../src/services/jsonFile.ts'
import { captureConsole, createLogFile, redactSecrets } from '../../src/services/logFile.ts'
import { keepEnds, keepTail, streamText } from '../../src/services/outputBuffer.ts'
import { DeviceStore } from '../../src/services/remote/devices.ts'

// 참고 레포 검토(02x)에서 나온 메인 프로세스 쪽 살림 — 깨진 파일 보호·로그 파일·부팅 진단·종료 기한·출력 모으기·권한·창 자리.
// 실제 창·종료·권한 핸들러를 거는 곳(electron/main.ts)은 단위 테스트가 못 닿는다 — 여기는 그 판단을 하는 순수 함수들이다

/** 이 파일이 만든 임시 폴더 — 끝나면 이 경로만 지운다 */
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'litecode-resilience-')))
afterAll(() => fs.rmSync(root, { recursive: true, force: true }))
let serial = 0
const folder = (): string => {
  const dir = path.join(root, String(serial++))
  fs.mkdirSync(dir)
  return dir
}
const at = new Date('2026-10-05T01:02:03.456Z')

describe('jsonFile — userData JSON 읽기', () => {
  it('없으면 undefined (옮기는 것 없음), 멀쩡하면 값', async () => {
    const dir = folder()
    const file = path.join(dir, 'a.json')
    expect(readJsonFileSync(file, 'object')).toBeUndefined()
    expect(await readJsonFile(file, 'object')).toBeUndefined()
    writeJsonFileSync(file, { a: 1 })
    expect(readJsonFileSync(file, 'object')).toEqual({ a: 1 })
    expect(await readJsonFile(file, 'object')).toEqual({ a: 1 })
    expect(fs.readdirSync(dir)).toEqual(['a.json'])
  })

  it.each([
    ['JSON 이 아니다', '{ 깨짐', 'object' as const],
    ['빈 파일(쓰다 죽음)', '', 'object' as const],
    ['맨 위가 배열인데 객체를 기대', '[1]', 'object' as const],
    ['맨 위가 객체인데 배열을 기대', '{"a":1}', 'array' as const],
    ['null', 'null', 'object' as const],
  ])('깨진 파일(%s)은 <이름>.corrupt-<시각> 으로 옮기고 undefined — 동기·비동기 둘 다', async (_label, raw, shape) => {
    for (const read of [readJsonFileSync, readJsonFile]) {
      const dir = folder()
      const file = path.join(dir, 'a.json')
      fs.writeFileSync(file, raw)
      expect(await read(file, shape, () => at)).toBeUndefined()
      expect(fs.readdirSync(dir)).toEqual(['a.json.corrupt-2026-10-05T01-02-03-456Z'])
      expect(fs.readFileSync(path.join(dir, 'a.json.corrupt-2026-10-05T01-02-03-456Z'), 'utf8')).toBe(raw)
    }
  })

  it('깨진 파일의 내용을 경고에 싣지 않는다 (비밀 파일일 수 있다)', () => {
    const file = path.join(folder(), 'keys.json')
    fs.writeFileSync(file, '{"gw":"c2VjcmV0LXZhbHVl')
    const warned: string[] = []
    const original = console.warn
    console.warn = (...args: unknown[]) => void warned.push(args.join(' '))
    try {
      readJsonFileSync(file, 'object')
    } finally {
      console.warn = original
    }
    expect(warned).toHaveLength(1)
    expect(warned[0]).toContain('keys.json')
    expect(warned[0]).not.toContain('c2VjcmV0')
  })

  it('모바일 기기 목록(remote-devices.json)도 깨지면 옮겨 두고 빈 목록으로 뜬다 — 다음 쓰기가 원본을 덮지 않는다', async () => {
    const dir = folder()
    const file = path.join(dir, 'remote-devices.json')
    fs.writeFileSync(file, '{"version":1,"devices":[{"id":"dev_1"')
    const store = new DeviceStore(file)
    await store.load()
    await store.setEnabled(true)
    await store.idle()
    const backup = fs.readdirSync(dir).find((name) => name.startsWith('remote-devices.json.corrupt-'))
    expect(fs.readFileSync(path.join(dir, backup ?? 'missing'), 'utf8')).toBe('{"version":1,"devices":[{"id":"dev_1"')
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toMatchObject({ enabled: true, devices: [] })
  })
})

describe('logFile — 메인 로그 파일', () => {
  it('시각·수준·글을 한 줄로 덧붙인다 — 오류는 스택까지', () => {
    const dir = path.join(folder(), 'logs')
    const log = createLogFile(dir, { now: () => at })
    log.write('error', ['[engine] 재시작 실패', new Error('포트를 못 잡았다')])
    log.write('warn', ['값 %d', 3])
    const lines = fs.readFileSync(log.path, 'utf8')
    expect(log.path).toBe(path.join(dir, 'main.log'))
    expect(lines).toContain('2026-10-05T01:02:03.456Z ERROR [engine] 재시작 실패 Error: 포트를 못 잡았다\n    at ')
    expect(lines.endsWith('2026-10-05T01:02:03.456Z WARN 값 3\n')).toBe(true)
  })

  it('크기 상한을 넘으면 main.1.log → main.2.log 로 밀고, 파일 수 상한을 넘는 것은 지운다', () => {
    const dir = folder()
    const log = createLogFile(dir, { maxBytes: 100, files: 3, now: () => at })
    for (const tag of ['a', 'b', 'c', 'd']) log.write('error', [tag.repeat(60)]) // 한 줄이 상한의 절반을 넘는다 → 줄마다 돈다
    expect(fs.readdirSync(dir).sort()).toEqual(['main.1.log', 'main.2.log', 'main.log'])
    expect(fs.readFileSync(path.join(dir, 'main.log'), 'utf8')).toContain('d'.repeat(60))
    expect(fs.readFileSync(path.join(dir, 'main.1.log'), 'utf8')).toContain('c'.repeat(60))
    expect(fs.readFileSync(path.join(dir, 'main.2.log'), 'utf8')).toContain('b'.repeat(60))
  })

  it('이전 실행이 남긴 파일 크기에서 이어 센다', () => {
    const dir = folder()
    fs.writeFileSync(path.join(dir, 'main.log'), 'x'.repeat(90))
    createLogFile(dir, { maxBytes: 100, now: () => at }).write('warn', ['다음 실행'])
    expect(fs.readFileSync(path.join(dir, 'main.1.log'), 'utf8')).toBe('x'.repeat(90))
    expect(fs.readFileSync(path.join(dir, 'main.log'), 'utf8')).toContain('다음 실행')
  })

  it('못 써도 던지지 않는다 (폴더 자리에 파일이 있다)', () => {
    const blocked = path.join(folder(), 'logs')
    fs.writeFileSync(blocked, '')
    expect(() => createLogFile(blocked).write('error', ['x'])).not.toThrow()
  })

  it('비밀을 가린다 — Authorization·Bearer/Basic 값·키 모양·주소 안 비밀번호·이름=값', () => {
    expect(redactSecrets('authorization: Bearer abcdefghijkl.mnop')).toBe('authorization: Bearer [redacted]')
    expect(redactSecrets('{"authorization":"Basic b3BlbmNvZGU6cGFzcw=="}')).toBe('{"authorization":"Basic [redacted]"}')
    expect(redactSecrets('key sk-live_1234567890abcdef 로 요청')).toBe('key sk-[redacted] 로 요청')
    expect(redactSecrets('OPENCODE_SERVER_PASSWORD=Zm9vYmFy next')).toBe('OPENCODE_SERVER_PASSWORD=[redacted] next')
    expect(redactSecrets('x-api-key: 0123456789')).toBe('x-api-key: [redacted]')
    expect(redactSecrets('http://user:hunter2@gw.local/v1?token=abcdef12')).toBe('http://user:[redacted]@gw.local/v1?token=[redacted]')
    expect(redactSecrets('tokens: 1234, 포트 127.0.0.1:8080 에서 실패 (HTTP 500)')).toBe('tokens: 1234, 포트 127.0.0.1:8080 에서 실패 (HTTP 500)')
  })

  it('파일에 쓰는 줄도 가려진다', () => {
    const log = createLogFile(folder(), { now: () => at })
    log.write('error', ['요청 실패', { headers: { authorization: 'Bearer real-secret-key-value' } }])
    expect(fs.readFileSync(log.path, 'utf8')).not.toContain('real-secret-key-value')
  })

  it('captureConsole — error·warn 이 원래 출력과 파일 둘 다에 남고, 되돌릴 수 있다', () => {
    const log = createLogFile(folder(), { now: () => at })
    const printed: string[] = []
    const target = { error: (...args: unknown[]) => void printed.push(`E ${args.join(' ')}`), warn: (...args: unknown[]) => void printed.push(`W ${args.join(' ')}`) }
    const restore = captureConsole(log, target)
    target.error('[quit] 정리 실패')
    target.warn('[engine] 표식을 못 뒀다')
    restore()
    target.error('되돌린 뒤')
    expect(printed).toEqual(['E [quit] 정리 실패', 'W [engine] 표식을 못 뒀다', 'E 되돌린 뒤'])
    const lines = fs.readFileSync(log.path, 'utf8')
    expect(lines).toContain('ERROR [quit] 정리 실패\n')
    expect(lines).toContain('WARN [engine] 표식을 못 뒀다\n')
    expect(lines).not.toContain('되돌린 뒤')
  })
})

describe('outputBuffer — 자식 프로세스 출력 모으기', () => {
  it('streamText: 조각 경계에 걸린 여러 바이트 글자를 다음 조각과 이어 푼다', () => {
    const bytes = Buffer.from('가나')
    const text = streamText()
    expect(text.push(bytes.subarray(0, 2))).toBe('')
    expect(text.push(bytes.subarray(2, 4))).toBe('가')
    expect(text.push(bytes.subarray(4))).toBe('나')
    expect(text.end()).toBe('')
  })

  it('keepTail: 끝 N자만 남긴다', () => {
    const tail = keepTail(5)
    tail.push('시작 로그 ')
    tail.push('error: 끝')
    expect(tail.text()).toBe('or: 끝')
  })

  it('keepEnds: 상한 안쪽이면 전부, 넘으면 앞·끝만 남기고 버린 글자 수를 센다', () => {
    const small = keepEnds(4, 4)
    small.push('abc')
    small.push('defgh')
    expect([small.head(), small.tail(), small.omitted()]).toEqual(['abcd', 'efgh', 0])

    const big = keepEnds(4, 4)
    for (const part of ['ab', 'cdef', 'ghij', 'klmn']) big.push(part)
    expect([big.head(), big.tail(), big.omitted()]).toEqual(['abcd', 'klmn', 6])
  })

  it('keepEnds·keepTail: 자른 자리가 대리쌍(이모지) 한가운데면 반쪽을 버린다', () => {
    const ends = keepEnds(3, 2)
    ends.push('ab😀cdefg😀h') // 앞 3 = 'ab' + 앞 반쪽, 끝 2 = 뒤 반쪽 + 'h'
    expect(ends.head()).toBe('ab')
    expect(ends.tail()).toBe('h')
    const tail = keepTail(2)
    tail.push('a😀b')
    expect(tail.text()).toBe('b')
  })
})

describe('부팅 진단 — 안 뜬 서비스 이름', () => {
  it('진짜 Cordis 컨텍스트에서: 뜬 서비스는 빼고 안 뜬 것만 — 그것을 inject 한 플러그인은 돌지 않은 채다', async () => {
    class Ready extends Service {
      constructor(ctx: Context) {
        super(ctx, 'readyOne' as never)
      }
    }
    const ctx = new Context()
    ctx.plugin(Ready)
    let booted = false
    const boot = (): void => {
      booted = true
    }
    boot.inject = ['readyOne', 'neverComes']
    ctx.plugin(boot)
    await new Promise<void>((resolve) => ctx.inject(['readyOne'], () => resolve()))

    expect(missingServices(boot.inject, (name) => ctx.get(name))).toEqual(['neverComes'])
    expect(booted).toBe(false)
  })
})

describe('렌더러가 죽었을 때 다시 불러오기', () => {
  it('짧은 시간 안에 정해진 횟수까지만 — 넘으면 멈추고, 시간이 지나면 다시 된다', () => {
    let now = 0
    const guard = reloadGuard({ max: 3, withinMs: 60_000, now: () => now })
    expect([guard.allow(), guard.allow(), guard.allow()]).toEqual([true, true, true])
    expect(guard.allow()).toBe(false)
    now = 59_999
    expect(guard.allow()).toBe(false)
    now = 60_000 // 처음 셋이 창 밖으로 나갔다
    expect(guard.allow()).toBe(true)
  })
})

describe('종료 정리 기한', () => {
  it('기한 안에 끝나면 done (실패로 끝나도), 안 끝나면 timeout — 던지지 않는다', async () => {
    expect(await withDeadline(Promise.resolve(), 1_000)).toBe('done')
    expect(await withDeadline(Promise.reject(new Error('정리 실패')), 1_000)).toBe('done')
    expect(await withDeadline(new Promise(() => {}), 20)).toBe('timeout')
  })
})

describe('권한 요청 — 기본 거부', () => {
  it('앱 화면(맨 위 프레임)의 클립보드 쓰기만 허용한다', () => {
    expect(allowPermission('clipboard-sanitized-write', true)).toBe(true)
    expect(allowPermission('clipboard-sanitized-write', false)).toBe(false) // 미리보기 iframe
    for (const permission of ['clipboard-read', 'media', 'geolocation', 'notifications', 'midi', 'openExternal', 'fullscreen', 'display-capture', 'unknown']) {
      expect(allowPermission(permission, true), permission).toBe(false)
    }
  })

  // 음성 입력(기능 voice) — 요청·검사 핸들러에 오는 모양은 실측 _workspace/01ag_voice_input.md §2.3
  it('마이크는 음성 입력이 켜져 있고 · 맨 위 프레임이고 · 달라는 것이 정확히 소리 하나일 때만', () => {
    const voice = true
    expect(allowPermission('media', true, { voice, mediaTypes: ['audio'] })).toBe(true)
    const denied: [string, boolean, { voice: boolean; mediaTypes?: string[] } | undefined][] = [
      ['media', true, { voice: false, mediaTypes: ['audio'] }], // 기능이 꺼져 있다
      ['media', false, { voice, mediaTypes: ['audio'] }], // 미리보기 iframe
      ['media', true, { voice, mediaTypes: ['video'] }], // 카메라
      ['media', true, { voice, mediaTypes: ['audio', 'video'] }], // 카메라가 끼었다
      ['media', true, { voice, mediaTypes: ['audio', 'audio'] }],
      ['media', true, { voice, mediaTypes: [] }],
      ['media', true, { voice }], // 종류를 모른다
      ['media', true, undefined],
      ['display-capture', true, { voice, mediaTypes: ['audio'] }],
      ['speaker-selection', true, { voice, mediaTypes: ['audio'] }],
      ['mediaKeySystem', true, { voice, mediaTypes: ['audio'] }],
    ]
    for (const [permission, isMainFrame, media] of denied) expect(allowPermission(permission, isMainFrame, media), JSON.stringify([permission, isMainFrame, media])).toBe(false)
    // 기능이 켜져 있어도 나머지 규칙은 그대로다
    expect(allowPermission('clipboard-sanitized-write', true, { voice })).toBe(true)
    expect(allowPermission('clipboard-read', true, { voice, mediaTypes: ['audio'] })).toBe(false)
  })

  it('검사 핸들러 — 종류가 audio 로 온 검사만 허용하고, getUserMedia 직전처럼 종류 없이 온 검사는 거절한다 (거절해도 요청 핸들러가 불린다 — 실측)', () => {
    /** main.ts 가 검사 핸들러의 details.mediaType(하나, 없을 수 있다)을 넘기는 방식 */
    const check = (mediaType: string | undefined, voice = true): boolean => allowPermission('media', true, { voice, mediaTypes: mediaType ? [mediaType] : undefined })
    expect(check('audio')).toBe(true)
    expect(check(undefined)).toBe(false)
    expect(check('video')).toBe(false)
    expect(check('unknown')).toBe(false)
    expect(check('audio', false)).toBe(false)
  })

  it('요청 핸들러 — macOS 는 OS 마이크 허락까지 받아야 허용이고, 규칙에서 거절된 요청은 OS 에 묻지도 않는다', async () => {
    const asked: string[] = []
    const os = (platform: string, answer: boolean | Error) => ({
      platform,
      askMicrophone: async () => {
        asked.push(platform)
        if (answer instanceof Error) throw answer
        return answer
      },
    })
    const mic = { voice: true, mediaTypes: ['audio'] }
    expect(await grantPermission('media', true, mic, os('darwin', true))).toBe(true)
    expect(await grantPermission('media', true, mic, os('darwin', false))).toBe(false) // 시스템 설정에서 거절됐다
    expect(await grantPermission('media', true, mic, os('darwin', new Error('tcc')))).toBe(false)
    expect(asked).toEqual(['darwin', 'darwin', 'darwin'])
    expect(await grantPermission('media', true, mic, os('win32', false))).toBe(true) // Windows 엔 묻는 창이 없다
    expect(await grantPermission('media', true, { voice: false, mediaTypes: ['audio'] }, os('darwin', true))).toBe(false)
    expect(await grantPermission('media', false, mic, os('darwin', true))).toBe(false)
    expect(await grantPermission('media', true, { voice: true, mediaTypes: ['audio', 'video'] }, os('darwin', true))).toBe(false)
    expect(await grantPermission('clipboard-sanitized-write', true, { voice: false }, os('darwin', false))).toBe(true) // 복사는 마이크와 무관
    expect(asked).toEqual(['darwin', 'darwin', 'darwin'])
  })
})

describe('창 크기·위치 되돌리기', () => {
  const screens = [
    { x: 0, y: 25, width: 1440, height: 875 },
    { x: 1440, y: 0, width: 1920, height: 1080 },
  ]

  it('화면 안이면 저장한 그대로 (둘째 모니터 포함)', () => {
    expect(restorableBounds({ x: 100, y: 80, width: 1200, height: 700 }, screens)).toEqual({ x: 100, y: 80, width: 1200, height: 700 })
    expect(restorableBounds({ x: 1600, y: 100, width: 1280, height: 800, extra: 1 }, screens)).toEqual({ x: 1600, y: 100, width: 1280, height: 800 })
  })

  it('화면 밖이거나(모니터를 뺐다) 겨우 걸친 자리면 기본값으로', () => {
    expect(restorableBounds({ x: 1600, y: 100, width: 1280, height: 800 }, [screens[0]!])).toBeUndefined()
    expect(restorableBounds({ x: -1150, y: 80, width: 1200, height: 700 }, screens)).toBeUndefined() // 50px 만 보인다
    expect(restorableBounds({ x: 100, y: 850, width: 1200, height: 700 }, [screens[0]!])).toBeUndefined()
  })

  it('모양이 틀리거나 너무 작으면 기본값으로', () => {
    for (const saved of [undefined, null, 'x', {}, { x: 0, y: 0, width: '1200', height: 700 }, { x: 0, y: 0, width: Number.NaN, height: 700 }, { x: 0, y: 30, width: 120, height: 90 }]) {
      expect(restorableBounds(saved, screens), JSON.stringify(saved)).toBeUndefined()
    }
  })
})

describe('windowMode — 닫을 때의 창 상태를 다음 창이 잇는다', () => {
  it('최대화·전체 화면으로 닫았으면 그 상태, 둘 다면 전체 화면', () => {
    expect(windowMode({ x: 0, y: 0, width: 1280, height: 800, maximized: true, fullScreen: false })).toBe('maximized')
    expect(windowMode({ maximized: false, fullScreen: true })).toBe('fullscreen')
    expect(windowMode({ maximized: true, fullScreen: true })).toBe('fullscreen')
  })

  it('보통 창·옛 파일(상태 없음)·틀린 모양은 보통 창', () => {
    expect(windowMode({ x: 0, y: 0, width: 1280, height: 800, maximized: false, fullScreen: false })).toBeUndefined()
    expect(windowMode({ x: 0, y: 0, width: 1280, height: 800 })).toBeUndefined()
    expect(windowMode({ maximized: 'yes', fullScreen: 1 })).toBeUndefined()
    expect(windowMode(undefined)).toBeUndefined()
  })
})
