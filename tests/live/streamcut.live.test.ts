import { Context } from 'cordis'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import { ProviderRegistry, type ProviderConfig } from '../../src/services/providers.ts'
import { LlmService, STREAM_IDLE_TIMEOUT_MS, type Attention, type LlmConfig } from '../../src/services/llm.ts'
import { SLOW_MS } from './support/fakeLlm.ts'
import { EngineService } from '../../src/services/engine.ts'
import { tr } from '../../src/i18n.ts'
import { engineOptions } from './support/opencodeServer.ts'

// 세션 SSE 끊김과 답 밀림 회귀 (_workspace/01q). 세션 SSE 는 스텝의 LLM 스트림·도구 실행·승인 대기 동안 0바이트라, undici 기본
// 300초 타임아웃이면 앱 쪽에서 끊기고, 끊겨도 opencode 턴은 계속 돌아 다음 프롬프트가 이전 턴의 답을 받았다.
// 300초를 기다릴 수 없어 ctx.llm 에 짧은 타임아웃(STREAM_TIMEOUT_MS)을 주입해 같은 끊김을 만든다. 조용한 구간은 가짜 LLM 의 `[slow]`·`[late]`
// (SLOW_MS·LATE_MS 동안 첫 바이트를 안 보냄)와 승인 대기로 만든다. 끊긴 턴엔 `[slow]` 를 쓴다 — `[late]`(3초)는 끊김 판정(interruption 이
// 엔진 종료를 2초 기다림)이 끝나기 전에 첫 턴이 끝나 버려 밀림을 못 만든다

const STREAM_TIMEOUT_MS = 1_000
/** 승인 카드를 띄워 두고 답하지 않는 시간 — STREAM_TIMEOUT_MS 보다 길다 */
const APPROVAL_WAIT_MS = 3_000

const fibers: { dispose(): Promise<void> }[] = []
/** 이 테스트가 만든 임시 폴더 — 끝나면 이 경로만 지운다 */
let root: string
let work: string
/** 세션 SSE 타임아웃을 짧게 준 ctx.llm */
let short: Context
/** 제품과 같은 설정(무바이트 한도 STREAM_IDLE_TIMEOUT_MS — heartbeat 세 번)의 ctx.llm */
let product: Context

const fakeProvider = (): ProviderConfig => ({
  id: 'fake',
  displayName: 'Fake',
  baseURL: `${inject('fakeLlmUrl')}/v1`,
  protocol: 'openai-chat-completions',
  models: [{ id: 'echo', displayName: 'Echo' }],
})

async function startServices(state: string, config?: LlmConfig): Promise<Context> {
  const ctx = new Context()
  fibers.push(ctx.plugin(ProviderRegistry, { defaults: [fakeProvider()] }))
  fibers.push(ctx.plugin(EngineService, engineOptions(state)))
  fibers.push(ctx.plugin(LlmService, config))
  return new Promise<Context>((resolve) => ctx.inject(['providers', 'engine', 'llm'], (ready) => resolve(ready)))
}

beforeAll(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'litecode-streamcut-')))
  work = path.join(root, 'work')
  await fs.mkdir(work)
  ;[short, product] = await Promise.all([startServices(path.join(root, 'short'), { streamTimeoutMs: STREAM_TIMEOUT_MS }), startServices(path.join(root, 'product'))])
})

afterAll(async () => {
  for (const fiber of fibers.reverse()) await fiber.dispose()
  if (root) await fs.rm(root, { recursive: true, force: true })
})

/** 첫 승인 요청을 waitMs 뒤에 answer 로 답한다 (answer 가 없으면 답하지 않는다) */
function approveAfter(services: Context, waitMs: number, answer?: 'once') {
  const shown: Attention[][] = []
  const onAttention = (requests: Attention[]) => {
    shown.push(requests)
    const first = requests[0]
    if (first && answer && shown.length === 1) setTimeout(() => void services.llm.reply(first.sessionId, first.id, answer), waitMs)
  }
  return { shown, onAttention }
}

describe('세션 SSE 가 끊긴 뒤 (01q)', () => {
  it('끊긴 대화에 다시 보내면 새 질문이 자기 답을 받는다 (이전 턴의 답이 한 칸 밀려 붙지 않는다)', async () => {
    const first = await short.llm.chat('fake', 'echo', work, '[slow] 첫 질문')
    expect(first).toMatchObject({ ok: false, interrupted: true, error: tr('error.streamBroken') })

    const second = await short.llm.chat('fake', 'echo', work, '두 번째 질문', first.sessionId)
    expect(second).toMatchObject({ ok: true, text: 'echo: 두 번째 질문' })
  })

  it('승인 대기 중에 끊기면 opencode 턴도 멈춘다 — 그 대화의 다음 턴이 자기 답을 받는다', async () => {
    const waiting = approveAfter(short, 0)
    const first = await short.llm.chat('fake', 'echo', work, '[bash:pwd] 승인 대기', undefined, undefined, undefined, undefined, 'ask', waiting.onAttention)
    expect(waiting.shown[0]?.[0]).toMatchObject({ kind: 'permission' })
    expect(first).toMatchObject({ ok: false, interrupted: true })

    const second = await short.llm.chat('fake', 'echo', work, '다음 질문', first.sessionId)
    expect(second).toMatchObject({ ok: true, text: 'echo: 다음 질문' })
  })
})

describe(`제품 설정(무바이트 한도 ${STREAM_IDLE_TIMEOUT_MS}ms)`, () => {
  // 레거시 /event 는 10초마다 heartbeat 를 보낸다 — 한도는 FIN 없이 죽은 연결만 잡고, LLM 이 한도보다 오래 조용해도 턴은 끊기지 않는다 (이슈 #20)
  it(`LLM 이 ${SLOW_MS / 1000}초 동안 첫 바이트를 안 보내도(한도 ${STREAM_IDLE_TIMEOUT_MS / 1000}초 이상) heartbeat 덕에 끝까지 받는다`, async () => {
    expect(await product.llm.chat('fake', 'echo', work, '[slow] 오래 걸리는 답')).toMatchObject({ ok: true, text: 'echo: [slow] 오래 걸리는 답' })
  }, SLOW_MS + 20_000)

  it(`짧은 타임아웃이면 끊기는 승인 대기(${APPROVAL_WAIT_MS}ms)를 지나 끝까지 받는다`, async () => {
    const approving = approveAfter(product, APPROVAL_WAIT_MS, 'once')
    const result = await product.llm.chat('fake', 'echo', work, '[bash:pwd] 오래 기다린 승인', undefined, undefined, undefined, undefined, 'ask', approving.onAttention)
    expect(approving.shown[0]?.[0]).toMatchObject({ kind: 'permission' })
    expect(result).toMatchObject({ ok: true })
    expect(result.text?.split('\n')[0]).toBe(`tool: ${work}`)
  })

  it('첫 바이트가 늦은 LLM 답도 끊기지 않는다', async () => {
    expect(await product.llm.chat('fake', 'echo', work, '[late] 느린 답')).toMatchObject({ ok: true, text: 'echo: [late] 느린 답' })
  })
})
