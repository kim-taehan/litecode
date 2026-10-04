import { Context, Service } from 'cordis'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SessionsService, type Conversation } from '../../src/services/sessions.ts'
import type { History } from '../../src/services/llm.ts'
import { TITLE_MAX } from '../../shared/chat.ts'

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

  // 다른 대화가 보낸 지시(이슈 #55)는 엔진 기록에 감싼 글(`<message-from-conversation …>`)만 있다 — 본문은 label, 출처는 noteOrigin 으로 적어 둔다
  it('noteOrigin 으로 적은 출처는 다시 열면 그 말풍선에 붙고, 화면이 다시 저장해도 남는다 — 보낸 대화가 지워져도 제목이 보인다', async () => {
    const { sessions } = await start()
    await sessions.save(conversation('c1', { engineSessionId: 'ses_1' }))
    await sessions.label('c1', 'msg_a', '깨진 테스트를 고쳐 줘')
    await sessions.noteOrigin('c1', 'msg_a', { conversationId: 'gone', title: '릴리스 준비' })
    await sessions.save(conversation('c1', { engineSessionId: 'ses_1', title: '바뀐 제목' }))

    const messages = (await (await start()).sessions.history('c1')).messages
    expect(messages[0]).toMatchObject({ id: 'msg_a', text: '깨진 테스트를 고쳐 줘', origin: { conversationId: 'gone', title: '릴리스 준비' } })
    expect(messages.slice(1).every((message) => message.origin === undefined)).toBe(true)
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

  // 이슈 #52 — 턴 끝의 시각·통계(ctx.chat)와 고른 모델·모드(화면)를 서로 덮지 않고 적는다
  it('patch 는 준 필드만 고친다 — 제목·카드·보일 글은 그대로, 저장 안 된 대화면 아무것도 안 하고 undefined', async () => {
    const { sessions } = await start()
    await sessions.save(conversation('c1', { engineSessionId: 'ses_1', usage: { turns: 1 } }))
    await sessions.label('c1', 'msg_a', '/hi world')
    const patched = await sessions.patch('c1', (entry) => ({ updatedAt: 5_000, usage: { turns: (entry.usage as { turns: number }).turns + 1 } }))
    expect(patched).toMatchObject({ id: 'c1', title: '제목 c1', engineSessionId: 'ses_1', updatedAt: 5_000, usage: { turns: 2 }, labels: { msg_a: '/hi world' } })
    await sessions.patch('c1', () => ({ model: { providerId: 'gw', modelId: 'm2' }, mode: 'plan' }))
    expect((await sessions.list())[0]).toMatchObject({ updatedAt: 5_000, usage: { turns: 2 }, model: { providerId: 'gw', modelId: 'm2' }, mode: 'plan' })
    expect(await sessions.patch('nope', () => ({ updatedAt: 1 }))).toBeUndefined()
    expect(ids(await sessions.list())).toEqual(['c1'])
  })

  it('손상된 파일이면 빈 목록으로 시작한다', async () => {
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, '{ 깨짐')
    expect(await (await start()).sessions.list()).toEqual([])
  })

  // 참고 레포 검토(02x A): 깨진 파일을 빈 목록으로 읽은 뒤 다음 쓰기가 원본을 덮었다 — 옆에 옮겨 둔다
  it('손상된 파일은 덮어쓰지 않고 옆에 .corrupt-<시각> 으로 옮겨 둔다', async () => {
    const raw = '{"conversations":[{"id":"c9" 깨짐'
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, raw)
    const { sessions } = await start()
    await sessions.save(conversation('c1'))

    const backups = (await fs.readdir(path.dirname(file))).filter((name) => name.startsWith('sessions.json.corrupt-'))
    expect(backups).toHaveLength(1)
    expect(await fs.readFile(path.join(path.dirname(file), backups[0]!), 'utf8')).toBe(raw)
    expect(ids(await sessions.list())).toEqual(['c1'])
  })
})

describe('SessionsService — 대화 고정 (이슈 #79)', () => {
  it('고정·해제를 적고 고친 대화를 준다 — 시각·순서는 그대로, 다시 켜도 남는다. 해제하면 표식이 없다', async () => {
    const { sessions } = await start()
    await sessions.save(conversation('c1', { updatedAt: 3_000 }))
    await sessions.save(conversation('c2'))

    expect(await sessions.pin('c1', true)).toMatchObject({ id: 'c1', pinned: true, updatedAt: 3_000 })
    const again = (await start()).sessions
    expect(ids(await again.list())).toEqual(['c2', 'c1'])
    expect((await again.list())[1]!.pinned).toBe(true)

    expect((await again.pin('c1', false))!.pinned).toBeUndefined()
    expect((await (await start()).sessions.list())[1]).not.toHaveProperty('pinned')
  })

  it('저장 안 된 대화는 고정하지 못한다 (undefined, 새로 만들지 않는다)', async () => {
    const { sessions } = await start()

    expect(await sessions.pin('없는-대화', true)).toBeUndefined()
    expect(await sessions.list()).toEqual([])
  })

  it('고정은 그 뒤의 통째 저장(save)·patch 가 지우지 않는다 — 화면이 보낸 목록 정보엔 고정이 없다', async () => {
    const { sessions } = await start()
    await sessions.save(conversation('c1'))
    await sessions.pin('c1', true)
    await sessions.save(conversation('c1', { updatedAt: 9_000 }))
    await sessions.patch('c1', () => ({ updatedAt: 9_500 }))

    expect((await sessions.list())[0]).toMatchObject({ pinned: true, updatedAt: 9_500 })
  })

  it('고정한 대화는 보관 개수에 세지 않고 자동 삭제되지 않는다 — 가장 오래됐어도 남고, 고정 안 한 것 중 오래된 것부터 지운다', async () => {
    const { sessions, llm } = await start({ limit: 2 })
    await sessions.save(conversation('old', { updatedAt: 1, engineSessionId: 'ses_old' }))
    await sessions.pin('old', true)
    await sessions.save(conversation('c2', { updatedAt: 2, engineSessionId: 'ses_2' }))
    expect(await sessions.save(conversation('c3', { updatedAt: 3 }))).toEqual([]) // 고정 1 + 나머지 2 — 아직 안 넘쳤다
    expect(await sessions.save(conversation('c4', { updatedAt: 4 }))).toEqual(['c2'])
    await settle()

    expect(ids(await sessions.list())).toEqual(['c4', 'c3', 'old'])
    expect(llm.deleted).toEqual(['ses_2'])
  })

  it('고정을 풀면 다음 저장 때 다시 보관 개수에 든다', async () => {
    const { sessions } = await start({ limit: 1 })
    await sessions.save(conversation('old', { updatedAt: 1 }))
    await sessions.pin('old', true)
    await sessions.save(conversation('c2', { updatedAt: 2 }))
    await sessions.pin('old', false)

    expect(await sessions.save(conversation('c3', { updatedAt: 3 }))).toEqual(['old', 'c2'])
  })
})

describe('SessionsService — 대화 이름 바꾸기 (이슈 #63)', () => {
  it('제목만 바꾸고(앞뒤 공백은 뗀다) 고친 대화를 준다 — 다른 정보는 그대로, 다시 켜도 남는다', async () => {
    const { sessions } = await start()
    await sessions.save(conversation('c1', { engineSessionId: 'ses_1', updatedAt: 3_000, labels: { msg_a: '/hi world' } }))
    await sessions.save(conversation('c2'))

    expect(await sessions.rename('c1', '  결제 API 문서 정리  ')).toMatchObject({ id: 'c1', title: '결제 API 문서 정리', engineSessionId: 'ses_1', updatedAt: 3_000 })

    const list = await (await start()).sessions.list()
    expect(ids(list)).toEqual(['c2', 'c1']) // 순서·시각은 안 바뀐다
    expect(list[1]).toMatchObject({ title: '결제 API 문서 정리', labels: { msg_a: '/hi world' } })
    expect(list[0]!.title).toBe('제목 c2')
  })

  it('빈 이름(공백뿐)은 저장하지 않는다 — 제목은 그대로이고 undefined', async () => {
    const { sessions } = await start()
    await sessions.save(conversation('c1'))

    expect(await sessions.rename('c1', '   ')).toBeUndefined()
    expect(await sessions.rename('c1', '')).toBeUndefined()
    expect((await sessions.list())[0]!.title).toBe('제목 c1')
  })

  it('길이 상한(자동 제목과 같은 80자)을 넘으면 자른다', async () => {
    const { sessions } = await start()
    await sessions.save(conversation('c1'))

    expect((await sessions.rename('c1', '가'.repeat(200)))!.title).toBe('가'.repeat(TITLE_MAX))
  })

  it('저장 안 된 대화는 못 바꾼다 (undefined, 새로 만들지 않는다)', async () => {
    const { sessions } = await start()

    expect(await sessions.rename('없는-대화', '이름')).toBeUndefined()
    expect(await sessions.list()).toEqual([])
  })

  it('사용자가 바꾼 제목은 그 뒤의 통째 저장(save)이 덮지 않는다 — 다시 켠 뒤에도. 다시 이름 바꾸기는 된다', async () => {
    const { sessions } = await start()
    await sessions.save(conversation('c1'))
    await sessions.rename('c1', '내가 지은 이름')
    await sessions.save(conversation('c1', { title: '자동 제목', updatedAt: 9_000 }))

    expect((await sessions.list())[0]).toMatchObject({ title: '내가 지은 이름', updatedAt: 9_000 })
    const again = (await start()).sessions
    await again.save(conversation('c1', { title: '또 자동 제목' }))
    expect((await again.list())[0]!.title).toBe('내가 지은 이름')
    expect((await again.rename('c1', '두 번째 이름'))!.title).toBe('두 번째 이름')
  })
})
