import { Context, Service } from 'cordis'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { ChatService } from '../../src/services/chat.ts'
import { HooksService, stopFeedback } from '../../src/services/hooks.ts'
import { entriesFor, gateMatchers, parseHooks, parseProjects, serializeHooks, serializeProjects } from '../../src/services/hooks/config.ts'
import { decodeHook, hookEnv, hookSpawn, hookStdin, runHook, type HookInput } from '../../src/services/hooks/run.ts'
import { SessionsService } from '../../src/services/sessions.ts'
import type { ChatResult, ToolDone } from '../../src/services/llm.ts'
import { setMainLanguage, tr } from '../../src/i18n.ts'
import { hookKey, hookTimeout, matchesTool, STOP_CHAIN_MAX, type HookDef } from '../../shared/hooks.ts'
import type { ChatEventMap, QueuedSend } from '../../shared/chat.ts'
import type { TurnItem } from '../../shared/contract.ts'

// 훅 (ctx.hooks, 이슈 #102 1단계 — 설계 _workspace/01af_hooks.md §6-6 ①). 단위로 고정하는 것: 매처 / 종료 코드 0·2·그 밖·기한 /
// 합치기(가장 제한적) / 턴 끝 훅의 연속 상한 / stdin 모양 / 도구 인자가 명령 문자열에 안 들어감 + 진짜 Cordis Context 에서 ctx.chat 과의 연결.
// 훅 명령은 진짜 /bin/sh 로 돈다 (SHELL 을 이 파일 동안만 바꾼다 — 로그인 zsh 는 뜨는 데만 수백 ms 다). ctx.llm 은 가짜, ctx.sessions·ctx.chat 은 진짜

let root: string
let shellBefore: string | undefined

beforeAll(() => {
  shellBefore = process.env['SHELL']
  process.env['SHELL'] = '/bin/sh'
})

afterAll(() => {
  if (shellBefore === undefined) delete process.env['SHELL']
  else process.env['SHELL'] = shellBefore
})

beforeEach(async () => {
  setMainLanguage('ko')
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'litecode-hooks-')))
})

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 })
})

const hook = (event: HookDef['event'], command: string, patch: Partial<HookDef> = {}): HookDef => ({ event, matcher: '', command, enabled: true, ...patch })
const input = (patch: Partial<HookInput> = {}): HookInput => ({ event: 'UserPromptSubmit', directory: root, conversationId: 'c1', ...patch })

describe('matchesTool (매처)', () => {
  it('비었거나 * 면 전부', () => {
    expect(matchesTool('', 'bash')).toBe(true)
    expect(matchesTool('  ', 'litecode_open_file')).toBe(true)
    expect(matchesTool('*', 'edit')).toBe(true)
  })

  it('| 나열은 이름 전체가 맞아야 한다', () => {
    expect(matchesTool('edit|write', 'edit')).toBe(true)
    expect(matchesTool('edit|write', 'write')).toBe(true)
    expect(matchesTool('edit|write', 'read')).toBe(false)
    expect(matchesTool('edit', 'multiedit')).toBe(false)
    expect(matchesTool('bash', 'bash_extra')).toBe(false)
  })

  it('정규식 — MCP 도구(`<서버>_<도구>`) 묶음', () => {
    expect(matchesTool('github_.*', 'github_create_issue')).toBe(true)
    expect(matchesTool('github_.*', 'gitlab_create_issue')).toBe(false)
    expect(matchesTool('(read|glob|grep)', 'grep')).toBe(true)
  })

  it('Claude Code 이름(Bash·Edit·Write·Read·Task)은 대소문자 무시로 엔진 이름과 같다', () => {
    for (const [matcher, tool] of [['Bash', 'bash'], ['Edit|Write', 'write'], ['Read', 'read'], ['Task', 'task']] as const) expect(matchesTool(matcher, tool)).toBe(true)
    expect(matchesTool('Bash', 'edit')).toBe(false)
  })

  it('잘못된 정규식은 "안 맞음" — 던지지 않는다', () => {
    expect(matchesTool('edit(', 'edit')).toBe(false)
    expect(matchesTool('[', '[')).toBe(false)
  })
})

describe('훅 정의 파일 (hooks/config.ts)', () => {
  const FILE = {
    hooks: {
      PreToolUse: [{ matcher: 'bash', hooks: [{ type: 'command', command: './guard.sh', timeout: 10 }] }],
      PostToolUse: [{ matcher: 'edit|write', hooks: [{ type: 'command', command: 'fmt "$LITECODE_FILE"' }, { type: 'command', command: 'lint', enabled: false }] }],
      Stop: [{ hooks: [{ type: 'command', command: 'npm test --silent' }] }],
    },
  }

  it('Claude Code hooks 형식을 펼친다 — 이벤트 순서는 정해져 있고 매처·기한·꺼짐이 실린다', () => {
    expect(parseHooks(FILE)).toEqual([
      { event: 'PreToolUse', matcher: 'bash', command: './guard.sh', timeout: 10, enabled: true },
      { event: 'PostToolUse', matcher: 'edit|write', command: 'fmt "$LITECODE_FILE"', enabled: true },
      { event: 'PostToolUse', matcher: 'edit|write', command: 'lint', enabled: false },
      { event: 'Stop', matcher: '', command: 'npm test --silent', enabled: true },
    ])
  })

  it('모양이 틀린 것은 거른다 — 모르는 이벤트·command 가 아닌 핸들러·빈 명령·틀린 기한·객체가 아닌 원소. 던지지 않는다', () => {
    for (const broken of [undefined, null, 'x', 3, [], { hooks: [] }, { hooks: 'x' }, { hooks: { Stop: 'x' } }, { hooks: { Stop: [null, 'x', { hooks: 'x' }] } }]) expect(parseHooks(broken)).toEqual([])
    const mixed = {
      hooks: {
        Nope: [{ hooks: [{ type: 'command', command: 'x' }] }],
        Stop: [
          { hooks: [{ type: 'http', url: 'http://x' }, { type: 'command', command: '   ' }, { type: 'command' }, null, { type: 'command', command: 'ok', timeout: -1 }] },
          { matcher: 3, hooks: [{ type: 'command', command: 'ok2', timeout: '5' }] },
        ],
      },
    }
    expect(parseHooks(mixed)).toEqual([hook('Stop', 'ok'), hook('Stop', 'ok2')])
  })

  it('저장 형식으로 적고 다시 읽으면 같은 목록이다', () => {
    const hooks = parseHooks(FILE)
    expect(parseHooks(serializeHooks(hooks))).toEqual(hooks)
    expect(parseHooks(JSON.parse(JSON.stringify(serializeHooks(hooks))))).toEqual(hooks)
  })

  it('프로젝트별 파일: realpath 키마다 훅과 켜기 값 — 모양이 틀린 켜기 값은 버린다', () => {
    const projects = parseProjects({ '/w/a': { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'make check' }] }] }, enabled: { k1: false, k2: 'yes' } }, '/w/b': 'x' })
    expect(projects).toEqual({ '/w/a': { hooks: [hook('Stop', 'make check')], enabled: { k1: false } } })
    expect(parseProjects(serializeProjects(projects))).toEqual(projects)
    expect(parseProjects([])).toEqual({})
  })

  it('그 프로젝트에서 본 훅: 모든 프로젝트 것 먼저 → 이 프로젝트만. 프로젝트별 켜기 값이 훅의 enabled 를 덮는다 (켜는 쪽·끄는 쪽 다)', () => {
    const all = [hook('Stop', 'a'), hook('Stop', 'b', { enabled: false })]
    const mine = { hooks: [hook('Stop', 'c')], enabled: { [hookKey(all[0]!)]: false, [hookKey(all[1]!)]: true } }
    expect(entriesFor(all, mine).map((entry) => [entry.command, entry.scope, entry.on])).toEqual([['a', 'all', false], ['b', 'all', true], ['c', 'project', true]])
    expect(entriesFor(all, undefined).map((entry) => entry.on)).toEqual([true, false])
  })

  it('기한(초): 프롬프트 제출·도구 실행 전은 30, 그 밖은 60, 훅마다 바꾸고 상한 600', () => {
    expect(hookTimeout('UserPromptSubmit')).toBe(30)
    expect(hookTimeout('PreToolUse')).toBe(30)
    expect(hookTimeout('PostToolUse')).toBe(60)
    expect(hookTimeout('Stop')).toBe(60)
    expect(hookTimeout('Stop', 5)).toBe(5)
    expect(hookTimeout('Stop', 9999)).toBe(600)
  })
})

describe('훅 입력 (stdin·env·명령)', () => {
  it('stdin JSON 은 Claude Code 이름 — 사건에 있는 것만 싣는다', () => {
    expect(hookStdin(input({ prompt: 'hi', mode: 'build' }))).toEqual({ hook_event_name: 'UserPromptSubmit', session_id: 'c1', cwd: root, mode: 'build', prompt: 'hi' })
    expect(hookStdin(input({ event: 'PostToolUse', tool: { name: 'edit', input: { filePath: 'a.ts' }, response: 'ok', file: '/w/a.ts' } }))).toEqual({
      hook_event_name: 'PostToolUse',
      session_id: 'c1',
      cwd: root,
      tool_name: 'edit',
      tool_input: { filePath: 'a.ts' },
      tool_response: 'ok',
    })
    expect(hookStdin(input({ event: 'Notification', notification: { type: 'permission', message: 'bash ls' } }))).toMatchObject({ notification_type: 'permission', message: 'bash ls' })
    expect(hookStdin(input({ event: 'Stop' }))).toEqual({ hook_event_name: 'Stop', session_id: 'c1', cwd: root })
  })

  it('env: 프로젝트 폴더(Claude Code 호환 이름도)와 파일 도구의 그 경로', () => {
    expect(hookEnv(input())).toEqual({ LITECODE_PROJECT_DIR: root, CLAUDE_PROJECT_DIR: root })
    expect(hookEnv(input({ tool: { name: 'edit', input: {}, file: '/w/a b.ts' } }))['LITECODE_FILE']).toBe('/w/a b.ts')
  })

  // 명령 주입 방지 — AI 가 정한 값(도구 인자·프롬프트)은 셸 문자열에 들어가지 않는다
  it('명령 글은 정의 그대로다 — 도구 인자·프롬프트는 stdin 에만 실린다', () => {
    const evil = '"; touch pwned; echo "$(touch pwned2)`touch pwned3`'
    const spawned = hookSpawn(hook('PostToolUse', 'fmt "$LITECODE_FILE"'), input({ event: 'PostToolUse', prompt: evil, tool: { name: 'bash', input: { command: evil }, response: evil } }))
    expect(spawned.command).toBe('fmt "$LITECODE_FILE"')
    expect(Object.values(spawned.env).join('\n')).not.toContain('pwned')
    expect(JSON.parse(spawned.stdin)).toMatchObject({ tool_input: { command: evil }, prompt: evil })
  })
})

describe('decodeHook (결과 해석)', () => {
  const done = (exitCode: number | null) => ({ exitCode, status: 'done' as const })

  it('0 = 통과 (stdout 이 맥락), 2 = 막기 (stderr 가 사유, 없으면 기본 문구), 그 밖 = 실패', () => {
    expect(decodeHook(done(0), ' branch main \n', 'noise', 30)).toEqual({ outcome: 'passed', context: 'branch main' })
    expect(decodeHook(done(0), '', '', 30)).toEqual({ outcome: 'passed' })
    expect(decodeHook(done(2), 'ignored', ' rm -rf 는 금지\n', 30)).toEqual({ outcome: 'blocked', reason: 'rm -rf 는 금지' })
    expect(decodeHook(done(2), '', '', 30)).toEqual({ outcome: 'blocked', reason: tr('hooks.blockedDefault') })
    expect(decodeHook(done(1), 'out', 'boom', 30)).toEqual({ outcome: 'failed', reason: `${tr('hooks.exit', { code: 1 })} — boom` })
    expect(decodeHook(done(127), '', '', 30)).toEqual({ outcome: 'failed', reason: tr('hooks.exit', { code: 127 }) })
  })

  it('기한 초과·멈춤·실행 실패는 실패다 — 막지 않는다 (훅 버그가 작업을 세우지 않게)', () => {
    expect(decodeHook({ exitCode: null, status: 'timeout' }, '', 'x', 30)).toEqual({ outcome: 'failed', reason: tr('hooks.timeout', { seconds: 30 }) })
    expect(decodeHook({ exitCode: null, status: 'stopped' }, '', '', 30)).toEqual({ outcome: 'failed', reason: tr('hooks.stopped') })
    expect(decodeHook({ exitCode: null, status: 'error', error: 'spawn ENOENT' }, '', '', 30)).toEqual({ outcome: 'failed', reason: 'spawn ENOENT' })
    expect(decodeHook({ exitCode: 2, status: 'timeout' }, '', 'no', 30).outcome).toBe('failed')
  })

  it('stdout 이 JSON 객체면: decision block = 막기, additionalContext 만 맥락 (맨 위·hookSpecificOutput). 깨진 JSON 은 글 그대로', () => {
    expect(decodeHook(done(0), '{"decision":"block","reason":"테스트부터"}', '', 30)).toEqual({ outcome: 'blocked', reason: '테스트부터' })
    expect(decodeHook(done(0), '{"additionalContext":"a"}', '', 30)).toEqual({ outcome: 'passed', context: 'a' })
    expect(decodeHook(done(0), '{"hookSpecificOutput":{"additionalContext":"b","updatedInput":{}}}', '', 30)).toEqual({ outcome: 'passed', context: 'b' })
    expect(decodeHook(done(0), '{"continue":true}', '', 30)).toEqual({ outcome: 'passed' })
    expect(decodeHook(done(0), '{not json', '', 30)).toEqual({ outcome: 'passed', context: '{not json' })
  })
})

describe('runHook (진짜 /bin/sh)', () => {
  it('프로젝트 폴더에서 돌고 stdin 으로 JSON 을 받는다. 통과면 stdout 이 맥락', async () => {
    const run = await runHook(hook('UserPromptSubmit', 'cat > in.json; pwd'), input({ prompt: '한글 프롬프트' }))
    expect(run).toMatchObject({ event: 'UserPromptSubmit', command: 'cat > in.json; pwd', outcome: 'passed', context: root, exitCode: 0 })
    expect(JSON.parse(await fs.readFile(path.join(root, 'in.json'), 'utf8'))).toEqual({ hook_event_name: 'UserPromptSubmit', session_id: 'c1', cwd: root, prompt: '한글 프롬프트' })
  })

  it('종료 코드 2 는 막기 — stderr 가 사유. 그 밖의 코드는 실패', async () => {
    expect(await runHook(hook('UserPromptSubmit', 'echo "비밀 금지" >&2; exit 2'), input())).toMatchObject({ outcome: 'blocked', reason: '비밀 금지', exitCode: 2 })
    expect(await runHook(hook('UserPromptSubmit', 'echo oops >&2; exit 3'), input())).toMatchObject({ outcome: 'failed', exitCode: 3 })
    expect(await runHook(hook('UserPromptSubmit', 'definitely-not-a-command-xyz'), input())).toMatchObject({ outcome: 'failed', exitCode: 127 })
  })

  it('막을 것이 없는 이벤트(도구 실행 후·세션 시작·알림)의 종료 코드 2 는 실패로 적는다', async () => {
    for (const event of ['PostToolUse', 'SessionStart', 'Notification'] as const) expect(await runHook(hook(event, 'echo no >&2; exit 2'), input({ event }))).toMatchObject({ outcome: 'failed', reason: 'no' })
    expect((await runHook(hook('Stop', 'echo no >&2; exit 2'), input({ event: 'Stop' }))).outcome).toBe('blocked')
  })

  it('기한을 넘기면 끄고 실패 — 막지 않는다', async () => {
    const run = await runHook(hook('UserPromptSubmit', 'while :; do :; done', { timeout: 7 }), input(), { timeoutMs: 80 })
    expect(run).toMatchObject({ outcome: 'failed', reason: tr('hooks.timeout', { seconds: 7 }), exitCode: null })
  })

  it('stdin 을 읽지 않는 명령도 된다 (큰 입력 — EPIPE 로 죽지 않는다)', async () => {
    const run = await runHook(hook('UserPromptSubmit', 'exit 0'), input({ prompt: 'x'.repeat(300_000) }))
    expect(run.outcome).toBe('passed')
  })

  it('env 로 프로젝트 폴더와 파일 경로를 받는다 — 공백 있는 경로도 따옴표만 치면 된다', async () => {
    const file = path.join(root, 'a b.ts')
    const run = await runHook(hook('PostToolUse', 'echo "$LITECODE_PROJECT_DIR|$CLAUDE_PROJECT_DIR|$LITECODE_FILE"'), input({ event: 'PostToolUse', tool: { name: 'edit', input: {}, file } }))
    expect(run.context).toBe(`${root}|${root}|${file}`)
  })

  // 명령 주입 방지 (01af §6-5) — 실제로 돌려도 인자 속 셸 문법이 실행되지 않는다
  it('도구 인자 속 셸 문법은 실행되지 않는다 — 글자 그대로 stdin 에만 있다', async () => {
    const evil = '"; touch pwned; echo "$(touch pwned2)`touch pwned3`'
    const run = await runHook(hook('PostToolUse', 'cat'), input({ event: 'PostToolUse', tool: { name: 'bash', input: { command: evil }, response: evil } }))
    expect(run.outcome).toBe('passed')
    expect((await fs.readdir(root)).filter((name) => name.startsWith('pwned'))).toEqual([])
  })
})

// ── 서비스: 진짜 Cordis Context + 진짜 ctx.chat·ctx.sessions + 가짜 ctx.llm ──

interface Call {
  prompt: string
  sessionId?: string
  context?: string
  progress(item: TurnItem): void
  finish(result?: Partial<ChatResult>): void
}

class FakeLlm extends Service {
  calls: Call[] = []
  private ids = 0
  constructor(ctx: Context) {
    super(ctx, 'llm')
  }
  newMessageId(): string {
    return `msg_${++this.ids}`
  }
  async chat(...args: unknown[]): Promise<ChatResult> {
    const [, , , prompt, sessionId, onSession, , onProgress, , , stop, , context] = args as [string, string, string, string, string | undefined, ((id: string) => Promise<void>) | undefined, string, ((item: TurnItem) => void) | undefined, string, unknown, AbortSignal | undefined, unknown, string | undefined]
    const id = sessionId ?? `ses_${this.calls.length + 1}`
    if (!sessionId) await onSession?.(id)
    return new Promise<ChatResult>((resolve) => {
      this.calls.push({
        prompt, sessionId, context,
        progress: (item) => onProgress?.(item),
        finish: (result = {}) => resolve({ ok: true, sessionId: id, text: `echo: ${prompt}`, ...result }),
      })
      stop?.addEventListener('abort', () => resolve({ ok: false, sessionId: id, error: tr('error.stopped'), interrupted: true }))
    })
  }
  async deleteSession(): Promise<void> {}
  purgeDeleted(): void {}
  /** 받은 게이트 대상 (ctx.hooks 가 알린 매처 — 부를 때마다) */
  gates: string[][] = []
  gateTools(matchers: readonly string[]): void {
    this.gates.push([...matchers])
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

type Recorded = { [K in keyof ChatEventMap]: [K, ChatEventMap[K]] }[keyof ChatEventMap]

async function until(done: () => boolean): Promise<void> {
  for (let tries = 0; tries < 600 && !done(); tries++) await new Promise((resolve) => setTimeout(resolve, 5))
  if (!done()) throw new Error('기다리던 일이 일어나지 않았다')
}

/** hooks.json 을 사용자가 손으로 고치듯 통째로 쓴다 */
async function writeHooks(hooks: HookDef[]): Promise<void> {
  await fs.writeFile(path.join(root, 'hooks.json'), JSON.stringify(serializeHooks(hooks)))
}

async function start(opts: { timeoutMs?: number; hooks?: boolean } = {}) {
  const ctx = new Context()
  ctx.plugin(FakeLlm)
  ctx.plugin(FakeProviders)
  ctx.plugin(SessionsService, { file: path.join(root, 'sessions.json') })
  ctx.plugin(ChatService)
  const fiber = opts.hooks === false ? undefined : ctx.plugin(HooksService, { file: path.join(root, 'hooks.json'), projectsFile: path.join(root, 'hooks-projects.json'), timeoutMs: opts.timeoutMs })
  const ready = await new Promise<Context>((resolve) => ctx.inject(opts.hooks === false ? ['chat', 'sessions', 'llm'] : ['chat', 'sessions', 'llm', 'hooks'], resolve))
  const events: Recorded[] = []
  ctx.on('chat/turn-started', (data) => void events.push(['turn.started', data]))
  ctx.on('chat/turn-progress', (data) => void events.push(['turn.progress', data]))
  ctx.on('chat/turn-ended', (data) => void events.push(['turn.ended', data]))
  ctx.on('chat/queue-changed', (data) => void events.push(['queue.changed', data]))
  const llm = ready.llm as unknown as FakeLlm
  const of = <K extends keyof ChatEventMap>(name: K) => events.filter((event) => event[0] === name).map((event) => event[1] as ChatEventMap[K])
  const turn = async (n: number): Promise<Call> => {
    await until(() => llm.calls.length >= n)
    return llm.calls[n - 1]!
  }
  const ended = async (n: number) => {
    await until(() => of('turn.ended').length >= n)
    return of('turn.ended')[n - 1]!
  }
  return { ctx: ready, chat: ready.chat, hooks: opts.hooks === false ? undefined! : ready.hooks, llm, fiber, of, turn, ended }
}

const send = (text: string, patch: Partial<QueuedSend> = {}): QueuedSend => ({ project: root, text, model: { providerId: 'gw', modelId: 'm1' }, mode: 'build', ...patch })
const hookLines = (items: readonly TurnItem[] | undefined) => (items ?? []).filter((item): item is Extract<TurnItem, { kind: 'hook' }> => item.kind === 'hook')

describe('HooksService.run (여러 훅 합치기)', () => {
  it('모든 프로젝트 → 이 프로젝트 순으로 하나씩 돌고, 통과한 훅의 맥락을 돈 순서로 모은다', async () => {
    const { hooks } = await start()
    await writeHooks([hook('UserPromptSubmit', 'echo A; echo a >> order.log'), hook('Stop', 'echo never')])
    hooks.save([hook('UserPromptSubmit', 'echo C; echo c >> order.log')], root)
    const result = await hooks.run(input())
    expect(result).toMatchObject({ outcome: 'passed', context: ['A', 'C'] })
    expect(result.runs.map((run) => run.command)).toEqual(['echo A; echo a >> order.log', 'echo C; echo c >> order.log'])
    expect(await fs.readFile(path.join(root, 'order.log'), 'utf8')).toBe('a\nc\n')
  })

  it('가장 제한적인 결과: 하나라도 막으면 막기다 — 그 뒤 훅은 돌지 않는다', async () => {
    const { hooks } = await start()
    await writeHooks([hook('UserPromptSubmit', 'echo A'), hook('UserPromptSubmit', 'echo "안 됨" >&2; exit 2')])
    hooks.save([hook('UserPromptSubmit', 'touch ran-after-block')], root)
    const result = await hooks.run(input())
    expect(result).toMatchObject({ outcome: 'blocked', reason: '안 됨', context: ['A'] })
    expect(result.runs.map((run) => run.outcome)).toEqual(['passed', 'blocked'])
    expect(await fs.readdir(root)).not.toContain('ran-after-block')
  })

  it('실패(그 밖의 코드·기한 초과)는 막지 않는다 — 다음 훅이 돌고 결과는 통과', async () => {
    const { hooks } = await start({ timeoutMs: 80 })
    await writeHooks([hook('UserPromptSubmit', 'exit 1'), hook('UserPromptSubmit', 'while :; do :; done'), hook('UserPromptSubmit', 'echo ok')])
    const result = await hooks.run(input())
    expect(result).toMatchObject({ outcome: 'passed', context: ['ok'] })
    expect(result.runs.map((run) => run.outcome)).toEqual(['failed', 'failed', 'passed'])
  })

  it('도구 이벤트는 매처로 거르고, 그 밖의 이벤트는 매처를 보지 않는다', async () => {
    const { hooks } = await start()
    await writeHooks([hook('PostToolUse', 'echo fmt', { matcher: 'Edit|Write' }), hook('PostToolUse', 'echo all'), hook('PostToolUse', 'echo bad', { matcher: 'edit(' }), hook('Stop', 'echo stop', { matcher: 'bash' })])
    const post = (name: string) => hooks.run(input({ event: 'PostToolUse', tool: { name, input: {} } })).then((result) => result.runs.map((run) => run.command))
    expect(await post('write')).toEqual(['echo fmt', 'echo all'])
    expect(await post('bash')).toEqual(['echo all'])
    expect((await hooks.run(input({ event: 'Stop' }))).runs.map((run) => run.command)).toEqual(['echo stop'])
  })

  it('켜기 값은 프로젝트별로 덮는다 — 끈 프로젝트에서만 안 돌고, 파일에서 꺼 둔 훅을 한 프로젝트에서만 켤 수 있다', async () => {
    const { hooks } = await start()
    const other = await fs.realpath(await fs.mkdtemp(path.join(root, 'other-')))
    await writeHooks([hook('UserPromptSubmit', 'echo on'), hook('UserPromptSubmit', 'echo off', { enabled: false })])
    const [on, off] = await hooks.list(root)
    expect([on!.scope, on!.on, off!.on]).toEqual(['all', true, false])
    hooks.setEnabled(root, on!.key, false)
    hooks.setEnabled(root, off!.key, true)
    expect((await hooks.run(input())).context).toEqual(['off'])
    expect((await hooks.run(input({ directory: other }))).context).toEqual(['on'])
    expect((await hooks.list(root)).map((entry) => entry.on)).toEqual([false, true])
  })

  it('파일을 고치면 다음 실행부터 반영된다. 깨진 파일은 훅 0개 — 던지지 않고 파일을 옮기지도 않는다', async () => {
    const { hooks } = await start()
    expect((await hooks.run(input())).runs).toEqual([]) // 파일이 없다
    await writeHooks([hook('UserPromptSubmit', 'echo v1')])
    expect((await hooks.run(input())).context).toEqual(['v1'])
    await writeHooks([hook('UserPromptSubmit', 'echo v2')])
    expect((await hooks.run(input())).context).toEqual(['v2'])
    await fs.writeFile(path.join(root, 'hooks.json'), '{ "hooks": { "UserPromptSubmit": [')
    await fs.writeFile(path.join(root, 'hooks-projects.json'), '[1, 2]')
    expect(await hooks.run(input())).toEqual({ outcome: 'passed', context: [], runs: [] })
    expect((await fs.readdir(root)).filter((name) => name.startsWith('hooks')).sort()).toEqual(['hooks-projects.json', 'hooks.json'])
  })

  it('저장: 모양이 틀린 것은 빠지고, 프로젝트만의 훅은 그 프로젝트에서만 보인다. 덮어쓰기 전에 깨진 파일은 옆에 남긴다', async () => {
    const { hooks } = await start()
    await fs.writeFile(path.join(root, 'hooks.json'), '{broken')
    hooks.save([hook('Stop', 'make check', { timeout: 5 }), hook('Stop', '   '), { ...hook('Stop', 'x'), event: 'Nope' as never }])
    hooks.save([hook('PreToolUse', './guard.sh', { matcher: 'bash' })], root)
    expect(await hooks.list()).toEqual([{ ...hook('Stop', 'make check', { timeout: 5 }), scope: 'all', key: 'Stop||make check', on: true }])
    expect((await hooks.list(root)).map((entry) => [entry.event, entry.scope])).toEqual([['Stop', 'all'], ['PreToolUse', 'project']])
    expect((await fs.readdir(root)).some((name) => name.startsWith('hooks.json.corrupt-'))).toBe(true)
  })

  it('실행 기록을 남긴다 (최근 것, 대화·폴더와 함께)', async () => {
    const { hooks } = await start()
    await writeHooks([hook('UserPromptSubmit', 'echo no >&2; exit 2')])
    await hooks.run(input())
    expect(hooks.recent()).toMatchObject([{ event: 'UserPromptSubmit', outcome: 'blocked', reason: 'no', conversationId: 'c1', directory: root, exitCode: 2 }])
  })

  it('서비스가 내려가면 돌던 훅을 끈다 (기한을 기다리지 않는다)', async () => {
    const { hooks, fiber } = await start()
    await writeHooks([hook('Stop', 'while :; do :; done'), hook('Stop', 'touch ran-after-dispose')])
    const running = hooks.run(input({ event: 'Stop' }))
    await new Promise((resolve) => setTimeout(resolve, 60))
    await fiber!.dispose()
    expect((await running).runs).toMatchObject([{ outcome: 'failed', reason: tr('hooks.stopped') }])
    expect(await fs.readdir(root)).not.toContain('ran-after-dispose')
  })
})

describe('ctx.hooks ↔ ctx.chat (턴 앞뒤)', () => {
  it('프롬프트 제출 훅이 막으면 엔진에 보내지 않는다 — 그 턴은 사유와 함께 실패로 끝나고 입력은 붙잡힌 대기열로 돌아간다', async () => {
    const { chat, llm, ended, of } = await start()
    await writeHooks([hook('UserPromptSubmit', 'echo "비밀이 들어 있습니다" >&2; exit 2'), hook('SessionStart', 'touch session-started')])
    expect(await chat.send('c1', send('키는 sk-123'))).toEqual({ state: 'sent' })
    const end = await ended(1)
    expect(end.outcome).toBe('failed')
    expect(end.message.error).toBe(tr('hooks.blocked', { reason: '비밀이 들어 있습니다' }))
    expect(hookLines(end.message.items)).toMatchObject([{ event: 'UserPromptSubmit', command: 'echo "비밀이 들어 있습니다" >&2; exit 2', outcome: 'blocked', reason: '비밀이 들어 있습니다' }])
    expect(llm.calls).toEqual([])
    expect(of('queue.changed').at(-1)).toMatchObject({ cid: 'c1', items: ['키는 sk-123'], held: true })
    expect(await fs.readdir(root)).not.toContain('session-started') // 막힌 턴에는 세션 시작 훅이 돌지 않는다
    // 화면이 입력창으로 되돌린다 (멈춘 턴의 대기열과 같은 길) — 되돌리면 풀린다
    expect(chat.takeQueue('c1')).toMatchObject({ text: '키는 sk-123' })
    expect(chat.queued('c1')).toBe(0)
  })

  it('통과한 프롬프트 제출·세션 시작 훅의 stdout 은 그 턴의 맥락으로 간다 — 세션 시작은 첫 턴에만', async () => {
    const { chat, turn, ended } = await start()
    await writeHooks([hook('UserPromptSubmit', 'cat > prompt.json; echo "오늘은 월요일"'), hook('SessionStart', 'echo "branch main"')])
    await chat.send('c1', send('안녕'))
    const first = await turn(1)
    expect(first.context).toBe('branch main\n\n오늘은 월요일')
    expect(first.prompt).toBe('안녕')
    expect(JSON.parse(await fs.readFile(path.join(root, 'prompt.json'), 'utf8'))).toEqual({ hook_event_name: 'UserPromptSubmit', session_id: 'c1', cwd: root, mode: 'build', prompt: '안녕' })
    first.finish()
    const end = await ended(1)
    expect(hookLines(end.message.items).map((line) => [line.event, line.outcome])).toEqual([['UserPromptSubmit', 'passed'], ['SessionStart', 'passed']])
    await chat.send('c1', send('또'))
    expect((await turn(2)).context).toBe('오늘은 월요일')
  })

  it('프롬프트 제출 훅은 사람 글에만 — 다른 대화가 보낸 지시는 막지 않는다 (세션 시작 훅은 출처와 무관)', async () => {
    const { chat, turn } = await start()
    await writeHooks([hook('UserPromptSubmit', 'exit 2'), hook('SessionStart', 'echo started')])
    await chat.send('c1', send('do it', { origin: 'session:c9', from: { conversationId: 'c9', title: '보낸 대화' } }))
    expect((await turn(1)).context).toBe('started')
  })

  it('훅이 없으면 맥락도 줄도 없다 — 턴은 평소대로', async () => {
    const { chat, turn, ended } = await start()
    await chat.send('c1', send('hi'))
    const call = await turn(1)
    expect(call.context).toBeUndefined()
    call.finish()
    expect((await ended(1)).message).toMatchObject({ text: 'echo: hi', items: [] })
  })

  it('턴 끝 훅: 통과면 줄만 남는다. 막으면 사유를 다음 메시지로 이어 보낸다 — 연속 상한까지만', async () => {
    const { chat, llm, turn, ended, of } = await start()
    await writeHooks([hook('Stop', 'echo "테스트 실패" >&2; exit 2')])
    await chat.send('c1', send('고쳐 줘'))
    for (let n = 1; n <= STOP_CHAIN_MAX + 1; n++) {
      const call = await turn(n)
      if (n > 1) expect(call.prompt).toBe(stopFeedback('테스트 실패'))
      call.finish()
      const end = await ended(n)
      expect(end.outcome).toBe('done')
      const [line] = hookLines(end.message.items)
      expect(line).toMatchObject({ event: 'Stop', outcome: 'blocked' })
      // 마지막(상한에 닿은) 턴의 줄에는 더 이어 가지 않는다는 말이 붙는다
      expect(line!.reason).toBe(n <= STOP_CHAIN_MAX ? '테스트 실패' : `테스트 실패 (${tr('hooks.stopLimit', { max: STOP_CHAIN_MAX })})`)
    }
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(llm.calls.length).toBe(STOP_CHAIN_MAX + 1) // 사람 턴 1 + 이어 간 턴 3
    expect(of('turn.started').map((event) => event.origin)).toEqual(['user', 'hook', 'hook', 'hook'])
    // 사람이 다시 보내면 상한은 처음부터 센다
    await chat.send('c1', send('다시'))
    ;(await turn(STOP_CHAIN_MAX + 2)).finish()
    expect((await turn(STOP_CHAIN_MAX + 3)).prompt).toBe(stopFeedback('테스트 실패'))
  })

  it('턴 끝 훅이 통과하면 이어 가지 않는다 — 줄은 답 뒤에 남는다', async () => {
    const { chat, llm, turn, ended } = await start()
    await writeHooks([hook('Stop', 'echo fine')])
    await chat.send('c1', send('hi'))
    ;(await turn(1)).finish()
    expect(hookLines((await ended(1)).message.items)).toMatchObject([{ event: 'Stop', outcome: 'passed' }])
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(llm.calls.length).toBe(1)
  })

  it('턴 끝 훅은 완료된 턴에만 돈다 — 멈춘 턴·실패한 턴·거절로 끝난 턴에는 돌지 않는다', async () => {
    const { chat, hooks, turn, ended } = await start()
    await writeHooks([hook('Stop', 'exit 2')])
    await chat.send('c1', send('one'))
    await turn(1)
    chat.stop('c1')
    expect((await ended(1)).outcome).toBe('interrupted')
    await chat.send('c1', send('two'))
    ;(await turn(2)).finish({ ok: false, error: 'boom' })
    expect((await ended(2)).outcome).toBe('failed')
    await chat.send('c1', send('three'))
    ;(await turn(3)).finish({ declined: true })
    await ended(3)
    expect(hooks.recent()).toEqual([])
  })

  it('턴 끝 훅이 도는 중에 사용자가 멈추면 훅을 끄고 이어 가지 않는다', async () => {
    const { chat, llm, turn, ended } = await start()
    await writeHooks([hook('Stop', 'while :; do :; done')])
    await chat.send('c1', send('hi'))
    ;(await turn(1)).finish()
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(chat.stop('c1')).toBe(true) // 훅이 도는 동안 턴은 아직 도는 것으로 보인다
    expect(hookLines((await ended(1)).message.items)).toMatchObject([{ event: 'Stop', outcome: 'failed', reason: tr('hooks.stopped') }])
    expect(llm.calls.length).toBe(1)
  })

  it('도구 실행 후 훅: 끝난 도구마다 매처에 맞는 훅이 돌고 그 턴에 줄이 남는다 — 실패한 도구에는 안 돌고, 턴 끝 훅은 그 뒤에 돈다', async () => {
    const { ctx, chat, turn, ended } = await start()
    await writeHooks([hook('PostToolUse', 'cat > post.json; echo "$LITECODE_FILE" >> order.log', { matcher: 'Edit|Write' }), hook('Stop', 'echo stop >> order.log')])
    await chat.send('c1', send('고쳐'))
    const call = await turn(1)
    const done = (patch: Partial<ToolDone>): ToolDone => ({ sessionId: 'ses_1', directory: root, tool: 'edit', input: { filePath: 'a.ts' }, output: 'ok', file: path.join(root, 'a.ts'), child: false, ...patch })
    ctx.emit('llm/tool-done', done({}))
    ctx.emit('llm/tool-done', done({ tool: 'bash', input: { command: 'ls' }, file: undefined })) // 매처에 안 맞는다
    ctx.emit('llm/tool-done', done({ tool: 'write', output: undefined, error: 'denied' })) // 실패한 호출
    ctx.emit('llm/tool-done', done({ tool: 'write', file: path.join(root, 'b.ts'), child: true })) // 하위 작업의 도구
    call.finish()
    const end = await ended(1)
    expect(hookLines(end.message.items).map((line) => [line.event, line.outcome])).toEqual([['PostToolUse', 'passed'], ['PostToolUse', 'passed'], ['Stop', 'passed']])
    expect(await fs.readFile(path.join(root, 'order.log'), 'utf8')).toBe(`${path.join(root, 'a.ts')}\n${path.join(root, 'b.ts')}\nstop\n`)
    expect(JSON.parse(await fs.readFile(path.join(root, 'post.json'), 'utf8'))).toEqual({ hook_event_name: 'PostToolUse', session_id: 'c1', cwd: root, mode: 'build', tool_name: 'write', tool_input: { filePath: 'a.ts' }, tool_response: 'ok' })
  })

  it('알림 훅: 답 필요·턴 끝에 돈다(관찰만) — 대화에 줄을 남기지 않고, 중단은 알리지 않는다', async () => {
    const { ctx, chat, hooks, turn, ended } = await start()
    await writeHooks([hook('Notification', 'cat >> notify.log; echo >> notify.log')])
    await chat.send('c1', send('hi'))
    const call = await turn(1)
    ctx.emit('llm/attention', { sessionId: 'ses_1', directory: root, kind: 'permission', title: 'bash ls' })
    await until(() => hooks.recent().length === 1)
    ctx.emit('llm/turn-ended', { sessionId: 'ses_1', directory: root, outcome: 'interrupted' })
    ctx.emit('llm/turn-ended', { sessionId: 'ses_1', directory: root, outcome: 'done' })
    await until(() => hooks.recent().length === 2)
    call.finish()
    expect(hookLines((await ended(1)).message.items)).toEqual([])
    const seen = (await fs.readFile(path.join(root, 'notify.log'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>)
    expect(seen).toMatchObject([
      { hook_event_name: 'Notification', session_id: 'c1', notification_type: 'permission', message: 'bash ls' },
      { hook_event_name: 'Notification', notification_type: 'done' },
    ])
  })

  it('도구 실행 전(PreToolUse) 훅은 도구가 끝난 것으로는 돌지 않는다 — 실행 전 판정(llm/pre-tool)으로만 돈다', async () => {
    const { ctx, chat, hooks, turn, ended } = await start()
    await writeHooks([hook('PreToolUse', 'touch pre-ran; exit 2', { matcher: 'bash' })])
    await chat.send('c1', send('hi'))
    const call = await turn(1)
    ctx.emit('llm/tool-done', { sessionId: 'ses_1', directory: root, tool: 'bash', input: { command: 'ls' }, output: '', child: false })
    call.finish()
    await ended(1)
    expect(await fs.readdir(root)).not.toContain('pre-ran')
    expect((await hooks.list(root)).map((entry) => entry.event)).toEqual(['PreToolUse'])
  })
})

// 2단계 (01af §6-1·§6-6 ②) — 도구 실행 전 훅. ctx.llm 이 승인 요청마다 묻는 중립 확장점 'llm/pre-tool' 에 답한다
describe("도구 실행 전 훅 ('llm/pre-tool' — 이슈 #102 2단계)", () => {
  const never = new AbortController().signal
  const pre = (patch: Record<string, unknown> = {}) => ({ sessionId: 'ses_1', directory: root, tool: 'bash', input: { command: 'rm -rf build' }, child: false, signal: never, ...patch })

  /** 턴 하나를 띄워 두고(ses_1) 판정을 묻는다 */
  async function asking(hooks: HookDef[], opts: { timeoutMs?: number } = {}) {
    const started = await start(opts)
    await writeHooks(hooks)
    await started.chat.send('c1', send('hi'))
    const call = await started.turn(1)
    const lines = async () => {
      call.finish()
      return hookLines((await started.ended(1)).message.items)
    }
    return { ...started, call, lines }
  }

  it('막기(종료 코드 2): { deny, reason } — stderr 가 사유, 그 턴에 "막음" 줄. stdin 으로 도구 이름·인자를 받는다', async () => {
    const { ctx, lines } = await asking([hook('PreToolUse', 'cat > pre.json; echo "rm -rf 는 금지" >&2; exit 2', { matcher: 'bash' })])
    expect(await ctx.serial('llm/pre-tool', pre())).toEqual({ deny: true, reason: 'rm -rf 는 금지' })
    expect(JSON.parse(await fs.readFile(path.join(root, 'pre.json'), 'utf8'))).toMatchObject({ hook_event_name: 'PreToolUse', session_id: 'c1', tool_name: 'bash', tool_input: { command: 'rm -rf build' }, mode: 'build' })
    expect(await lines()).toMatchObject([{ event: 'PreToolUse', outcome: 'blocked', reason: 'rm -rf 는 금지' }])
  })

  it("통과(종료 코드 0): 'allow' — 통과 줄이 남는다", async () => {
    const { ctx, lines } = await asking([hook('PreToolUse', 'true', { matcher: 'bash' })])
    expect(await ctx.serial('llm/pre-tool', pre())).toBe('allow')
    expect(await lines()).toMatchObject([{ event: 'PreToolUse', outcome: 'passed' }])
  })

  it('stdout JSON 의 permissionDecision: deny 는 막기(사유 permissionDecisionReason), ask 는 사용자에게 묻기, allow 는 통과', async () => {
    const decide = (decision: string) => `echo '{"hookSpecificOutput":{"permissionDecision":"${decision}","permissionDecisionReason":"정책 위반"}}'`
    const { ctx } = await asking([hook('PreToolUse', decide('deny'), { matcher: 'bash' }), hook('PreToolUse', decide('ask'), { matcher: 'edit' }), hook('PreToolUse', decide('allow'), { matcher: 'read' })])
    expect(await ctx.serial('llm/pre-tool', pre())).toEqual({ deny: true, reason: '정책 위반' })
    expect(await ctx.serial('llm/pre-tool', pre({ tool: 'edit' }))).toBe('ask')
    expect(await ctx.serial('llm/pre-tool', pre({ tool: 'read' }))).toBe('allow')
  })

  it('여럿이면 가장 제한적인 것: 막기 > 묻기 > 통과 — 막으면 그 뒤 훅은 돌지 않는다', async () => {
    const ask = `echo '{"permissionDecision":"ask"}'`
    const { ctx } = await asking([hook('PreToolUse', ask, { matcher: 'bash|edit' }), hook('PreToolUse', 'true'), hook('PreToolUse', 'exit 2', { matcher: 'edit' }), hook('PreToolUse', 'touch after-block', { matcher: 'edit' })])
    expect(await ctx.serial('llm/pre-tool', pre())).toBe('ask')
    expect(await ctx.serial('llm/pre-tool', pre({ tool: 'edit' }))).toMatchObject({ deny: true })
    expect(await fs.readdir(root)).not.toContain('after-block')
  })

  it('실패(그 밖의 종료 코드)·기한 초과는 통과다 — 훅 버그가 작업을 세우지 않는다. 줄에는 실패로 남는다', async () => {
    const failing = await asking([hook('PreToolUse', 'echo oops >&2; exit 1', { matcher: 'bash' })])
    expect(await failing.ctx.serial('llm/pre-tool', pre())).toBe('allow')
    expect(await failing.lines()).toMatchObject([{ outcome: 'failed' }])
    const slow = await asking([hook('PreToolUse', 'sleep 5; exit 2', { matcher: 'bash' })], { timeoutMs: 150 })
    expect(await slow.ctx.serial('llm/pre-tool', pre())).toBe('allow')
    expect(await slow.lines()).toMatchObject([{ outcome: 'failed', reason: tr('hooks.timeout', { seconds: 30 }) }])
  })

  it('맞는 훅이 없으면 답하지 않는다(undefined) — 꺼 둔 훅·다른 도구의 훅·다른 이벤트의 훅', async () => {
    const { ctx, hooks, lines } = await asking([hook('PreToolUse', 'exit 2', { matcher: 'edit' }), hook('PreToolUse', 'exit 2', { matcher: 'bash', enabled: false }), hook('PostToolUse', 'exit 2')])
    expect(await ctx.serial('llm/pre-tool', pre())).toBeUndefined()
    hooks.setEnabled(root, hookKey(hook('PreToolUse', 'exit 2', { matcher: 'bash' })), true) // 이 프로젝트에서만 켠다
    expect(await ctx.serial('llm/pre-tool', pre())).toMatchObject({ deny: true })
    expect(await lines()).toHaveLength(1)
  })

  it('하위 작업의 도구에도 걸린다 — 줄은 부모 턴에. 파일 도구면 LITECODE_FILE 로 경로를 받는다', async () => {
    const { ctx, lines } = await asking([hook('PreToolUse', 'printf %s "$LITECODE_FILE" > file.txt; exit 2', { matcher: 'write' })])
    const file = path.join(root, 'src', 'a.ts')
    expect(await ctx.serial('llm/pre-tool', pre({ tool: 'write', input: { filePath: file }, file, child: true }))).toMatchObject({ deny: true })
    expect(await fs.readFile(path.join(root, 'file.txt'), 'utf8')).toBe(file)
    expect(await lines()).toMatchObject([{ event: 'PreToolUse', outcome: 'blocked' }])
  })

  it('앱이 모르는 세션의 호출에는 답하지 않는다', async () => {
    const { ctx } = await asking([hook('PreToolUse', 'touch ran; exit 2')])
    expect(await ctx.serial('llm/pre-tool', pre({ sessionId: 'ses_other' }))).toBeUndefined()
    expect(await fs.readdir(root)).not.toContain('ran')
  })

  it('턴이 멈추면(signal) 도는 훅을 끄고 막지 않는다', async () => {
    const { ctx } = await asking([hook('PreToolUse', 'sleep 5; exit 2')])
    const stop = new AbortController()
    setTimeout(() => stop.abort(), 100)
    const startedAt = Date.now()
    expect(await ctx.serial('llm/pre-tool', pre({ signal: stop.signal }))).toBe('allow')
    expect(Date.now() - startedAt).toBeLessThan(3_000)
  })
})

describe('게이트 대상 알리기 (ctx.llm.gateTools — 이슈 #102 2단계)', () => {
  it('gateMatchers: 어느 프로젝트에서든 켜진 도구 실행 전 훅의 매처 합집합 — 다른 이벤트·모두에서 꺼진 훅은 빠진다', () => {
    const all = [hook('PreToolUse', 'a', { matcher: 'bash' }), hook('PreToolUse', 'b', { matcher: 'edit', enabled: false }), hook('PreToolUse', 'c', { matcher: 'read', enabled: false }), hook('PostToolUse', 'd', { matcher: 'write' })]
    const projects = {
      '/p1': { hooks: [hook('PreToolUse', 'e', { matcher: ' mcp_.* ' }), hook('PreToolUse', 'f', { matcher: 'glob', enabled: false })], enabled: { [hookKey(all[1]!)]: true } },
      '/p2': { hooks: [hook('PreToolUse', 'g')], enabled: { [hookKey(all[0]!)]: false } },
    }
    expect(gateMatchers(all, projects)).toEqual(['', 'bash', 'edit', 'mcp_.*'])
    expect(gateMatchers([], {})).toEqual([])
    expect(gateMatchers([hook('Stop', 'x')], {})).toEqual([])
  })

  it('서비스가 뜰 때·턴을 보내기 전(손으로 고친 파일)·저장할 때·켜고 끌 때 알린다', async () => {
    await writeHooks([hook('PreToolUse', 'true', { matcher: 'bash' })])
    const { llm, chat, hooks, turn } = await start()
    await until(() => llm.gates.length >= 1)
    expect(llm.gates.at(-1)).toEqual(['bash'])
    await writeHooks([hook('PreToolUse', 'true', { matcher: 'bash' }), hook('PreToolUse', 'true', { matcher: 'edit|write' })])
    await chat.send('c1', send('hi'))
    await turn(1)
    expect(llm.gates.at(-1)).toEqual(['bash', 'edit|write'])
    const before = llm.gates.length
    hooks.save([hook('PreToolUse', 'true', { matcher: 'read' })], root)
    await until(() => llm.gates.length > before)
    expect(llm.gates.at(-1)).toEqual(['bash', 'edit|write', 'read'])
    hooks.setEnabled(root, hookKey(hook('PreToolUse', 'true', { matcher: 'read' })), false)
    await until(() => llm.gates.at(-1)?.length === 2)
    expect(llm.gates.at(-1)).toEqual(['bash', 'edit|write'])
  })

  it('도구 실행 전 훅이 없으면 빈 목록을 알린다 (게이트 없음)', async () => {
    await writeHooks([hook('PostToolUse', 'true'), hook('Stop', 'true')])
    const { llm } = await start()
    await until(() => llm.gates.length >= 1)
    expect(llm.gates.at(-1)).toEqual([])
  })
})

describe('decodeHook — 도구 실행 전의 permissionDecision', () => {
  const ok = { status: 'done' as const, exitCode: 0 }
  it('도구 실행 전에서만 읽는다 — 다른 이벤트에서는 무시한다', () => {
    const out = '{"permissionDecision":"deny","permissionDecisionReason":"no"}'
    expect(decodeHook(ok, out, '', 30, 'PreToolUse')).toEqual({ outcome: 'blocked', reason: 'no' })
    expect(decodeHook(ok, out, '', 30, 'UserPromptSubmit')).toEqual({ outcome: 'passed' })
    expect(decodeHook(ok, out, '', 30)).toEqual({ outcome: 'passed' })
  })

  it('deny 에 사유가 없으면 기본 문구, ask 는 통과 + 묻기, allow·모르는 값은 통과. updatedInput 은 무시한다(지원 안 함)', () => {
    expect(decodeHook(ok, '{"hookSpecificOutput":{"permissionDecision":"deny"}}', '', 30, 'PreToolUse')).toEqual({ outcome: 'blocked', reason: tr('hooks.blockedDefault') })
    expect(decodeHook(ok, '{"permissionDecision":"ask"}', '', 30, 'PreToolUse')).toEqual({ outcome: 'passed', ask: true })
    expect(decodeHook(ok, '{"permissionDecision":"allow","updatedInput":{"command":"ls"}}', '', 30, 'PreToolUse')).toEqual({ outcome: 'passed' })
    expect(decodeHook(ok, '{"permissionDecision":"maybe"}', '', 30, 'PreToolUse')).toEqual({ outcome: 'passed' })
  })

  it('종료 코드 2 와 decision:block 은 그대로 막기다', () => {
    expect(decodeHook({ status: 'done', exitCode: 2 }, '', '안 됨', 30, 'PreToolUse')).toEqual({ outcome: 'blocked', reason: '안 됨' })
    expect(decodeHook(ok, '{"decision":"block","reason":"x"}', '', 30, 'PreToolUse')).toEqual({ outcome: 'blocked', reason: 'x' })
  })
})

// 기능이 꺼져 있을 때(서비스 없음)의 ctx.chat 확장점 — 듣는 쪽이 없으면 아무 일도 없고, 듣는 쪽은 훅이 아니어도 된다 (중립)
describe('ctx.chat 턴 앞뒤 확장점 (ctx.hooks 없이)', () => {
  it("'chat/before-send' 가 채운 맥락은 엔진으로, 'chat/after-turn' 의 followUp 은 출처 'hook' 의 다음 턴으로 — 앞서 쌓인 대기열보다 먼저", async () => {
    const { ctx, chat, turn, ended, of } = await start({ hooks: false })
    const seen: string[] = []
    ctx.on('chat/before-send', (before) => {
      seen.push(`before ${before.origin} first=${before.first} ${before.text}`)
      before.context.push('ctx-a', 'ctx-b')
    })
    let follow = true
    ctx.on('chat/after-turn', (after) => {
      seen.push(`after ${after.origin} ${after.outcome} ${after.text}`)
      if (follow) after.followUp = 'keep going'
      follow = false
    })
    await chat.send('c1', send('one'))
    const first = await turn(1)
    expect(first.context).toBe('ctx-a\n\nctx-b')
    await chat.send('c1', send('queued')) // 도는 중 — 대기열
    first.finish()
    const second = await turn(2)
    expect(second.prompt).toBe('keep going')
    second.finish()
    expect((await turn(3)).prompt).toBe('queued')
    await ended(2)
    expect(of('turn.started').map((event) => event.origin)).toEqual(['user', 'hook', 'user'])
    expect(seen.slice(0, 4)).toEqual(['before user first=true one', 'after user done echo: one', 'before hook first=false keep going', 'after hook done echo: keep going'])
  })

  it("'chat/before-send' 가 막으면 보내지 않고 사람 글을 되돌려 놓는다. 다른 대화의 지시는 되돌려 놓지 않는다", async () => {
    const { ctx, chat, llm, ended, of } = await start({ hooks: false })
    ctx.on('chat/before-send', (before) => void (before.blocked = `no: ${before.text}`))
    await chat.send('c1', send('typed'))
    expect((await ended(1)).message).toMatchObject({ error: 'no: typed' })
    expect(of('queue.changed').at(-1)).toMatchObject({ items: ['typed'], held: true })
    await chat.send('c2', send('ordered', { origin: 'session:c1', from: { conversationId: 'c1', title: 't' } }))
    expect((await ended(2)).message).toMatchObject({ error: 'no: ordered' })
    expect(chat.queued('c2')).toBe(0)
    expect(llm.calls).toEqual([])
  })

  it('note: 도는 턴에만 진행 줄을 더한다 — 없으면 false', async () => {
    const { chat, turn, ended } = await start({ hooks: false })
    const line: TurnItem = { kind: 'hook', id: 'h1', event: 'Stop', command: 'x', outcome: 'passed', seconds: 0.1 }
    expect(chat.note('c1', line)).toBe(false)
    await chat.send('c1', send('hi'))
    const call = await turn(1)
    expect(chat.note('c1', line)).toBe(true)
    call.finish()
    expect((await ended(1)).message.items).toEqual([line])
    expect(chat.note('c1', line)).toBe(false)
  })
})
