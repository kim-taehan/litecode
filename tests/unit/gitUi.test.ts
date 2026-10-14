import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { translate, type MessageKey } from '../../shared/i18n/index.ts'
import type { Attention } from '../../shared/contract.ts'
import type { GitBranch, GitStatus, GitView } from '../../shared/git.ts'
import { changeCount, gitViewOf, refreshGit, toggleAllGitFolds, toggleGitFold } from '../../renderer/gitStore.ts'
import { SECTION_UNTRACKED } from '../../renderer/gitTree.ts'
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
  it('변경: 브랜치·↑↓·가져오기/올리기, 하위 탭 셋, 변경 구역(stage 된 것·안 된 것 한 트리)과 상태 글자·줄 수, 메시지가 없으면 커밋 버튼은 꺼짐', async () => {
    const directory = await withView(status())
    const out = html(createElement(GitPanel, { directory }))
    expect(out).toContain('feat_290_git')
    expect(out).toContain('↑2 ↓0')
    expect(out).toContain('>가져오기</button>')
    expect(out).toContain('>올리기</button>')
    for (const tab of ['변경', '기록', '브랜치']) expect(out).toContain(`>${tab}</button>`)
    expect(out).toContain('변경 <span class="git-sec__n">2개 파일</span>')
    expect(out).toContain('<span class="git-add">+12</span><span class="git-del">−48</span>')
    expect(out).toMatch(/<button type="button" class="attention-card__button attention-card__button--primary" disabled="">1개 파일 커밋<\/button>/)
    // 되돌리기 버튼은 작업 트리 쪽 변경이 있는 줄에만 (stage 만 된 줄엔 없다)
    expect(out).toContain('docs/status.md 변경 되돌리기')
    expect(out).not.toContain('src/a.ts 변경 되돌리기')
  })

  it('변경 트리 (#388 시안 ①) — 구역 머리 체크 3상태·폴더 줄(체크·폴더·이름·N개 파일)·파일 줄(체크·글자·이름·+N −N), 하위 탭 줄 오른쪽 모두 접기·펴기', async () => {
    const directory = await withView(
      status({
        staged: [
          { path: 'renderer/Git.tsx', kind: 'M', added: 42, removed: 7 },
          { path: 'renderer/git.css', kind: 'M', added: 18, removed: 2 },
        ],
        changed: [{ path: 'src/services/git.ts', kind: 'M', added: 5, removed: 1 }],
      }),
    )
    const out = html(createElement(GitPanel, { directory }))
    // 구역 머리: 일부만 stage → 일부(−)
    expect(out).toMatch(/<div class="git-sec"><input type="checkbox" class="git-check" data-state="mix"[^>]*aria-label="변경 모두 스테이지"\/>변경 <span class="git-sec__n">3개 파일<\/span><\/div>/)
    // 폴더 줄: 폴더 먼저 이름 순, 체크 상태, 이름·개수, 펼침
    expect(out).toMatch(/<li class="git-dir" style="padding-left:26px"><input type="checkbox" class="git-check" data-state="on" aria-label="renderer 폴더 스테이지" checked=""\/><button type="button" class="git-dir__toggle" aria-expanded="true" title="renderer">.*<span class="git-dir__name">renderer<\/span><span class="git-dir__count">2개 파일<\/span><\/button><\/li>/)
    expect(out).toMatch(/data-state="off"[^>]*aria-label="src\/services 폴더 스테이지"/)
    expect(out.indexOf('>renderer<')).toBeLessThan(out.indexOf('>src/services<'))
    // 파일 줄: 폴더 안 46px, 이름만(경로는 폴더 줄이)
    expect(out).toMatch(/<div class="git-file__row" style="padding-left:46px"><input type="checkbox" class="git-check" data-state="on" aria-label="renderer\/Git.tsx 스테이지" checked=""\/><button type="button" class="git-file__toggle" aria-expanded="false" title="renderer\/Git.tsx"><span class="git-kind" data-kind="M" aria-hidden="true">M<\/span><span class="git-file__name">Git.tsx<\/span><span class="git-add">\+42<\/span><span class="git-del">−7<\/span><\/button>/)
    expect(out).not.toContain('changed-files__folder')
    // 모두 접기·펴기 — 하위 탭(tablist) 밖, 같은 줄 오른쪽
    expect(out).toMatch(/<div class="git-sub"><div class="git-sub__tabs" role="tablist"[^>]*>.*<\/div><button type="button" class="git-sub__tool" aria-label="모두 접기·펴기"/)
  })

  it('새 파일 구역 — 기본 접힘(개수와 설명만), 펴면 같은 트리·체크. 접힘은 gitStore 에 남는다(다시 그려도)', async () => {
    const directory = await withView(status({ staged: [], changed: [{ path: 'docs/a.md', kind: 'U' }, { path: 'docs/b.md', kind: 'U' }, { path: 'x.txt', kind: 'U' }] }))
    const closed = html(createElement(GitPanel, { directory }))
    expect(closed).toMatch(/<div class="git-sec git-sec--untracked"><input type="checkbox" class="git-check" data-state="off"[^>]*aria-label="새 파일 모두 스테이지"\/><button type="button" class="git-sec__toggle" aria-expanded="false">.*새 파일 <span class="git-sec__n">3개 · 아직 git 이 모르는 파일<\/span><\/button><\/div>/)
    expect(closed).not.toContain('git-dir')
    expect(closed).not.toContain('>a.md<')
    // 변경 구역은 tracked 가 없으면 없다
    expect(closed).not.toContain('class="git-sec"')
    toggleGitFold(directory, SECTION_UNTRACKED)
    const open = html(createElement(GitPanel, { directory }))
    expect(open).toContain('aria-expanded="true">')
    expect(open).toMatch(/<span class="git-dir__name">docs<\/span><span class="git-dir__count">2개 파일<\/span>/)
    expect(open).toMatch(/<div class="git-file__row" style="padding-left:26px">[^]*data-kind="U"[^>]*>U<\/span><span class="git-file__name">x.txt<\/span><\/button>/)
    // 모두 접기 → 구역·폴더 모두 접힘
    toggleAllGitFolds(directory, [SECTION_UNTRACKED, 'u:docs'])
    expect(html(createElement(GitPanel, { directory }))).not.toContain('git-dir')
  })

  it('폴더를 접으면 그 안 파일 줄이 없고 개수는 남는다, 아무 변경도 없으면 깨끗합니다', async () => {
    const directory = await withView(status({ staged: [], changed: [{ path: 'src/a.ts', kind: 'M' }, { path: 'src/b.ts', kind: 'M' }] }))
    toggleGitFold(directory, 'c:src')
    const out = html(createElement(GitPanel, { directory }))
    expect(out).toMatch(/aria-expanded="false" title="src">.*<span class="git-dir__count">2개 파일<\/span>/)
    expect(out).not.toContain('git-file__row')
    const clean = html(createElement(GitPanel, { directory: await withView(status({ staged: [], changed: [] })) }))
    expect(clean).toContain('>깨끗합니다</p>')
    expect(clean).toMatch(/class="git-sub__tool"[^>]*disabled=""/)
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
  it('변경이 있으면 탭에 숫자, 알약은 브랜치 이름과 ● 만(숫자 없음). 기능이 꺼졌거나 저장소가 아니면 알약이 없다', async () => {
    const directory = await withView(status())
    expect(html(createElement(GitTabCount, { directory }))).toContain('>3</span>')
    const pill = html(createElement(GitBranchPill, { directory }))
    expect(pill).toContain('feat_290_git')
    expect(pill).toContain('>●</span>')
    expect(pill).not.toContain('● 3')
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

// ── 변경 파일 우클릭 메뉴·보관함 (#389, 시안 ① Main.dc.html 의 .menu · .file.sel · 보관함 N) ──

const { FILE_MENU, DANGER_ITEMS, entryPaths, isMenuKey, menuEnabled, menuShortcut, menuShortcutLabel } = await import('../../renderer/gitMenu.ts')
const { FileMenu, StashList, ConfirmCard } = await import('../../renderer/Git.tsx')

describe('우클릭 메뉴 — 순수 규칙', () => {
  it('항목 순서·구분선은 시안 그대로 (커밋·되돌리기 | 변경 보기·미리보기 | 패치·보관 | 삭제), 삭제만 위험', () => {
    expect(FILE_MENU).toEqual([['commitFile', 'discard'], ['showDiff', 'preview'], ['copyPatch', 'stash'], ['trash']])
    expect([...DANGER_ITEMS]).toEqual(['trash'])
  })

  it('단축키 글자 — mac 은 ⌥⌘Z·⌘D·⌘↓, 그 밖은 Ctrl. 나머지 항목은 없음', () => {
    expect(['commitFile', 'discard', 'showDiff', 'preview', 'copyPatch', 'stash', 'trash'].map((item) => menuShortcutLabel(item as never, true))).toEqual([undefined, '⌥⌘Z', '⌘D', '⌘↓', undefined, undefined, undefined])
    expect(menuShortcutLabel('discard', false)).toBe('Ctrl+Alt+Z')
    expect(menuShortcutLabel('showDiff', false)).toBe('Ctrl+D')
    expect(menuShortcutLabel('preview', false)).toBe('Ctrl+↓')
  })

  it('단축키 — 물리 키(code)로, mac 은 ⌘ · 그 밖은 Ctrl. Shift 가 섞이면 아님. 메뉴 키 = ContextMenu·Shift+F10', () => {
    const key = (extra: Partial<Parameters<typeof menuShortcut>[0]>) => ({ code: '', key: '', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...extra })
    expect(menuShortcut(key({ code: 'KeyZ', key: 'Ω', metaKey: true, altKey: true }), true)).toBe('discard')
    expect(menuShortcut(key({ code: 'KeyZ', metaKey: true }), true)).toBeUndefined() // ⌘Z 는 되돌리기가 아니다
    expect(menuShortcut(key({ code: 'KeyD', key: 'ㅇ', metaKey: true }), true)).toBe('showDiff')
    expect(menuShortcut(key({ key: 'ArrowDown', code: 'ArrowDown', metaKey: true }), true)).toBe('preview')
    expect(menuShortcut(key({ code: 'KeyD', ctrlKey: true }), true)).toBeUndefined()
    expect(menuShortcut(key({ code: 'KeyD', ctrlKey: true }), false)).toBe('showDiff')
    expect(menuShortcut(key({ code: 'KeyZ', ctrlKey: true, altKey: true }), false)).toBe('discard')
    expect(menuShortcut(key({ code: 'KeyD', metaKey: true, shiftKey: true }), true)).toBeUndefined()
    expect(isMenuKey({ key: 'ContextMenu', shiftKey: false })).toBe(true)
    expect(isMenuKey({ key: 'F10', shiftKey: true })).toBe(true)
    expect(isMenuKey({ key: 'F10', shiftKey: false })).toBe(false)
  })

  it('누를 수 있나 — 되돌리기는 작업 트리 변경이 있을 때, 지운 파일은 미리보기·삭제 없음, 병합 중엔 커밋·보관 없음, 첫 커밋 전엔 보관 없음', () => {
    const ok = { merging: false, hasCommits: true }
    const stagedOnly = { path: 'a', staged: { path: 'a', kind: 'M' as const } }
    const deleted = { path: 'd', changed: { path: 'd', kind: 'D' as const } }
    expect(menuEnabled('discard', stagedOnly, ok)).toBe(false)
    expect(menuEnabled('discard', deleted, ok)).toBe(true)
    expect(menuEnabled('preview', deleted, ok)).toBe(false)
    expect(menuEnabled('trash', deleted, ok)).toBe(false)
    expect(menuEnabled('preview', stagedOnly, ok)).toBe(true)
    expect(menuEnabled('commitFile', stagedOnly, { merging: true, hasCommits: true })).toBe(false)
    expect(menuEnabled('stash', stagedOnly, { merging: true, hasCommits: true })).toBe(false)
    expect(menuEnabled('stash', stagedOnly, { merging: false, hasCommits: false })).toBe(false)
    expect(menuEnabled('commitFile', stagedOnly, { merging: false, hasCommits: false })).toBe(true)
    expect(menuEnabled('copyPatch', deleted, ok)).toBe(true)
    // 이름 바꾼 파일은 옛 경로도 같이
    expect(entryPaths({ path: 'new.ts', staged: { path: 'new.ts', kind: 'R', from: 'old.ts' } })).toEqual(['new.ts', 'old.ts'])
    expect(entryPaths(stagedOnly)).toEqual(['a'])
  })
})

describe('우클릭 메뉴 — 정적 그림 (시안 ① .menu)', () => {
  const entry = { path: 'renderer/Git.tsx', staged: { path: 'renderer/Git.tsx', kind: 'M' as const }, changed: { path: 'renderer/Git.tsx', kind: 'M' as const } }
  const menu = (extra: Partial<Parameters<typeof FileMenu>[0]> = {}) => html(createElement(FileMenu, { entry, view: status(), mac: true, at: { left: 10, top: 20 }, onPick() {}, onClose() {}, ...extra }))

  it('항목·구분선·단축키 글자가 시안 순서, 삭제는 위험 색, .gitignore 항목은 아직 없다(#390)', () => {
    const out = menu()
    expect(out).toMatch(/^<div class="git-menu" role="menu" aria-label="Git.tsx 메뉴" style="left:10px;top:20px">/)
    const text = out
      .replace(/<div class="git-menu__sep" role="separator"><\/div>/g, '|')
      .replace(/<span class="git-menu__sc">([^<]*)<\/span>/g, '[$1]')
      .replace(/<[^>]+>/g, '')
    expect(text).toBe('이 파일만 커밋…되돌리기…[⌥⌘Z]|변경 보기[⌘D]파일 미리보기로 열기[⌘↓]|패치로 복사보관(stash)…|삭제…')
    expect(out).toMatch(/<button type="button" role="menuitem" class="git-menu__item" data-danger="true"[^>]*>삭제…<\/button>/)
    expect(out).not.toContain('gitignore')
    expect(menu({ mac: false })).toContain('<span class="git-menu__sc">Ctrl+Alt+Z</span>')
  })

  it('못 누르는 항목은 disabled — 지운 파일은 미리보기·삭제, stage 만 된 파일은 되돌리기', () => {
    const deleted = menu({ entry: { path: 'gone.ts', changed: { path: 'gone.ts', kind: 'D' } } })
    expect(deleted).toMatch(/disabled=""[^>]*>파일 미리보기로 열기/)
    expect(deleted).toMatch(/disabled=""[^>]*>삭제…/)
    expect(deleted).not.toMatch(/disabled=""[^>]*>되돌리기…/)
    const stagedOnly = menu({ entry: { path: 'a.ts', staged: { path: 'a.ts', kind: 'M' } } })
    expect(stagedOnly).toMatch(/disabled=""[^>]*>되돌리기…/)
  })
})

describe('보관함 (#389) — 정적 그림', () => {
  it('하위 탭 줄 오른쪽 — 모두 접기·펴기 다음에 보관함 N (변경 탭에서만)', async () => {
    const directory = await withView(status())
    const out = html(createElement(GitPanel, { directory }))
    expect(out).toMatch(/aria-label="모두 접기·펴기"[^]*<\/button><div class="git-stash"><button type="button" class="git-sub__tool git-stash__button" aria-label="보관\(stash\) 목록" aria-haspopup="dialog" aria-expanded="false"[^>]*>보관함 0<\/button><\/div><\/div>/)
  })

  it('목록 — 줄마다 메시지·브랜치·시각과 [적용]·[삭제], 없으면 빈 글', () => {
    const now = Date.now()
    const out = html(
      createElement(StashList, {
        stashes: [
          { index: 0, hash: 'a'.repeat(40), message: 'wip a', branch: 'main', time: now - 120_000 },
          { index: 1, hash: 'b'.repeat(40), message: '분리된 HEAD 에서', time: now - 7_200_000 },
        ],
        busy: false,
        onApply() {},
        onDrop() {},
      }),
    )
    expect(out).toContain('<div class="branch-pop__label">보관(stash) 목록</div>')
    expect(out).toMatch(/<span class="git-stash__message" title="wip a">wip a<\/span><span class="git-stash__meta">main · [^<]+<\/span>/)
    expect(out).toMatch(/<span class="git-stash__message"[^>]*>분리된 HEAD 에서<\/span><span class="git-stash__meta">[^·<]+<\/span>/)
    expect(out.match(/>적용<\/button>/g)).toHaveLength(2)
    expect(out.match(/>삭제<\/button>/g)).toHaveLength(2)
    expect(out.indexOf('wip a')).toBeLessThan(out.indexOf('분리된 HEAD 에서'))
    expect(html(createElement(StashList, { stashes: [], busy: false, onApply() {}, onDrop() {} }))).toContain('보관한 것이 없습니다')
  })
})

describe('메뉴의 확인 카드 (승인 카드 틀)', () => {
  const entry = { path: 'src/a.ts', changed: { path: 'src/a.ts', kind: 'M' as const } }
  const card = (confirm: Parameters<typeof ConfirmCard>[0]['confirm']) => html(createElement(ConfirmCard, { confirm, view: status(), busy: false, onCancel() {}, onAccept: async () => {} }))

  it('이 파일만 커밋 — 파일·메시지 칸, 메시지가 비면 커밋 버튼이 꺼진다', () => {
    const out = card({ kind: 'commitFile', entry })
    expect(out).toContain('이 파일만 커밋')
    expect(out).toContain('src/a.ts 만 커밋합니다')
    expect(out).toContain('aria-label="커밋 메시지"')
    expect(out).toMatch(/class="attention-card__button attention-card__button--primary" disabled="">커밋<\/button>/)
  })

  it('보관 — 메시지는 없어도 된다(버튼 켜짐), 삭제 — 휴지통·위험 버튼, 보관 삭제 — 위험 버튼', () => {
    const stash = card({ kind: 'stash', entry })
    expect(stash).toContain('aria-label="보관 메시지 (없어도 됩니다)"')
    expect(stash).toMatch(/class="attention-card__button attention-card__button--primary">보관<\/button>/)
    const trash = card({ kind: 'trash', entry })
    expect(trash).toContain('data-tone="danger"')
    expect(trash).toContain('src/a.ts 을 휴지통으로 옮깁니다.')
    expect(trash).toMatch(/attention-card__button--danger">삭제<\/button>/)
    const drop = card({ kind: 'dropStash', stash: { index: 0, hash: 'a'.repeat(40), message: 'wip a', time: 0 } })
    expect(drop).toContain('보관 &quot;wip a&quot; 를 지웁니다.')
    expect(drop).toMatch(/attention-card__button--danger">삭제<\/button>/)
  })
})
