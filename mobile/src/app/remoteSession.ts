// 진짜 세션 — 연결 코어(`Connection`)를 화면이 보는 모양(AppSession)으로 감싼다 (이슈 #62). 순수 TS 다(React Native 를 모른다 —
// transport 를 받아 쓴다. 앱은 expo/fetch 로 만든 것을, 테스트는 Node fetch 로 만든 것을 넘긴다).
// 상태는 전부 데스크탑에서 온다: 목록·대화·진행 줄·승인·대기열. 여기서 만드는 것은 "보내지 못했다" 같은 안내(notice)뿐이다.

import type { RemoteModel } from '../../../shared/remote.ts'
import { Connection, newClientMessageId, RemoteClient, RemoteError, type Transport } from '../core/index.ts'
import type { AppSession, DesktopInfo, SessionNotice } from './session.ts'

export interface RemoteSessionOptions {
  transport: Transport
  /** `http://host:port` */
  baseUrl: string
  token: string
  desktop: DesktopInfo
}

export function createRemoteSession(options: RemoteSessionOptions): AppSession {
  const client = new RemoteClient({ transport: options.transport, baseUrl: options.baseUrl, token: options.token })
  const connection = new Connection(client)
  const listeners = new Set<() => void>()
  let models: RemoteModel[] = []
  let notice: SessionNotice | undefined
  /** 목록(프로젝트·대화·모델)을 받았거나 받는 중 */
  let listed = false
  let disposed = false
  /** 화면이 열어 둔 대화 — 받지 못했으면(끊긴 사이에 열었다) 다시 붙을 때 받는다 */
  const wanted = new Set<string>()
  let wasConnected = false
  const open = (cid: string): void => {
    connection.openConversation(cid).catch(() => undefined) // 못 받았으면 화면은 빈 채다 — 다시 붙을 때 또 받아 본다
  }

  const notify = (): void => {
    for (const listener of listeners) listener()
  }
  const setNotice = (next: SessionNotice | undefined): void => {
    if (notice === next) return
    notice = next
    notify()
  }
  /** 명령이 실패했다 — 닿지 못한 것도, 데스크탑이 거절한 것도 */
  const failed = (): void => setNotice('failed')

  // 처음 붙으면 목록을 받는다. 그 뒤 바뀌는 것은 Connection 이 이벤트(conversations.changed·reset)를 보고 다시 받는다
  const list = async (): Promise<void> => {
    listed = true
    try {
      await connection.loadProjects()
      await Promise.all(connection.state.projects.map((project) => connection.loadConversations(project.path)))
      models = await client.models()
      notify()
    } catch {
      listed = false // 다음에 붙을 때 다시
    }
  }
  const off = connection.subscribe(() => {
    const connected = connection.status.kind === 'connected'
    if (connected && !disposed) {
      if (!listed) void list()
      if (!wasConnected) for (const cid of wanted) if (!(cid in connection.state.views) && !(cid in connection.state.loading)) open(cid)
    }
    wasConnected = connected
    notify()
  })
  connection.start()

  return {
    getState: () => connection.state,
    getStatus: () => connection.status,
    getNotice: () => notice,
    onEvent: (listener) => connection.onEvent(listener),
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    desktop: options.desktop,
    get models() {
      return models
    },

    openConversation(cid) {
      wanted.add(cid)
      open(cid)
    },
    closeConversation(cid) {
      wanted.delete(cid)
      connection.closeConversation(cid)
    },

    async send(cid, text) {
      setNotice(undefined)
      try {
        await client.send(cid, { text, clientMessageId: newClientMessageId() })
        return true
      } catch (error) {
        // 403 = 전체 권한 모드 대화 (폰에 열지 않는다 — 데스크탑에서만)
        setNotice(error instanceof RemoteError && error.status === 403 ? 'desktop-only' : 'send-failed')
        return false
      }
    },
    stop(cid) {
      client.stop(cid).catch(failed)
    },
    async takeQueue(cid) {
      try {
        return (await client.takeQueue(cid)).text
      } catch {
        failed()
        return ''
      }
    },
    reply(request, answer) {
      client.reply(request.sessionId, request.id, answer).then((result) => {
        if (result.handled === 'elsewhere') setNotice('elsewhere')
      }, failed)
    },
    async createConversation(project) {
      try {
        const created = await client.createConversation({ project })
        wanted.add(created.id)
        await connection.openConversation(created.id)
        return created.id
      } catch {
        failed()
        return undefined
      }
    },

    clearNotice: () => setNotice(undefined),
    wake: () => connection.wake(),
    dispose() {
      disposed = true
      off()
      connection.stop()
      listeners.clear()
    },
  }
}
