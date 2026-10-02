import fs from 'node:fs/promises'
import path from 'node:path'

// 프로젝트 지시문(AGENTS.md, 없으면 CLAUDE.md)을 앱이 읽어 매 턴 prompt 의 `system` 으로 싣는다 (이슈 #13, 사용자 결정 2026-10-02).
// 레거시 경로는 프로젝트 설정(opencode.json·.opencode/ 의 MCP·플러그인)을 묻지 않고 실행해서 OPENCODE_DISABLE_PROJECT_CONFIG=1 로 막는데(L0),
// 그 플래그는 프로젝트 AGENTS.md/CLAUDE.md 읽기도 끈다 — 같은 효과를 앱이 낸다 (01w 3-1 실측: system 은 그 요청에만 실린다 → 매 턴).
// opencode 와 같은 모양(`Instructions from: <경로>\n<내용>`), 같은 순서(작업 폴더에서 위로)로 만든다. 위로 올라가는 끝은 git 루트다 —
// git 저장소가 아니면 작업 폴더만 본다 (opencode 는 git 이 아니면 "/" 까지 올라간다 — 홈 폴더의 파일까지 싣지 않으려고 좁혔다).
// 전역 지시문(~/.config/opencode/AGENTS.md 등)은 플래그와 무관하게 opencode 가 스스로 싣는다.

const NAMES = ['AGENTS.md', 'CLAUDE.md']

/** 작업 폴더(realpath)의 지시문 — 없으면 undefined. 첫 이름(AGENTS.md)이 하나라도 있으면 그 이름만 쓴다 */
export async function projectInstructions(directory: string): Promise<string | undefined> {
  const top = await gitRoot(directory)
  const folders: string[] = []
  for (let dir = directory; ; dir = path.dirname(dir)) {
    folders.push(dir)
    if (!top || dir === top || dir === path.dirname(dir)) break
  }
  for (const name of NAMES) {
    const found: string[] = []
    for (const dir of folders) {
      const file = path.join(dir, name)
      const text = await fs.readFile(file, 'utf8').catch(() => undefined)
      if (text !== undefined) found.push(`Instructions from: ${file}\n${text}`)
    }
    if (found.length > 0) return found.join('\n\n')
  }
  return undefined
}

/** 위로 올라가며 .git(폴더 또는 worktree 의 파일)이 있는 첫 폴더 */
async function gitRoot(directory: string): Promise<string | undefined> {
  for (let dir = directory; ; dir = path.dirname(dir)) {
    if (await fs.stat(path.join(dir, '.git')).then(() => true, () => false)) return dir
    if (dir === path.dirname(dir)) return undefined
  }
}
