import { BrowserWindow, dialog, shell, type WebContents } from 'electron'
import type { ReportHost } from '../src/services/report.ts'
import { tr } from '../src/i18n.ts'

// ctx.report 의 창·OS 쪽 (이슈 #177) — 저장 대화상자·폴더 고르기·폴더 열기. owner 는 다리가 넘긴 IPC 요청의 sender(WebContents)다:
// 그 창에 대화상자를 붙이고, 창을 못 찾으면 따로 띄운다 (attachmentsHost.ts 와 같다)

function windowOf(owner: unknown): BrowserWindow | null {
  return owner ? BrowserWindow.fromWebContents(owner as WebContents) : null
}

export const systemReportHost: ReportHost = {
  async chooseSaveFile(defaultName, owner) {
    const win = windowOf(owner)
    const options = { title: tr('report.saveDialogTitle'), defaultPath: defaultName, filters: [{ name: 'JSON', extensions: ['json'] }] }
    const chosen = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options)
    return chosen.canceled || !chosen.filePath ? undefined : chosen.filePath
  },
  async chooseFolder(owner) {
    const win = windowOf(owner)
    const options = { title: tr('report.folderDialogTitle'), buttonLabel: tr('report.folderDialogButton'), properties: ['openDirectory' as const, 'createDirectory' as const] }
    const chosen = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
    return chosen.canceled ? undefined : chosen.filePaths[0]
  },
  async openFolder(dir) {
    // openPath 는 실패하면 사유 문자열을 준다 (성공이면 빈 글)
    if (await shell.openPath(dir)) throw new Error(tr('report.openFailed'))
  },
}
