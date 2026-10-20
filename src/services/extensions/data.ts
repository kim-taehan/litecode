import fs from 'node:fs/promises'
import path from 'node:path'

// 확장별 자료 파일 (이슈 #536) — `<root>/data/<id>/{storage,secrets,origins}.json`. 확장이 storage·secrets 로 남긴 값과 사용자가 허용한 주소.
// 확장마다 폴더가 따로라 다른 확장의 값에 닿지 않는다(id 는 서비스가 iframe 출처로 정한 것만 온다). 확장을 지우면 폴더째 지운다.
// installed/·pending/·staging/ 과 따로 둬서 업그레이드(installed/<id> 교체)에도 값이 남는다

export type DataKind = 'storage' | 'secrets' | 'origins'

export class ExtensionData {
  private readonly root: string

  constructor(root: string) {
    this.root = path.join(path.resolve(root), 'data')
  }

  /** 파일의 JSON 값 — 없으면 undefined. 깨졌으면(손으로 고침) 로그를 남기고 undefined (모양 검사는 부르는 쪽) */
  async read(id: string, kind: DataKind): Promise<unknown> {
    let text: string
    try {
      text = await fs.readFile(this.file(id, kind), 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
    try {
      return JSON.parse(text)
    } catch {
      console.warn(`[extensions] ${id} 의 ${kind}.json 이 깨져 비운 것으로 본다`)
      return undefined
    }
  }

  /** 임시 파일에 쓰고 바꿔 넣는다 — 쓰다 죽어도 이전 값이 남는다 */
  async write(id: string, kind: DataKind, value: unknown): Promise<void> {
    const file = this.file(id, kind)
    await fs.mkdir(path.dirname(file), { recursive: true })
    const temp = `${file}.${process.pid}.tmp`
    await fs.writeFile(temp, JSON.stringify(value), { mode: 0o600 })
    await fs.rename(temp, file)
  }

  /** 그 확장의 자료를 모두 지운다 (삭제 적용 때) */
  async remove(id: string): Promise<void> {
    await fs.rm(path.join(this.root, id), { recursive: true, force: true })
  }

  private file(id: string, kind: DataKind): string {
    return path.join(this.root, id, `${kind}.json`)
  }
}
