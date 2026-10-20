import { Context } from 'cordis'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SettingsService, type SettingsOptions } from '../../src/services/settings.ts'
import { tr, setMainLanguage } from '../../src/i18n.ts'
import { ko } from '../../shared/i18n/ko.ts'
import { en } from '../../shared/i18n/en.ts'
import { translate } from '../../shared/i18n/index.ts'
import { chatFontVars } from '../../shared/fontSize.ts'
import { MAX_RUNNING_TASKS, MAX_TASKS, runningTaskLimit, taskCap } from '../../shared/tasks.ts'

async function service(options: SettingsOptions): Promise<{ ctx: Context; settings: SettingsService }> {
  const ctx = new Context()
  ctx.plugin(SettingsService, options)
  return new Promise((resolve) => ctx.inject(['settings'], (ready) => resolve({ ctx, settings: ready.settings })))
}

let tmp: string
let file: string
beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'litecode-settings-'))
  file = path.join(tmp, 'settings.json')
})
afterEach(async () => {
  setMainLanguage('ko')
  await fs.rm(tmp, { recursive: true, force: true })
})

describe('SettingsService', () => {
  it('파일이 없으면 기본값 — 영어·라이트·14px (사용자 결정 2026-10-01)', async () => {
    const { settings } = await service({ file })
    expect(settings.get()).toEqual({ language: 'en', appearance: 'light', fontSize: 14, defaultMode: 'build' })
  })

  it('넘긴 기본값이 이긴다 (실물 테스트의 한국어 고정)', async () => {
    const { settings } = await service({ file, defaults: { language: 'ko' } })
    expect(settings.get().language).toBe('ko')
  })

  it('바꾼 값은 파일에 남아 다시 열어도 그대로고, 바뀜 이벤트를 낸다', async () => {
    const { ctx, settings } = await service({ file })
    const seen: unknown[] = []
    ctx.on('settings/changed', (next) => void seen.push(next))
    expect(settings.set({ language: 'ko', appearance: 'dark', fontSize: 16, defaultMode: 'plan' })).toEqual({ language: 'ko', appearance: 'dark', fontSize: 16, defaultMode: 'plan' })
    expect(seen).toEqual([{ language: 'ko', appearance: 'dark', fontSize: 16, defaultMode: 'plan' }])
    expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual({ language: 'ko', appearance: 'dark', fontSize: 16, defaultMode: 'plan' })

    const again = await service({ file })
    expect(again.settings.get()).toEqual({ language: 'ko', appearance: 'dark', fontSize: 16, defaultMode: 'plan' })
  })

  it('잘못된 값은 저장하지 않고 거절한다 — 글자 크기는 12~17 정수', async () => {
    const { settings } = await service({ file })
    expect(() => settings.set({ fontSize: 18 })).toThrow()
    expect(() => settings.set({ fontSize: 11 })).toThrow()
    expect(() => settings.set({ fontSize: 13.5 })).toThrow()
    expect(() => settings.set({ language: 'French' })).toThrow() // 언어 태그 모양이 아니다 — 팩 언어(zh-CN 등)는 받고, 그 팩이 없으면 ctx.extensions 가 되돌린다 (이슈 #525)
    expect(() => settings.set({ appearance: 'blue' as never })).toThrow()
    expect(() => settings.set({ defaultMode: 'yolo' as never })).toThrow()
    expect(settings.get()).toEqual({ language: 'en', appearance: 'light', fontSize: 14, defaultMode: 'build' })
    await expect(fs.stat(file)).rejects.toThrow()
  })

  it('손으로 고친 파일의 잘못된 값·모르는 키는 그 값만 기본값으로 돌린다', async () => {
    await fs.writeFile(file, JSON.stringify({ language: 'ko', appearance: 'purple', fontSize: 99, extra: 1 }))
    const { settings } = await service({ file })
    expect(settings.get()).toEqual({ language: 'ko', appearance: 'light', fontSize: 14, defaultMode: 'build' })
  })

  // 전수 검사 #126: 없앤 스위치(코딩 뷰·알림)의 필드를 지웠다 — 그 키가 남은 옛 파일도 그대로 읽힌다
  it('옛 파일에 남은 codingView·notifications 는 무시하고 나머지는 그대로 읽는다 — 다음 저장 때 파일에서도 빠진다', async () => {
    await fs.writeFile(file, JSON.stringify({ language: 'ko', appearance: 'dark', fontSize: 16, codingView: false, notifications: false, defaultMode: 'plan' }))
    const { settings } = await service({ file })
    expect(settings.get()).toEqual({ language: 'ko', appearance: 'dark', fontSize: 16, defaultMode: 'plan' })
    expect((await fs.readdir(path.dirname(file))).filter((name) => name.includes('.corrupt-'))).toEqual([])
    expect(() => settings.set({ codingView: true } as never)).toThrow()
    settings.set({ fontSize: 15 })
    const raw = await fs.readFile(file, 'utf8')
    expect(JSON.parse(raw)).toEqual({ language: 'ko', appearance: 'dark', fontSize: 15, defaultMode: 'plan' })
    expect(raw).toBe(`${JSON.stringify(JSON.parse(raw), null, 2)}\n`) // 사람이 열어 고치는 파일 — 들여 쓴다
  })

  it('손상된 파일이면 기본값으로 뜬다', async () => {
    await fs.writeFile(file, '{ not json')
    const { settings } = await service({ file })
    expect(settings.get().language).toBe('en')
  })

  // 참고 레포 검토(02x A): 손으로 고치다 깨뜨린 파일을 다음 저장이 덮지 않게 옆에 옮겨 둔다
  it('손상된 파일은 덮어쓰지 않고 옆에 .corrupt-<시각> 으로 옮겨 둔다', async () => {
    const raw = '{ "language": "ko", not json'
    await fs.writeFile(file, raw)
    const { settings } = await service({ file })
    settings.set({ fontSize: 15 })

    const backups = (await fs.readdir(path.dirname(file))).filter((name) => name.startsWith('settings.json.corrupt-'))
    expect(backups).toHaveLength(1)
    expect(await fs.readFile(path.join(path.dirname(file), backups[0]!), 'utf8')).toBe(raw)
  })

  it('설정 파일 열기 — 없으면 지금 값으로 만들어 경로를 준다', async () => {
    const { settings } = await service({ file })
    expect(await settings.ensureFile()).toBe(file)
    expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual({ language: 'en', appearance: 'light', fontSize: 14, defaultMode: 'build' })
  })

  it('메인 프로세스 문구는 설정 언어를 따른다 — 올라올 때와 바꿀 때', async () => {
    const { settings } = await service({ file })
    expect(tr('error.noConversation')).toBe('No such chat')
    settings.set({ language: 'ko' })
    expect(tr('error.noConversation')).toBe('없는 대화입니다')
  })
})

describe('사전', () => {
  it('두 언어의 키 집합이 같다 (타입이 잡지만 런타임으로도)', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(ko).sort())
  })

  it('같은 키의 자리표시자 이름이 두 언어에서 같다', () => {
    const names = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort()
    for (const key of Object.keys(ko) as (keyof typeof ko)[]) expect([key, names(en[key])]).toEqual([key, names(ko[key])])
  })

  it('자리표시자를 채우고 모르는 변수는 그대로 둔다', () => {
    expect(translate('ko', 'project.cannotOpen', { dir: '/a' })).toBe('폴더를 열 수 없습니다: /a')
    expect(translate('en', 'sidebar.messageCount', { count: 3 })).toBe('3 messages')
    expect(translate('en', 'project.cannotOpen')).toBe('Cannot open folder: {dir}')
  })
})

describe('대화 글자 크기 변수', () => {
  it('제목은 기준 14 에서의 차이, 작은 글자는 14 이하 −1 · 넘으면 −2 (dsh ui-theme)', () => {
    expect(chatFontVars(14)).toEqual({ '--chat-font-size': '14px', '--chat-font-delta': '0px', '--chat-font-size-secondary': '13px' })
    expect(chatFontVars(12)['--chat-font-delta']).toBe('-2px')
    expect([12, 13, 14, 15, 16, 17].map((size) => chatFontVars(size)['--chat-font-size-secondary'])).toEqual(['11px', '12px', '13px', '13px', '14px', '15px'])
  })
})

describe('알림 채널 자 스위치 (settings.notifyChannels, 이슈 #372)', () => {
  it('꺼진 채널만(false) 저장되고, 없는 키는 둘 다 켜짐. 글자·배열·모르는 키는 거절', async () => {
    const { settings } = await service({ file })
    expect(settings.get().notifyChannels).toBeUndefined()
    settings.set({ notifyChannels: { system: false } })
    settings.set({ notifyChannels: { system: false, app: false } })
    expect(JSON.parse(await fs.readFile(file, 'utf8')).notifyChannels).toEqual({ system: false, app: false })
    expect(() => settings.set({ notifyChannels: { system: 'off' } as never })).toThrow()
    expect(() => settings.set({ notifyChannels: [false] as never })).toThrow()
    expect(() => settings.set({ notifyChannels: { bogus: false } as never })).toThrow()
  })

  it('파일을 손으로 고쳐 잘못된 값이면 그 값만 기본값(둘 다 켜짐)으로 돌린다', async () => {
    await fs.writeFile(file, JSON.stringify({ language: 'ko', notifyChannels: { system: 'off', app: false } }))
    const { settings } = await service({ file })
    expect(settings.get().notifyChannels).toBeUndefined()
  })
})

describe('확장 켜기 (settings.extensions, 이슈 #482)', () => {
  it('없으면 undefined(모두 켜짐). 확장 id 형식의 키 → boolean 만 저장된다', async () => {
    const { settings } = await service({ file })
    expect(settings.get().extensions).toBeUndefined()
    settings.set({ extensions: { 'my-ext': false } })
    expect(JSON.parse(await fs.readFile(file, 'utf8')).extensions).toEqual({ 'my-ext': false })
    settings.set({ extensions: {} })
    expect(settings.get().extensions).toEqual({})
    expect(() => settings.set({ extensions: { 'my-ext': 'off' } as never })).toThrow()
    expect(() => settings.set({ extensions: [false] as never })).toThrow()
    expect(() => settings.set({ extensions: { 'My_Ext': false } })).toThrow()
    expect(() => settings.set({ extensions: { '../x': false } })).toThrow()
    expect(() => settings.set({ extensions: { ab: false } })).toThrow() // 3자 미만
  })

  it('내장 서버 설정 (settings.extensionServers, 이슈 #537) — 확장 id → startWithApp·stopWithApp boolean 만', async () => {
    const { settings } = await service({ file })
    expect(settings.get().extensionServers).toBeUndefined()
    settings.set({ extensionServers: { sonarqube: { startWithApp: true, stopWithApp: false } } })
    expect(JSON.parse(await fs.readFile(file, 'utf8')).extensionServers).toEqual({ sonarqube: { startWithApp: true, stopWithApp: false } })
    settings.set({ extensionServers: { sonarqube: {} } })
    expect(() => settings.set({ extensionServers: { sonarqube: { startWithApp: 'yes' } } as never })).toThrow()
    expect(() => settings.set({ extensionServers: { sonarqube: { port: 1 } } as never })).toThrow()
    expect(() => settings.set({ extensionServers: { 'Bad Id': {} } })).toThrow()
    expect(() => settings.set({ extensionServers: { sonarqube: null } as never })).toThrow()
  })

  it('파일을 손으로 고쳐 잘못된 값이면 그 값만 기본값으로 — 나머지 설정은 그대로', async () => {
    await fs.writeFile(file, JSON.stringify({ language: 'ko', extensions: { 'my-ext': false, 'Bad Id': false } }))
    const { settings } = await service({ file })
    expect(settings.get()).toEqual({ language: 'ko', appearance: 'light', fontSize: 14, defaultMode: 'build' })
  })

  it('extensions 가 없는 옛 설정 파일은 그대로 읽히고, 저장해도 extensions 를 만들지 않는다', async () => {
    await fs.writeFile(file, JSON.stringify({ language: 'ko', fontSize: 16, features: { git: true } }))
    const { settings } = await service({ file })
    expect(settings.get()).toEqual({ language: 'ko', appearance: 'light', fontSize: 16, defaultMode: 'build', features: { git: true } })
    settings.set({ fontSize: 15 })
    expect(JSON.parse(await fs.readFile(file, 'utf8'))).not.toHaveProperty('extensions')
  })
})

describe('다른 앱에서 열기 기본 앱 (settings.openInApp)', () => {
  it('처음엔 없다(목록 첫 앱), 고르면 settings.json 에 남고 다시 읽힌다. 문자열이 아니면 거절', async () => {
    const { settings } = await service({ file })
    expect(settings.get().openInApp).toBeUndefined()
    settings.set({ openInApp: 'iterm' })
    expect(JSON.parse(await fs.readFile(file, 'utf8')).openInApp).toBe('iterm')
    expect((await service({ file })).settings.get().openInApp).toBe('iterm')
    expect(() => settings.set({ openInApp: 3 as unknown as string })).toThrow()
  })
})

describe('동시에 실행할 하위 작업 (settings.maxRunningTasks, 이슈 #321)', () => {
  it('1~8 정수만 저장한다 — 범위 밖·소수·글자는 거절, 없으면 기본 2', async () => {
    const { settings } = await service({ file })
    expect(settings.get().maxRunningTasks).toBeUndefined()
    expect(runningTaskLimit(settings.get().maxRunningTasks)).toBe(MAX_RUNNING_TASKS)
    for (const bad of [0, 9, 2.5, '3']) expect(() => settings.set({ maxRunningTasks: bad as number }), String(bad)).toThrow()
    expect(settings.set({ maxRunningTasks: 5 }).maxRunningTasks).toBe(5)
    expect(JSON.parse(await fs.readFile(file, 'utf8')).maxRunningTasks).toBe(5)
  })

  it('파일을 손으로 고쳐 범위 밖이면 그 값만 기본값으로 돌린다', async () => {
    await fs.writeFile(file, JSON.stringify({ language: 'ko', maxRunningTasks: 50 }))
    const { settings } = await service({ file })
    expect(settings.get()).toMatchObject({ language: 'ko' })
    expect(runningTaskLimit(settings.get().maxRunningTasks)).toBe(MAX_RUNNING_TASKS)
  })

  it('쓰는 쪽은 한 번 더 보정한다 — 범위 끝으로, 소수는 내림, 숫자가 아니면 기본값. 합계 상한은 동시 실행 수보다 작지 않다', () => {
    expect([runningTaskLimit(0), runningTaskLimit(-3), runningTaskLimit(20), runningTaskLimit(3.9), runningTaskLimit(Number.NaN), runningTaskLimit('4')]).toEqual([1, 1, 8, 3, MAX_RUNNING_TASKS, MAX_RUNNING_TASKS])
    expect([taskCap(1), taskCap(2), taskCap(6)]).toEqual([MAX_TASKS, MAX_TASKS, 6])
  })
})
