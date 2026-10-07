import { Context, Service } from 'cordis'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ChatService } from '../../src/services/chat.ts'
import { SessionsService } from '../../src/services/sessions.ts'
import { changesSince, commandChanges, takeSnapshot } from '../../src/services/commandChanges.ts'
import type { ChatOptions, ChatResult } from '../../src/services/llm.ts'
import type { ChatEventMap, QueuedSend } from '../../shared/chat.ts'
import type { FileDiff, TurnItem } from '../../shared/contract.ts'

// 명령으로 바뀐 파일 (이슈 #213) — 턴 앞뒤 두 번 뜬 git 스냅숏의 차이. 진짜 git 으로 임시 저장소를 만든다 (이 머신의 git).
// 고정하는 것: ① 도구 없이 sed 로 바뀐 파일 ② 턴 전부터 더러운 파일은 그 턴의 변경만 ③(화면 쪽 중복은 changedFiles.test) ④ 저장소 아님·git 없음
// ⑤ 상한 ⑥ 새 파일·삭제 ⑦ .gitignore 된 비밀 파일 + 진짜 ctx.chat 에 걸린 플러그인

let root: string
/** 대화 목록 파일 자리 — 저장소 밖 */
let state: string

const git = (...args: string[]): string => execFileSync('git', args, { cwd: root, encoding: 'utf8' })
const write = (file: string, text: string) => fs.writeFile(path.join(root, file), text)
/** 진짜 sed -i (BSD·GNU 둘 다 되게 백업 접미사를 주고 지운다) */
async function sed(file: string, script: string): Promise<void> {
  execFileSync('sed', ['-i.bak', script, file], { cwd: root })
  await fs.rm(path.join(root, `${file}.bak`))
}

async function repo(files: Record<string, string>): Promise<void> {
  git('init', '-q')
  git('config', 'user.email', 't@example.com')
  git('config', 'user.name', 't')
  git('config', 'commit.gpgsign', 'false')
  for (const [file, text] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true })
    await write(file, text)
  }
  git('add', '-A')
  git('commit', '-q', '-m', 'init')
}

const byPath = (diffs: readonly FileDiff[]) => Object.fromEntries(diffs.map((diff) => [diff.path, diff]))

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'litecode-cmdchanges-')))
  state = await fs.mkdtemp(path.join(os.tmpdir(), 'litecode-cmdchanges-state-'))
})

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
  await fs.rm(state, { recursive: true, force: true })
})

describe('takeSnapshot · changesSince — 턴 앞뒤 git 스냅숏의 차이', () => {
  it('① 도구 없이 sed 로 바꾼 파일이 들어간다 — 줄 수와 patch(@@ 부터)', async () => {
    await repo({ 'a.txt': 'one\ntwo\nthree\n', 'b.txt': 'keep\n' })
    const start = (await takeSnapshot(root))!
    expect(start).toBeDefined()
    await sed('a.txt', 's/two/TWO/')
    const found = (await changesSince(start))!
    expect(found.truncated).toBe(false)
    expect(found.diffs.map((diff) => diff.path)).toEqual(['a.txt'])
    expect(found.diffs[0]).toMatchObject({ path: 'a.txt', status: 'modified', added: 1, removed: 1 })
    expect(found.diffs[0]!.patch.startsWith('@@')).toBe(true)
    expect(found.diffs[0]!.patch).toContain('-two\n+TWO\n')
  })

  it('아무것도 안 바뀌면 빈 목록', async () => {
    await repo({ 'a.txt': 'one\n' })
    const start = (await takeSnapshot(root))!
    expect(await changesSince(start)).toEqual({ diffs: [], truncated: false })
  })

  it('② 턴 전부터 더러운 파일은 그 턴에 안 바뀌면 빠지고, 바뀌면 그 턴의 변경만 보인다', async () => {
    await repo({ 'dirty.txt': 'base\n', 'again.txt': 'line1\nline2\n' })
    await write('dirty.txt', 'base\nbefore-turn\n')
    await write('again.txt', 'line1\nline2\nbefore-turn\n')
    await write('scratch.txt', 'untracked before turn\n')
    const start = (await takeSnapshot(root))!
    await sed('again.txt', 's/line1/LINE1/')
    const found = (await changesSince(start))!
    expect(found.diffs.map((diff) => diff.path)).toEqual(['again.txt'])
    const patch = found.diffs[0]!.patch
    expect(found.diffs[0]).toMatchObject({ status: 'modified', added: 1, removed: 1 })
    expect(patch).toContain('-line1\n+LINE1\n')
    expect(patch).not.toContain('+before-turn') // 턴 전의 변경은 이 턴의 것이 아니다
  })

  it('② 같은 내용으로 다시 쓴 파일(포매터가 그대로 둔 것)은 빠진다', async () => {
    await repo({ 'a.txt': 'x\n' })
    await write('a.txt', 'dirty\n')
    const start = (await takeSnapshot(root))!
    await write('a.txt', 'dirty\n')
    expect((await changesSince(start))!.diffs).toEqual([])
  })

  it('⑥ 새 파일(untracked)은 added — 줄 전부가 추가, 지운 파일은 deleted', async () => {
    await repo({ 'gone.txt': 'a\nb\n', 'keep.txt': 'k\n' })
    const start = (await takeSnapshot(root))!
    await fs.mkdir(path.join(root, 'gen'))
    await write('gen/new.ts', 'export const a = 1\nexport const b = 2\n')
    await fs.rm(path.join(root, 'gone.txt'))
    const diffs = byPath((await changesSince(start))!.diffs)
    expect(Object.keys(diffs).sort()).toEqual(['gen/new.ts', 'gone.txt'])
    expect(diffs['gen/new.ts']).toMatchObject({ status: 'added', added: 2, removed: 0 })
    expect(diffs['gen/new.ts']!.patch).toContain('+export const b = 2')
    expect(diffs['gone.txt']).toMatchObject({ status: 'deleted', added: 0, removed: 2 })
  })

  it('⑥ 턴 전부터 있던 untracked 파일을 지우면 deleted, git add 까지 한 새 파일도 added', async () => {
    await repo({ 'k.txt': 'k\n' })
    await write('notes.txt', 'n1\nn2\n')
    const start = (await takeSnapshot(root))!
    await fs.rm(path.join(root, 'notes.txt'))
    await write('staged.txt', 's\n')
    git('add', 'staged.txt')
    const diffs = byPath((await changesSince(start))!.diffs)
    expect(diffs['notes.txt']).toMatchObject({ status: 'deleted', removed: 2 })
    expect(diffs['staged.txt']).toMatchObject({ status: 'added', added: 1 })
  })

  it('⑥ 바꾸고 git add 해도(인덱스에 올려도) 그 턴의 변경으로 보인다', async () => {
    await repo({ 'a.txt': 'old\n' })
    const start = (await takeSnapshot(root))!
    await write('a.txt', 'new\n')
    git('add', 'a.txt')
    expect((await changesSince(start))!.diffs[0]).toMatchObject({ path: 'a.txt', status: 'modified', added: 1, removed: 1 })
  })

  it('⑦ .gitignore 된 비밀 파일(.env)은 git 이 안 봐서 빠진다', async () => {
    await repo({ '.gitignore': '.env\n', 'a.txt': 'a\n' })
    await write('.env', 'KEY=old\n')
    const start = (await takeSnapshot(root))!
    await write('.env', 'KEY=secret\n')
    await write('.env.local', 'not ignored\n')
    const found = (await changesSince(start))!
    expect(found.diffs.map((diff) => diff.path)).toEqual(['.env.local'])
    expect(JSON.stringify(found)).not.toContain('secret')
  })

  it('프로젝트가 저장소의 하위 폴더면 그 폴더 안만, 경로는 프로젝트 기준', async () => {
    await repo({ 'outside.txt': 'o\n', 'pkg/inside.txt': 'i\n' })
    const start = (await takeSnapshot(path.join(root, 'pkg')))!
    await write('outside.txt', 'O\n')
    await write('pkg/inside.txt', 'I\n')
    expect((await changesSince(start))!.diffs.map((diff) => diff.path)).toEqual(['inside.txt'])
  })

  it('④ git 저장소가 아니면 undefined — 던지지 않는다', async () => {
    await write('a.txt', 'a\n')
    expect(await takeSnapshot(root)).toBeUndefined()
  })

  it('④ git 을 못 띄우면 undefined — 던지지 않는다', async () => {
    await repo({ 'a.txt': 'a\n' })
    expect(await takeSnapshot(root, { git: path.join(root, 'no-such-git') })).toBeUndefined()
  })

  it('⑤ 바뀐 파일 수 상한 — 넘으면 앞의 것만, truncated', async () => {
    await repo({ 'a.txt': 'a\n', 'b.txt': 'b\n', 'c.txt': 'c\n' })
    const start = (await takeSnapshot(root, { maxFiles: 2 }))!
    for (const file of ['a.txt', 'b.txt', 'c.txt']) await write(file, 'changed\n')
    const found = (await changesSince(start))!
    expect(found.diffs).toHaveLength(2)
    expect(found.truncated).toBe(true)
  })

  it('⑤ 상한과 딱 같으면 truncated 가 아니다', async () => {
    await repo({ 'a.txt': 'a\n', 'b.txt': 'b\n', 'c.txt': 'c\n' })
    const start = (await takeSnapshot(root, { maxFiles: 2 }))!
    for (const file of ['a.txt', 'b.txt']) await write(file, 'changed\n')
    expect((await changesSince(start))!).toMatchObject({ truncated: false, diffs: [{ path: 'a.txt' }, { path: 'b.txt' }] })
  })

  it('⑥ 빈 새 파일·바이너리 새 파일도 added (patch 는 빈 글)', async () => {
    await repo({ 'a.txt': 'a\n' })
    const start = (await takeSnapshot(root))!
    await write('empty.txt', '')
    await fs.writeFile(path.join(root, 'blob.bin'), Buffer.from([0, 1, 2, 0, 255]))
    const diffs = byPath((await changesSince(start))!.diffs)
    expect(diffs['empty.txt']).toEqual({ path: 'empty.txt', status: 'added', added: 0, removed: 0, patch: '' })
    expect(diffs['blob.bin']).toEqual({ path: 'blob.bin', status: 'added', added: 0, removed: 0, patch: '' })
  })

  it('⑤ 턴 전부터 더러운 파일이 상한을 넘으면 스냅숏을 믿을 수 없다 — 빈 목록 + truncated', async () => {
    await repo({ 'a.txt': 'a\n', 'b.txt': 'b\n' })
    await write('a.txt', 'A\n')
    await write('b.txt', 'B\n')
    const start = (await takeSnapshot(root, { maxEntries: 1 }))!
    await write('c.txt', 'new\n')
    expect(await changesSince(start)).toEqual({ diffs: [], truncated: true })
  })
})

// ── 진짜 ctx.chat 에 걸린 플러그인 — 'chat/before-send' 에 뜨고 'chat/after-turn' 에 비교해 그 턴의 진행 줄로 싣는다 ──

class FakeLlm extends Service {
  finishers: Array<() => void> = []
  problem: string | undefined
  private ids = 0
  constructor(ctx: Context) {
    super(ctx, 'llm')
  }
  newMessageId(): string {
    return `msg_${++this.ids}`
  }
  async folderProblem(): Promise<string | undefined> {
    return this.problem
  }
  async chat({ sessionId, onSession }: ChatOptions): Promise<ChatResult> {
    const id = sessionId ?? 'ses_1'
    if (!sessionId) await onSession?.(id)
    return new Promise<ChatResult>((resolve) => this.finishers.push(() => resolve({ ok: true, sessionId: id, text: '끝' })))
  }
}

class FakeProviders extends Service {
  constructor(ctx: Context) {
    super(ctx, 'providers')
  }
  get() {
    return { models: [{ id: 'm1' }] }
  }
}

async function until(done: () => boolean): Promise<void> {
  for (let tries = 0; tries < 600 && !done(); tries++) await new Promise((resolve) => setTimeout(resolve, 5))
  if (!done()) throw new Error('기다리던 일이 일어나지 않았다')
}

async function start() {
  const ctx = new Context()
  ctx.plugin(FakeLlm)
  ctx.plugin(FakeProviders)
  ctx.plugin(SessionsService, { file: path.join(state, 'sessions.json') })
  ctx.plugin(ChatService)
  ctx.plugin(commandChanges)
  const ready = await new Promise<Context>((resolve) => ctx.inject(['chat', 'llm'], resolve))
  const ended: ChatEventMap['turn.ended'][] = []
  ctx.on('chat/turn-ended', (data) => void ended.push(data))
  return { chat: ready.chat, llm: ready.llm as unknown as FakeLlm, ended }
}

const send: QueuedSend = { project: '', text: '고쳐 줘', model: { providerId: 'gw', modelId: 'm1' }, mode: 'build' }
const changesOf = (items: readonly TurnItem[] | undefined) => (items ?? []).filter((item) => item.kind === 'changes')

describe('commandChanges 플러그인', () => {
  it('턴 중에 명령으로 바뀐 파일이 그 턴의 진행 줄(changes)로 실린다', async () => {
    await repo({ 'a.txt': 'one\n' })
    const { chat, llm, ended } = await start()
    await chat.send('c1', { ...send, project: root })
    await until(() => llm.finishers.length === 1) // 스냅숏은 엔진에 보내기 전에 끝났다
    await write('a.txt', 'ONE\n')
    llm.finishers[0]!()
    await until(() => ended.length === 1)
    const [item] = changesOf(ended[0]!.message.items)
    expect(item).toMatchObject({ kind: 'changes', diffs: [{ path: 'a.txt', status: 'modified', added: 1, removed: 1 }] })
  })

  it('엔진에 넘기지 않는 폴더(engineFolder 문)면 git 을 부르지 않는다 — 줄이 없다', async () => {
    await repo({ 'a.txt': 'one\n' })
    const { chat, llm, ended } = await start()
    llm.problem = '플러그인 파일이 있다'
    await chat.send('c1', { ...send, project: root })
    await until(() => llm.finishers.length === 1)
    await write('a.txt', 'ONE\n')
    llm.finishers[0]!()
    await until(() => ended.length === 1)
    expect(changesOf(ended[0]!.message.items)).toEqual([])
  })

  it('git 저장소가 아니면 줄이 없다 — 턴은 그대로 끝난다', async () => {
    const { chat, llm, ended } = await start()
    await chat.send('c1', { ...send, project: root })
    await until(() => llm.finishers.length === 1)
    await write('a.txt', 'new\n')
    llm.finishers[0]!()
    await until(() => ended.length === 1)
    expect(ended[0]!.outcome).toBe('done')
    expect(changesOf(ended[0]!.message.items)).toEqual([])
  })
})
