import { Context, Service } from 'cordis'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { canonicalJson, callKey, RepeatCounter, repeatReminder } from '../../src/services/repeatCounter.ts'
import { RepeatGuardService } from '../../src/services/repeatGuard.ts'
import { SettingsService } from '../../src/services/settings.ts'
import { FeaturesService } from '../../src/services/features.ts'
import { historyMessages } from '../../src/services/history.ts'
import type { EngineMessage, ToolStarted } from '../../src/services/llm.ts'
import { FEATURE_GROUPS, featureOn } from '../../shared/features.ts'

// 같은 도구 반복 알림 (이슈 #284) — 순수 세기(repeatCounter.ts)와 'llm/tool-started' 를 듣는 묶음(repeatGuard.ts).
// ctx.llm 은 remind 만 흉내 낸다 — 엔진에 실제로 끼워 넣는 길은 interject.test.ts 의 remind 묶음이 가짜 opencode 로 본다

describe('RepeatCounter — 연속 같은 호출 세기', () => {
  it('연속 3·5·8 번째에만 그 횟수를 준다 (9번째 이상은 조용)', () => {
    const counter = new RepeatCounter()
    const hits = Array.from({ length: 10 }, () => counter.observe('c', 'read', { filePath: 'a.ts' }))
    expect(hits).toEqual([undefined, undefined, 3, undefined, 5, undefined, undefined, 8, undefined, undefined])
  })

  it('다른 호출이 끼면 1 부터 다시 센다', () => {
    const counter = new RepeatCounter()
    counter.observe('c', 'read', { filePath: 'a.ts' })
    counter.observe('c', 'read', { filePath: 'a.ts' })
    counter.observe('c', 'grep', { pattern: 'x' })
    expect(counter.observe('c', 'read', { filePath: 'a.ts' })).toBeUndefined()
    expect(counter.observe('c', 'read', { filePath: 'a.ts' })).toBeUndefined()
    expect(counter.observe('c', 'read', { filePath: 'a.ts' })).toBe(3)
  })

  it('같은 도구라도 인자가 다르면 다른 호출이다 — 키 순서만 다르면 같은 호출', () => {
    const counter = new RepeatCounter()
    counter.observe('c', 'bash', { command: 'ls', timeout: 5 })
    counter.observe('c', 'bash', { timeout: 5, command: 'ls' })
    expect(counter.observe('c', 'bash', { command: 'ls -a', timeout: 5 })).toBeUndefined()
    expect(canonicalJson({ b: [{ y: 1, x: 2 }], a: null })).toBe('{"a":null,"b":[{"x":2,"y":1}]}')
    expect(callKey('bash', { a: 1, b: 2 })).toBe(callKey('bash', { b: 2, a: 1 }))
    expect(callKey('bash', { a: 1 })).not.toBe(callKey('read', { a: 1 }))
  })

  it('reset 하면(새 턴) 처음부터 — 대화마다 따로 센다', () => {
    const counter = new RepeatCounter()
    counter.observe('c1', 'read', { filePath: 'a.ts' })
    counter.observe('c1', 'read', { filePath: 'a.ts' })
    counter.observe('c2', 'read', { filePath: 'a.ts' })
    expect(counter.observe('c1', 'read', { filePath: 'a.ts' })).toBe(3)
    expect(counter.observe('c2', 'read', { filePath: 'a.ts' })).toBeUndefined()
    counter.reset('c2')
    counter.observe('c2', 'read', { filePath: 'a.ts' })
    expect(counter.observe('c2', 'read', { filePath: 'a.ts' })).toBeUndefined()
  })

  it('알림 문구 — 도구 이름과 횟수를 싣는 영어 한 줄', () => {
    expect(repeatReminder('read', 3)).toBe('You have called `read` with the same arguments 3 times in a row. Review the previous results and change your approach, or finish.')
  })
})

/** ctx.llm 흉내 — remind 로 온 것을 적는다 */
class FakeLlm extends Service {
  reminded: { sessionId: string; text: string }[] = []
  constructor(ctx: Context) {
    super(ctx, 'llm')
  }
  async remind(sessionId: string, text: string): Promise<boolean> {
    this.reminded.push({ sessionId, text })
    return true
  }
}

let calls = 0
/** 실행에 들어간 호출 하나 (callID 는 매번 새로) */
const running = (sessionId: string, tool: string, input: unknown, child = false): ToolStarted => ({ sessionId, directory: '/p', tool, input, callID: `call_${++calls}`, child })

describe('RepeatGuardService — llm/tool-started(running) 를 듣고 ctx.llm.remind', () => {
  async function start(): Promise<{ ctx: Context; llm: FakeLlm; fiber: { dispose(): unknown } }> {
    const ctx = new Context()
    ctx.plugin(FakeLlm)
    const fiber = ctx.plugin(RepeatGuardService)
    const ready = await new Promise<Context>((resolve) => ctx.inject(['llm', 'repeatGuard'], resolve))
    return { ctx, llm: ready.llm as unknown as FakeLlm, fiber }
  }

  it('같은 대화에서 같은 호출 3번째에 그 대화로 한 줄 — 다른 대화의 같은 호출은 따로 센다', async () => {
    const { ctx, llm } = await start()
    for (let i = 0; i < 2; i++) ctx.emit('llm/tool-started', running('ses_1', 'read', { filePath: 'a.ts' }))
    ctx.emit('llm/tool-started', running('ses_2', 'read', { filePath: 'a.ts' }))
    expect(llm.reminded).toEqual([])
    ctx.emit('llm/tool-started', running('ses_1', 'read', { filePath: 'a.ts' }))
    expect(llm.reminded).toEqual([{ sessionId: 'ses_1', text: repeatReminder('read', 3) }])
  })

  it('연속 10번 실행에 들어가면 3·5·8번째의 running 시점에만 알린다', async () => {
    const { ctx, llm } = await start()
    for (let i = 0; i < 10; i++) ctx.emit('llm/tool-started', running('ses_1', 'grep', { pattern: 'x' }))
    expect(llm.reminded.map((entry) => entry.text)).toEqual([3, 5, 8].map((count) => repeatReminder('grep', count)))
  })

  it('끝난 도구(llm/tool-done)로는 세지 않는다 — 엔진이 이미 다음 요청을 보낸 뒤라 늦다', async () => {
    const { ctx, llm } = await start()
    for (let i = 0; i < 3; i++) ctx.emit('llm/tool-done', { sessionId: 'ses_1', directory: '/p', tool: 'read', input: { filePath: 'a.ts' }, output: 'x', child: false })
    expect(llm.reminded).toEqual([])
  })

  it('새 턴이 시작되면 다시 센다', async () => {
    const { ctx, llm } = await start()
    for (let i = 0; i < 2; i++) ctx.emit('llm/tool-started', running('ses_1', 'read', { filePath: 'a.ts' }))
    ctx.emit('llm/turn-started', { sessionId: 'ses_1', directory: '/p' })
    for (let i = 0; i < 2; i++) ctx.emit('llm/tool-started', running('ses_1', 'read', { filePath: 'a.ts' }))
    expect(llm.reminded).toEqual([])
  })

  it('하위 작업(task)이 부른 도구는 세지도 끊지도 않는다 — 알림이 부모 턴으로 가서 그 하위 에이전트가 못 읽는다', async () => {
    const { ctx, llm } = await start()
    for (let i = 0; i < 3; i++) ctx.emit('llm/tool-started', running('ses_1', 'read', { filePath: 'a.ts' }, true))
    expect(llm.reminded).toEqual([])
  })

  it('묶음을 내리면 알림이 없다', async () => {
    const { ctx, llm, fiber } = await start()
    await fiber.dispose()
    for (let i = 0; i < 3; i++) ctx.emit('llm/tool-started', running('ses_1', 'read', { filePath: 'a.ts' }))
    expect(llm.reminded).toEqual([])
  })
})

describe('기능 묶음 repeatGuard', () => {
  let tmp: string
  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'litecode-repeat-'))
  })
  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true })
  })

  it('고르는 기능·기본 켜짐·"AI 도구" 묶음', () => {
    expect(featureOn(undefined, 'repeatGuard')).toBe(true)
    expect(featureOn({ repeatGuard: false }, 'repeatGuard')).toBe(false)
    expect(FEATURE_GROUPS.find((group) => group.id === 'ai')?.features).toContain('repeatGuard')
  })

  it('설정에서 끄면 같은 호출을 몇 번 해도 알림 0', async () => {
    const ctx = new Context()
    ctx.plugin(FakeLlm)
    ctx.plugin(SettingsService, { file: path.join(tmp, 'settings.json') })
    ctx.plugin(FeaturesService, [{ id: 'repeatGuard', service: 'repeatGuard', plugin: (inner: Context) => void inner.plugin(RepeatGuardService) }])
    const ready = await new Promise<Context>((resolve) => ctx.inject(['llm', 'settings', 'features'], resolve))
    await ready.features.idle()
    ready.settings.set({ features: { repeatGuard: false } })
    await ready.features.idle()
    for (let i = 0; i < 8; i++) ctx.emit('llm/tool-started', running('ses_1', 'read', { filePath: 'a.ts' }))
    expect((ready.llm as unknown as FakeLlm).reminded).toEqual([])
  })
})

describe('다시 연 대화 — 알림은 사람 말로 남지 않는다', () => {
  it('합성 글뿐인 user(알림)는 말풍선이 아니고, 그 뒤 답은 같은 턴의 답에 이어 붙는다', () => {
    const raw: EngineMessage[] = [
      { info: { id: 'msg_A', sessionID: 's', role: 'user', time: { created: 1 } }, parts: [{ type: 'text', text: '고쳐 줘' }] },
      { info: { id: 'msg_a1', sessionID: 's', role: 'assistant', parentID: 'msg_A', time: { created: 2, completed: 3 } }, parts: [{ type: 'text', text: '앞 ' }] },
      { info: { id: 'msg_R', sessionID: 's', role: 'user', time: { created: 4 } }, parts: [{ type: 'text', text: repeatReminder('read', 3), synthetic: true }] },
      { info: { id: 'msg_r1', sessionID: 's', role: 'assistant', parentID: 'msg_R', time: { created: 5, completed: 6 } }, parts: [{ type: 'text', text: '뒤' }] },
    ] as EngineMessage[]
    const messages = historyMessages(raw, false)
    expect(messages.map((message) => message.role)).toEqual(['user', 'assistant'])
    expect(messages[1]!.text).toBe('앞 뒤')
    expect(JSON.stringify(messages)).not.toContain('same arguments')
  })
})
