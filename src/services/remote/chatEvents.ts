import type { Context } from 'cordis'
import { tr } from '../../i18n.ts'
import type { Conversation, NoticeState } from '../../../shared/contract.ts'
import type { RemoteEventMap, RemoteEventName } from '../../../shared/remote.ts'
import { liveStatus, remoteOrigin } from './wire.ts'

// ctx.chat·알림의 이벤트를 폰의 이벤트(계약)로 (이슈 #298 에서 remote.ts 생성자에서 옮김 — 구독 순서·시점은 그대로: 서비스 생성자가 부른다)

/** 이벤트를 옮기는 데 쓰는 서비스의 상태 — 같은 Map 을 그대로 넘긴다 */
export interface ChatEventsHost {
  /** 서비스의 this.ctx — 읽기(ctx.chat·notifications)는 이것으로 */
  ctx: Context
  /** 폰이 만든 새 대화 (RemoteService.drafts) */
  drafts: Map<string, Conversation>
  emitEvent<K extends RemoteEventName>(event: K, data: RemoteEventMap[K]): void
}

/** 구독은 생성자의 ctx 로 건다 (서비스가 내려가면 같이 풀린다) */
export function bridgeChatEvents(ctx: Context, host: ChatEventsHost): void {
  /** 도는 턴의 대화 id → 프로젝트 (notices.changed 에 싣는다 — ctx.chat 의 스냅샷에는 프로젝트가 없다) */
  const turnProjects = new Map<string, string>()
  /** 마지막으로 낸 notices.changed (JSON) — 같은 것을 두 번 내지 않는다 (알림 기능이 켜져 있으면 같은 변화가 두 길로 온다) */
  let lastNotices = '{}'

  /** 폰에 보낼 대화 상태 (#126 E3) — 진행 중·답 필요는 알림 기능(기본 꺼짐)과 무관하게 ctx.chat 의 도는 턴에서, 안 본 완료·실패·중단은
   *  알림 기능의 것 그대로. 서비스가 뜨기 전에 시작한 턴은 프로젝트를 몰라 여기엔 빠진다 (목록의 status 에는 실린다) */
  const emitNotices = (unread: NoticeState = host.ctx.get('notifications')?.snapshot() ?? {}): void => {
    const state: NoticeState = { ...unread }
    for (const [cid, live] of Object.entries(host.ctx.chat.snapshot())) {
      const status = liveStatus(live)
      const project = turnProjects.get(cid)
      if (status && project) state[cid] = { project, status }
    }
    const json = JSON.stringify(state)
    if (json === lastNotices) return
    lastNotices = json
    host.emitEvent('notices.changed', state)
  }

  // ctx.chat 의 이벤트를 계약의 이벤트로 — 데스크탑 화면에만 필요한 덧붙인 필드(conversation·held·attachments·removed)는 뺀다
  ctx.on('chat/turn-started', ({ cid, message, origin, conversation }) => {
    host.drafts.delete(cid) // 보낸 대화는 ctx.chat 이 저장했다
    turnProjects.set(cid, conversation.project)
    host.emitEvent('turn.started', { cid, message, origin: remoteOrigin(origin) })
    emitNotices()
  })
  ctx.on('chat/turn-progress', ({ cid, item }) => host.emitEvent('turn.progress', { cid, item }))
  ctx.on('chat/turn-attention', ({ cid, requests }) => {
    host.emitEvent('turn.attention', { cid, requests })
    emitNotices()
  })
  ctx.on('chat/turn-interjected', ({ cid, message }) => host.emitEvent('turn.interjected', { cid, message }))
  ctx.on('chat/turn-ended', ({ cid, message, usage, outcome, unanswered }) => {
    turnProjects.delete(cid)
    host.emitEvent('turn.ended', { cid, message, ...(usage && { usage }), outcome, ...(unanswered && { unanswered }) })
    emitNotices()
  })
  ctx.on('chat/queue-changed', ({ cid, items }) => host.emitEvent('queue.changed', { cid, items }))
  ctx.on('chat/conversations-changed', ({ project }) => host.emitEvent('conversations.changed', { project }))
  // 전체 권한은 폰에 열지 않는다 — 보낼 때(POST …/messages) 한 번 본 것으로는 대기열에 쌓인 사이 데스크탑이 full 로 바꾼 것을 못 막는다 (#186 B1).
  // 엔진에 넘기기 직전에 한 번 더 본다: 막힌 폰 글은 훅이 막은 글과 같이 대기열 맨 앞에 붙잡히고(폰이 되돌리기로 가져간다) 그 턴은 사유와 함께 실패로 끝난다
  ctx.on('chat/before-send', (send) => {
    if (send.mode === 'full' && send.origin.startsWith('device:')) send.blocked = tr('remote.fullAccessBlocked')
  })
  // 알림 기능이 꺼져 있으면 이 이벤트는 오지 않는다 (없어도 동작한다 — 진행 중·답 필요는 위 ctx.chat 이벤트로 나간다)
  ctx.on('notifications/changed', (state) => emitNotices(state))
}
