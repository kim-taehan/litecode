import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { precedingId, previousConversation, previousHistory, PREVIOUS_CONVERSATION_LIMIT, type PreviousMessage } from '../../src/services/migrate.ts'
import { ascendingId } from '../../src/services/llm.ts'
import { tr } from '../../src/i18n.ts'

// 레거시 전환 전에 쌓인 대화(신규 세대 GET /api/session/{id}/message)를 이어 쓰기 — 이슈 #21.
// 모양은 01c Q2·01g 2e 실측 (opencode 1.18.18): user {id, type, text, time.created}, assistant {id, type, agent, time{created, completed?}, content[], error?},
// 도구 턴은 assistant 둘. 레거시 기록과는 서로 안 보이므로(01w 2절) 화면은 이 기록을 앞에 이어 붙이고, LLM 엔 글로만 한 번 넘긴다

const modeOf = (agent: string | undefined) => (agent === 'build' ? 'default' : agent === 'plan' ? 'plan' : undefined) as never
const user = (id: string, text: string, created = 1): PreviousMessage => ({ id, type: 'user', text, time: { created } })
const assistant = (id: string, text: string, extra: Partial<PreviousMessage> = {}): PreviousMessage => ({
  id,
  type: 'assistant',
  agent: 'build',
  time: { created: 2, completed: 5 },
  content: text ? [{ type: 'text', text }] : [],
  ...extra,
})

describe('previousHistory (옛 기록 → 말풍선)', () => {
  it('user·답을 차례로, 도구 스텝은 한 답으로 합치고 도구 줄을 싣는다', () => {
    const tool = assistant('msg_a1', '', {
      time: { created: 2, completed: 3 },
      content: [{ type: 'reasoning', text: 'hmm' }, { type: 'tool', id: 't1', name: 'bash', state: { status: 'completed', input: { command: 'pwd', description: 'where' }, content: [{ text: '/w' }] } }],
    })
    const messages = previousHistory([user('msg_u1', '어디?'), tool, assistant('msg_a2', 'tool: /w'), user('msg_u2', '고마워'), assistant('msg_a3', 'echo: 고마워')], modeOf)
    expect(messages.map(({ role, text }) => ({ role, text }))).toEqual([
      { role: 'user', text: '어디?' },
      { role: 'assistant', text: 'tool: /w' },
      { role: 'user', text: '고마워' },
      { role: 'assistant', text: 'echo: 고마워' },
    ])
    expect(messages[0]).toMatchObject({ id: 'msg_u1', at: 1, mode: 'default' })
    expect(messages[1]!.items!.map((item) => item.kind)).toEqual(['think', 'tool', 'text'])
    expect(messages[1]!.items![1]).toMatchObject({ name: 'bash', status: 'done', summary: 'where', result: '/w' })
    expect(messages[1]!.duration).toBe(4)
    expect(messages[1]!.error).toBeUndefined()
  })

  it('끝나지 않은 마지막 답·답 없는 마지막 질문은 "중단됨" — 신규 세대로는 다시 돌지 않는다', () => {
    expect(previousHistory([user('u', 'a'), assistant('a', 'half', { time: { created: 2 } })], modeOf)[1]).toMatchObject({ interrupted: true, error: tr('error.interrupted') })
    expect(previousHistory([user('u', 'a')], modeOf)[1]).toMatchObject({ role: 'assistant', interrupted: true })
  })

  it('실패한 답은 사유를 싣는다', () => {
    expect(previousHistory([user('u', 'a'), assistant('a', '', { error: { message: 'boom' } })], modeOf)[1]!.error).toBe('boom')
  })

  // 이슈 #635 실측 (out-v2-reply·out-v2-reject): 신규 세대 기록은 답이 state.structured.answers, 거절 문구가 "Tool execution interrupted", 시각은 파트의 time
  it('질문 도구: 답(structured.answers)은 말풍선 데이터로, 거절은 답 없는 말풍선 — 거절로 끝난 턴은 그대로 거절함', () => {
    const input = { questions: [{ question: 'Which DB?', header: 'DB', options: [{ label: 'Postgres', description: 'pg' }, { label: 'SQLite', description: 'file' }] }] }
    const replied = assistant('msg_a1', '', {
      content: [
        {
          type: 'tool',
          id: 'call_17',
          name: 'question',
          state: { status: 'completed', input, content: [{ text: 'User has answered your questions: "Which DB?"="SQLite". …' }], structured: { answers: [['SQLite']] } },
          time: { created: 10, ran: 11, completed: 20 },
        },
      ],
    })
    // 거절한 메시지는 finish·time.completed 가 없다 (§ 신규 세대 멈춤 실측 5/5)
    const rejected = assistant('msg_a3', '', {
      time: { created: 30 },
      content: [{ type: 'tool', id: 'call_18', name: 'question', state: { status: 'error', input, content: [], structured: {}, error: { message: 'Tool execution interrupted' } }, time: { created: 30, ran: 31, completed: 40 } }],
    })
    const messages = previousHistory([user('msg_u1', 'db?'), replied, assistant('msg_a2', 'ok SQLite'), user('msg_u2', 'again'), rejected], modeOf)
    expect(messages[1]!.items![0]).toEqual({ kind: 'reply', id: 'msg_a1:call_17', questions: [{ question: 'Which DB?', answer: 'SQLite' }], askedAt: 11, at: 20 })
    expect(messages[3]!.items![0]).toEqual({ kind: 'reply', id: 'msg_a3:call_18', questions: [{ question: 'Which DB?' }], askedAt: 31, at: 40 })
    expect(messages[3]!.declined).toBe(true)
  })

  // § 신규 세대 멈춤 (실측 2026-10-24, 멈춤 5/5 · 거절 5/5): 파트는 둘 다 "Tool execution interrupted" — 가르는 것은 메시지. 멈춤 = finish "tool-calls" + time.completed,
  // 거절 = 둘 다 없음. 원본 JSON(out-v2-abort1·out-v2-reject 의 메시지, asc 로 뒤집음)을 그대로 쓴다
  it('질문 도구: 원본 기록의 멈춤은 도구 줄 + 중단됨(레거시와 같게), 거절은 답 없는 말풍선 + 거절함', () => {
    const fixture = JSON.parse(readFileSync(new URL('../fixtures/question-v2-history.json', import.meta.url), 'utf8')) as Record<'abort' | 'reject', PreviousMessage[]>
    const aborted = previousHistory(fixture.abort, modeOf)
    expect(aborted[1]!.items![0]).toMatchObject({ kind: 'tool', name: 'question', status: 'error', error: 'Tool execution interrupted' })
    expect(aborted[1]).toMatchObject({ interrupted: true })
    expect(aborted[1]!.declined).toBeUndefined()
    const rejected = previousHistory(fixture.reject, modeOf)
    expect(rejected[1]!.items![0]).toMatchObject({ kind: 'reply', questions: [{ question: 'Which DB?' }] })
    expect(rejected[1]).toMatchObject({ declined: true })
    expect(rejected[1]!.interrupted).toBeUndefined()
  })

  it('빈 기록(레거시로 만든 세션)은 빈 목록', () => {
    expect(previousHistory([], modeOf)).toEqual([])
  })
})

describe('previousConversation (LLM 에 넘길 옛 글)', () => {
  it('user·답 글만 차례로 <previous-conversation> 에 싼다 — 생각·도구는 빠진다', () => {
    const raw = [
      user('u1', 'my name is ZED'),
      assistant('a1', '', { content: [{ type: 'reasoning', text: 'secret thought' }, { type: 'tool', name: 'bash', state: { status: 'completed' } }] }),
      assistant('a2', 'hi ZED'),
      { id: 's', type: 'system', text: 'Instructions from: /x/AGENTS.md' },
      user('u2', 'remember BLUE'),
      assistant('a3', 'ok BLUE'),
    ]
    const text = previousConversation(raw)!
    expect(text.startsWith('<previous-conversation>\n')).toBe(true)
    expect(text.endsWith('\n</previous-conversation>')).toBe(true)
    expect(text).toContain('user: my name is ZED\nassistant: hi ZED\nuser: remember BLUE\nassistant: ok BLUE')
    expect(text).not.toContain('secret thought')
    expect(text).not.toContain('Instructions from')
  })

  it('넘길 글이 없으면 undefined — 아무것도 넣지 않는다', () => {
    expect(previousConversation([])).toBeUndefined()
    expect(previousConversation([{ type: 'agent-switched', agent: 'plan' }])).toBeUndefined()
  })

  it('상한을 넘으면 뒤(최근)에서부터 남기고 잘렸다고 적는다', () => {
    const raw = Array.from({ length: 200 }, (_, index) => [user(`u${index}`, `question ${index} ${'x'.repeat(100)}`), assistant(`a${index}`, `answer ${index}`)]).flat()
    const text = previousConversation(raw)!
    expect(text.length).toBeLessThan(PREVIOUS_CONVERSATION_LIMIT + 200)
    expect(text).toContain('[earlier part omitted]')
    expect(text).toContain('answer 199\n</previous-conversation>')
    expect(text).not.toContain('question 0 ')
  })
})

describe('precedingId', () => {
  it('opencode 형식 id 바로 앞에 선다 (이번 입력보다 옛 글이 먼저)', () => {
    const before = ascendingId('msg')
    const id = ascendingId('msg')
    const injected = precedingId(id)
    expect(injected).toMatch(/^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/)
    expect(injected < id).toBe(true)
    expect(injected >= before.slice(0, 16)).toBe(true)
  })
})
