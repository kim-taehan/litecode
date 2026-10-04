import type { PresentedFile, TurnItem } from '../shared/contract.ts'

// 턴 끝 "결과물" 카드 (이슈 #91) 의 데이터 — AI 가 앱 MCP 의 present 로 선언한 파일. 새 저장은 없다: 성공한 선언 줄에 실린 presented
// (turnProgress.ts — 그 호출의 인자)를 턴 단위로 모은다. 실시간 턴과 다시 연 대화가 같은 줄(TurnItem)을 쓰므로 같은 함수로 같은 카드가 나온다.
// 하위 작업 안의 선언은 세지 않는다 — 결과물은 메인 대화가 선언한다 (엔진 규칙도 하위 에이전트에서 이 도구를 뺀다, engine.ts)

/** 앱 MCP 서버의 present 도구 (엔진 이름 `litecode_present`) — 화면은 McpToolRef 로 가른다 */
const PRESENT_SERVER = 'litecode'
const PRESENT_TOOL = 'present'

/** 결과물 선언 줄인가 (도는 중·거절된 것도) — 줄 이름을 "MCP · litecode · present" 대신 "결과물" 로 */
export function isPresentTool(item: TurnItem): boolean {
  return item.kind === 'tool' && item.mcp?.server === PRESENT_SERVER && item.mcp.tool === PRESENT_TOOL
}

/** 턴의 진행 줄 → 선언한 결과물. 같은 파일을 여러 번 선언하면 한 줄 — 자리는 처음, 제목은 마지막에 준 것. 하나도 없으면 undefined (카드를 그리지 않는다) */
export function presentedFiles(items: readonly TurnItem[]): PresentedFile[] | undefined {
  const files = new Map<string, PresentedFile>()
  for (const item of items) {
    if (item.kind !== 'tool' || item.status !== 'done' || !item.presented) continue
    for (const file of item.presented) {
      const title = file.title ?? files.get(file.path)?.title
      files.set(file.path, { path: file.path, ...(title && { title }) })
    }
  }
  return files.size > 0 ? [...files.values()] : undefined
}
