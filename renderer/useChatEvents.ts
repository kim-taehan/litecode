import { useEffect, type Dispatch, type RefObject, type SetStateAction } from 'react'
import type { ChatEvent } from '../shared/ipc.ts'
import { applyChat, withStoredTitles } from './chatState.ts'
import { fromConversation, type Session } from './session.ts'

interface ChatEventsOptions {
  setSessions: Dispatch<SetStateAction<Session[]>>
  setFresh: Dispatch<SetStateAction<ReadonlySet<string>>>
  /** 비동기 이벤트가 지금 대화 목록을 보게 */
  sessionsRef: RefObject<Session[]>
  updateSession(id: string, mutate: (session: Session) => Session): void
  forgetPruned(ids: string[]): void
  /** 턴이 시작된 대화 — 보는 대화면 맨 아래를 따라간다 */
  follow(cid: string): void
}

/** 메인(ctx.chat)이 보내는 대화 이벤트와 `!명령` 카드의 출력 조각을 화면의 대화 목록에 입힌다. 첫 그리기의 함수로 한 번만 구독한다 */
export function useChatEvents({ setSessions, setFresh, sessionsRef, updateSession, forgetPruned, follow }: ChatEventsOptions): void {
  // 대화의 턴·대기열은 메인(ctx.chat)이 쥔다 — 내 말·진행 줄·승인 카드·답·대기열을 이벤트로 받아 그 대화에 입힌다 (대화 id 로 온다).
  // 제목·시각·통계도 메인이 저장한 것이 실려 온다. 턴이 시작되면 맨 아래를 따라간다
  useEffect(() => {
    const apply = (event: ChatEvent & { data: { cid: string } }) => updateSession(event.data.cid, (session) => applyChat(session, event))
    const offs = [
      window.litecode.onTurnStarted((data) => {
        // 보는 대화의 턴일 때만 — 다른 대화의 턴이 지금 읽던 자리를 맨 아래로 끌고 가지 않게
        follow(data.cid)
        // 화면이 모르는 대화의 턴 — 화면 밖(짝지은 폰)에서 새로 만든 대화다. 메인이 저장한 목록 정보로 목록에 넣는다.
        // 내용은 이 턴이 전부라 엔진에서 다시 부르지 않는다 (history 없음 = 이번 실행에 만든 대화)
        if (!sessionsRef.current.some((session) => session.id === data.cid)) {
          const created: Session = { ...fromConversation(data.conversation), history: undefined }
          setSessions((sessionsNow) => (sessionsNow.some((session) => session.id === data.cid) ? sessionsNow : [created, ...sessionsNow]))
          if (data.origin !== 'user') setFresh((now) => new Set(now).add(data.cid))
        }
        apply({ event: 'turn.started', data })
      }),
      window.litecode.onTurnProgress((cid, item) => {
        apply({ event: 'turn.progress', data: { cid, item } })
      }),
      window.litecode.onTurnAttention((cid, requests) => apply({ event: 'turn.attention', data: { cid, requests } })),
      window.litecode.onTurnEnded((data) => {
        apply({ event: 'turn.ended', data })
      }),
      window.litecode.onTurnInterjected((data) => apply({ event: 'turn.interjected', data })),
      window.litecode.onQueueChanged((data) => apply({ event: 'queue.changed', data })),
      window.litecode.onConversationsChanged((data) => {
        forgetPruned(data.removed)
        // 메인이 바꾼 제목(자동 대화 제목 #215 등)은 턴 이벤트에 안 실린다 — 목록을 다시 읽어 입힌다
        void window.litecode.listConversations().then((stored) => setSessions((sessionsNow) => withStoredTitles(sessionsNow, stored)), () => {})
      }),
    ]
    return () => offs.forEach((off) => off())
  }, [])
  // 돌고 있는 `!명령` 카드의 출력 조각 — 카드 id 로 찾는다
  useEffect(
    () =>
      window.litecode.onShellData((runId, chunk) =>
        setSessions((sessionsNow) =>
          sessionsNow.map((session) =>
            session.shells?.some((shell) => shell.id === runId && shell.running)
              ? { ...session, shells: session.shells.map((shell) => (shell.id === runId ? { ...shell, output: shell.output + chunk } : shell)) }
              : session,
          ),
        ),
      ),
    [],
  )
}
