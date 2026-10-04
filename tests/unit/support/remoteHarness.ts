import { Context, Service } from 'cordis'
import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { ChatService } from '../../../src/services/chat.ts'
import { ProjectsService } from '../../../src/services/projects.ts'
import { RemoteService, type RemoteServiceOptions } from '../../../src/services/remote.ts'
import { SessionsService } from '../../../src/services/sessions.ts'
import { SettingsService } from '../../../src/services/settings.ts'
import type { ChatResult } from '../../../src/services/llm.ts'
import type { Attention, History, HistoryMessage, TurnItem } from '../../../shared/contract.ts'
import type { ChatEventMap } from '../../../shared/chat.ts'
import type { PairResponse } from '../../../shared/remote.ts'

// ctx.remote 시험의 바탕 (이슈 #56) — 서버는 진짜 HTTP(127.0.0.1 빈 포트)로 띄운다. ctx.chat·ctx.sessions·ctx.projects·ctx.settings 는
// 진짜고, 엔진(ctx.llm)만 가짜다: 턴을 받아 쥐고 있다가 시험이 끝낸다. 루트 단위 테스트(tests/unit/remote.test.ts)와 모바일 클라이언트
// 코어를 이 서버에 붙이는 테스트(mobile/tests/desktop.test.ts)가 같이 쓴다 — 그래서 vitest 를 import 하지 않는다(두 쪽의 vitest 가 다르다).

export interface Call {
  prompt: string
  sessionId: string
  mode?: string
  progress(item: TurnItem): void
  attention(requests: Attention[]): void
  finish(result?: Partial<ChatResult>): void
}

export class FakeLlm extends Service {
  calls: Call[] = []
  replies: unknown[][] = []
  /** 다음 reply 가 던질 오류 */
  replyError?: string
  private transcript = new Map<string, HistoryMessage[]>()
  private ids = 0
  constructor(ctx: Context) {
    super(ctx, 'llm')
  }
  newMessageId(): string {
    return `msg_${++this.ids}`
  }
  async chat(
    _providerId: string,
    _modelId: string,
    _directory: string,
    prompt: string,
    sessionId?: string,
    onSession?: (sessionId: string) => Promise<void>,
    messageId?: string,
    onProgress?: (item: TurnItem) => void,
    mode?: string,
    onAttention?: (requests: Attention[]) => void,
    stop?: AbortSignal,
  ): Promise<ChatResult> {
    const id = sessionId ?? `ses_${this.calls.length + 1}`
    if (!sessionId) await onSession?.(id)
    const messages = this.transcript.get(id) ?? []
    this.transcript.set(id, messages)
    messages.push({ id: messageId, role: 'user', text: prompt })
    return new Promise<ChatResult>((resolve) => {
      this.calls.push({
        prompt,
        sessionId: id,
        mode,
        progress: (item) => onProgress?.(item),
        attention: (requests) => onAttention?.(requests),
        finish: (result = {}) => {
          messages.push({ role: 'assistant', text: `echo: ${prompt}` })
          resolve({ ok: true, sessionId: id, text: `echo: ${prompt}`, ...result })
        },
      })
      stop?.addEventListener('abort', () => resolve({ ok: false, sessionId: id, error: 'stopped', interrupted: true }))
    })
  }
  async history(_directory: string, sessionId: string): Promise<History> {
    return { messages: [...(this.transcript.get(sessionId) ?? [])] }
  }
  async reply(...args: unknown[]): Promise<void> {
    if (this.replyError) throw new Error(this.replyError)
    this.replies.push(args)
  }
  async stopSubtask(): Promise<boolean> {
    return false
  }
  async deleteSession(): Promise<void> {}
  purgeDeleted(): void {}
}

class FakeProviders extends Service {
  constructor(ctx: Context) {
    super(ctx, 'providers')
  }
  list() {
    return [{ id: 'gw', displayName: 'Gateway', baseURL: 'http://secret.example/v1', protocol: 'openai-chat-completions', hasKey: true, custom: true, models: [{ id: 'm1', displayName: 'Model One' }, { id: 'm2', displayName: '' }] }]
  }
  get(id: string) {
    return this.list().find((provider) => provider.id === id)
  }
}

export const MODEL = { providerId: 'gw', modelId: 'm1' }

/** 시험 하나의 자리 — 임시 폴더(root)·등록할 프로젝트 폴더·시계 밀기(offset, ms)·끝날 때 거둘 것 */
export const box = { root: '', project: '', offset: 0, cleanups: [] as (() => Promise<unknown> | unknown)[] }

/** beforeEach 에서 */
export async function setUp(): Promise<void> {
  box.offset = 0
  box.root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'litecode-remote-')))
  box.project = path.join(box.root, 'proj')
  await fs.mkdir(box.project)
}

/** afterEach 에서 — 띄운 서비스·스트림을 거두고 임시 폴더(만들 때 적어 둔 그 경로만)를 지운다 */
export async function tearDown(): Promise<void> {
  for (const cleanup of box.cleanups.reverse()) await cleanup()
  box.cleanups = []
  await fs.rm(box.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 })
}

export async function until(done: () => boolean, what = '조건'): Promise<void> {
  for (let tries = 0; tries < 600 && !done(); tries++) await new Promise((resolve) => setTimeout(resolve, 5))
  if (!done()) throw new Error(`기다렸지만 오지 않았다: ${what}`)
}

export interface Answer<T = any> {
  status: number
  body: T
  headers: http.IncomingHttpHeaders
}

export async function start(options: Partial<RemoteServiceOptions> = {}, enabled = true) {
  const { root, project, cleanups } = box
  const ctx = new Context()
  const fibers = [
    ctx.plugin(FakeLlm),
    ctx.plugin(FakeProviders),
    ctx.plugin(SettingsService),
    ctx.plugin(ProjectsService, { file: path.join(root, 'projects.json') }),
    ctx.plugin(SessionsService, { file: path.join(root, 'sessions.json') }),
    ctx.plugin(ChatService),
    ctx.plugin(RemoteService, { file: path.join(root, 'remote-devices.json'), port: 0, name: 'test-pc', appVersion: '1.2.3', now: () => Date.now() + box.offset, ...options }),
  ]
  cleanups.push(async () => {
    for (const fiber of fibers.reverse()) await fiber.dispose()
  })
  const ready = await new Promise<Context>((resolve) => ctx.inject(['remote', 'chat', 'sessions', 'projects', 'llm', 'settings'], resolve))
  const remote = ready.remote
  await remote.ready()
  await ready.projects.open(project)
  if (enabled) await remote.setEnabled(true)
  const llm = ready.llm as unknown as FakeLlm
  const chatEvents: { [K in keyof ChatEventMap]: [K, ChatEventMap[K]] }[keyof ChatEventMap][] = []
  ready.on('chat/turn-started', (data) => void chatEvents.push(['turn.started', data]))
  ready.on('chat/turn-ended', (data) => void chatEvents.push(['turn.ended', data]))

  const base = () => `http://${remote.status().addresses[0]}`

  /** 요청 하나 (node:http — Origin 같은 머리도 그대로 실린다) */
  const api = <T = any>(method: string, route: string, init: { token?: string; body?: unknown; raw?: string; headers?: Record<string, string> } = {}): Promise<Answer<T>> =>
    new Promise((resolve, reject) => {
      const payload = init.raw ?? (init.body === undefined ? undefined : JSON.stringify(init.body))
      const request = http.request(
        `${base()}${route}`,
        { method, agent: false, headers: { ...(init.token && { authorization: `Bearer ${init.token}` }), ...(payload !== undefined && { 'content-type': 'application/json' }), ...init.headers } },
        (response) => {
          let text = ''
          response.setEncoding('utf8')
          response.on('data', (chunk: string) => (text += chunk))
          response.on('end', () => resolve({ status: response.statusCode ?? 0, body: text ? JSON.parse(text) : undefined, headers: response.headers }))
        },
      )
      request.on('error', reject)
      request.end(payload)
    })

  /** 짝짓기 요청을 보내고 데스크탑 확인 창에 뜰 때까지 — 답은 answer 로 */
  const requestPair = async (deviceName = 'Pixel 8', code = remote.startPairing().pairing!.code) => {
    const before = remote.status().requests.length
    const answer = api<PairResponse>('POST', '/v1/pair', { body: { code, deviceName, platform: 'android' } })
    await until(() => remote.status().requests.length > before, '짝짓기 요청')
    return { answer, request: remote.status().requests.at(-1)! }
  }

  /** 짝지은 기기 하나 */
  const pair = async (deviceName = 'Pixel 8'): Promise<PairResponse> => {
    const { answer, request } = await requestPair(deviceName)
    remote.answerPair(request.id, true)
    const paired = await answer
    if (paired.status !== 200) throw new Error(`짝짓기 실패: ${paired.status}`)
    return paired.body
  }

  /** 이벤트 스트림 하나를 열어 모은다 */
  const events = async (token: string, query = '') => {
    let raw = ''
    let ended = false
    let status = 0
    const request = http.get(`${base()}/v1/events${query}`, { agent: false, headers: { authorization: `Bearer ${token}` } }, (response) => {
      status = response.statusCode ?? 0
      response.setEncoding('utf8')
      response.on('data', (chunk: string) => (raw += chunk))
      response.on('close', () => (ended = true))
    })
    request.on('error', () => (ended = true))
    cleanups.push(() => request.destroy())
    await until(() => status !== 0 || ended, '스트림 열림')
    return {
      get frames() {
        return parseFrames(raw)
      },
      raw: () => raw,
      ended: () => ended,
      status: () => status,
      close: () => request.destroy(),
      has: (name: string) => parseFrames(raw).some((frame) => frame.event === name),
    }
  }

  const save = (id: string, extra: Record<string, unknown> = {}) => ready.sessions.save({ id, project, title: `대화 ${id}`, updatedAt: Date.now(), model: MODEL, mode: 'build', ...extra })
  const turn = async (n: number): Promise<Call> => {
    await until(() => llm.calls.length >= n, `턴 ${n}`)
    return llm.calls[n - 1]!
  }
  return { ctx: ready, remote, llm, api, requestPair, pair, events, save, turn, chatEvents, base }
}

/** 받은 글에서 완성된 프레임만 (`: ping` 주석은 프레임이 아니다) */
export function parseFrames(raw: string): { event: string; data: any; seq?: number }[] {
  return raw
    .split('\n\n')
    .slice(0, -1)
    .filter((block) => block.includes('event: '))
    .map((block) => {
      const field = (name: string) => block.split('\n').find((line) => line.startsWith(`${name}: `))?.slice(name.length + 2)
      return { event: field('event')!, data: JSON.parse(field('data') ?? 'null'), seq: field('id') === undefined ? undefined : Number(field('id')) }
    })
}
