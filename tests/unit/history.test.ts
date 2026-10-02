import { describe, expect, it } from 'vitest'
import { historyMessages, INTERRUPTED } from '../../src/services/llm.ts'

// opencode `GET /api/session/{id}/message?order=asc` 의 메시지 → 화면이 그리는 중립 모양 (user/assistant 말풍선).
// 모양은 01c 실측: user 는 text, assistant 는 content[](text·tool)·finish·error·time.completed. 도구 턴은 assistant 둘로 온다.
// 끊긴 턴(01c Q6): 마지막이 답 없는 user 이거나 time.completed 없는 assistant 이고, 그 세션이 active 가 아니면 "중단됨".

const user = (text: string) => ({ type: 'user', text, time: { created: 1 } })
const assistant = (text: string, extra: Record<string, unknown> = {}) => ({
  type: 'assistant',
  time: { created: 2, completed: 3 },
  content: [{ type: 'text', id: 'text-0', text }],
  finish: 'stop',
  ...extra,
})

describe('historyMessages', () => {
  it('user·assistant 를 말풍선으로 옮긴다', () => {
    expect(historyMessages([user('안녕'), assistant('echo: 안녕')], false)).toMatchObject([
      { role: 'user', text: '안녕' },
      { role: 'assistant', text: 'echo: 안녕' },
    ])
  })

  it('도구 턴의 assistant 둘은 한 답으로 합치고 텍스트만 쓴다 (실시간 턴이 text.ended 만 모으는 것과 같다)', () => {
    const tool = { type: 'tool', name: 'bash', state: { status: 'completed', content: [{ text: '/x' }] } }
    expect(
      historyMessages([user('[bash:pwd]'), assistant('', { content: [tool], finish: 'tool-calls' }), assistant('tool: /x')], false),
    ).toMatchObject([
      { role: 'user', text: '[bash:pwd]' },
      { role: 'assistant', text: 'tool: /x' },
    ])
  })

  it('user 말풍선은 엔진 메시지 id 를 싣는다 — 앱이 정한 id 로 보일 글을 찾는다 (ctx.sessions label)', () => {
    expect(historyMessages([{ ...user('Say world'), id: 'msg_litecode_1' }, assistant('echo: Say world')], false)[0]).toMatchObject({
      id: 'msg_litecode_1',
      role: 'user',
      text: 'Say world',
    })
  })

  it('실패한 턴은 오류를 싣는다', () => {
    const failed = assistant('', { content: [], finish: 'error', error: { type: 'unknown', message: 'Provider request failed with HTTP 500' } })
    expect(historyMessages([user('[fail]'), failed], false)).toMatchObject([
      { role: 'user', text: '[fail]' },
      { role: 'assistant', text: '', error: 'Provider request failed with HTTP 500' },
    ])
  })

  it('다른 종류(모델 바꿈·시스템 등)는 건너뛴다', () => {
    expect(historyMessages([user('a'), { type: 'model-switched' }, assistant('b'), { type: 'synthetic', text: 'x' }], false)).toMatchObject([
      { role: 'user', text: 'a' },
      { role: 'assistant', text: 'b' },
    ])
  })

  it('답 없는 user 로 끝났으면 "중단됨" 답을 붙인다', () => {
    expect(historyMessages([user('a'), assistant('b'), user('[slow] c')], false)).toMatchObject([
      { role: 'user', text: 'a' },
      { role: 'assistant', text: 'b' },
      { role: 'user', text: '[slow] c' },
      { role: 'assistant', text: '', error: INTERRUPTED, interrupted: true },
    ])
  })

  it('완료 시각 없는 assistant 로 끝났으면 그 답이 "중단됨" 이다 (스트리밍·도구 실행 중 끊김)', () => {
    const hanging = { type: 'assistant', time: { created: 2 }, content: [{ type: 'text', text: '' }] }
    expect(historyMessages([user('[drip] a'), hanging], false)).toMatchObject([
      { role: 'user', text: '[drip] a' },
      { role: 'assistant', text: '', error: INTERRUPTED, interrupted: true },
    ])
  })

  it('지금 돌고 있는 세션이면 "중단됨" 을 붙이지 않는다', () => {
    expect(historyMessages([user('a')], true)).toMatchObject([{ role: 'user', text: 'a' }])
  })

  it('빈 세션은 빈 목록이다', () => {
    expect(historyMessages([], false)).toMatchObject([])
  })

  it('답에 그 턴의 진행 줄(생각·도구·글)과 걸린 시간을, 내 말에 보낸 시각을 싣는다. 지시문 바뀜은 다음 답 줄 맨 앞에', () => {
    const step1 = {
      type: 'assistant',
      id: 'm1',
      time: { created: 1_100, completed: 1_500 },
      content: [{ type: 'reasoning', text: 'plan' }, { type: 'tool', name: 'bash', state: { status: 'completed', input: { command: 'ls', description: 'List' } } }],
    }
    const step2 = { type: 'assistant', id: 'm2', time: { created: 1_600, completed: 3_000 }, content: [{ type: 'text', text: 'done' }] }
    const system = { type: 'system', id: 's1', text: 'Instructions from: /p/AGENTS.md' }
    const [question, answer] = historyMessages([{ type: 'user', text: 'q', time: { created: 1_000 } }, system, step1, step2], false)
    expect(question).toMatchObject({ role: 'user', at: 1_000 })
    expect(answer).toMatchObject({ role: 'assistant', text: 'done', duration: 2_000 })
    expect(answer!.items!.map((item) => item.kind)).toEqual(['context', 'think', 'tool', 'text'])
    expect(answer!.items![0]).toMatchObject({ text: '지시문 바뀜 · AGENTS.md' })
  })

  it('마지막 스텝이 안 끝났으면 걸린 시간이 없다', () => {
    const hanging = { type: 'assistant', time: { created: 2 }, content: [] }
    expect(historyMessages([user('a'), hanging], true)[1]!.duration).toBeUndefined()
  })
})
