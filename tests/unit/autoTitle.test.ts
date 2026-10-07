import { Context, Service } from 'cordis'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ChatService } from '../../src/services/chat.ts'
import { SessionsService } from '../../src/services/sessions.ts'
import { SettingsService } from '../../src/services/settings.ts'
import { AUTO_TITLE_INPUT_BYTES, AUTO_TITLE_MAX, autoTitle, cleanTitle, titlePrompt } from '../../src/services/autoTitle.ts'
import type { ChatOptions, ChatResult } from '../../src/services/llm.ts'
import { setMainLanguage } from '../../src/i18n.ts'
import type { TurnUsage } from '../../shared/contract.ts'

// 자동 대화 제목 (이슈 #215) — 설정이 켜져 있으면 첫 턴이 잘 끝난 뒤 ctx.llm.askOnce(임시 세션)로 짧은 제목을 한 번 묻는다.
// ctx.llm 은 가짜다: 턴은 바로 끝나고, askOnce 는 시험이 정한 대로 답한다. ctx.sessions·ctx.chat·ctx.settings 는 진짜(임시 파일·메모리)다.

interface Ask {
  providerId: string
  modelId: string
  directory: string
  prompt: string
  stop?: AbortSignal
}

type AskResult = { ok: true; text: string } | { ok: false; error: string }

class FakeLlm extends Service {
  asks: Ask[] = []
  /** 다음 askOnce 의 답 — 기본은 바로 "Fix login bug" */
  answer: (ask: Ask) => Promise<AskResult> = async () => ({ ok: true, text: 'Fix login bug' })
  /** 턴의 답 글 (기본 "echo: <prompt>"), 결과를 바꾸려면 result */
  result: Partial<ChatResult> = {}
  private ids = 0
  private turns = 0
  constructor(ctx: Context) {
    super(ctx, 'llm')
  }
  newMessageId(): string {
    return `msg_${++this.ids}`
  }
  async chat({ prompt, sessionId, onSession }: ChatOptions): Promise<ChatResult> {
    const id = sessionId ?? `ses_${++this.turns}`
    if (!sessionId) await onSession?.(id)
    return { ok: true, sessionId: id, text: `echo: ${prompt}`, usage: USAGE, ...this.result }
  }
  async askOnce(ask: Ask): Promise<AskResult> {
    this.asks.push(ask)
    return this.answer(ask)
  }
  async deleteSession(): Promise<void> {}
  purgeDeleted(): void {}
}

class FakeProviders extends Service {
  constructor(ctx: Context) {
    super(ctx, 'providers')
  }
  get(id: string) {
    return id === 'gw' ? { models: [{ id: 'm1' }] } : undefined
  }
}

const USAGE: TurnUsage = { steps: 1, tokens: { input: 10, output: 5, reasoning: 0, cacheRead: 0, cacheWrite: 0 }, llmMs: 100, toolMs: 0, ttftMs: 10, ttftSteps: 1, lastContextTokens: 15 }
const MODEL = { providerId: 'gw', modelId: 'm1' }
const TIMEOUT_MS = 80
let root: string

beforeEach(async () => {
  setMainLanguage('ko')
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'litecode-autotitle-')))
})

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 })
})

async function start({ on = true } = {}) {
  const ctx = new Context()
  ctx.plugin(FakeLlm)
  ctx.plugin(FakeProviders)
  ctx.plugin(SettingsService, on ? { defaults: { autoTitle: true } } : {})
  ctx.plugin(SessionsService, { file: path.join(root, 'sessions.json') })
  ctx.plugin(ChatService)
  ctx.plugin(autoTitle, { timeoutMs: TIMEOUT_MS })
  const ready = await new Promise<Context>((resolve) => ctx.inject(['chat', 'sessions', 'llm', 'settings'], resolve))
  const events: string[] = []
  const changed: string[] = []
  ctx.on('chat/turn-started', ({ cid }) => void events.push(`started ${cid}`))
  ctx.on('chat/turn-ended', ({ cid, outcome }) => void events.push(`ended ${cid} ${outcome}`))
  ctx.on('chat/conversations-changed', ({ project }) => void changed.push(project))
  const llm = ready.llm as unknown as FakeLlm
  const stored = async (id: string) => (await ready.sessions.list()).find((entry) => entry.id === id)
  /** 보내고 턴이 끝날 때까지 */
  const send = async (cid: string, text: string, extra: { display?: string } = {}) => {
    const before = events.filter((event) => event.startsWith('ended')).length
    await ready.chat.send(cid, { text, ...extra, project: root, model: MODEL })
    await until(() => events.filter((event) => event.startsWith('ended')).length > before)
  }
  return { ctx: ready, llm, events, changed, stored, send }
}

async function until(check: () => boolean | Promise<boolean>, ms = 2_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('timeout')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, TIMEOUT_MS + 40))

describe('자동 대화 제목 (이슈 #215)', () => {
  it('설정이 꺼져 있으면(기본) 묻지 않는다 — 제목은 첫 메시지 그대로', async () => {
    const { llm, stored, send, ctx } = await start({ on: false })
    expect(ctx.settings.get().autoTitle).toBeUndefined()
    await send('c1', 'login page is broken when I press enter')
    await settle()
    expect(llm.asks).toEqual([])
    expect((await stored('c1'))?.title).toBe('login page is broken when I press enter')
  })

  it('켜져 있으면 첫 턴이 잘 끝난 뒤 그 대화의 모델·폴더로 한 번 묻고 제목을 바꾼 뒤 목록 바뀜을 알린다 — 첫 사용자 글과 첫 답이 실린다', async () => {
    const { llm, stored, send, changed } = await start()
    await send('c1', 'login page is broken when I press enter')
    await until(async () => (await stored('c1'))?.title === 'Fix login bug')
    expect(llm.asks).toHaveLength(1)
    expect(llm.asks[0]).toMatchObject({ providerId: 'gw', modelId: 'm1', directory: root })
    expect(llm.asks[0]!.prompt).toContain('login page is broken when I press enter')
    expect(llm.asks[0]!.prompt).toContain('echo: login page is broken when I press enter')
    expect(llm.asks[0]!.stop).toBeInstanceOf(AbortSignal)
    expect(changed.at(-1)).toBe(root)
    expect((await stored('c1'))?.renamed).toBeUndefined() // 자동 제목은 "사용자가 바꾼 제목" 이 아니다
  })

  it('실패·빈 답·던짐이면 조용히 기존 제목을 둔다 — 화면에 가는 오류·턴 이벤트가 없다', async () => {
    for (const [index, answer] of [
      async (): Promise<AskResult> => ({ ok: false, error: 'HTTP 502' }),
      async (): Promise<AskResult> => ({ ok: true, text: '  \n "" \n' }),
      async (): Promise<AskResult> => {
        throw new Error('engine gone')
      },
    ].entries()) {
      const cid = `c${index}` // 같은 목록 파일 — 대화마다 첫 턴이게
      const { llm, stored, send, events, changed } = await start()
      llm.answer = answer
      await send(cid, 'first question')
      await settle()
      expect(llm.asks).toHaveLength(1)
      expect((await stored(cid))?.title).toBe('first question')
      expect(events).toEqual([`started ${cid}`, `ended ${cid} done`])
      expect(changed).toEqual([root]) // 첫 저장의 알림 하나뿐
    }
  })

  it('시간 안에 답이 없으면 멈춤 신호를 걸고 기존 제목을 둔다 — 늦게 온 답도 안 쓴다', async () => {
    const { llm, stored, send } = await start()
    let late!: (result: AskResult) => void
    llm.answer = () => new Promise((resolve) => (late = resolve))
    await send('c1', 'first question')
    await until(() => llm.asks.length === 1)
    await until(() => llm.asks[0]!.stop!.aborted)
    late({ ok: true, text: 'Too late' })
    await settle()
    expect((await stored('c1'))?.title).toBe('first question')
  })

  it('턴 끝 처리를 막지 않는다 — 답을 기다리는 동안에도 턴은 끝나 있고 다음 보내기가 바로 간다', async () => {
    const { ctx, llm, send } = await start()
    llm.answer = () => new Promise(() => {}) // 끝나지 않는다 (게이트웨이가 꺼져 있다)
    await send('c1', 'first question')
    expect(ctx.chat.running()).toBe(0)
    await send('c1', 'second question') // 막히면 until 이 시간 초과로 던진다
  })

  it('두 번째 턴에는 묻지 않는다 (한 대화에 한 번)', async () => {
    const { llm, stored, send } = await start()
    await send('c1', 'first question')
    await until(async () => (await stored('c1'))?.title === 'Fix login bug')
    await send('c1', 'second question')
    await settle()
    expect(llm.asks).toHaveLength(1)
  })

  it('첫 턴이 실패하면 묻지 않는다', async () => {
    const { llm, send } = await start()
    llm.result = { ok: false, text: '', error: 'boom' }
    await send('c1', 'first question')
    await settle()
    expect(llm.asks).toEqual([])
  })

  it('묻는 사이 사용자가 이름을 바꿨으면 덮지 않는다', async () => {
    const { ctx, llm, stored, send } = await start()
    let reply!: (result: AskResult) => void
    llm.answer = () => new Promise((resolve) => (reply = resolve))
    await send('c1', 'first question')
    await until(() => llm.asks.length === 1)
    await ctx.chat.rename('c1', 'My name')
    reply({ ok: true, text: 'Auto name' })
    await settle()
    expect(await stored('c1')).toMatchObject({ title: 'My name', renamed: true })
  })

  it('임시 세션은 대화 목록·통계에 안 남는다 — 대화는 하나, 통계는 첫 턴 것만, 엔진 세션은 그 대화의 것 그대로', async () => {
    const { ctx, stored, send } = await start()
    await send('c1', 'first question')
    await until(async () => (await stored('c1'))?.title === 'Fix login bug')
    const list = await ctx.sessions.list()
    expect(list.map((entry) => entry.id)).toEqual(['c1'])
    expect(list[0]).toMatchObject({ engineSessionId: 'ses_1', usage: { turns: 1 } })
  })

  it('보낸 본문이 아니라 말풍선 글(친 글)을 싣는다 — `/` 명령이 풀어 쓴 본문은 가지 않는다', async () => {
    const { llm, send } = await start()
    await send('c1', 'EXPANDED TEMPLATE BODY', { display: '/review src' })
    await until(() => llm.asks.length === 1)
    expect(llm.asks[0]!.prompt).toContain('/review src')
    expect(llm.asks[0]!.prompt.split('<user>')[1]!.split('</user>')[0]).not.toContain('EXPANDED TEMPLATE BODY')
  })
})

describe('titlePrompt — 실리는 양의 상한', () => {
  it('첫 사용자 글과 첫 답은 각각 상한 바이트까지만 (한글이 잘려 깨지지 않는다)', () => {
    const prompt = titlePrompt('가'.repeat(5_000), 'b'.repeat(5_000))
    const user = prompt.split('<user>\n')[1]!.split('\n</user>')[0]!
    const answer = prompt.split('<assistant>\n')[1]!.split('\n</assistant>')[0]!
    expect(Buffer.byteLength(user)).toBeLessThanOrEqual(AUTO_TITLE_INPUT_BYTES)
    expect(user).toMatch(/^가+$/)
    expect(Buffer.byteLength(answer)).toBeLessThanOrEqual(AUTO_TITLE_INPUT_BYTES)
  })
})

describe('cleanTitle — 모델이 준 제목 다듬기', () => {
  it('첫 줄만, 앞뒤 따옴표·"Title:"·머리표·끝 마침표를 떼고 공백을 줄인다', () => {
    expect(cleanTitle('"Fix login bug"')).toBe('Fix login bug')
    expect(cleanTitle('\n\nTitle: “Fix  login   bug”.\nExplanation: the user …')).toBe('Fix login bug')
    expect(cleanTitle('제목: 「로그인 버그 고치기」')).toBe('로그인 버그 고치기')
    expect(cleanTitle('# **Refactor auth module**')).toBe('Refactor auth module')
    expect(cleanTitle("'single'")).toBe('single')
    expect(cleanTitle('`code title`')).toBe('code title')
  })

  it('긴 글은 상한 글자 수로 자른다 (글자 단위 — 이모지·한글이 깨지지 않는다)', () => {
    const title = cleanTitle('가'.repeat(100))
    expect([...title]).toHaveLength(AUTO_TITLE_MAX)
    expect([...cleanTitle('😀'.repeat(100))]).toHaveLength(AUTO_TITLE_MAX)
  })

  it('쓸 글이 없으면 빈 글', () => {
    expect(cleanTitle('')).toBe('')
    expect(cleanTitle('  \n  ')).toBe('')
    expect(cleanTitle('""')).toBe('')
    expect(cleanTitle('<think>hmm</think>')).toBe('')
  })

  it('생각 블록(<think>)은 뺀다', () => {
    expect(cleanTitle('<think>\nlet me think\n</think>\nDeploy script fix')).toBe('Deploy script fix')
  })
})
