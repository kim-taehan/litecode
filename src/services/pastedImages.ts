import { randomBytes } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

// 경로 없이 온 이미지(붙여넣은 스크린숏, 이슈 #80)를 두는 곳 — 앱 폴더 아래 폴더 하나의 임시 파일.
// 파일로 두는 이유: 그 뒤로는 고른 파일과 같은 길(경로 칩 → 대화별 초안 → 대기열 → 보낼 때 메인이 읽기)을 그대로 탄다.
// 남는 파일이 없게 지우는 때:
// - 보낸 뒤 (ctx.chat 이 읽고 나서 'chat/attachments-read') · 칩을 뺄 때 (화면이 알린다) · 그 대화를 지울 때 ('sessions/removed')
// - 앱을 켤 때와 끌 때 폴더째 (reset) — 초안·대기열은 메모리에만 있어 다시 켠 앱에는 이 파일을 가리키는 것이 없다
// **지우는 것은 이 실행이 만든 경로뿐이다** (discard) — 화면이 아무 경로나 지우게 하는 길이 되지 않게. reset 만 폴더를 통째로 비운다

export class PastedImages {
  /** 이 실행이 만든 파일 → 그 초안의 대화 id */
  private owned = new Map<string, string>()

  constructor(private readonly dir: string) {}

  /** 바이트를 파일로 두고 그 경로를 준다 (나만 읽는 권한) */
  async store(conversationId: string, data: Uint8Array, mime: 'image/png' | 'image/jpeg'): Promise<string> {
    await fs.mkdir(this.dir, { recursive: true, mode: 0o700 })
    const file = path.join(this.dir, `pasted-${randomBytes(6).toString('hex')}.${mime === 'image/png' ? 'png' : 'jpg'}`)
    await fs.writeFile(file, data, { mode: 0o600, flag: 'wx' })
    this.owned.set(file, conversationId)
    return file
  }

  /** 그 경로들 중 이 실행이 만든 것만 지운다 */
  async discard(paths: readonly string[]): Promise<void> {
    for (const file of paths) {
      if (!this.owned.delete(file)) continue
      await fs.rm(file, { force: true }).catch(() => {})
    }
  }

  /** 그 대화들의 것을 지운다 */
  async discardOf(conversationIds: readonly string[]): Promise<void> {
    await this.discard([...this.owned].filter(([, id]) => conversationIds.includes(id)).map(([file]) => file))
  }

  /** 폴더를 비운다 — 앞 실행이 남긴 것까지 */
  async reset(): Promise<void> {
    this.owned.clear()
    await fs.rm(this.dir, { recursive: true, force: true })
  }
}
