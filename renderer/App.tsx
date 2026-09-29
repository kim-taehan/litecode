import { useEffect, useRef, useState } from 'react'
import type { ProviderConfig } from '../shared/ipc.ts'

interface ChatMessage {
  role: 'user' | 'assistant'
  text: string
}

interface Session {
  id: string
  title: string
  messages: ChatMessage[]
}

function newSession(): Session {
  return { id: crypto.randomUUID(), title: '새 대화', messages: [] }
}

export function App() {
  const [providers, setProviders] = useState<ProviderConfig[]>([])
  const [sessions, setSessions] = useState<Session[]>(() => [newSession()])
  const [activeId, setActiveId] = useState<string>(() => sessions[0]!.id)
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    void window.litecode.listProviders().then(setProviders)
  }, [])

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight })
  })

  const active = sessions.find((session) => session.id === activeId) ?? sessions[0]!
  const provider = providers[0]
  const model = provider?.models[0]

  function updateActive(mutate: (session: Session) => Session): void {
    setSessions((current) => current.map((session) => (session.id === active.id ? mutate(session) : session)))
  }

  async function send(): Promise<void> {
    const prompt = draft.trim()
    if (!prompt || sending || !provider || !model) return

    setDraft('')
    setSending(true)
    updateActive((session) => ({
      ...session,
      title: session.messages.length === 0 ? prompt.slice(0, 24) : session.title,
      messages: [...session.messages, { role: 'user', text: prompt }],
    }))

    const result = await window.litecode.sendMessage(provider.id, model.id, prompt)
    updateActive((session) => ({
      ...session,
      messages: [
        ...session.messages,
        { role: 'assistant', text: result.ok ? (result.text ?? '') : `⚠️ ${result.error}` },
      ],
    }))
    setSending(false)
  }

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="sidebar__project">
          <button type="button" className="project-switch" disabled>
            <span className="project-switch__badge">LC</span>
            <span className="project-switch__name">litecode</span>
          </button>
        </div>

        <div className="sidebar__new">
          <button
            type="button"
            className="new-chat"
            onClick={() => {
              const session = newSession()
              setSessions((current) => [session, ...current])
              setActiveId(session.id)
            }}
          >
            + 새 대화
          </button>
        </div>

        <div className="sidebar__label">대화 목록</div>

        <div className="sidebar__sessions">
          {sessions.map((session) => (
            <button
              key={session.id}
              type="button"
              className={`session-item${session.id === active.id ? ' session-item--active' : ''}`}
              onClick={() => setActiveId(session.id)}
            >
              {session.title}
            </button>
          ))}
        </div>

        <div className="sidebar__status">
          <span className={`status-dot${providers.length > 0 ? ' status-dot--ok' : ''}`} />
          {providers.length > 0 ? `${provider?.displayName} 연결됨` : '연결 확인 중…'}
        </div>
      </aside>

      <main className="main">
        <div className="main__header">{active.title}</div>

        <div className="main__messages" ref={listRef}>
          {active.messages.length === 0 && <div className="empty">무엇을 도와드릴까요?</div>}
          {active.messages.map((message, index) => (
            <div key={index} className={`bubble bubble--${message.role}`}>
              {message.text}
            </div>
          ))}
        </div>

        <div className="composer">
          <textarea
            className="composer__input"
            placeholder="메시지를 입력하세요…"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                void send()
              }
            }}
          />
          <div className="composer__row">
            <span className="composer__model">{model?.displayName ?? '모델 불러오는 중…'}</span>
            <button type="button" className="composer__send" onClick={() => void send()} disabled={sending}>
              보내기
            </button>
          </div>
        </div>
      </main>
    </div>
  )
}
