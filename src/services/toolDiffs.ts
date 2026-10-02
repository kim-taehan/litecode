import path from 'node:path'

// 도구가 바꾼 파일 — opencode 도구 결과를 화면이 그리는 중립 모양(FileDiff)으로 바꾼다. 진행 이벤트(turnProgress.ts)와
// 기록(turnProgress.messageItems·trajectory.ts)이 같은 함수를 쓴다. opencode 형식을 아는 곳이라 엔진을 바꾸면 이것도 바꾼다.
//
// 레거시 경로 실측 (2026-10-02, opencode 1.18.18 — 이슈 #20 L2, 01w 1절 diff 행 + 바이너리의 도구 코드):
// - edit: state.metadata.filediff = {file(**절대 경로**), patch(**`Index:`·`===`·`---`·`+++` 머리 포함** — jsdiff createTwoFilesPatch, 문맥 3),
//   additions, deletions}. status 가 없다 — 빈 파일에서 시작한(oldString "" 로 새 파일) patch 는 `@@ -0,0` 이다
// - write: patch 가 없다 — metadata {filepath(절대), exists}. 새 파일이면 인자 content 전부가 추가다.
//   덮어쓰기(exists:true)는 옛 내용을 모른다 → 새 내용을 추가로 보이고 unknownBefore 로 그렇다고 말한다
// - apply_patch: 모델 id 에 `gpt-`(oss·gpt-4 제외)가 있을 때만 있다(그때는 edit·write 가 없다). metadata.files[] =
//   {filePath(절대), relativePath, type: add|update|delete|move, patch(머리 포함), additions, deletions, movePath}.
//   delete 의 deletions 는 줄 수 + 1 로 센다(`split("\n")`) → 추가·삭제 수는 patch 의 줄에서 다시 센다
// - 경로는 세션 폴더(root) 기준 상대로 바꾼다 — opencode 의 title·relativePath 는 worktree 기준인데 git 이 아닌 폴더의 worktree 는 `/` 다
// - 화면의 diffRows 는 @@ 앞 머리 줄을 건너뛰므로 patch 는 머리째 넘긴다

/** 파일 하나의 변경. patch 는 unified diff (@@ hunk 들, 앞에 파일 머리가 있을 수 있다) */
export interface FileDiff {
  path: string
  status: 'added' | 'modified' | 'deleted'
  added: number
  removed: number
  patch: string
  /** write 로 덮어써서 이전 내용을 모른다 — patch 는 새 내용 전부를 추가로 */
  unknownBefore?: true
}

interface RawFile {
  filePath?: unknown
  movePath?: unknown
  type?: unknown
  patch?: unknown
}

/** 도구 이름·인자·state.metadata → 바꾼 파일들. root 는 세션 폴더(realpath). 파일을 안 바꿨으면 undefined */
export function toolDiffs(name: string, input: unknown, metadata: unknown, root: string): FileDiff[] | undefined {
  if (!metadata || typeof metadata !== 'object') return undefined
  const result = metadata as { filediff?: { file?: unknown; patch?: unknown }; files?: unknown; filepath?: unknown; exists?: unknown }
  const shown = (file: unknown): string => relative(root, String(file ?? ''))
  if (name === 'edit' && result.filediff && typeof result.filediff.patch === 'string') {
    const patch = result.filediff.patch
    const { added, removed } = countLines(patch)
    return [{ path: shown(result.filediff.file), status: /^@@ -0,0 /m.test(patch) && removed === 0 ? 'added' : 'modified', added, removed, patch }]
  }
  if (name === 'apply_patch' && Array.isArray(result.files)) {
    const diffs = (result.files as RawFile[]).map((file): FileDiff => {
      const patch = String(file.patch ?? '')
      return {
        path: shown(file.movePath ?? file.filePath),
        status: file.type === 'add' ? 'added' : file.type === 'delete' ? 'deleted' : 'modified',
        ...countLines(patch),
        patch,
      }
    })
    return diffs.length > 0 ? diffs : undefined
  }
  if (name === 'write' && typeof result.filepath === 'string') {
    const content = (input as { content?: unknown } | undefined)?.content
    const lines = typeof content === 'string' && content !== '' ? content.replace(/\n$/, '').split('\n') : []
    const diff: FileDiff = {
      path: shown(result.filepath),
      status: result.exists ? 'modified' : 'added',
      added: lines.length,
      removed: 0,
      patch: lines.length > 0 ? `@@ -0,0 +1,${lines.length} @@\n${lines.map((line) => `+${line}\n`).join('')}` : '',
    }
    if (result.exists) diff.unknownBefore = true
    return [diff]
  }
  return undefined
}

/** 세션 폴더 안이면 상대 경로, 밖이면 절대 경로 그대로 */
function relative(root: string, file: string): string {
  if (!root || !path.isAbsolute(file)) return file
  const rel = path.relative(root, file)
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel.split(path.sep).join('/') : file
}

/** patch 의 hunk 본문에서 추가·삭제 줄 수 (머리의 `---`·`+++` 는 hunk 밖이라 세지 않는다) */
function countLines(patch: string): { added: number; removed: number } {
  let added = 0
  let removed = 0
  let oldLeft = 0
  let newLeft = 0
  for (const line of patch.split('\n')) {
    const hunk = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(line)
    if (oldLeft <= 0 && newLeft <= 0) {
      if (hunk) {
        oldLeft = Number(hunk[1] ?? 1)
        newLeft = Number(hunk[2] ?? 1)
      }
      continue
    }
    if (line.startsWith('\\')) continue
    if (line.startsWith('+')) {
      added++
      newLeft--
    } else if (line.startsWith('-')) {
      removed++
      oldLeft--
    } else {
      oldLeft--
      newLeft--
    }
  }
  return { added, removed }
}
