import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { translate, type MessageKey } from '../../shared/i18n/index.ts'
import type { Attention } from '../../shared/contract.ts'
import type { GitBranch, GitStatus, GitView } from '../../shared/git.ts'
import { changeCount, gitViewOf, refreshGit } from '../../renderer/gitStore.ts'
import { GIT_TAB, getPanelState, openFilePreview, openGitTab, selectTab } from '../../renderer/filePreviewStore.ts'

// Git 탭·브랜치 알약·AI 승인 카드의 화면 (이슈 #290) — 정적 마크업과 저장소 규칙. 진짜 창 모양은 스크린샷으로 따로 봤다(보고서)

const features = vi.hoisted(() => ({ on: new Set<string>(['git']) }))
vi.mock('../../renderer/settingsStore.ts', () => ({ useT: () => (key: MessageKey, vars?: Record<string, string | number>) => translate('ko', key, vars) }))
vi.mock('../../renderer/featuresStore.ts', () => ({ useFeatures: () => features.on }))

const { GitBranchPill, GitPanel, GitTabCount } = await import('../../renderer/Git.tsx')
const { AttentionCard } = await import('../../renderer/Attention.tsx')

const status = (extra: Partial<GitStatus> = {}): GitStatus => ({
  state: 'ok',
  branch: 'feat_290_git',
  upstream: 'origin/feat_290_git',
  ahead: 2,
  behind: 0,
  remote: 'git@git.company.local:team/app.git',
  hasCommits: true,
  merging: false,
  staged: [{ path: 'src/a.ts', kind: 'M', added: 12, removed: 48 }],
  changed: [
    { path: 'docs/status.md', kind: 'M', added: 3, removed: 1 },
    { path: 'notes.txt', kind: 'U' },
  ],
  conflicts: [],
  ...extra,
})

let dir = 0
async function withView(view: GitView): Promise<string> {
  const directory = `/p${++dir}`
  await refreshGit(directory, async () => view)
  return directory
}

const html = (element: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(element)

describe('gitStore', () => {
  it('늦게 온 옛 답은 버린다 — 마지막 요청의 답만', async () => {
    let first!: (view: GitView) => void
    const slow = refreshGit('/race', () => new Promise<GitView>((resolve) => (first = resolve)))
    await refreshGit('/race', async () => ({ state: 'not-repo' }))
    first(status())
    await slow
    expect(gitViewOf('/race')).toEqual({ state: 'not-repo' })
  })

  it('변경 수 = 스테이지 + 변경 + 충돌, 저장소가 아니면 0', () => {
    expect(changeCount(status({ conflicts: [{ path: 'c', kind: 'C' }] }))).toBe(4)
    expect(changeCount({ state: 'missing' })).toBe(0)
    expect(changeCount(undefined)).toBe(0)
  })

  it('실패한 읽기(기능 꺼짐 — 채널 없음)는 값을 바꾸지 않는다', async () => {
    const directory = await withView(status())
    await refreshGit(directory, async () => Promise.reject(new Error('No handler registered')))
    expect(gitViewOf(directory)).toMatchObject({ state: 'ok' })
  })
})

describe('패널 탭 저장소 — Git 탭', () => {
  it('openGitTab 은 Git 탭을 고르고, 하위 탭을 줄 때마다 seq 가 오른다. 파일 탭과 섞이지 않는다', () => {
    openFilePreview('/g', 'a.ts')
    openGitTab('/g', 'branches')
    const first = getPanelState()!
    expect(first).toMatchObject({ open: true, active: GIT_TAB, tabs: ['a.ts'], gitSub: { sub: 'branches' } })
    openGitTab('/g', 'branches')
    expect(getPanelState()!.gitSub!.seq).toBeGreaterThan(first.gitSub!.seq)
    selectTab('a.ts')
    expect(getPanelState()).toMatchObject({ active: 'a.ts', tabs: ['a.ts'] })
  })
})

describe('GitPanel — 정적 그림', () => {
  it('변경: 브랜치·↑↓·가져오기/올리기, 하위 탭 셋, 스테이지/변경 묶음과 상태 글자·줄 수, 메시지가 없으면 커밋 버튼은 꺼짐', async () => {
    const directory = await withView(status())
    const out = html(createElement(GitPanel, { directory }))
    expect(out).toContain('feat_290_git')
    expect(out).toContain('↑2 ↓0')
    expect(out).toContain('>가져오기</button>')
    expect(out).toContain('>올리기</button>')
    for (const tab of ['변경', '기록', '브랜치']) expect(out).toContain(`>${tab}</button>`)
    expect(out).toContain('스테이지됨 (1)')
    expect(out).toContain('변경됨 (2)')
    expect(out).toContain('+12 −48')
    expect(out).toContain('새 파일')
    expect(out).toMatch(/data-kind="U"/)
    expect(out).toMatch(/<button type="button" class="attention-card__button attention-card__button--primary" disabled="">1개 파일 커밋<\/button>/)
    // 되돌리기 버튼은 변경 쪽에만 (스테이지 줄엔 없다)
    expect(out).toContain('docs/status.md 변경 되돌리기')
    expect(out).not.toContain('src/a.ts 변경 되돌리기')
  })

  it('충돌이면 위에 경고 카드 — 파일·가져오기 취소', async () => {
    const directory = await withView(status({ merging: true, conflicts: [{ path: 'src/llm.ts', kind: 'C' }] }))
    const out = html(createElement(GitPanel, { directory }))
    expect(out).toContain('충돌 1개 · 가져오기를 멈췄습니다')
    expect(out).toContain('U src/llm.ts')
    expect(out).toContain('>가져오기 취소</button>')
  })

  it('못 쓰는 상태 — git 없음(다시 확인)·저장소 아님(git init)', async () => {
    const missing = html(createElement(GitPanel, { directory: await withView({ state: 'missing' }) }))
    expect(missing).toContain('git 을 찾지 못했습니다')
    expect(missing).toContain('>다시 확인</button>')
    const notRepo = html(createElement(GitPanel, { directory: await withView({ state: 'not-repo' }) }))
    expect(notRepo).toContain('이 폴더는 git 저장소가 아닙니다')
    expect(notRepo).toContain('>git init</button>')
  })
})

describe('탭 숫자·브랜치 알약', () => {
  it('변경이 있으면 숫자, 알약은 브랜치 이름과 ● 수. 기능이 꺼졌거나 저장소가 아니면 알약이 없다', async () => {
    const directory = await withView(status())
    expect(html(createElement(GitTabCount, { directory }))).toContain('>3</span>')
    const pill = html(createElement(GitBranchPill, { directory }))
    expect(pill).toContain('feat_290_git')
    expect(pill).toContain('● 3')
    expect(html(createElement(GitBranchPill, { directory: await withView({ state: 'not-repo' }) }))).toBe('')
    features.on = new Set()
    expect(html(createElement(GitBranchPill, { directory }))).toBe('')
    features.on = new Set(['git'])
  })
})

describe('AI 의 git 쓰기 도구 승인 카드', () => {
  const card = (tool: string, input: unknown): Attention => ({ kind: 'permission', id: 'per_1', sessionId: 'ses_1', action: `litecode_${tool}`, resources: ['*'], mcp: { server: 'litecode', tool }, input: JSON.stringify(input) })
  it('무엇을 하는지 제목, 커밋 메시지를 그대로 — 항상 허용은 있다 (2026-10-12, 이 대화에서 기억)', () => {
    const out = html(createElement(AttentionCard, { request: card('git_commit', { message: 'llm.ts 를 나눈다' }), onAnswer: async () => {} }))
    expect(out).toContain('AI 가 커밋하려고 합니다')
    expect(out).toContain('llm.ts 를 나눈다')
    expect(out).toContain('>항상 허용</button>')
    expect(html(createElement(AttentionCard, { request: card('git_push', {}), onAnswer: async () => {} }))).toContain('AI 가 원격에 올리려고 합니다 (push)')
  })
})

// ── 브랜치 팝업 (이슈 #386, 시안 Branch.dc.html ②) ──

const { recentBranches, branchPrefix, groupBranches, matchesQuery, branchTrack, popupShortcut, shortcutLabel } = await import('../../renderer/branchPopup.ts')
const { BranchList } = await import('../../renderer/Git.tsx')

const br = (name: string, extra: Partial<GitBranch> = {}): GitBranch => ({ name, current: false, time: 0, ahead: 0, behind: 0, unmerged: 0, ...extra })

describe('브랜치 팝업 — 순수 규칙', () => {
  it('최근 = 지금 브랜치 먼저, 그다음 마지막 커밋 시각 순 상위 3개', () => {
    const list = [br('a', { time: 1 }), br('b', { time: 5 }), br('c', { time: 3, current: true }), br('d', { time: 4 }), br('e', { time: 2 })]
    expect(recentBranches(list).map((branch) => branch.name)).toEqual(['c', 'b', 'd'])
    expect(recentBranches([br('x')]).map((branch) => branch.name)).toEqual(['x'])
  })

  it('앞부분 — 구분자 _ 와 / 둘 다, 구분자가 없거나 끝에만 있으면 없다', () => {
    expect(branchPrefix('feat_290_git')).toBe('feat_')
    expect(branchPrefix('feat/log-graph')).toBe('feat/')
    expect(branchPrefix('fix_1')).toBe('fix_')
    expect(branchPrefix('main')).toBeUndefined()
    expect(branchPrefix('wip_')).toBeUndefined()
    expect(branchPrefix('_x')).toBeUndefined()
  })

  it('묶기 — 둘 이상인 앞부분만 묶음(이름 순), 하나뿐이면 낱개. 묶음이 먼저, 낱개는 이름 순. feat_ 와 feat/ 는 다른 묶음', () => {
    const list = [br('main'), br('feat_303_terminal'), br('dev'), br('feat_290_git'), br('fix_1'), br('fix_2'), br('docs_only'), br('feat/a'), br('feat/b')]
    const entries = groupBranches(list)
    expect(entries.map((entry) => (entry.kind === 'group' ? `${entry.prefix}[${entry.branches.map((branch) => branch.name).join(',')}]` : entry.branch.name))).toEqual([
      'feat/[feat/a,feat/b]',
      'feat_[feat_290_git,feat_303_terminal]',
      'fix_[fix_1,fix_2]',
      'dev',
      'docs_only',
      'main',
    ])
  })

  it('검색 — 대소문자 무시, 앞뒤 공백 무시, 빈 검색은 모두', () => {
    expect(matchesQuery('feat_290_GIT', ' git ')).toBe(true)
    expect(matchesQuery('main', 'dev')).toBe(false)
    expect(matchesQuery('main', '  ')).toBe(true)
  })

  it('↑↓ — 있는 쪽만', () => {
    expect(branchTrack(br('a', { ahead: 3 }))).toBe('↑3')
    expect(branchTrack(br('a', { ahead: 1, behind: 2 }))).toBe('↑1 ↓2')
    expect(branchTrack(br('a', { behind: 2 }))).toBe('↓2')
    expect(branchTrack(br('a'))).toBe('')
  })

  it('단축키 — mac 은 ⌘T·⌥⌘N, 그 밖은 Ctrl+T·Ctrl+Alt+N. 물리 키(code)로 본다 (한글 입력 체계)', () => {
    const key = (code: string, mods: { meta?: boolean; ctrl?: boolean; alt?: boolean; shift?: boolean } = {}) => ({ code, metaKey: !!mods.meta, ctrlKey: !!mods.ctrl, altKey: !!mods.alt, shiftKey: !!mods.shift })
    expect(popupShortcut(key('KeyT', { meta: true }), true)).toBe('pull')
    expect(popupShortcut(key('KeyN', { meta: true, alt: true }), true)).toBe('newBranch')
    expect(popupShortcut(key('KeyN', { meta: true }), true)).toBeUndefined() // ⌘N 은 새 대화
    expect(popupShortcut(key('KeyT', { ctrl: true }), true)).toBeUndefined()
    expect(popupShortcut(key('KeyT', { meta: true, shift: true }), true)).toBeUndefined()
    expect(popupShortcut(key('KeyT', { ctrl: true }), false)).toBe('pull')
    expect(popupShortcut(key('KeyN', { ctrl: true, alt: true }), false)).toBe('newBranch')
    expect(popupShortcut(key('KeyT', { meta: true }), false)).toBeUndefined()
    expect([shortcutLabel('pull', true), shortcutLabel('newBranch', true), shortcutLabel('pull', false), shortcutLabel('newBranch', false)]).toEqual(['⌘T', '⌥⌘N', 'Ctrl+T', 'Ctrl+Alt+N'])
  })
})

describe('브랜치 팝업 — 정적 그림', () => {
  const branches = [
    br('feat_290_git', { current: true, time: 9, upstream: 'origin/feat_290_git', ahead: 2 }),
    br('dev', { time: 8, upstream: 'origin/dev' }),
    br('feat_295_jobs_strip', { time: 3, ahead: 3 }),
    br('feat_303_terminal_panel', { time: 2 }),
    br('fix_1', { time: 1 }),
    br('fix_2', { time: 1 }),
    br('main', { time: 0, upstream: 'origin/main' }),
  ]
  const list = (extra: Partial<Parameters<typeof BranchList>[0]> = {}) =>
    html(
      createElement(BranchList, {
        view: status(),
        branches,
        remotes: ['origin/dev', 'origin/main', 'origin/feat_x'],
        busy: false,
        mac: true,
        onPull() {},
        onPush() {},
        onCreate() {},
        onRevision() {},
        onSwitch() {},
        onSwitchRemote() {},
        ...extra,
      }),
    )

  it('시안의 줄 — 검색 칸(⌘K 글자 없음)·가져오기 ⌘T·올리기 ↑2·새 브랜치 ⌥⌘N·태그·커밋으로 전환·최근·로컬 브랜치·원격 브랜치 개수', () => {
    const out = list()
    expect(out).toContain('placeholder="브랜치·동작 검색"')
    expect(out).not.toContain('⌘K')
    expect(out).toContain('가져오기 (원격 → 이 브랜치)')
    expect(out).toContain('>⌘T<')
    expect(out).toMatch(/올리기<\/span><span class="branch-pop__tr">↑2</)
    expect(out).toContain('새 브랜치 만들기…')
    expect(out).toContain('>⌥⌘N<')
    expect(out).toContain('태그·커밋으로 전환…')
    expect(out).toContain('>최근<')
    expect(out).toContain('>로컬 브랜치<')
    expect(out).toMatch(/원격 브랜치<\/span><span class="branch-pop__tr">3개</)
    // 원격 목록은 접혀 있다
    expect(out).not.toContain('origin/feat_x')
    // 순서: 동작 → 최근 → 로컬 → 원격
    const at = (text: string) => out.indexOf(text)
    expect(at('가져오기 (원격')).toBeLessThan(at('>최근<'))
    expect(at('>최근<')).toBeLessThan(at('>로컬 브랜치<'))
    expect(at('>로컬 브랜치<')).toBeLessThan(at('원격 브랜치</span>'))
  })

  it('로컬 — 지금 브랜치가 든 묶음은 펼침, 다른 묶음은 접힘(개수), 낱개는 upstream, ↑ 수, 지금 브랜치 ●', () => {
    const out = list()
    const local = out.slice(out.indexOf('>로컬 브랜치<'))
    expect(local).toMatch(/feat_<\/span><span class="branch-pop__tr">3개</)
    expect(local).toMatch(/fix_<\/span><span class="branch-pop__tr">2개</)
    expect(local).toContain('feat_295_jobs_strip')
    expect(local).toContain('>↑3<')
    expect(local).not.toContain('fix_1') // 접힘
    expect(local).toContain('aria-label="지금 브랜치"')
    expect(local).toContain('>origin/main<')
    expect(local.indexOf('fix_<')).toBeLessThan(local.indexOf('>dev<'))
    // 지금 브랜치 줄은 누를 수 없다
    expect(local).toMatch(/<button type="button" class="branch-pop__item branch-pop__item--child" disabled="" aria-current="true"><span class="branch-pop__name git-mono" title="feat_290_git">/)
  })

  it('최근 — 지금 브랜치(●·↑2) 다음 dev(upstream)', () => {
    const out = list()
    const recent = out.slice(out.indexOf('>최근<'), out.indexOf('>로컬 브랜치<'))
    expect(recent.indexOf('feat_290_git')).toBeLessThan(recent.indexOf('>dev<'))
    expect(recent).toContain('>origin/dev<')
    expect(recent).toContain('●')
  })

  it('커밋 전이면 새 브랜치를 못 누르고, 분리된 HEAD·충돌 중이면 가져오기·올리기를 못 누른다', () => {
    expect(list({ view: status({ hasCommits: false }) })).toMatch(/<button type="button" class="branch-pop__item" disabled=""><svg[^]*?새 브랜치 만들기…/)
    const detached = list({ view: status({ branch: undefined }) })
    expect(detached).toMatch(/<button type="button" class="branch-pop__item" disabled=""><span class="branch-pop__name">가져오기/)
    expect(detached).toMatch(/<button type="button" class="branch-pop__item" disabled=""><span class="branch-pop__name">올리기/)
  })

  it('원격 브랜치가 없으면 그 줄이 없다, 브랜치를 읽는 중이면 읽는 중', () => {
    expect(list({ remotes: [] })).not.toContain('원격 브랜치')
    expect(list({ branches: undefined })).toContain('불러오는 중')
  })

  it('알약 — 분리된 HEAD 여도 그린다, 팝업 단추(aria-haspopup·닫힘)', async () => {
    const pill = html(createElement(GitBranchPill, { directory: await withView(status({ branch: undefined, upstream: undefined })) }))
    expect(pill).toContain('분리된 HEAD')
    expect(pill).toContain('aria-haspopup="dialog"')
    expect(pill).toContain('aria-expanded="false"')
  })
})

// ── 커밋 영역 (이슈 #387, 시안 Git 탭 재설계 ① Main.dc.html 맨 아래) ──

const { commitControls, commitThenPush, commitNotice } = await import('../../renderer/gitCommit.ts')
const { CommitBox } = await import('../../renderer/Git.tsx')
const tko = (key: MessageKey, vars?: Record<string, string | number>) => translate('ko', key, vars)

describe('커밋 영역 — 순수 규칙', () => {
  const last = { message: 'fix(git): 로그\n\n본문', pushed: false }

  it('고치기 체크 — 첫 커밋 전·병합 중·이미 올린 커밋이면 막고 이유, 마지막 커밋을 읽기 전엔 막되 이유 없음', () => {
    expect(commitControls(status(), last, false, '', false)).toMatchObject({ amendable: true, amendBlock: undefined })
    expect(commitControls(status({ hasCommits: false }), undefined, false, '', false)).toMatchObject({ amendable: false, amendBlock: 'noCommits' })
    expect(commitControls(status({ merging: true }), last, false, '', false)).toMatchObject({ amendable: false, amendBlock: 'merging' })
    expect(commitControls(status(), { ...last, pushed: true }, false, '', false)).toMatchObject({ amendable: false, amendBlock: 'pushed' })
    expect(commitControls(status(), undefined, false, '', false)).toMatchObject({ amendable: false, amendBlock: undefined })
  })

  it('주 버튼 — 메시지 + stage 가 있어야, 고치기면 stage 없이도(메시지만). 막힌 고치기 체크는 꺼진 것으로 본다. 작업 중이면 못 누른다', () => {
    expect(commitControls(status(), last, false, 'msg', false)).toMatchObject({ amending: false, canCommit: true })
    expect(commitControls(status(), last, false, '  ', false).canCommit).toBe(false)
    expect(commitControls(status({ staged: [] }), last, false, 'msg', false).canCommit).toBe(false)
    expect(commitControls(status({ staged: [] }), last, true, 'msg', false)).toMatchObject({ amending: true, canCommit: true })
    expect(commitControls(status({ staged: [] }), { ...last, pushed: true }, true, 'msg', false)).toMatchObject({ amending: false, canCommit: false })
    expect(commitControls(status(), last, false, 'msg', true).canCommit).toBe(false)
  })

  it('올리기 버튼 — 주 버튼과 같은 조건 + 원격(origin)·브랜치가 있어야. 없으면 이유', () => {
    expect(commitControls(status(), last, false, 'msg', false)).toMatchObject({ canPush: true, pushBlock: undefined })
    expect(commitControls(status({ remote: undefined }), last, false, 'msg', false)).toMatchObject({ canPush: false, pushBlock: 'no-remote' })
    expect(commitControls(status({ branch: undefined }), last, false, 'msg', false)).toMatchObject({ canPush: false, pushBlock: 'detached' })
    expect(commitControls(status(), last, false, '', false)).toMatchObject({ canPush: false, pushBlock: undefined })
  })

  it('흐름 — 커밋(또는 고치기) 뒤 올리기, 커밋이 실패하면 올리지 않는다', async () => {
    const calls: string[] = []
    const ok = async (action: { kind: string }) => (calls.push(action.kind), action.kind === 'push' ? { ok: true as const, branch: 'main' } : { ok: true as const, short: 'abc1234', files: 2 })
    expect(await commitThenPush(ok, 'm', false, false)).toEqual({ short: 'abc1234', files: 2, amend: false })
    expect(calls).toEqual(['commit'])
    calls.length = 0
    expect(await commitThenPush(ok, 'm', true, true)).toEqual({ short: 'abc1234', files: 2, amend: true, push: { ok: true, branch: 'main' } })
    expect(calls).toEqual(['amend', 'push'])
    calls.length = 0
    const fail = async (action: { kind: string }) => (calls.push(action.kind), { ok: false as const, reason: 'nothing' as const, message: 'x' })
    expect(await commitThenPush(fail, 'm', false, true)).toBeUndefined()
    expect(calls).toEqual(['commit'])
  })

  it('한 줄 — 커밋만은 실행 취소, 고치기는 실행 취소 없음, 올렸으면 원격 열기, 거절이면 커밋은 남았다 + 이유, 인증·연결은 커밋 줄(상태 카드가 따로)', () => {
    const base = { short: 'abc1234', files: 2, amend: false }
    expect(commitNotice(tko, base)).toEqual({ tone: 'ok', text: '커밋 abc1234 · 파일 2개', undo: true })
    expect(commitNotice(tko, { ...base, amend: true })).toEqual({ tone: 'ok', text: '커밋 abc1234 을 고쳤습니다', undo: false })
    expect(commitNotice(tko, { ...base, push: { ok: true, branch: 'main' } })).toEqual({ tone: 'ok', text: '커밋 abc1234 을 main 에 올렸습니다', remote: true })
    const rejected = commitNotice(tko, { ...base, push: { ok: false, reason: 'rejected', message: '! [rejected]' } })
    expect(rejected).toMatchObject({ tone: 'error', detail: '! [rejected]' })
    expect(rejected.text).toContain('커밋 abc1234 은 남았지만 올리지 못했습니다')
    expect(rejected.text).toContain('원격에 새 커밋이 있습니다')
    for (const reason of ['auth', 'network'] as const) expect(commitNotice(tko, { ...base, push: { ok: false, reason, message: '' } })).toEqual({ tone: 'ok', text: '커밋 abc1234 · 파일 2개', undo: true })
  })
})

describe('커밋 영역 — 정적 그림 (시안 ①)', () => {
  const box = (extra: Partial<Parameters<typeof CommitBox>[0]> = {}) =>
    html(
      createElement(CommitBox, {
        view: status({ staged: [{ path: 'a', kind: 'M' }, { path: 'b', kind: 'M' }] }),
        last: { message: 'old', pushed: false },
        message: 'fix(git): 로그에 부모·ref 를 더한다',
        amend: false,
        busy: false,
        mac: true,
        onMessage() {},
        onAmend() {},
        onCommit() {},
        ...extra,
      }),
    )

  it('메시지 칸 + 둘째 줄 자리 표시, 고치기 체크(올리기 전만)·⌘↵, 두 버튼 — N개 파일 커밋(주)·커밋하고 올리기', () => {
    const out = box()
    expect(out).toContain('aria-label="커밋 메시지"')
    expect(out).toContain('변경 이유를 한 줄 더…')
    expect(out).toMatch(/<input type="checkbox"[^>]*>마지막 커밋 고치기 <span class="git-commit__note">\(올리기 전만\)<\/span>/)
    expect(out).toContain('title="아직 안 올린 마지막 커밋만 고칠 수 있어요"')
    expect(out).toContain('>⌘↵</span>')
    expect(out).toMatch(/class="attention-card__button attention-card__button--primary">2개 파일 커밋<\/button><button type="button" class="attention-card__button"[^>]*>커밋하고 올리기<\/button>/)
    expect(box({ mac: false })).toContain('>Ctrl+↵</span>')
    // 둘째 줄을 쓰기 시작하면 자리 표시가 사라진다
    expect(box({ message: '제목\n본문' })).not.toContain('변경 이유를 한 줄 더…')
  })

  it('고치기 체크하면 버튼이 커밋 고치기·고치고 올리기 (stage 없이도 누를 수 있다)', () => {
    const out = box({ amend: true, view: status({ staged: [] }) })
    expect(out).toMatch(/<input type="checkbox"[^>]*checked=""/)
    expect(out).toMatch(/class="attention-card__button attention-card__button--primary">커밋 고치기<\/button>/)
    expect(out).toMatch(/class="attention-card__button"[^>]*>고치고 올리기<\/button>/)
  })

  it('이미 올린 커밋이면 체크가 꺼지고 이유, 원격이 없으면 올리기 버튼이 꺼지고 이유', () => {
    const pushed = box({ amend: true, last: { message: 'old', pushed: true } })
    expect(pushed).toMatch(/<input type="checkbox"[^>]*disabled=""/)
    expect(pushed).not.toMatch(/checked=""/)
    expect(pushed).toContain('title="마지막 커밋을 이미 올려서 고칠 수 없습니다"')
    expect(pushed).toContain('>2개 파일 커밋</button>')
    const noRemote = box({ view: status({ remote: undefined }) })
    expect(noRemote).toMatch(/<button type="button" class="attention-card__button" disabled="" title="원격 주소\(origin\)가 없어 올릴 수 없습니다[^"]*">커밋하고 올리기<\/button>/)
  })
})
