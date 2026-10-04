import { Context, Service } from 'cordis'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SessionsService, type Conversation } from '../../src/services/sessions.ts'
import type { History } from '../../src/services/llm.ts'

// 대화 목록 정보 — userData 의 sessions.json. 내용의 정본은 opencode DB 이고 여기는 목록에 보일 것만 쥔다 (00_request 방식 A).
// 프로젝트마다 최근 50개(테스트는 낮춘다), 넘치면 마지막 활동이 가장 오래된 것부터 지운다. 지우기는 목록에서 빼고 엔진 세션도 지운다 —
// 엔진 삭제가 실패해도 목록에선 빼고, 다음 시작 때 다시 지워 본다.

let root: string
let file: string

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'litecode-sessions-')))
  file = path.join(root, 'userData', 'sessions.json')
})

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

/** ctx.llm 자리의 가짜 — 지우라고 받은 엔진 세션 id 를 적는다. failing 이면 지우기가 실패한다 */
class FakeLlm extends Service {
  deleted: string[] = []
  failing = false
  constructor(ctx: Context) {
    super(ctx, 'llm')
  }
  purges = 0
  async deleteSession(id: string): Promise<void> {
    if (this.failing) throw new Error('엔진이 안 떠 있다')
    this.deleted.push(id)
  }
  purgeDeleted(): void {
    this.purges++
  }
  async history(): Promise<History> {
    return { messages: [{ id: 'msg_a', role: 'user', text: 'Say world (풀어 쓴 template)' }, { role: 'assistant', text: 'echo' }, { id: 'msg_b', role: 'user', text: '그냥 질문' }] }
  }
}

async function start(options: { limit?: number; failing?: boolean } = {}): Promise<{ sessions: SessionsService; llm: FakeLlm }> {
  const ctx = new Context()
  ctx.plugin(FakeLlm)
  ctx.plugin(SessionsService, { file, limit: options.limit })
  return new Promise((resolve) =>
    ctx.inject(['sessions', 'llm'], (ready) => {
      const llm = ready.llm as unknown as FakeLlm
      llm.failing = options.failing ?? false
      resolve({ sessions: ready.sessions, llm })
    }),
  )
}

function conversation(id: string, patch: Partial<Conversation> = {}): Conversation {
  return { id, project: '/work/a', title: `제목 ${id}`, updatedAt: 1_000, ...patch }
}

const ids = (list: Conversation[]) => list.map((entry) => entry.id)
/** 엔진 삭제는 목록 저장 뒤에 따로 돈다 — 끝날 때까지 기다린다 */
const settle = () => new Promise((resolve) => setTimeout(resolve, 20))

describe('SessionsService', () => {
  it('지우기(수동·보관 개수 초과)는 sessions/removed 로 지운 id 를 알린다 — ctx.notifications 가 그 알림을 거둔다', async () => {
    const { sessions } = await start({ limit: 1 })
    const removed: string[][] = []
    sessions['ctx'].on('sessions/removed', (ids) => void removed.push(ids))
    await sessions.save(conversation('c1', { updatedAt: 1 }))
    await sessions.save(conversation('c2', { updatedAt: 2 }))
    await sessions.remove('c2')
    expect(removed).toEqual([['c1'], ['c2']])
  })

  it('대화별 모드를 저장해 다시 열어도 그대로다 — 손으로 고친 모르는 모드 값은 버린다 (기본 모드로 시작)', async () => {
    const { sessions } = await start()
    await sessions.save(conversation('c1', { mode: 'plan' }))
    await sessions.save(conversation('c2'))
    expect((await (await start()).sessions.list()).map((entry) => [entry.id, entry.mode])).toEqual([['c2', undefined], ['c1', 'plan']])
    const stored = JSON.parse(await fs.readFile(file, 'utf8')) as { conversations: Conversation[] }
    stored.conversations[1]!.mode = 'yolo' as never
    await fs.writeFile(file, JSON.stringify(stored))
    expect((await (await start()).sessions.list()).find((entry) => entry.id === 'c1')!.mode).toBeUndefined()
  })

  it('처음(파일 없음)에는 빈 목록이다', async () => {
    expect(await (await start()).sessions.list()).toEqual([])
  })

  it('저장한 목록 정보(제목·시각·엔진 세션·모델·통계)가 재시작해도 그대로다', async () => {
    const { sessions } = await start()
    const saved = conversation('c1', {
      engineSessionId: 'ses_1',
      model: { providerId: 'gw', modelId: 'm1' },
      usage: { turns: 2, steps: 3 },
      updatedAt: 5_000,
    })
    await sessions.save(saved)

    expect(await (await start()).sessions.list()).toEqual([saved])
  })

  it('새 대화는 맨 앞에 붙고, 같은 id 를 다시 저장하면 그 자리에서 고쳐진다', async () => {
    const { sessions } = await start()
    await sessions.save(conversation('c1'))
    await sessions.save(conversation('c2'))
    await sessions.save(conversation('c1', { title: '바뀐 제목' }))

    const list = await sessions.list()
    expect(ids(list)).toEqual(['c2', 'c1'])
    expect(list[1]!.title).toBe('바뀐 제목')
  })

  it('보내는 도중 붙인 엔진 세션 id 는, 그 id 를 모르는 화면이 다시 저장해도 지워지지 않는다', async () => {
    const { sessions } = await start()
    await sessions.save(conversation('c1'))
    await sessions.attach('c1', 'ses_1')
    await sessions.save(conversation('c1', { title: '모델만 바꿈' }))

    expect((await sessions.list())[0]).toMatchObject({ engineSessionId: 'ses_1', title: '모델만 바꿈' })
  })

  it('한 프로젝트가 제한을 넘으면 마지막 활동이 가장 오래된 것부터 지우고 엔진 세션도 지운다 — 다른 프로젝트는 세지 않는다', async () => {
    const { sessions, llm } = await start({ limit: 2 })
    await sessions.save(conversation('old', { updatedAt: 1_000, engineSessionId: 'ses_old' }))
    await sessions.save(conversation('mid', { updatedAt: 3_000, engineSessionId: 'ses_mid' }))
    await sessions.save(conversation('other', { project: '/work/b', updatedAt: 500 }))
    // 'old' 는 먼저 만들었지만 최근에 활동했다 — 만든 순서가 아니라 마지막 활동으로 고른다
    await sessions.save(conversation('old', { updatedAt: 4_000, engineSessionId: 'ses_old' }))

    expect(await sessions.save(conversation('new', { updatedAt: 5_000 }))).toEqual(['mid'])
    expect(ids(await sessions.list())).toEqual(['new', 'other', 'old'])
    await settle()
    expect(llm.deleted).toEqual(['ses_mid'])
    expect(llm.purges).toBe(1)
  })

  it('지우면 목록에서 빠지고 엔진 세션도 지운다', async () => {
    const { sessions, llm } = await start()
    await sessions.save(conversation('c1', { engineSessionId: 'ses_1' }))
    await sessions.save(conversation('c2'))

    await sessions.remove('c1')
    expect(ids(await sessions.list())).toEqual(['c2'])
    await settle()
    expect(llm.deleted).toEqual(['ses_1'])
    expect(llm.purges).toBe(1) // 지운 본문을 DB 파일에서 걷어내라고 한 번
  })

  it('엔진 삭제가 실패하면 DB 정리를 부르지 않는다', async () => {
    const { sessions, llm } = await start({ failing: true })
    await sessions.save(conversation('c1', { engineSessionId: 'ses_1' }))
    await sessions.remove('c1')
    await settle()
    expect(llm.purges).toBe(0)
  })

  it('엔진 삭제가 실패해도 목록에선 빠지고, 다음 시작 때 남은 엔진 세션을 다시 지운다', async () => {
    const first = await start({ failing: true })
    await first.sessions.save(conversation('c1', { engineSessionId: 'ses_1' }))
    await first.sessions.remove('c1')
    await settle()
    expect(await first.sessions.list()).toEqual([])
    expect(first.llm.deleted).toEqual([])

    const second = await start()
    await settle()
    expect(second.llm.deleted).toEqual(['ses_1'])

    const third = await start()
    await settle()
    expect(third.llm.deleted).toEqual([]) // 지운 것은 다시 안 지운다
  })

  // `/hi world` 는 풀어 쓴 template 으로 엔진에 간다 — 다시 열어도 친 글이 보이게 메시지 id 로 적어 둔다 (01d "말풍선 문제")
  it('label 로 적은 메시지는 다시 열면 그 글로 보이고, 화면이 labels 없이 다시 저장해도 남는다', async () => {
    const { sessions } = await start()
    await sessions.save(conversation('c1', { engineSessionId: 'ses_1' }))
    await sessions.label('c1', 'msg_a', '/hi world')
    await sessions.save(conversation('c1', { engineSessionId: 'ses_1', title: '바뀐 제목' }))

    expect((await (await start()).sessions.history('c1')).messages.map((message) => message.text)).toEqual(['/hi world', 'echo', '그냥 질문'])
  })

  // 글 파일 첨부(이슈 #44)는 엔진 기록에 file 파트가 없다(글로 풀어 보낸다) — 칩은 앱이 메시지 id 로 적어 둔다. 이미지 칩은 엔진 기록에서 온다
  it('noteAttachments 로 적은 파일 칩은 다시 열면 그 말풍선에 붙고(엔진 기록의 이미지 칩 앞), 화면이 다시 저장해도 남는다', async () => {
    const { sessions } = await start()
    await sessions.save(conversation('c1', { engineSessionId: 'ses_1' }))
    await sessions.label('c1', 'msg_a', '이것 봐 줘')
    await sessions.noteAttachments('c1', 'msg_a', [{ kind: 'file', name: 'openapi.yaml', size: 12_288 }])
    await sessions.save(conversation('c1', { engineSessionId: 'ses_1', title: '바뀐 제목' }))

    const again = await start()
    again.llm.history = async () => ({
      messages: [{ id: 'msg_a', role: 'user', text: '이것 봐 줘\n\nopenapi.yaml:\n```\n…\n```', attachments: [{ kind: 'image', name: 'shot.png' }] }, { id: 'msg_b', role: 'user', text: '그냥 질문' }],
    })
    expect((await again.sessions.history('c1')).messages).toEqual([
      { id: 'msg_a', role: 'user', text: '이것 봐 줘', attachments: [{ kind: 'file', name: 'openapi.yaml', size: 12_288 }, { kind: 'image', name: 'shot.png' }] },
      { id: 'msg_b', role: 'user', text: '그냥 질문' },
    ])
  })

  it('손상된 파일이면 빈 목록으로 시작한다', async () => {
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, '{ 깨짐')
    expect(await (await start()).sessions.list()).toEqual([])
  })
})
