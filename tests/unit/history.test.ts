import { describe, expect, it } from 'vitest'
import { historyMessages, interruptedError, type EngineMessage } from '../../src/services/llm.ts'
import { tr } from '../../src/i18n.ts'

// opencode 레거시 `GET /session/{id}/message?directory=` 의 [{info, parts}] → 화면이 그리는 중립 모양 (user/assistant 말풍선).
// 모양은 01w 실측 (opencode 1.18.18): user info{id, role, time.created, agent, model} + text 파트, assistant info{parentID, agent, time{created,
// completed?}, error?{name, data.message}, summary?} + step-start·reasoning·text·tool·step-finish 파트. 도구 턴은 assistant 둘로 온다.
// 끊긴 턴: 재시작 뒤 그 턴은 완료 시각 없는 assistant(+ running 도구)로 남는다 — 그 세션이 돌고 있지 않으면 "중단됨"

let seq = 0
const user = (text: string, extra: Partial<EngineMessage['info']> = {}): EngineMessage => ({
  info: { id: `msg_u${++seq}`, role: 'user', time: { created: 1 }, agent: 'build', ...extra },
  parts: [{ type: 'text', id: `prt_${seq}`, text }],
})
const assistant = (text: string, extra: Partial<EngineMessage['info']> = {}, parts: EngineMessage['parts'] = []): EngineMessage => ({
  info: { id: `msg_a${++seq}`, role: 'assistant', time: { created: 2, completed: 3 }, agent: 'build', ...extra },
  parts: [{ type: 'step-start' }, ...parts, ...(text ? [{ type: 'text', id: `prt_${seq}`, text, time: { start: 2, end: 3 } }] : []), { type: 'step-finish', reason: 'stop' }],
})

describe('historyMessages (레거시 기록)', () => {
  it('user·assistant 를 말풍선으로 옮긴다', () => {
    expect(historyMessages([user('안녕'), assistant('echo: 안녕')], false).map(({ role, text }) => ({ role, text }))).toEqual([
      { role: 'user', text: '안녕' },
      { role: 'assistant', text: 'echo: 안녕' },
    ])
  })

  it('도구 턴의 assistant 둘은 한 답으로 합치고 텍스트만 쓴다 (실시간 턴이 글 줄만 모으는 것과 같다)', () => {
    const tool = { type: 'tool', id: 'prt_t', tool: 'bash', callID: 'call_1', state: { status: 'completed', input: { command: 'pwd', description: 'fake' }, output: '/w\n' } }
    const messages = historyMessages([user('[bash:pwd]'), assistant('', {}, [tool]), assistant('tool: /w')], false)
    expect(messages).toHaveLength(2)
    expect(messages[1]).toMatchObject({ role: 'assistant', text: 'tool: /w' })
    expect(messages[1]!.items!.map((item) => item.kind)).toEqual(['tool', 'text'])
    expect(messages[1]!.items![0]).toMatchObject({ name: 'bash', status: 'done', summary: 'fake', result: '/w\n' })
  })

  it('user 말풍선은 엔진 메시지 id 를 싣는다 — 앱이 정한 id 로 보일 글을 찾는다 (ctx.sessions label)', () => {
    expect(historyMessages([user('/hi', { id: 'msg_mine' }), assistant('x')], false)[0]).toMatchObject({ id: 'msg_mine', text: '/hi' })
  })

  it('실패한 턴은 오류를 싣는다 (info.error.data.message)', () => {
    const failed = assistant('', { error: { name: 'APIError', data: { message: 'fake-llm: 요청된 실패' } } })
    expect(historyMessages([user('[fail]'), failed], false)[1]).toMatchObject({ role: 'assistant', error: 'fake-llm: 요청된 실패' })
  })

  it('한도 초과로 실패한 답은 다시 열어도 안내 문장', () => {
    const failed = assistant('', { error: { name: 'ContextOverflowError', data: { message: "This model's maximum context length is 8000 tokens" } } })
    expect(historyMessages([user('u'), failed], false)[1]!.error).toBe(tr('error.contextOverflow'))
  })

  it('사용자가 멈춘 턴(MessageAbortedError)은 "중단됨" 이다 — 실패가 아니다', () => {
    const aborted = assistant('', { time: { created: 2, completed: 3 }, error: { name: 'MessageAbortedError', data: { message: 'The operation was aborted.' } } })
    expect(historyMessages([user('[slow]'), aborted, user('다음'), assistant('echo: 다음')], false)[1]).toMatchObject({ interrupted: true, error: tr('error.stopped') })
  })

  it('합성 글뿐인 user(자동 요약 뒤 Continue)와 요약 답(summary:true)은 말풍선이 아니다', () => {
    const synthetic: EngineMessage = { info: { id: 'msg_s', role: 'user', time: { created: 5 } }, parts: [{ type: 'text', synthetic: true, text: 'Continue if you have next steps' }] }
    const compaction: EngineMessage = { info: { id: 'msg_c', role: 'user', time: { created: 4 } }, parts: [{ type: 'compaction' }] }
    const summary = assistant('## Objective', { summary: true })
    const messages = historyMessages([user('a'), assistant('echo: a'), compaction, summary, synthetic, assistant('계속')], false)
    expect(messages.map(({ role }) => role)).toEqual(['user', 'assistant']) // 요약 뒤 이어진 답의 자리·표시는 L2
    expect(messages[1]!.text).not.toContain('## Objective')
  })

  it('답 없는 user 로 끝났으면 "중단됨" 답을 붙인다', () => {
    expect(historyMessages([user('a'), assistant('1'), user('b')], false).at(-1)).toEqual({ role: 'assistant', text: '', error: interruptedError(), interrupted: true })
  })

  it('완료 시각 없는 assistant 로 끝났으면 그 답이 "중단됨" 이다 (재시작 뒤 running 도구가 남는다 — 01w)', () => {
    const hanging = assistant('', { time: { created: 2 } }, [{ type: 'tool', id: 'p', tool: 'bash', state: { status: 'running', input: { command: 'sleep 9' } } }])
    expect(historyMessages([user('a'), hanging], false)[1]).toMatchObject({ interrupted: true, error: interruptedError() })
  })

  it('마지막이 아닌 턴도 완료 시각 없이 끝났으면 "중단됨" 이다', () => {
    const hanging = assistant('', { time: { created: 2 } })
    expect(historyMessages([user('a'), hanging, user('b'), assistant('echo: b')], false)[1]).toMatchObject({ interrupted: true })
  })

  it('지금 돌고 있는 세션이면 마지막 턴에 "중단됨" 을 붙이지 않는다', () => {
    expect(historyMessages([user('a')], true)).toHaveLength(1)
  })

  it('빈 세션은 빈 목록이다', () => {
    expect(historyMessages([], false)).toEqual([])
  })

  it('답에 그 턴의 진행 줄(생각·도구·글)과 걸린 시간을, 내 말에 보낸 시각을 싣는다', () => {
    const tool = { type: 'tool', id: 'prt_t', tool: 'bash', state: { status: 'completed', input: { command: 'ls', description: 'List' }, output: '' } }
    const step1 = assistant('', { time: { created: 1_100, completed: 1_500 } }, [{ type: 'reasoning', id: 'prt_r', text: 'plan' }, tool])
    const step2 = assistant('done', { time: { created: 1_600, completed: 3_000 } })
    const [question, answer] = historyMessages([user('q', { time: { created: 1_000 } }), step1, step2], false)
    expect(question).toMatchObject({ role: 'user', at: 1_000 })
    expect(answer).toMatchObject({ role: 'assistant', text: 'done', duration: 2_000 })
    expect(answer!.items!.map((item) => item.kind)).toEqual(['think', 'tool', 'text'])
    expect(answer!.items![0]).toMatchObject({ text: 'plan', done: true })
  })

  it('마지막 스텝이 안 끝났으면 걸린 시간이 없다', () => {
    expect(historyMessages([user('a'), assistant('', { time: { created: 2 } })], true)[1]!.duration).toBeUndefined()
  })

  it('내 말에 그 턴의 모드를 싣는다 — 레거시는 user 메시지마다 agent 가 남는다. 모르는 에이전트는 없음', () => {
    const messages = historyMessages(
      [user('a', { agent: 'build' }), assistant('1'), user('b', { agent: 'plan' }), assistant('2'), user('c', { agent: 'litecode-ask' }), assistant('3'), user('d', { agent: 'explore' })],
      true,
    )
    expect(messages.filter((message) => message.role === 'user').map((message) => message.mode)).toEqual(['build', 'plan', 'ask', undefined])
  })

  it('거절로 끝난 턴(마지막 도구가 오류, 다음 스텝 없음)은 "중단됨" 이 아니라 거절함이다 — 끊긴 도구는 running 으로 남는다', () => {
    const rejected = { type: 'tool', id: 'p', tool: 'bash', state: { status: 'error', input: { command: 'ls' }, error: 'The user rejected permission to use this specific tool call.' } }
    const declined = assistant('', {}, [rejected])
    expect(historyMessages([user('[bash:ls]'), declined], false)[1]).toMatchObject({ role: 'assistant', declined: true })
    expect(historyMessages([user('[bash:ls]'), declined], false)[1]!.interrupted).toBeUndefined()
    const cut = assistant('', { time: { created: 2 } }, [{ ...rejected, state: { status: 'running', input: { command: 'ls' } } }])
    expect(historyMessages([user('[bash:ls]'), cut], false)[1]).toMatchObject({ interrupted: true })
    // 실패한 도구 뒤에 이어 답한 턴은 거절이 아니다
    expect(historyMessages([user('[call:write]'), declined, assistant('tool: Unknown tool')], false)[1]!.declined).toBeUndefined()
  })
})
