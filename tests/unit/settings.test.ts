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
    expect(() => settings.set({ language: 'fr' as never })).toThrow()
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
