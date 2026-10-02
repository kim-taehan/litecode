import { Context, Service } from 'cordis'
import path from 'node:path'
import type { Conversation } from './sessions.ts'
import type { TurnInfo } from './llm.ts'
import { tr } from '../i18n.ts'

// 알림 (ctx.notifications) — ctx.llm 이 내는 턴 이벤트를 받아 앱 알림(토스트·점)이나 PC 알림(OS 알림)으로 바꾼다.
// ctx.llm 은 알림을 모른다: 이 플러그인을 빼면 알림만 사라진다 (사용자 승인 2026-10-02, _workspace/00_next_notifications.md).
//
// 판정 (사용자 결정 Q2, 01i 9절 G1): 사건 순간 앱 창이 없거나 포커스가 없으면 PC 알림, 앞이면 앱 알림(토스트 + 점).
// 앞인데 보고 있는 그 대화면 아무것도 안 한다. "어느 대화를 보는지" 는 화면이 view() 로 알려 준다.
// PC 알림은 대화마다 최신 하나(Q7) — 같은 대화의 이전 것은 닫는다. 문구는 대화 제목 + "프로젝트 · 상태" 뿐(Q5 — 답·질문·오류 원문 없음).
// 중단(엔진 재시작)은 PC 알림 없이 앱 안 표시만(Q10). 설정 > 일반 "알림" 을 끄면 PC 알림만 없다(Q9).
// 상태(실행 중 / 답 필요 / 안 본 완료·실패·중단)는 메인이 쥐는 정본이고 메모리에만 둔다 — 화면은 snapshot 을 받아 점을 그린다.
// 누르면: 창을 앞으로(host.reveal) → 열 대상을 적어 두고 화면에 신호 → 화면이 takePendingOpen 으로 당겨 가 기존 프로젝트 열기 경로로 연다
// (새로 만든 창은 리스너가 걸리기 전이라 신호만으로는 잃는다 — 01i 10-a). 앱 종료 때 남은 PC 알림은 다 닫는다(10-b).
//
// Electron 을 모른다 — 창·OS 알림·배지는 host 로 받는다 (electron/notificationHost.ts, 테스트는 기록하는 host).

/** PC 알림 · 토스트의 사건 */
export type NoticeKind = 'done' | 'failed' | 'interrupted' | 'question' | 'permission'
/** 대화 행 점 — 답 필요(attention) > 실행 중 > 안 본 끝남(done·failed·interrupted) */
export type ConversationStatus = 'running' | 'attention' | 'done' | 'failed' | 'interrupted'

export interface NoticeEntry {
  /** 그 대화의 프로젝트(작업 폴더) — 프로젝트 전환 버튼·팝오버 점에 쓴다 */
  project: string
  status: ConversationStatus
}

/** 대화 id → 상태. 아무 표시도 없는 대화는 빠진다 */
export type NoticeState = Record<string, NoticeEntry>

/** 앞일 때 화면에 띄울 토스트 */
export interface Toast {
  conversationId: string
  project: string
  projectName: string
  /** 대화 제목 — 빈 값이면 화면이 "새 대화" 로 번역한다 */
  title: string
  kind: NoticeKind
}

/** 알림을 눌러 열 곳 */
export interface OpenTarget {
  conversationId: string
  project: string
}

export interface SystemNotification {
  close(): void
}

/** 창·OS 쪽 — 메인이 Electron 으로(또는 테스트 모드면 기록으로) 채운다 */
export interface NotificationHost {
  /** 앱 창이 있고 포커스가 있나 */
  isForeground(): boolean
  /** PC 알림 — 돌려준 것을 쥐고 있어야 click 이 온다(GC) */
  show(note: { title: string; body: string }, onClick: () => void): SystemNotification
  /** dock 배지 — 주의가 필요한 대화 수 (0 이면 지운다) */
  setBadge(count: number): void
  /** 창 확보(없으면 만들기)·복원·보이기·포커스 */
  reveal(): void
}

declare module 'cordis' {
  interface Context {
    notifications: NotificationsService
  }
  interface Events {
    /** 상태가 바뀌었다 — 메인이 화면에 흘린다 */
    'notifications/changed'(state: NoticeState): void
    /** 앞일 때의 앱 알림 */
    'notifications/toast'(toast: Toast): void
    /** PC 알림을 눌렀다 — 화면이 takePendingOpen 으로 열 곳을 당겨 간다 */
    'notifications/open'(): void
    // ↓ 라운드 A 가 llm.ts 에 선언하면 이 두 줄을 지운다 (turn-* 는 llm.ts 에 있다)
    'llm/attention'(info: TurnInfo & { kind: 'permission' | 'question'; title: string }): void
    'llm/attention-resolved'(info: TurnInfo): void
  }
}

/** 사건을 어디로 — 창이 없거나 포커스가 없으면 PC, 앞이고 그 대화를 보고 있으면 없음, 앞이면 앱 */
export function route({ foreground, viewing, conversationId }: { foreground: boolean; viewing?: string; conversationId: string }): 'system' | 'app' | 'none' {
  if (!foreground) return 'system'
  return viewing === conversationId ? 'none' : 'app'
}

interface Entry {
  project: string
  running: boolean
  attention?: 'permission' | 'question'
  unread?: 'done' | 'failed' | 'interrupted'
}

export class NotificationsService extends Service {
  static readonly inject = ['settings', 'sessions', 'projects']

  private entries = new Map<string, Entry>()
  /** 대화 id → 떠 있는 PC 알림 (참조를 쥐어야 click 이 온다) */
  private shown = new Map<string, { note: SystemNotification; attention: boolean }>()
  private viewing?: string
  private pendingOpen?: OpenTarget
  /** 이벤트를 받은 순서대로 처리한다 — 대화를 찾는 비동기 조회 때문에 started·ended 가 뒤바뀌지 않게 */
  private queue: Promise<void> = Promise.resolve()

  constructor(
    ctx: Context,
    private host: NotificationHost,
  ) {
    super(ctx, 'notifications')
    ctx.on('llm/turn-started', (info) => this.enqueue(info.sessionId, (entry) => {
      entry.running = true
      entry.unread = undefined
    }))
    ctx.on('llm/turn-ended', (info) => this.enqueue(info.sessionId, (entry, conversation) => {
      entry.running = false
      entry.attention = undefined
      return this.announce(conversation, entry, info.outcome)
    }))
    ctx.on('llm/attention', (info) => this.enqueue(info.sessionId, (entry, conversation) => {
      entry.attention = info.kind
      return this.announce(conversation, entry, info.kind)
    }))
    ctx.on('llm/attention-resolved', (info) => this.enqueue(info.sessionId, (entry, conversation) => {
      entry.attention = undefined
      if (this.shown.get(conversation.id)?.attention) this.close(conversation.id)
    }))
    ctx.on('sessions/removed', (ids) => {
      for (const id of ids) this.forget(id)
      this.publish()
    })
    ctx.on('projects/removed', (dir) => {
      for (const [id, entry] of this.entries) if (entry.project === dir) this.forget(id, true)
      this.publish()
    })
    ctx.effect(() => () => {
      for (const id of [...this.shown.keys()]) this.close(id)
    })
  }

  /** 화면에 그릴 상태 */
  snapshot(): NoticeState {
    const state: NoticeState = {}
    for (const [id, entry] of this.entries) {
      const status = statusOf(entry)
      if (status) state[id] = { project: entry.project, status }
    }
    return state
  }

  /** 화면이 지금 보여 주는 대화 (없으면 undefined). 앞이면 그 대화를 읽음으로 */
  view(conversationId?: string): void {
    this.viewing = conversationId
    if (conversationId && this.host.isForeground()) this.read(conversationId)
  }

  /** 창이 포커스를 얻었다 — 보고 있던 대화를 읽음으로 */
  focused(): void {
    if (this.viewing) this.read(this.viewing)
  }

  /** 누른 알림의 열 곳 — 한 번 당겨 가면 비운다 */
  takePendingOpen(): OpenTarget | undefined {
    const target = this.pendingOpen
    this.pendingOpen = undefined
    return target
  }

  /** 받은 이벤트를 다 처리할 때까지 (테스트용) */
  idle(): Promise<void> {
    return this.queue
  }

  private enqueue(sessionId: string, apply: (entry: Entry, conversation: Conversation) => void | Promise<void>): void {
    this.queue = this.queue.then(async () => {
      const conversation = (await this.ctx.sessions.list()).find((entry) => entry.engineSessionId === sessionId)
      if (!conversation) return // 앱이 모르는 세션 — 알릴 곳이 없다
      const entry = this.entries.get(conversation.id) ?? { project: conversation.project, running: false }
      this.entries.set(conversation.id, entry)
      await apply(entry, conversation)
      if (!statusOf(entry)) this.entries.delete(conversation.id)
      this.publish()
    }).catch((error: unknown) => console.error('[notifications] 처리 실패', error))
  }

  private async announce(conversation: Conversation, entry: Entry, kind: NoticeKind): Promise<void> {
    const where = route({ foreground: this.host.isForeground(), viewing: this.viewing, conversationId: conversation.id })
    this.close(conversation.id) // 대화마다 최신 하나 — 새 사건이면 이전 PC 알림은 낡았다
    if (where === 'none') return // 보고 있다 — 화면에 이미 보인다
    if (kind === 'done' || kind === 'failed' || kind === 'interrupted') entry.unread = kind
    const projectName = await this.projectName(conversation.project)
    if (where === 'app') {
      this.ctx.emit('notifications/toast', { conversationId: conversation.id, project: conversation.project, projectName, title: conversation.title, kind })
      return
    }
    if (kind === 'interrupted' || !this.ctx.settings.get().notifications) return
    const target: OpenTarget = { conversationId: conversation.id, project: conversation.project }
    const note = this.host.show(
      { title: conversation.title || tr('sidebar.untitled'), body: tr('notify.body', { project: projectName, status: tr(`notify.${kind}`) }) },
      () => this.open(target),
    )
    this.shown.set(conversation.id, { note, attention: kind === 'question' || kind === 'permission' })
  }

  private open(target: OpenTarget): void {
    this.close(target.conversationId)
    this.pendingOpen = target
    this.host.reveal()
    this.ctx.emit('notifications/open')
  }

  /** 안 본 끝남과 그 PC 알림을 지운다 — 답 필요·실행 중은 읽음과 무관하다 */
  private read(conversationId: string): void {
    const entry = this.entries.get(conversationId)
    this.close(conversationId)
    if (!entry?.unread) return
    entry.unread = undefined
    if (!statusOf(entry)) this.entries.delete(conversationId)
    this.publish()
  }

  /** keepLive: 프로젝트를 목록에서만 뺀 것 — 실제로 돌고 있거나 답을 기다리는 대화의 점은 남긴다 */
  private forget(conversationId: string, keepLive = false): void {
    this.close(conversationId)
    const entry = this.entries.get(conversationId)
    if (!entry) return
    entry.unread = undefined
    if (!keepLive || !statusOf(entry)) this.entries.delete(conversationId)
  }

  private close(conversationId: string): void {
    this.shown.get(conversationId)?.note.close()
    this.shown.delete(conversationId)
  }

  private publish(): void {
    const state = this.snapshot()
    this.host.setBadge(Object.values(state).filter((entry) => entry.status !== 'running').length)
    this.ctx.emit('notifications/changed', state)
  }

  /** 목록의 보이는 이름, 목록에서 빠졌으면 폴더 이름 */
  private async projectName(dir: string): Promise<string> {
    return (await this.ctx.projects.list()).find((project) => project.path === dir)?.name ?? path.basename(dir)
  }
}

function statusOf(entry: Entry): ConversationStatus | undefined {
  if (entry.attention) return 'attention'
  if (entry.running) return 'running'
  return entry.unread
}
