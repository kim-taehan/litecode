import { app, Notification } from 'electron'
import type { NotificationHost } from '../src/services/notifications.ts'

// ctx.notifications 의 창·OS 쪽. 제품은 Electron Notification·dock 배지, 실물 테스트(LITECODE_TEST_HIDDEN=1)는 기록만 한다 —
// 테스트 창은 숨겨져 포커스가 없어서 그대로 두면 테스트가 사용자 화면에 OS 알림을 띄운다 (01i 4절). 테스트는 판정(앞/뒤)도 주입한다.

/** 앱 창 — 없으면 만든다 (electron/main.ts) */
export interface WindowAccess {
  current(): Electron.BrowserWindow | undefined
  /** 창 확보·복원·보이기·포커스 */
  reveal(): void
}

export function systemHost(windows: WindowAccess): NotificationHost {
  return {
    isForeground: () => windows.current()?.isFocused() ?? false,
    show(note, onClick) {
      // 시스템 기본 소리(Q11 — silent 기본값 false). 지원하지 않는 환경이면 조용히 건너뛴다 — 앱 안 점·배지가 남는다
      if (!Notification.isSupported()) return { close() {} }
      const notification = new Notification(note)
      notification.on('click', onClick)
      notification.show()
      return notification
    },
    setBadge: (count) => void app.setBadgeCount(count), // macOS dock 배지. Windows 는 미지원(무시된다)
    reveal: () => windows.reveal(),
  }
}

/** 테스트가 app.evaluate 로 읽고 바꾸는 기록 — globalThis.__litecodeNotifyTest */
export interface NotifyTestRecord {
  /** 판정 주입: 앱이 앞에 있다고 칠까 (기본 뒤 — 숨긴 창은 포커스가 없다) */
  foreground: boolean
  shown: { title: string; body: string; closed: boolean; click(): void }[]
  badge: number[]
  /** 창을 앞으로 부른 횟수 — 알림 클릭·두 번째 실행 */
  reveals: number
}

export function recordingHost(record: NotifyTestRecord): NotificationHost {
  return {
    isForeground: () => record.foreground,
    show(note, onClick) {
      const entry = { ...note, closed: false, click: onClick }
      record.shown.push(entry)
      return { close: () => void (entry.closed = true) }
    },
    setBadge: (count) => void record.badge.push(count),
    // 숨긴 테스트 창을 보이게 하지 않는다 — 앞으로 왔다고 기록하고 판정도 앞으로 (실제 reveal 은 포커스를 가져온다)
    reveal() {
      record.reveals++
      record.foreground = true
    },
  }
}
