import { app, BrowserWindow, dialog, type WebContents } from 'electron'
import path from 'node:path'
import type { ExtensionsOptions } from '../src/services/extensions.ts'

// ctx.extensions 의 창·OS 쪽 (이슈 #482) — 저장소 자리·앱 버전·zip 고르기 대화상자. owner 는 다리가 넘긴 IPC 요청의 sender(WebContents)다:
// 그 창에 대화상자를 붙이고, 창을 못 찾으면 따로 띄운다 (reportHost.ts 와 같다). mount(B 층)는 아직 주지 않는다 — 확장 코드는 실행되지 않는다

export function systemExtensionsHost(userData: string): ExtensionsOptions {
  return {
    root: path.join(userData, 'extensions'),
    appVersion: app.getVersion(),
    async pick(owner) {
      const win = owner ? BrowserWindow.fromWebContents(owner as WebContents) : null
      const options = { properties: ['openFile' as const], filters: [{ name: 'ZIP', extensions: ['zip'] }] }
      const chosen = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
      return chosen.canceled ? undefined : chosen.filePaths[0]
    },
  }
}
