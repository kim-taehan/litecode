import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { translate, type MessageKey } from '../../shared/i18n/index.ts'
import type { Attention } from '../../shared/contract.ts'
import type { GitStatus, GitView } from '../../shared/git.ts'
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
    expect(out).toMatch(/<button type="button" class="attention-card__button attention-card__button--primary" disabled="">커밋 \(1\)<\/button>/)
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
