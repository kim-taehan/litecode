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

  // 이슈 #176 — 실시간 턴과 같은 지시문 항목을 다시 연 기록에서도 (user info.system 에서 읽는다)
  it('user info.system 에 .local.md 가 실렸거나 잘렸으면 그 답의 진행 줄 맨 앞에 지시문 항목. 아니면 없다', () => {
    const local = `Instructions from: /w/p/AGENTS.md\nrules\n\nInstructions from: /w/p/AGENTS.local.md\nmine\n\n(잘림: 9바이트 중 5)`
    const messages = historyMessages(
      [user('a', { id: 'msg_x', system: local }), assistant('ok'), user('b', { system: 'Instructions from: /w/p/AGENTS.md\nrules' }), assistant('ok2')],
      false,
      '/w/p',
    )
    expect(messages[1]!.items![0]).toEqual({
      kind: 'context',
      id: 'msg_x:instructions',
      text: `${tr('chat.instructionsLocal', { files: 'AGENTS.local.md' })} · ${tr('chat.instructionsTruncated', { total: 9, kept: 5 })}`,
    })
    expect(messages[1]!.items!.map((item) => item.kind)).toEqual(['context', 'text'])
    expect(messages[3]!.items!.some((item) => item.kind === 'context')).toBe(false)
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

  // 자동 요약 (이슈 #20 L2 실측): 요약 user(compaction 파트) → 요약 답(summary:true, parentID = 요약 user) → 이음 user(합성 Continue, 또는 한도 초과
  // 뒤 앞 user 의 복사본) → 그 답. 요약 user 는 그 턴 답의 요약 줄이고, 이음의 답은 같은 턴 답에 붙는다
  const compaction = (id = 'msg_c'): EngineMessage => ({ info: { id, role: 'user', time: { created: 4 } }, parts: [{ type: 'compaction', auto: true }] })
  const continued: EngineMessage = { info: { id: 'msg_s', role: 'user', time: { created: 5 } }, parts: [{ type: 'text', synthetic: true, text: 'Continue if you have next steps' }] }

  it('요약 user·요약 답·합성 Continue 는 말풍선이 아니다 — 요약 줄(done)이 그 턴 답에 붙고, Continue 의 답도 같은 턴 답이다', () => {
    const summary = assistant('## Objective', { summary: true, parentID: 'msg_c', agent: 'compaction', time: { created: 4, completed: 6 } })
    const messages = historyMessages([user('a'), assistant('echo: a'), compaction(), summary, continued, assistant('계속', { time: { created: 7, completed: 9 } }), user('b'), assistant('echo: b')], false)
    expect(messages.map(({ role, text }) => [role, text])).toEqual([
      ['user', 'a'],
      ['assistant', 'echo: a계속'],
      ['user', 'b'],
      ['assistant', 'echo: b'],
    ])
    expect(messages[1]!.items!.map((item) => (item.kind === 'compaction' ? `compaction:${item.status}` : item.kind))).toEqual(['text', 'compaction:done', 'text'])
    expect(messages[1]!.duration).toBe(8)
  })

  it('한도 초과 뒤 요약이 앞 user 를 복사해 다시 넣으면(이음) 그 복사본은 말풍선이 아니다', () => {
    const summary = assistant('## Objective', { summary: true, parentID: 'msg_c' })
    const copy = user('a') // 같은 글, 새 id
    const messages = historyMessages([user('first'), assistant('1'), user('a'), assistant(''), compaction(), summary, copy, assistant('echo: a')], false)
    expect(messages.map(({ role, text }) => [role, text])).toEqual([
      ['user', 'first'],
      ['assistant', '1'],
      ['user', 'a'],
      ['assistant', 'echo: a'],
    ])
  })

  it('요약도 한도를 넘어 실패하면(요약 답 ContextOverflowError) 그 턴은 "새 대화로" 안내 — 요약 줄은 failed, 다음 user 는 새 턴', () => {
    const summary = assistant('', { summary: true, parentID: 'msg_c', error: { name: 'ContextOverflowError', data: { message: 'Session too large to compact - context exceeds model limit even after stripping media' } } })
    const messages = historyMessages([user('[huge]'), assistant(''), compaction(), summary, user('again'), assistant('x')], false)
    expect(messages.map(({ role }) => role)).toEqual(['user', 'assistant', 'user', 'assistant'])
    expect(messages[1]).toMatchObject({ error: tr('error.contextOverflow') })
    expect(messages[1]!.items).toEqual([{ kind: 'compaction', id: 'msg_c:compaction', status: 'failed' }])
  })

  it('요약 중에 끊겼으면(요약 답 완료 시각 없음, 세션이 쉼) "중단됨"', () => {
    const summary: EngineMessage = { info: { id: 'msg_sum', role: 'assistant', parentID: 'msg_c', summary: true, time: { created: 4 } }, parts: [] }
    expect(historyMessages([user('a'), assistant('1'), compaction(), summary], false)[1]).toMatchObject({ interrupted: true })
  })

  it('바꾼 파일은 세션 폴더 기준 상대 경로로 (root)', () => {
    const patch = 'Index: /w/a.txt\n===\n--- /w/a.txt\n+++ /w/a.txt\n@@ -1 +1 @@\n-a\n+A\n'
    const edit = { type: 'tool', id: 'prt_e', tool: 'edit', callID: 'c', state: { status: 'completed', input: { filePath: '/w/a.txt' }, output: 'ok', metadata: { filediff: { file: '/w/a.txt', patch } } } }
    const [, reply] = historyMessages([user('edit'), assistant('', {}, [edit]), assistant('done')], false, '/w')
    expect(reply!.items![0]).toMatchObject({ kind: 'tool', diffs: [{ path: 'a.txt', added: 1, removed: 1 }] })
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

  // 첨부 (이슈 #44, 01y 5절): user 메시지의 file 파트는 칩 정보(이름·종류)로만 — url(data: 통째, 장당 수 MB)은 화면으로 안 넘긴다.
  // opencode 가 덧붙인 synthetic 글("Called the Read tool…")은 내 말이 아니다
  it('user 의 file 파트는 칩 정보가 되고 data: 본문·synthetic 글은 빠진다', () => {
    const url = `data:image/png;base64,${'A'.repeat(4_000)}`
    const asked: EngineMessage = {
      info: { id: 'msg_img', role: 'user', time: { created: 1 }, agent: 'build' },
      parts: [
        { type: 'text', id: 'prt_1', text: 'see' },
        { type: 'text', id: 'prt_2', synthetic: true, text: 'Called the Read tool with the following input: {"filePath":"/w/red.png"}' },
        { type: 'file', id: 'prt_3', mime: 'image/png', filename: 'red.png', url },
        { type: 'file', id: 'prt_4', mime: 'text/plain', filename: 'note.txt', url: 'file:///w/note.txt' },
      ],
    }
    const [mine] = historyMessages([asked, assistant('ok')], false)
    expect(mine).toMatchObject({
      id: 'msg_img',
      text: 'see',
      attachments: [
        { kind: 'image', name: 'red.png' },
        { kind: 'file', name: 'note.txt' },
      ],
    })
    expect(JSON.stringify(mine)).not.toContain('base64')
  })

  it('글 없이 이미지만 보낸 user 메시지도 말풍선이다 (text 파트가 없다 — 01y 2절)', () => {
    const only: EngineMessage = {
      info: { id: 'msg_only', role: 'user', time: { created: 1 }, agent: 'build' },
      parts: [{ type: 'file', id: 'prt_1', mime: 'image/jpeg', filename: 'a.jpg', url: 'data:image/jpeg;base64,AAAA' }],
    }
    expect(historyMessages([only, assistant('ok')], false)).toMatchObject([
      { role: 'user', text: '', attachments: [{ kind: 'image', name: 'a.jpg' }] },
      { role: 'assistant', text: 'ok' },
    ])
  })

  // 손으로 부른 요약 (/compact, 이슈 #144 실측): user(compaction 파트 auto:false, 글 없음) → 요약 답(summary:true, parentID = 그 user) → idle. 이음 user 가 없다
  it('손으로 부른 요약은 그 자체가 한 턴이다 — 빈 내 말(보일 글은 앱이 id 로 적어 둔다) + 요약 줄 done, 앞 턴 답에 붙지 않고 다음 user 는 평범한 턴', () => {
    const manual: EngineMessage = { info: { id: 'msg_m', role: 'user', time: { created: 10 }, agent: 'build' }, parts: [{ type: 'compaction', auto: false }] }
    const summary = assistant('## Objective', { summary: true, parentID: 'msg_m', agent: 'compaction', time: { created: 10, completed: 14 } })
    const messages = historyMessages([user('a'), assistant('echo: a'), manual, summary, user('b'), assistant('echo: b')], false)
    expect(messages.map(({ role, text }) => ({ role, text }))).toEqual([
      { role: 'user', text: 'a' },
      { role: 'assistant', text: 'echo: a' },
      { role: 'user', text: '' },
      { role: 'assistant', text: '' },
      { role: 'user', text: 'b' },
      { role: 'assistant', text: 'echo: b' },
    ])
    expect(messages[1]!.items!.some((item) => item.kind === 'compaction')).toBe(false)
    expect(messages[1]!.duration).toBe(2) // 앞 턴의 걸린 시간에 요약이 섞이지 않는다
    expect(messages[2]).toMatchObject({ id: 'msg_m', at: 10 })
    expect(messages[3]).toMatchObject({ items: [{ kind: 'compaction', id: 'msg_m:compaction', status: 'done' }], duration: 4 })
    expect(messages[3]!.error).toBeUndefined()
  })

  it('손으로 부른 요약이 아직 도는 중이면 요약 줄은 running', () => {
    const manual: EngineMessage = { info: { id: 'msg_m', role: 'user', time: { created: 10 } }, parts: [{ type: 'compaction', auto: false }] }
    const summary = assistant('', { summary: true, parentID: 'msg_m', time: { created: 10 } })
    expect(historyMessages([user('a'), assistant('echo: a'), manual, summary], true).at(-1)).toMatchObject({ items: [{ kind: 'compaction', status: 'running' }] })
  })

  it('첨부가 없는 user 메시지에는 attachments 가 없다', () => {
    expect(historyMessages([user('hi'), assistant('ok')], false)[0]).not.toHaveProperty('attachments')
  })
})
