// 도구가 바꾼 파일 — opencode 도구 결과(structured)를 화면이 그리는 중립 모양(FileDiff)으로 바꾼다. 진행 이벤트(turnProgress.ts)와
// 기록(turnProgress.messageItems·trajectory.ts)이 같은 함수를 쓴다. opencode 형식을 아는 곳이라 엔진을 바꾸면 이것도 바꾼다.
//
// 실측 (2026-10-02, opencode 1.18.18, _workspace/01p_diff.md 2-a):
// - edit·apply_patch: structured.files[] = {file(세션 폴더 상대), patch(unified, jsdiff 형식, 문맥 3), additions, deletions, status}.
//   같은 값이 /message 기록의 state.structured 에도 남는다 (git 무관)
// - write: patch 가 없다 — {operation, target, resource(상대), existed}. 새 파일이면 인자 content 전부가 추가다.
//   덮어쓰기(existed:true)는 옛 내용을 모른다 → 새 내용을 추가로 보이고 unknownBefore 로 그렇다고 말한다

/** 파일 하나의 변경. patch 는 unified diff 본문 (@@ hunk 들) */
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
  file?: unknown
  patch?: unknown
  additions?: unknown
  deletions?: unknown
  status?: unknown
}

/** 도구 이름·인자·structured → 바꾼 파일들. 파일을 안 바꿨으면 undefined */
export function toolDiffs(name: string, input: unknown, structured: unknown): FileDiff[] | undefined {
  if (!structured || typeof structured !== 'object') return undefined
  const result = structured as { files?: unknown; resource?: unknown; existed?: unknown }
  if (Array.isArray(result.files)) {
    const diffs = (result.files as RawFile[]).map((file): FileDiff => ({
      path: String(file.file ?? ''),
      status: file.status === 'added' || file.status === 'deleted' ? file.status : 'modified',
      added: Number(file.additions ?? 0),
      removed: Number(file.deletions ?? 0),
      patch: String(file.patch ?? ''),
    }))
    return diffs.length > 0 ? diffs : undefined
  }
  if (name === 'write' && typeof result.resource === 'string') {
    const content = (input as { content?: unknown } | undefined)?.content
    const lines = typeof content === 'string' && content !== '' ? content.replace(/\n$/, '').split('\n') : []
    const diff: FileDiff = {
      path: result.resource,
      status: result.existed ? 'modified' : 'added',
      added: lines.length,
      removed: 0,
      patch: lines.length > 0 ? `@@ -0,0 +1,${lines.length} @@\n${lines.map((line) => `+${line}\n`).join('')}` : '',
    }
    if (result.existed) diff.unknownBefore = true
    return [diff]
  }
  return undefined
}
