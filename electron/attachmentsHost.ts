import { BrowserWindow, dialog, type WebContents } from 'electron'
import type { AttachmentsHost } from '../src/services/attachmentsService.ts'

// ctx.attachments 의 창·OS 쪽 (이슈 #97) — OS 파일 고르기. owner 는 다리가 넘긴 IPC 요청의 sender(WebContents)다:
// 그 창에 대화상자를 붙이고, 창을 못 찾으면 따로 띄운다

export const systemAttachmentsHost: AttachmentsHost = {
  async chooseFiles(request, owner) {
    const win = owner ? BrowserWindow.fromWebContents(owner as WebContents) : null
    const options = { properties: ['openFile' as const, 'multiSelections' as const], ...request }
    const chosen = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
    return chosen.canceled ? undefined : chosen.filePaths
  },
}
