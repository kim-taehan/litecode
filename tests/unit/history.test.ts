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
    expect(historyMessages([user('안녕'), assistant('echo: 안녕')], false)).toEqual([
      { role: 'user', text: '안녕' },
      { role: 'assistant', text: 'echo: 안녕' },
    ])
  })

  it('도구 턴의 assistant 둘은 한 답으로 합치고 텍스트만 쓴다 (실시간 턴이 text.ended 만 모으는 것과 같다)', () => {
    const tool = { type: 'tool', name: 'bash', state: { status: 'completed', content: [{ text: '/x' }] } }
    expect(
      historyMessages([user('[bash:pwd]'), assistant('', { content: [tool], finish: 'tool-calls' }), assistant('tool: /x')], false),
    ).toEqual([
      { role: 'user', text: '[bash:pwd]' },
      { role: 'assistant', text: 'tool: /x' },
    ])
  })

  it('user 말풍선은 엔진 메시지 id 를 싣는다 — 앱이 정한 id 로 보일 글을 찾는다 (ctx.sessions label)', () => {
    expect(historyMessages([{ ...user('Say world'), id: 'msg_litecode_1' }, assistant('echo: Say world')], false)[0]).toEqual({
      id: 'msg_litecode_1',
      role: 'user',
      text: 'Say world',
    })
  })

  it('실패한 턴은 오류를 싣는다', () => {
    const failed = assistant('', { content: [], finish: 'error', error: { type: 'unknown', message: 'Provider request failed with HTTP 500' } })
    expect(historyMessages([user('[fail]'), failed], false)).toEqual([
      { role: 'user', text: '[fail]' },
      { role: 'assistant', text: '', error: 'Provider request failed with HTTP 500' },
    ])
  })

  it('다른 종류(모델 바꿈·시스템 등)는 건너뛴다', () => {
    expect(historyMessages([user('a'), { type: 'model-switched' }, assistant('b'), { type: 'synthetic', text: 'x' }], false)).toEqual([
      { role: 'user', text: 'a' },
      { role: 'assistant', text: 'b' },
    ])
  })

  it('답 없는 user 로 끝났으면 "중단됨" 답을 붙인다', () => {
    expect(historyMessages([user('a'), assistant('b'), user('[slow] c')], false)).toEqual([
      { role: 'user', text: 'a' },
      { role: 'assistant', text: 'b' },
      { role: 'user', text: '[slow] c' },
      { role: 'assistant', text: '', error: INTERRUPTED },
    ])
  })

  it('완료 시각 없는 assistant 로 끝났으면 그 답이 "중단됨" 이다 (스트리밍·도구 실행 중 끊김)', () => {
    const hanging = { type: 'assistant', time: { created: 2 }, content: [{ type: 'text', text: '' }] }
    expect(historyMessages([user('[drip] a'), hanging], false)).toEqual([
      { role: 'user', text: '[drip] a' },
      { role: 'assistant', text: '', error: INTERRUPTED },
    ])
  })

  it('지금 돌고 있는 세션이면 "중단됨" 을 붙이지 않는다', () => {
    expect(historyMessages([user('a')], true)).toEqual([{ role: 'user', text: 'a' }])
  })

  it('빈 세션은 빈 목록이다', () => {
    expect(historyMessages([], false)).toEqual([])
  })
})
