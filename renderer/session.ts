import type { Conversation, Mode } from '../shared/ipc.ts'
import type { ChatFields } from './chatState.ts'
import type { ModelRef } from './modelChoice.ts'
import type { ShellCardView } from './ShellCard.tsx'
import type { ChatUsage } from './stats.ts'

/** 말풍선·도는 턴(pending·progress·sentAt·attention)·대기열·제목·시각·통계는 메인(ctx.chat)이 정한다 — 이벤트로 받아 입힌다 (chatState.ts).
 *  답이 실패·중단이면 message.error 에 사유 (`⚠️ 사유` 로 그린다) */
export interface Session extends ChatFields {
  id: string
  /** 이 대화가 속한 프로젝트(작업 디렉터리) — 사이드바는 현재 프로젝트의 대화만 보여준다 */
  project: string
  /** 엔진 쪽 세션 id — 첫 메시지를 보낼 때 생기고, 그 뒤로는 계속 재사용한다 */
  engineSessionId?: string
  /** 입력창 드롭다운에서 고른 이 대화의 모델. 없으면(아직 안 고르고 안 보낸 새 대화) 마지막으로 고른 모델을 따른다.
   *  대화 중에 바꾸면 다음 턴부터 그 모델로 간다 (엔진 세션의 모델은 ctx.llm 이 바꾼다) */
  model?: ModelRef
  /** 입력창 칩의 모드. 없으면 설정의 "새 대화 기본 모드". 바꾸면 다음 턴을 보낼 때 엔진 세션이 그 모드가 된다 (ctx.llm) */
  mode?: Mode
  /** `!명령` 결과 카드 — 저장된 것은 메인(ctx.sessions)이 정본이고, 여기는 화면 사본 + 돌고 있는 카드 */
  shells?: ShellCardView[]
  /** 마지막 활동 시각(ms) — 목록에 `38min`·`1d` 로 보이고, 보관 개수 제한의 기준이 된다 */
  updatedAt: number
  /** 고정한 대화 (이슈 #79) — 목록 맨 위 묶음. 정본은 메인(ctx.sessions) */
  pinned?: boolean
  /** 입력창 아래 통계 줄의 값 — 턴마다 엔진이 주는 사용량·시간을 메인이 이 대화에 더한다. 없으면 "—" */
  usage?: ChatUsage
  /** 지난 실행에서 저장된 대화의 내용 상태 — 목록 정보만 저장되고 내용은 열 때 엔진에서 부른다(ctx.sessions). 이번 실행에 만든 대화는 없다 */
  history?: 'unloaded' | 'loading' | 'loaded' | 'missing'
}

export function newSession(project: string): Session {
  return { id: crypto.randomUUID(), project, title: '', messages: [], updatedAt: Date.now() }
}

/** 아직 아무것도 안 보낸 새 대화 — 저장하지 않고, 지울 것도 없다 */
export function isBlank(session: Session): boolean {
  return session.messages.length === 0 && !session.history && !session.shells?.length
}

/** 저장할 목록 정보 (말풍선·대기 상태·카드는 빼고 — 카드는 메인이 저장한다) */
export function toConversation({ id, project, engineSessionId, title, updatedAt, model, mode, usage }: Session): Conversation {
  return { id, project, engineSessionId, title, updatedAt, model, mode, usage }
}

export function fromConversation(conversation: Conversation): Session {
  return { ...conversation, usage: conversation.usage as ChatUsage | undefined, messages: [], history: 'unloaded', shells: conversation.shells }
}

/** 그 프로젝트에 대화가 하나도 없으면 새 대화를 하나 더한다 — 같은 값을 두 번 넣어도 한 번만 더해진다 */
export function withSessionFor(project: string) {
  return (current: Session[]) => (current.some((session) => session.project === project) ? current : [newSession(project), ...current])
}

/** 그 프로젝트에 빈 새 대화가 없으면 맨 앞에 더한다 — 앱을 켜면 저장된 대화 위에 새 대화로 시작한다 */
export function withBlankFor(project: string) {
  return (current: Session[]) =>
    current.some((session) => session.project === project && isBlank(session)) ? current : [newSession(project), ...current]
}

/** 내용을 다 불러온 대화에만 보낸다 — 폴더가 없는 대화는 지우기만 된다 */
export function canWrite(session: Session): boolean {
  return !session.history || session.history === 'loaded'
}
