// 폰 알림의 규칙 (이슈 #71) — 순수 TS 다(React Native 를 모른다). 공식 푸시(FCM/APNs)는 쓰지 않는다: 폐쇄망이고 중계 서버가 없다.
// 폰은 데스크탑과의 연결(이벤트 스트림)로 소식을 받아 **스스로** 알린다 — 그래서 연결이 살아 있는 동안만 알림이 온다.
//
// 알릴 일 (데스크탑 ctx.notifications 와 같은 뜻 — src/services/notifications.ts):
// - 답 필요: `turn.attention` 에 새 승인·질문이 왔다 (같은 요청은 한 번만 — 목록은 올 때마다 전부 실려 온다)
// - 완료·실패: `turn.ended` 의 outcome. 중단(사용자가 멈춤)·거절(사용자가 승인을 거절)은 알리지 않는다 — 사람이 한 일이다
// - 지금 보고 있는 대화(앱이 앞에 있고 그 대화 화면)의 일은 알리지 않는다
// 어디로: 앱이 앞이면 화면 위 띠(몇 초), 뒤면 시스템 로컬 알림. 대화마다 최신 하나(같은 키로 덮는다).
// 거두기: 대기가 풀렸다·새 턴이 시작됐다·그 대화를 열었다 → 그 대화의 알림을 지운다.
// **스냅샷으로는 알리지 않는다** — 이벤트만 본다. 다시 붙어 스냅샷을 새로 받아도(reset) 옛 일이 다시 울리지 않는다.
// (끊긴 사이의 이벤트가 `after` 로 재생되면 그것은 놓친 새 일이라 알린다. 이미 본 seq 는 Connection 이 걸러 여기 오지 않는다.)

import type { Attention } from '../../../shared/contract.ts'
import type { RemoteEvent } from '../../../shared/remote.ts'
import type { RemoteState } from '../core/index.ts'
import type { AppSession } from './session.ts'
import { S } from './strings.ts'

export type AlertKind = 'attention' | 'done' | 'failed'

export interface Alert {
  cid: string
  kind: AlertKind
  /** 답 필요일 때 무엇을 묻는지 한 줄 — 승인이면 명령·도구, 질문이면 질문 글 */
  detail?: string
}

export interface AlertText {
  title: string
  body: string
}

export type AlertAction =
  /** 화면 위 띠 (앱이 앞) */
  | { type: 'banner'; alert: Alert }
  /** 시스템 알림 (앱이 뒤) */
  | { type: 'system'; alert: Alert }
  /** 그 대화의 시스템 알림·띠를 거둔다 */
  | { type: 'dismiss'; cid: string }

export interface AlertContext {
  /** 설정의 "알림" 스위치 */
  enabled: boolean
  /** 앱이 앞에 있다 */
  foreground: boolean
  /** 지금 열어 둔 대화 화면 */
  viewing?: string
}

/** 띠가 떠 있는 시간 */
export const BANNER_MS = 5_000
const DETAIL_MAX = 120

/** 시스템 알림의 대체 키 — 대화마다 하나. 같은 키로 다시 내면 앞의 것이 바뀐다 */
export function alertKey(cid: string): string {
  return `conversation:${cid}`
}

/** 알림 채널 — 답 필요(중요도 높음)와 결과(기본) 둘 */
export function alertChannel(kind: AlertKind): 'attention' | 'result' {
  return kind === 'attention' ? 'attention' : 'result'
}

function oneLine(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > DETAIL_MAX ? `${line.slice(0, DETAIL_MAX - 1)}…` : line
}

function attentionDetail(request: Attention): string | undefined {
  if (request.kind === 'question') return oneLine(request.questions[0]?.question ?? '') || undefined
  if (request.mcp) return `${request.mcp.server}/${request.mcp.tool}`
  return oneLine(request.resources[0] ?? request.action) || undefined
}

export class AlertRules {
  /** 대화 → 이미 알린(또는 본) 요청 id */
  private readonly seen = new Map<string, Set<string>>()

  decide(event: RemoteEvent, context: AlertContext): AlertAction[] {
    const watching = (cid: string): boolean => context.foreground && context.viewing === cid
    const raise = (alert: Alert): AlertAction[] => [{ type: context.foreground ? 'banner' : 'system', alert }]

    switch (event.event) {
      case 'turn.attention': {
        const { cid, requests } = event.data
        const known = this.seen.get(cid)
        const fresh = requests.filter((request) => !known?.has(request.id))
        this.seen.set(cid, new Set(requests.map((request) => request.id)))
        if (requests.length === 0) return [{ type: 'dismiss', cid }]
        const latest = fresh[fresh.length - 1]
        if (!latest || !context.enabled || watching(cid)) return []
        const detail = attentionDetail(latest)
        return raise({ cid, kind: 'attention', ...(detail !== undefined && { detail }) })
      }
      case 'turn.ended': {
        const { cid, outcome, message } = event.data
        this.seen.delete(cid)
        if (outcome === 'interrupted' || message.declined || watching(cid)) return [{ type: 'dismiss', cid }]
        if (!context.enabled) return []
        return raise({ cid, kind: outcome === 'failed' ? 'failed' : 'done' })
      }
      case 'turn.started':
        return [{ type: 'dismiss', cid: event.data.cid }]
      default:
        return []
    }
  }
}

/** 알림 글 — 제목은 대화 제목, 본문은 "프로젝트 · 상태"(+ 무엇을 묻는지 한 줄). 원문(답·오류)은 싣지 않는다 */
export function alertText(alert: Alert, state: RemoteState): AlertText {
  const conversation = Object.values(state.conversations)
    .flat()
    .find((candidate) => candidate.id === alert.cid)
  const project = state.projects.find((candidate) => candidate.path === conversation?.project)
  const status = alert.kind === 'attention' ? S.needsAnswer : alert.kind === 'failed' ? S.failed : S.done
  const head = [project?.name, status].filter(Boolean).join(' · ')
  return { title: conversation?.title || S.untitled, body: alert.detail ? `${head}\n${alert.detail}` : head }
}

/** OS 알림을 내는 쪽 (platform/notifications.ts — expo-notifications). 테스트는 기록하는 host */
export interface AlertHost {
  notify(key: string, channel: 'attention' | 'result', text: AlertText, cid: string): void
  dismiss(key: string): void
}

export type Banner = AlertText & { cid: string; kind: AlertKind }

/** 세션의 이벤트를 규칙에 넣고, 나온 것을 띠(자기 상태)와 시스템 알림(host)으로 보낸다 */
export class AlertCenter {
  private readonly rules = new AlertRules()
  private readonly listeners = new Set<() => void>()
  private current: Banner | undefined
  private timer: ReturnType<typeof setTimeout> | undefined
  private viewing: string | undefined
  private detach: (() => void) | undefined

  constructor(private readonly deps: { host: AlertHost; prefs: () => { notifications: boolean }; foreground: () => boolean }) {}

  /** 지금 떠 있는 띠 */
  get banner(): Banner | undefined {
    return this.current
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** 이 세션의 이벤트를 듣는다 (앞의 세션은 놓는다) */
  attach(session: AppSession): void {
    this.detach?.()
    this.detach = session.onEvent((event) => {
      const context: AlertContext = { enabled: this.deps.prefs().notifications, foreground: this.deps.foreground(), ...(this.viewing !== undefined && { viewing: this.viewing }) }
      for (const action of this.rules.decide(event, context)) {
        if (action.type === 'dismiss') this.clear(action.cid)
        else if (action.type === 'system') this.deps.host.notify(alertKey(action.alert.cid), alertChannel(action.alert.kind), alertText(action.alert, session.getState()), action.alert.cid)
        else this.show({ ...alertText(action.alert, session.getState()), cid: action.alert.cid, kind: action.alert.kind })
      }
    })
  }

  /** 지금 보고 있는 대화 (없으면 undefined) — 열면 그 대화의 알림·띠를 지운다 */
  view(cid: string | undefined): void {
    this.viewing = cid
    if (cid !== undefined) this.clear(cid)
  }

  closeBanner(): void {
    clearTimeout(this.timer)
    if (this.current === undefined) return
    this.current = undefined
    this.notify()
  }

  dispose(): void {
    this.detach?.()
    this.detach = undefined
    this.closeBanner()
  }

  private show(banner: Banner): void {
    clearTimeout(this.timer)
    this.current = banner
    this.timer = setTimeout(() => this.closeBanner(), BANNER_MS)
    this.notify()
  }

  private clear(cid: string): void {
    this.deps.host.dismiss(alertKey(cid))
    if (this.current?.cid === cid) this.closeBanner()
  }

  private notify(): void {
    for (const listener of this.listeners) listener()
  }
}
