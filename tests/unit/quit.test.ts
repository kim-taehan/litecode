import { Context, Service } from 'cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { closeAction, quitPrompt, QuitService, staysInTray, type QuitHost, type QuitPrompt } from '../../src/services/quit.ts'
import { SettingsService, type Settings } from '../../src/services/settings.ts'
import { setMainLanguage } from '../../src/i18n.ts'

// 종료 확인 · 창 닫기 = 숨기기 (이슈 #92). 판정은 순수 함수(플랫폼·설정·도는 턴 수·붙은 폰 수 → 무엇을 물을지·닫기를 무엇으로 바꿀지)이고,
// 서비스는 Electron 을 모른다 — 확인 창·트레이·알림은 host 로 받는다 (여기선 기록하는 host). Windows·Linux 는 이 머신에서 못 돌려
// 플랫폼을 인자로 주는 이 테스트가 전부다.

afterEach(() => {
  setMainLanguage('ko')
  vi.useRealTimers()
})

describe('quitPrompt — 무엇을 물을지', () => {
  it('도는 턴도 붙은 폰도 없으면 묻지 않는다', () => {
    expect(quitPrompt({ turns: 0, phones: 0 })).toBeUndefined()
  })

  it('도는 턴이 있으면 그 수를 말한다', () => {
    expect(quitPrompt({ turns: 2, phones: 0 })).toEqual({ message: 'litecode 를 종료할까요?', detail: '진행 중인 대화 2개가 중단됩니다', quit: '종료', cancel: '취소' })
  })

  it('붙은 폰이 있으면 연결이 끊긴다고 말한다 (몇 대든 한 줄)', () => {
    expect(quitPrompt({ turns: 0, phones: 2 })?.detail).toBe('폰 연결이 끊깁니다')
  })

  it('둘 다면 두 줄', () => {
    expect(quitPrompt({ turns: 1, phones: 1 })?.detail).toBe('진행 중인 대화 1개가 중단됩니다\n폰 연결이 끊깁니다')
  })

  it('문구는 메인의 지금 언어를 따른다', () => {
    setMainLanguage('en')
    expect(quitPrompt({ turns: 3, phones: 1 })).toEqual({
      message: 'Quit litecode?',
      detail: 'Chats in progress that will be interrupted: 3\nThe phone connection will be dropped',
      quit: 'Quit',
      cancel: 'Cancel',
    })
  })
})

describe('closeAction — 창 닫기를 무엇으로 바꿀지', () => {
  const base = { keepRunning: true, automatic: false, quitting: false }

  it('macOS 는 그대로 닫는다 (앱은 Dock 에 남는다) — 스위치와 무관', () => {
    expect(closeAction({ ...base, platform: 'darwin' })).toBe('close')
    expect(closeAction({ ...base, platform: 'darwin', keepRunning: false })).toBe('close')
  })

  it('Windows·Linux 는 숨긴다', () => {
    expect(closeAction({ ...base, platform: 'win32' })).toBe('hide')
    expect(closeAction({ ...base, platform: 'linux' })).toBe('hide')
  })

  it('"창을 닫아도 계속 실행" 을 끄면 Windows·Linux 의 창 닫기는 종료 요청이다 (종료 확인을 거친다)', () => {
    expect(closeAction({ ...base, platform: 'win32', keepRunning: false })).toBe('quit')
    expect(closeAction({ ...base, platform: 'linux', keepRunning: false })).toBe('quit')
  })

  it('종료가 정해진 뒤와 자동 실행(테스트)에서는 어디서든 그대로 닫는다', () => {
    expect(closeAction({ ...base, platform: 'win32', quitting: true })).toBe('close')
    expect(closeAction({ ...base, platform: 'win32', keepRunning: false, quitting: true })).toBe('close')
    expect(closeAction({ ...base, platform: 'win32', automatic: true })).toBe('close')
    expect(closeAction({ ...base, platform: 'linux', keepRunning: false, automatic: true })).toBe('close')
  })
})

describe('staysInTray — 트레이 아이콘을 둘지', () => {
  it('Windows·Linux 에서 스위치가 켜져 있을 때만', () => {
    expect(staysInTray({ platform: 'win32', keepRunning: true, automatic: false })).toBe(true)
    expect(staysInTray({ platform: 'linux', keepRunning: true, automatic: false })).toBe(true)
    expect(staysInTray({ platform: 'win32', keepRunning: false, automatic: false })).toBe(false)
    expect(staysInTray({ platform: 'darwin', keepRunning: true, automatic: false })).toBe(false)
    expect(staysInTray({ platform: 'win32', keepRunning: true, automatic: true })).toBe(false)
  })
})

class FakeChat extends Service {
  turns = 0
  constructor(ctx: Context) {
    super(ctx, 'chat')
  }
  running(): number {
    return this.turns
  }
}

class FakeRemote extends Service {
  connected: boolean[] = []
  constructor(ctx: Context) {
    super(ctx, 'remote')
  }
  status() {
    return { devices: this.connected.map((connected) => ({ connected })) }
  }
}

interface Tray {
  labels: { tooltip: string; open: string; quit: string }
  removed: boolean
}

function fakeHost(platform: string) {
  const record = { prompts: [] as QuitPrompt[], answers: [] as ((go: boolean) => void)[], trays: [] as Tray[], notes: [] as { title: string; body: string }[] }
  const host: QuitHost = {
    platform,
    confirm: (prompt) => {
      record.prompts.push(prompt)
      return new Promise((resolve) => record.answers.push(resolve))
    },
    tray(labels) {
      const tray: Tray = { labels, removed: false }
      record.trays.push(tray)
      return () => void (tray.removed = true)
    },
    notify: (note) => void record.notes.push(note),
  }
  return { record, host }
}

async function start(platform: string, options: { automatic?: boolean; remote?: boolean; settings?: Partial<Settings> } = {}) {
  const ctx = new Context()
  const { record, host } = fakeHost(platform)
  ctx.plugin(SettingsService, { defaults: { language: 'ko', ...options.settings } })
  ctx.plugin(FakeChat)
  if (options.remote) ctx.plugin(FakeRemote)
  const fiber = ctx.plugin(QuitService, { host, automatic: options.automatic })
  const quit = await new Promise<QuitService>((resolve) => ctx.inject(['quit'], (ready) => resolve(ready.quit)))
  return { ctx, quit, record, fiber, chat: ctx.get('chat') as unknown as FakeChat, remote: ctx.get('remote') as unknown as FakeRemote | undefined }
}

describe('QuitService — 종료 확인', () => {
  it('아무것도 없으면 묻지 않고 끝낸다', async () => {
    const { quit, record } = await start('darwin')
    expect(await quit.confirmQuit()).toBe(true)
    expect(record.prompts).toEqual([])
  })

  it('도는 턴이 있으면 묻는다 — 취소면 안 끝내고 다음에 다시 묻는다, 종료면 끝낸다', async () => {
    const { quit, record, chat } = await start('darwin')
    chat.turns = 2
    const first = quit.confirmQuit()
    expect(record.prompts.map((prompt) => prompt.detail)).toEqual(['진행 중인 대화 2개가 중단됩니다'])
    record.answers[0](false)
    expect(await first).toBe(false)

    const second = quit.confirmQuit()
    expect(record.prompts).toHaveLength(2)
    record.answers[1](true)
    expect(await second).toBe(true)
  })

  it('모바일 연결 기능이 꺼져 있어도(ctx.remote 없음) 뜨고, 턴만 본다', async () => {
    const { quit, record, remote } = await start('win32')
    expect(remote).toBeUndefined()
    expect(await quit.confirmQuit()).toBe(true)
    expect(record.prompts).toEqual([])
  })

  it('붙어 있는 폰이 있으면 묻는다 — 짝만 지어 두고 안 붙은 기기는 세지 않는다', async () => {
    const paired = await start('darwin', { remote: true })
    paired.remote!.connected = [false, false]
    expect(await paired.quit.confirmQuit()).toBe(true)
    expect(paired.record.prompts).toEqual([])

    const { quit, record, remote } = await start('darwin', { remote: true })
    remote!.connected = [false, true]
    const asked = quit.confirmQuit()
    expect(record.prompts.map((prompt) => prompt.detail)).toEqual(['폰 연결이 끊깁니다'])
    record.answers[0](true)
    expect(await asked).toBe(true)
  })

  it('확인 창이 떠 있는 동안 또 종료를 누르면 창을 하나 더 띄우지 않고 같은 답을 받는다', async () => {
    const { quit, record, chat } = await start('darwin')
    chat.turns = 1
    const first = quit.confirmQuit()
    const second = quit.confirmQuit()
    expect(record.prompts).toHaveLength(1)
    record.answers[0](true)
    expect(await Promise.all([first, second])).toEqual([true, true])
  })

  it('자동 실행(테스트)은 도는 턴이 있어도 묻지 않는다', async () => {
    const { quit, record, chat } = await start('darwin', { automatic: true })
    chat.turns = 3
    expect(await quit.confirmQuit()).toBe(true)
    expect(record.prompts).toEqual([])
  })

  it('OS 종료·로그아웃 직후의 종료는 묻지 않는다 — 그 표식은 1분 뒤 풀린다 (OS 종료가 취소됐을 때 다음 종료는 다시 묻게)', async () => {
    vi.useFakeTimers()
    const { quit, record, chat } = await start('darwin')
    chat.turns = 1
    quit.allowQuit()
    expect(await quit.confirmQuit()).toBe(true)
    expect(record.prompts).toEqual([])

    vi.advanceTimersByTime(61_000)
    void quit.confirmQuit()
    expect(record.prompts).toHaveLength(1)
  })
})

describe('QuitService — 창 닫기와 트레이', () => {
  it('macOS: 창은 그대로 닫히고 트레이·안내가 없다', async () => {
    const { quit, record } = await start('darwin')
    expect(quit.windowClosing()).toBe('close')
    expect(record.trays).toEqual([])
    expect(record.notes).toEqual([])
  })

  it('Windows: 트레이 아이콘을 두고 창 닫기는 숨기기 — 처음 숨길 때 한 번만 안내하고 설정에 적는다', async () => {
    const { ctx, quit, record } = await start('win32')
    expect(record.trays.map((tray) => tray.labels)).toEqual([{ tooltip: 'litecode', open: '열기', quit: '종료' }])

    expect(quit.windowClosing()).toBe('hide')
    expect(record.notes).toEqual([{ title: 'litecode', body: '앱이 트레이에서 계속 실행됩니다 — 끝내려면 트레이 아이콘의 "종료" 를 누르세요' }])
    expect(ctx.settings.get().trayNoticeShown).toBe(true)

    expect(quit.windowClosing()).toBe('hide')
    expect(record.notes).toHaveLength(1)
  })

  it('안내를 이미 본 사용자(설정 파일의 표식)에게는 다시 안 띄운다', async () => {
    const { quit, record } = await start('linux', { settings: { trayNoticeShown: true } })
    expect(quit.windowClosing()).toBe('hide')
    expect(record.notes).toEqual([])
  })

  it('스위치를 끄면 트레이를 거두고 창 닫기는 종료 요청, 다시 켜면 트레이가 돌아온다', async () => {
    const { ctx, quit, record } = await start('win32')
    ctx.settings.set({ keepRunning: false })
    expect(record.trays.map((tray) => tray.removed)).toEqual([true])
    expect(quit.windowClosing()).toBe('quit')
    expect(record.notes).toEqual([])

    ctx.settings.set({ keepRunning: true })
    expect(record.trays.map((tray) => tray.removed)).toEqual([true, false])
  })

  it('언어를 바꾸면 트레이 메뉴 글자가 따라온다. 무관한 설정 변경에는 트레이를 다시 만들지 않는다', async () => {
    const { ctx, record } = await start('win32')
    ctx.settings.set({ fontSize: 15 })
    expect(record.trays).toHaveLength(1)

    ctx.settings.set({ language: 'en' })
    expect(record.trays.map((tray) => tray.removed)).toEqual([true, false])
    expect(record.trays[1].labels).toEqual({ tooltip: 'litecode', open: 'Open', quit: 'Quit' })
  })

  it('종료를 확인한 뒤의 창 닫기는 숨기지 않는다', async () => {
    const { quit } = await start('win32')
    expect(await quit.confirmQuit()).toBe(true)
    expect(quit.windowClosing()).toBe('close')
  })

  it('자동 실행(테스트)은 트레이 없이 그대로 닫는다', async () => {
    const { quit, record } = await start('win32', { automatic: true })
    expect(record.trays).toEqual([])
    expect(quit.windowClosing()).toBe('close')
  })

  it('서비스를 내리면 트레이를 거둔다', async () => {
    const { record, fiber } = await start('win32')
    await fiber.dispose()
    expect(record.trays.map((tray) => tray.removed)).toEqual([true])
  })
})
