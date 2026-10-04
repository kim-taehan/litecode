import { app, dialog, Menu, nativeImage, Notification, Tray } from 'electron'
import type { QuitHost } from '../src/services/quit.ts'
import type { WindowAccess } from './notificationHost.ts'

// ctx.quit 의 창·OS 쪽 (이슈 #92) — 네이티브 확인 창·트레이 아이콘·"트레이에서 계속 실행됩니다" 알림.
// 실물 테스트(LITECODE_TEST_HIDDEN)는 서비스가 automatic 이라 이 host 의 어느 것도 부르지 않는다.
// Windows·Linux 실행은 미검증이다 (트레이는 그 둘에서만 올라온다).

/** 트레이 아이콘 32×32 PNG — 강조색(#4176e6) 둥근 사각형에 흰 "L". 레포에 아이콘 자원이 없어(build/ 에 이미지 없음) 코드에 싣는다:
 *  파일로 두면 개발 실행·설치본(asar)의 경로를 따로 풀어야 한다. 앱 아이콘이 생기면 그것으로 바꾼다 */
const TRAY_ICON =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAXElEQVR42u3XMQ4AEBBE0b2aSzmya9BpEFssI/In0UnmlTtmi6RcauQzb6KL3ZDTxVuIFHC7fEBIAaryjvB+nAUAAAAAAACQA3YBACAU8OVd+M5ZzjJ6Ypyq5nkDbxR8V8pWExAAAAAASUVORK5CYII='

export function systemQuitHost(windows: WindowAccess): QuitHost {
  return {
    platform: process.platform,
    async confirm(prompt) {
      const options = {
        type: 'question' as const,
        message: prompt.message,
        detail: prompt.detail,
        buttons: [prompt.quit, prompt.cancel],
        defaultId: 1,
        cancelId: 1, // Esc·창 닫기 = 취소
        noLink: true,
      }
      // 보이는 창이 있으면 그 창에 붙이고, 숨었거나 없으면 따로 띄운다 (숨은 창을 다시 보이게 하지 않는다 — dsh)
      const win = windows.current()
      const { response } = win?.isVisible() ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options)
      return response === 0
    },
    tray(labels) {
      let tray: Tray | undefined
      let removed = false
      // Tray 는 app ready 뒤에만 만들 수 있다 — 서비스가 그 전에 올라올 수 있다
      void app.whenReady().then(() => {
        if (removed) return
        tray = new Tray(nativeImage.createFromDataURL(TRAY_ICON))
        tray.setToolTip(labels.tooltip)
        tray.setContextMenu(
          Menu.buildFromTemplate([
            { label: labels.open, click: () => windows.reveal() },
            { label: labels.quit, click: () => app.quit() }, // before-quit 이 ctx.quit 에 묻는다
          ]),
        )
        tray.on('click', () => windows.reveal()) // Linux 는 환경에 따라 click 이 안 온다 — 메뉴의 "열기" 가 남는다
      })
      return () => {
        removed = true
        tray?.destroy()
      }
    },
    notify(note) {
      if (Notification.isSupported()) new Notification(note).show()
    },
  }
}
