import { Context, Service } from 'cordis'
import './chat.ts' // ctx.chat 선언
import './remote.ts' // ctx.remote 선언 (선택 의존 — 아래)
import './settings.ts'
import { tr } from '../i18n.ts'

// 종료 확인 · 창 닫기 = 숨기기 (ctx.quit, 이슈 #92 — dsh 의 종료 확인·트레이 결정을 참조, 코드는 새로 썼다).
//
// - 종료 확인: 사용자가 앱을 끝내려 할 때(⌘Q·메뉴·트레이 "종료") 도는 턴이나 붙어 있는 폰이 있으면 한 번 묻는다. 없으면 묻지 않는다.
//   자동 실행(실물 테스트)과 OS 종료·로그아웃은 묻지 않는다
// - 창 닫기: macOS 는 그대로(창만 닫히고 앱은 Dock 에 남는다 — 턴은 메인의 ctx.chat 이 쥐고 있어 이어진다). Windows·Linux 는
//   창을 숨기고 트레이에 남는다. "창을 닫아도 계속 실행" 을 끄면 창 닫기 = 종료 요청(위 확인을 거친다)
//
// 판정은 아래 순수 함수 셋이고, Electron 을 모른다 — 확인 창·트레이·알림은 host 로 받는다 (electron/quitHost.ts).
// ctx.remote 는 선택 의존이다: 모바일 연결 기능이 꺼져 있으면 서비스가 없다 — inject 에 넣지 않고 물을 때 ctx.get 으로 본다.

/** 종료 확인 창의 글 */
export interface QuitPrompt {
  message: string
  detail: string
  /** 버튼 글자 — 기본 버튼은 cancel */
  quit: string
  cancel: string
}

/** 무엇을 물을지 — 끊길 것이 없으면 undefined (묻지 않고 끝낸다). 문구는 메인의 지금 언어 */
export function quitPrompt({ turns, phones }: { turns: number; phones: number }): QuitPrompt | undefined {
  const lines = [...(turns > 0 ? [tr('quit.turns', { count: turns })] : []), ...(phones > 0 ? [tr('quit.phones')] : [])]
  if (!lines.length) return undefined
  return { message: tr('quit.message'), detail: lines.join('\n'), quit: tr('quit.confirm'), cancel: tr('quit.cancel') }
}

/** 창 닫기를 무엇으로 — close: 그대로 닫는다, hide: 숨긴다(앱은 트레이에), quit: 닫지 않고 앱 종료를 요청한다(종료 확인을 거친다) */
export type CloseAction = 'close' | 'hide' | 'quit'

export function closeAction({ platform, keepRunning, automatic, quitting }: { platform: string; keepRunning: boolean; automatic: boolean; quitting: boolean }): CloseAction {
  if (automatic || quitting || platform === 'darwin') return 'close'
  return keepRunning ? 'hide' : 'quit'
}

/** 트레이 아이콘을 둘지 — 창 닫기가 숨기기인 곳에서만 (숨은 창을 다시 여는 길이다) */
export function staysInTray(input: { platform: string; keepRunning: boolean; automatic: boolean }): boolean {
  return closeAction({ ...input, quitting: false }) === 'hide'
}

/** 창·OS 쪽 — 메인이 Electron 으로 채운다 */
export interface QuitHost {
  /** process.platform */
  platform: string
  /** 네이티브 확인 창 — 종료를 골랐으면 true */
  confirm(prompt: QuitPrompt): Promise<boolean>
  /** 트레이 아이콘을 올린다 (메뉴 "열기"·"종료", 아이콘 클릭 = 열기 — 창 열기와 앱 종료 요청은 host 가 잇는다). 돌려준 함수가 거둔다 */
  tray(labels: { tooltip: string; open: string; quit: string }): () => void
  /** PC 알림 한 번 (눌러도 아무 일 없다) */
  notify(note: { title: string; body: string }): void
}

export interface QuitOptions {
  host: QuitHost
  /** 실물 테스트(LITECODE_TEST_HIDDEN) — 묻지 않고, 숨기지 않고, 트레이도 없다 */
  automatic?: boolean
}

declare module 'cordis' {
  interface Context {
    quit: QuitService
  }
}

const APP_NAME = 'litecode'
/** allowQuit 표식이 사는 시간 — OS 종료는 다른 앱이 취소할 수 있다. 그 뒤의 종료는 다시 묻는다 */
const ALLOW_MS = 60_000

export class QuitService extends Service {
  static readonly inject = ['chat', 'settings']

  /** 사용자가 종료를 확인했다(또는 물을 것이 없었다) — 이 뒤로 창 닫기를 가로채지 않는다 */
  private confirmed = false
  private allowedUntil = 0
  /** 떠 있는 확인 창 — 그 사이의 종료 요청은 같은 답을 받는다 */
  private asking?: Promise<boolean>
  private tray?: { remove(): void; key: string }

  constructor(
    ctx: Context,
    private opts: QuitOptions,
  ) {
    super(ctx, 'quit')
    this.syncTray()
    ctx.on('settings/changed', () => this.syncTray())
    ctx.effect(() => () => this.dropTray())
  }

  /** 앱을 끝내도 되는가 — 끊길 것(도는 턴·붙은 폰)이 있으면 사용자에게 묻는다. 메인의 before-quit 이 부른다 */
  confirmQuit(): Promise<boolean> {
    if (this.opts.automatic || this.confirmed || Date.now() < this.allowedUntil) return Promise.resolve(true)
    this.asking ??= this.ask().finally(() => (this.asking = undefined))
    return this.asking
  }

  /** 곧 올 종료는 묻지 않는다 — OS 종료·로그아웃 (사용자가 이미 OS 에 답했다) */
  allowQuit(): void {
    this.allowedUntil = Date.now() + ALLOW_MS
  }

  /** 창이 닫히려 한다 — 무엇으로 바꿀지. 처음 숨길 때 한 번만 "트레이에서 계속 실행됩니다" 를 알리고 설정에 적는다 */
  windowClosing(): CloseAction {
    const settings = this.ctx.settings.get()
    const action = closeAction({ ...this.place(), quitting: this.confirmed || Date.now() < this.allowedUntil })
    if (action === 'hide' && !settings.trayNoticeShown) {
      this.opts.host.notify({ title: APP_NAME, body: tr('tray.notice') })
      this.ctx.settings.set({ trayNoticeShown: true })
    }
    return action
  }

  private async ask(): Promise<boolean> {
    const phones = this.ctx.get('remote')?.status().devices.filter((device) => device.connected).length ?? 0
    const prompt = quitPrompt({ turns: this.ctx.chat.running(), phones })
    const go = !prompt || (await this.opts.host.confirm(prompt))
    if (go) this.confirmed = true
    return go
  }

  private place(): { platform: string; keepRunning: boolean; automatic: boolean } {
    return { platform: this.opts.host.platform, keepRunning: this.ctx.settings.get().keepRunning !== false, automatic: !!this.opts.automatic }
  }

  /** 트레이를 설정에 맞춘다 — 스위치가 바뀌면 올리거나 거두고, 언어가 바뀌면 메뉴 글자를 다시 만든다 */
  private syncTray(): void {
    const labels = { tooltip: APP_NAME, open: tr('tray.open'), quit: tr('tray.quit') }
    const key = staysInTray(this.place()) ? JSON.stringify(labels) : ''
    if (key === (this.tray?.key ?? '')) return
    this.dropTray()
    if (key) this.tray = { remove: this.opts.host.tray(labels), key }
  }

  private dropTray(): void {
    this.tray?.remove()
    this.tray = undefined
  }
}
