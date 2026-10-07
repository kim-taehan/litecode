import fs from 'node:fs/promises'
import path from 'node:path'
import { tr } from '../i18n.ts'

// 프로젝트 지시문(AGENTS.md, 없으면 CLAUDE.md)을 앱이 읽어 매 턴 prompt 의 `system` 으로 싣는다 (이슈 #13, 사용자 결정 2026-10-02).
// 레거시 경로는 프로젝트 설정(opencode.json·.opencode/ 의 MCP·플러그인)을 묻지 않고 실행해서 OPENCODE_DISABLE_PROJECT_CONFIG=1 로 막는데(L0),
// 그 플래그는 프로젝트 AGENTS.md/CLAUDE.md 읽기도 끈다 — 같은 효과를 앱이 낸다 (01w 3-1 실측: system 은 그 요청에만 실린다 → 매 턴).
// opencode 와 같은 모양(`Instructions from: <경로>\n<내용>`), 같은 순서(작업 폴더에서 위로)로 만든다. 위로 올라가는 끝은 git 루트다 —
// git 저장소가 아니면 작업 폴더만 본다 (opencode 는 git 이 아니면 "/" 까지 올라간다 — 홈 폴더의 파일까지 싣지 않으려고 좁혔다).
// 전역 지시문(~/.config/opencode/AGENTS.md 등)은 플래그와 무관하게 opencode 가 스스로 싣는다.
// 이슈 #176 (dsh agent-instructions 의 아이디어): 폴더마다 이긴 이름의 파일 뒤에 git 에 안 올리는 개인 지시문(AGENTS.local.md·CLAUDE.local.md)을
// 덧붙이고(어느 이름이 이기는지는 기본 파일만 정한다), 이어 붙인 사슬 전체를 바이트 상한으로 자른다. 순서가 좁은 폴더 → 넓은 폴더라 뒤를 자르면
// 넓은 쪽이 먼저 잘린다. 잘리면 끝에 "(잘림: N바이트 중 M)" 를 붙인다 — 진행 줄 지시문 항목(instructionsNote)이 이것과 머리 줄을 읽는다.

const NAMES = ['AGENTS.md', 'CLAUDE.md']
const LOCAL_NAMES = ['AGENTS.local.md', 'CLAUDE.local.md']
/** 사슬 전체(이어 붙인 결과)의 UTF-8 바이트 상한 — 잘림 표시는 이 밖에 붙는다 */
export const INSTRUCTIONS_MAX_BYTES = 65_536
const HEADER = /^Instructions from: (.+)$/gm
const TRUNCATED = /^\(잘림: (\d+)바이트 중 (\d+)\)$/m

/** 작업 폴더(realpath)의 지시문 — 없으면 undefined. 첫 이름(AGENTS.md)이 하나라도 있으면 그 이름만 쓴다. 폴더마다 그 뒤에 비어 있지 않은 .local.md */
export async function projectInstructions(directory: string, maxBytes = INSTRUCTIONS_MAX_BYTES): Promise<string | undefined> {
  const top = await gitRoot(directory)
  const folders: string[] = []
  for (let dir = directory; ; dir = path.dirname(dir)) {
    folders.push(dir)
    if (!top || dir === top || dir === path.dirname(dir)) break
  }
  const read = (file: string) => fs.readFile(file, 'utf8').catch(() => undefined)
  for (const name of NAMES) {
    const found: string[] = []
    let based = false
    for (const dir of folders) {
      const file = path.join(dir, name)
      const text = await read(file)
      if (text !== undefined) {
        based = true
        found.push(`Instructions from: ${file}\n${text}`)
      }
      for (const local of LOCAL_NAMES) {
        const localFile = path.join(dir, local)
        const localText = await read(localFile)
        if (localText !== undefined && localText.trim() !== '') found.push(`Instructions from: ${localFile}\n${localText}`)
      }
    }
    // 이 이름의 기본 파일이 없으면 다음 이름으로 — 마지막 이름이면 .local.md 만이라도 싣는다
    if (based || name === NAMES.at(-1)) return found.length > 0 ? limitBytes(found.join('\n\n'), maxBytes) : undefined
  }
  return undefined
}

/** UTF-8 로 maxBytes 를 넘으면 글자 경계에서 자르고 "(잘림: 원래 바이트 중 남긴 바이트)" 를 붙인다 */
function limitBytes(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text, 'utf8')
  if (bytes.length <= maxBytes) return text
  let cut = maxBytes
  while (cut > 0 && (bytes[cut]! & 0xc0) === 0x80) cut-- // 이어지는 바이트(10xxxxxx) 앞에서는 자르지 않는다
  return `${bytes.subarray(0, cut).toString('utf8')}\n\n(잘림: ${bytes.length}바이트 중 ${cut})`
}

/** 진행 줄 "지시문" 항목의 글 — 그 턴 system 에 개인 지시문(.local.md)이 실렸거나 잘렸을 때만. root 는 작업 폴더(경로를 그 기준으로 적는다).
 *  실시간 턴(보낸 system)과 다시 연 기록(user info.system)이 같은 글을 얻는다 */
export function instructionsNote(system: string | undefined, root: string): string | undefined {
  if (!system) return undefined
  const locals = [...system.matchAll(HEADER)].map((match) => match[1]!.trim()).filter((file) => LOCAL_NAMES.includes(path.basename(file)))
  const truncated = TRUNCATED.exec(system)
  const notes = [
    ...(locals.length > 0 ? [tr('chat.instructionsLocal', { files: locals.map((file) => path.relative(root, file)).join(', ') })] : []),
    ...(truncated ? [tr('chat.instructionsTruncated', { total: truncated[1]!, kept: truncated[2]! })] : []),
  ]
  return notes.length > 0 ? notes.join(' · ') : undefined
}

/** 위로 올라가며 .git(폴더 또는 worktree 의 파일)이 있는 첫 폴더 */
async function gitRoot(directory: string): Promise<string | undefined> {
  for (let dir = directory; ; dir = path.dirname(dir)) {
    if (await fs.stat(path.join(dir, '.git')).then(() => true, () => false)) return dir
    if (dir === path.dirname(dir)) return undefined
  }
}
