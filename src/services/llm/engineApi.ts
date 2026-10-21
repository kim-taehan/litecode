import type { EngineConnection } from '../engine.ts'
import { subtaskSessions } from '../turnProgress.ts'
import { unfinishedCompactions } from '../history.ts'
import { tr } from '../../i18n.ts'
import { AGENT_LIST_TIMEOUT_MS, MODEL_CATALOG_TIMEOUT_MS } from './limits.ts'
import type { CatalogModel, EngineMessage } from './types.ts'

/** 레거시 호출의 폴더 쿼리 (01w: 모든 레거시 호출에 붙인다) */
export function at(directory: string): string {
  return `directory=${encodeURIComponent(directory)}`
}

// model 을 꼭 명시한다 — 빼면 opencode 가 opencode.json 의 model 을 무시하고 models.dev 카탈로그의 외부 provider(실측: nano-gpt/...)로
// 세션을 만들 때가 있다 (2026-09-30 실측). 우리 provider/모델 id 를 opencode 의 providerID/모델 id 로 그대로 쓴다.
// title 을 주면 opencode 가 제목을 만들려고 LLM 을 한 번 더 부르지 않는다 (01w — 제목은 앱이 정한다). 응답은 감싸지 않은 세션 그대로
export async function createSession(conn: EngineConnection, providerId: string, modelId: string, directory: string, title: string): Promise<string> {
  const res = await fetch(`${conn.url}/session?${at(directory)}`, {
    method: 'POST',
    headers: { ...conn.headers, 'content-type': 'application/json' },
    body: JSON.stringify({ model: { providerID: providerId, id: modelId }, title }),
  })
  if (!res.ok) throw new Error(tr('error.sessionCreate', { status: res.status }))
  return ((await res.json()) as { id: string }).id
}

// 보내기 전에 opencode 모델 카탈로그에 그 모델이 있는지 본다 (신규 세대 /api/model — 읽기 전용). 레거시는 없는 모델을 session.error 로 거절하지만
// (01w), 화면에 알맞은 사유("모델 없음")를 주고 보내지 않으려고 먼저 본다. 카탈로그는 지연 로드라 첫 응답이 빈 목록일 수 있고 세 단계로 채워진다
// (빈 목록 → models.dev 원본 → 설정 반영, 2026-09-30 실측) — **찾는 모델이 나올 때까지** 다시 묻는다. 기한까지 안 나오면 없다고 본다.
// 카탈로그는 디렉터리별이다(전역 설정 + 그 폴더의 opencode.json) — 세션의 폴더 것을 본다.
export async function waitForModel(conn: EngineConnection, providerId: string, modelId: string, directory: string): Promise<CatalogModel | undefined> {
  const deadline = Date.now() + MODEL_CATALOG_TIMEOUT_MS
  while (true) {
    const models = await listModels(conn, directory)
    const found = models.find((model) => model.providerID === providerId && model.id === modelId)
    if (found) return found
    if (Date.now() >= deadline) return undefined
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
}

// 쿼리 이름은 `location[directory]` (deepObject). 틀린 이름(`?directory=`)이면 opencode 는 200 에 서버 cwd 의
// 카탈로그를 조용히 준다 (2026-09-30 실측) — engine.live.test.ts 의 "주소를 바꾸면 거부" 시나리오가 이것을 지킨다.
export async function listModels(conn: EngineConnection, directory: string): Promise<CatalogModel[]> {
  const query = new URLSearchParams({ 'location[directory]': directory })
  const res = await fetch(`${conn.url}/api/model?${query}`, { headers: conn.headers })
  if (!res.ok) throw new Error(tr('error.modelList', { status: res.status }))
  return ((await res.json()) as { data: CatalogModel[] }).data
}

// 모드의 에이전트가 그 폴더의 에이전트 목록에 있는지 — 레거시는 없는 이름을 session.error 로 거절하지만 idle 이 오지 않는다(01w).
// 목록은 지연 로드라 첫 응답이 빈 목록일 수 있다(01f ~1.5초) — 모델처럼 나올 때까지 묻는다. subagent·hidden 은 primary 로 못 쓴다
export async function waitForAgent(conn: EngineConnection, agent: string, directory: string): Promise<boolean> {
  const deadline = Date.now() + AGENT_LIST_TIMEOUT_MS
  const query = new URLSearchParams({ 'location[directory]': directory })
  while (true) {
    const res = await fetch(`${conn.url}/api/agent?${query}`, { headers: conn.headers })
    if (!res.ok) throw new Error(tr('error.agentList', { status: res.status }))
    const agents = ((await res.json()) as { data: { id: string; mode?: string; hidden?: boolean }[] }).data
    if (agents.some((entry) => entry.id === agent && entry.mode !== 'subagent' && !entry.hidden)) return true
    if (Date.now() >= deadline) return false
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
}

/** 끝나지 않은(멈췄거나 실패한) 손 요약의 메시지를 지운다. 요약 요청(sent)이 돌아올 때까지 기다린다 — 멈춤이 요약 시작보다 빨랐으면 엔진은
 *  아직 요약을 돌리고 있다, 돌아올 때까지 다시 멈춘다 */
export async function dropUnfinishedCompactions(conn: EngineConnection, sessionId: string, workdir: string, sent: Promise<unknown>): Promise<void> {
  const settled = sent.then(() => true, () => true)
  while (!(await Promise.race([settled, new Promise<false>((resolve) => setTimeout(() => resolve(false), 100))]))) await abort(conn, sessionId, workdir)
  for (const id of unfinishedCompactions(await engineMessages(conn, sessionId, workdir))) {
    await fetch(`${conn.url}/session/${sessionId}/message/${id}?${at(workdir)}`, { method: 'DELETE', headers: conn.headers })
  }
}

/** 레거시 세션의 메시지 전부 (오래된 것부터). limit=N 은 최근 N개만 (01w) — 반환은 항상 오래된 것부터. 더 있나 (more)는 부를 때만 안다 */
export async function engineMessages(conn: EngineConnection, sessionId: string, workdir: string, limit?: number): Promise<EngineMessage[]> {
  const params = limit !== undefined && limit > 0 ? `limit=${limit}` : ''
  const res = await fetch(`${conn.url}/session/${sessionId}/message?${at(workdir)}${params ? `&${params}` : ''}`, { headers: conn.headers })
  if (!res.ok) throw new Error(tr('error.messageRead', { status: res.status }))
  return (await res.json()) as EngineMessage[]
}

/** 자식 세션 기록을 이어 읽는다 (#31 — 부모 task 파트 metadata.sessionId). 자식 하나를 못 읽어도 대화는 연다 — 그 하위 작업 줄이 비어 보일 뿐 */
export async function subtaskMessages(conn: EngineConnection, raw: readonly EngineMessage[], workdir: string): Promise<Map<string, EngineMessage[]>> {
  const ids = [...new Set(subtaskSessions(raw))]
  const read = await Promise.all(ids.map((id) => engineMessages(conn, id, workdir).then((messages) => [id, messages] as const, () => undefined)))
  return new Map(read.filter((entry) => entry !== undefined))
}

/** opencode 의 그 세션 턴을 멈춘다 — `POST /session/{id}/abort?directory=` 는 200 true 뒤 session.error(MessageAbortedError) → idle(두 번) (01w 8회).
 *  실패는 삼킨다(결과는 어차피 "중단됨") */
export async function abort(conn: EngineConnection, sessionId: string, workdir: string): Promise<void> {
  await fetch(`${conn.url}/session/${sessionId}/abort?${at(workdir)}`, { method: 'POST', headers: conn.headers }).catch(() => {})
}
