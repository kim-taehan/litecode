import { describe, expect, it } from 'vitest'
import {
  GIT_TAB,
  allPanelsForProject,
  closeFilePreview,
  closeGitTab,
  closeTab,
  compareCandidates,
  cycleTerminalTab,
  exitCompare,
  getGitSub,
  getPanelState,
  isFileTab,
  isTerminalTab,
  openFilePreview,
  openFilesTab,
  openGitTab,
  openTerminalTab,
  openTurnTab,
  panelTakesFocus,
  revealPanel,
  selectTab,
  startCompare,
  tabKey,
  terminalIdOf,
  terminalTabKey,
  toggleFullscreen,
  turnTabKey,
} from '../../renderer/filePreviewStore.ts'
import { buildHtmlDocument, HTML_PREVIEW_CSP } from '../../renderer/htmlPreview.ts'
import { kindOf } from '../../renderer/FilePreview.tsx'
import { lineJump } from '../../renderer/lineJump.ts'

// 오른쪽 패널(이슈 #29) — 탭 저장소의 규칙(같은 파일 한 탭, 닫으면 이웃, 닫아도 탭 유지, 다른 프로젝트면 새로)과 HTML 미리보기 문서의 격리 정책.
// 대화별 패널 (이슈 #579): 파일·터미널·턴·확장 탭은 conversationId 로, Git 탭만 directory 로

const read = (dir: string, conv?: string) => getPanelState(conv, dir)

describe('tabKey', () => {
  it('./·..·프로젝트 안 절대 경로를 한 열쇠로, 밖으로 나가는 글자는 그대로', () => {
    expect(tabKey('/p', 'src/a.ts')).toBe('src/a.ts')
    expect(tabKey('/p', './src/a.ts')).toBe('src/a.ts')
    expect(tabKey('/p', 'src/../src/./a.ts')).toBe('src/a.ts')
    expect(tabKey('/p/', '/p/src/a.ts')).toBe('src/a.ts')
    expect(tabKey('/p', '../x.ts')).toBe('../x.ts')
    expect(tabKey('/p', '/etc/hosts')).toBe('/etc/hosts')
  })
})

describe('패널 탭 저장소', () => {
  it('같은 파일은 한 탭, 고른 탭을 닫으면 오른쪽 이웃 → 왼쪽 → 파일 탭', () => {
    openFilePreview('/p', 'a.ts')
    openFilePreview('/p', 'b.ts')
    openFilePreview('/p', './a.ts')
    openFilePreview('/p', 'c.ts')
    expect(read('/p')).toMatchObject({ directory: '/p', open: true, tabs: ['a.ts', 'b.ts', 'c.ts'], active: 'c.ts' })
    selectTab('b.ts', '/p')
    closeTab('b.ts', '/p')
    expect(read('/p')).toMatchObject({ tabs: ['a.ts', 'c.ts'], active: 'c.ts' })
    closeTab('c.ts', '/p')
    expect(read('/p')).toMatchObject({ tabs: ['a.ts'], active: 'a.ts' })
    closeTab('a.ts', '/p')
    expect(read('/p')).toMatchObject({ tabs: [], active: undefined })
    closeFilePreview('/p')
  })

  it('닫아도 탭은 남아 다시 열면 그대로, 전체 화면은 풀린다. "+" 는 파일 탭으로. 다른 프로젝트면 새로', () => {
    openFilePreview('/p', 'a.ts')
    toggleFullscreen('/p')
    expect(read('/p')?.fullscreen).toBe(true)
    closeFilePreview('/p')
    expect(read('/p')).toMatchObject({ open: false, fullscreen: false, tabs: ['a.ts'], active: 'a.ts' })
    revealPanel('/p')
    expect(read('/p')).toMatchObject({ open: true, tabs: ['a.ts'], active: 'a.ts' })
    openFilesTab('/p')
    expect(read('/p')).toMatchObject({ tabs: ['a.ts'], active: undefined })
    openFilePreview('/q', 'z.ts')
    expect(read('/q')).toMatchObject({ directory: '/q', tabs: ['z.ts'], active: 'z.ts', fullscreen: false })
    closeFilePreview('/p')
    closeFilePreview('/q')
  })
})

// 감사 E4 — AI 의 open_file 은 탭만 열고 고른다. 치던 입력창의 포커스는 가져가지 않는다 (open_terminal 의 quiet 와 같게)
describe('조용히 열기 (AI 의 open_file)', () => {
  it('quiet 로 열면 탭은 열리고 골라지지만 focus 는 오르지 않고, 패널은 포커스를 잡지 않는다 — 닫혀 있던 패널이 새로 뜰 때도', () => {
    openFilePreview('/quiet', 'a.ts', undefined, { quiet: true })
    const opened = read('/quiet')!
    expect(opened).toMatchObject({ open: true, tabs: ['a.ts'], active: 'a.ts', focus: 0 })
    expect(panelTakesFocus(opened)).toBe(false)
    closeFilePreview('/quiet')
  })

  it('사용자가 연 뒤(칩·Files 버튼·머리 버튼)에는 다시 포커스를 잡는다', () => {
    openFilePreview('/quiet2', 'a.ts')
    const byUser = read('/quiet2')!
    expect(byUser.focus).toBe(1)
    expect(panelTakesFocus(byUser)).toBe(true)
    openFilePreview('/quiet2', 'b.ts', undefined, { quiet: true })
    expect(read('/quiet2')).toMatchObject({ active: 'b.ts', focus: 1 })
    expect(panelTakesFocus(read('/quiet2')!)).toBe(false)
    openFilePreview('/quiet2', 'a.ts')
    expect(read('/quiet2')!.focus).toBe(2)
    expect(panelTakesFocus(read('/quiet2')!)).toBe(true)
    openFilePreview('/quiet2', 'b.ts', undefined, { quiet: true })
    openFilesTab('/quiet2')
    expect(read('/quiet2')!.focus).toBe(3)
    expect(panelTakesFocus(read('/quiet2')!)).toBe(true)
    openFilePreview('/quiet2', 'b.ts', undefined, { quiet: true })
    closeFilePreview('/quiet2')
    revealPanel('/quiet2')
    expect(panelTakesFocus(read('/quiet2')!)).toBe(true)
    closeFilePreview('/quiet2')
  })

  it('quiet 로 같은 줄을 다시 열어도 다시 간다 — 줄 이동의 seq 는 focus 와 따로 오른다', () => {
    openFilePreview('/quiet3', 'a.ts', 7, { quiet: true })
    const first = read('/quiet3')!.jump!
    openFilePreview('/quiet3', 'a.ts', 7, { quiet: true })
    expect(read('/quiet3')!.jump).toEqual({ key: 'a.ts', line: 7, seq: first.seq + 1 })
    closeFilePreview('/quiet3')
  })
})

// 이슈 #51 — AI 의 open_file 이 줄을 주면 그 탭을 그 줄로. 화면 계산은 순수 함수(lineJump)
describe('줄 이동', () => {
  it('저장소: 줄을 주고 열면 그 탭에 jump 가 남고, 다른 탭으로 가도 그 줄은 남는다', () => {
    openFilePreview('/jump', 'a.ts', 12)
    const first = read('/jump')!
    expect(first).toMatchObject({ active: 'a.ts', jump: { key: 'a.ts', line: 12 } })
    openFilePreview('/jump', './a.ts', 12)
    expect(read('/jump')!.jump).toMatchObject({ key: 'a.ts', line: 12 })
    openFilePreview('/jump', 'b.ts')
    expect(read('/jump')).toMatchObject({ active: 'b.ts', tabs: ['a.ts', 'b.ts'], jump: { key: 'a.ts', line: 12 } })
    closeFilePreview('/jump')
  })

  it('lineJump: n번째 줄의 자리 = (n−1) × 줄 높이, 스크롤은 그 줄이 위에서 1/3 쯤에 오게', () => {
    expect(lineJump(1, 100, 20, 300)).toEqual({ line: 1, top: 0, scrollTop: 0 })
    expect(lineJump(3, 100, 20, 300)).toEqual({ line: 3, top: 40, scrollTop: 0 }) // 위쪽 줄은 스크롤이 음수가 되지 않는다
    expect(lineJump(51, 100, 20, 300)).toEqual({ line: 51, top: 1000, scrollTop: 900 })
    expect(lineJump(51, 100, 20, 300, 8)).toEqual({ line: 51, top: 1000, scrollTop: 908 }) // 코드 위 패딩만큼 더
    expect(lineJump(51, 100, 20.8, 300).top).toBeCloseTo(1040)
  })

  it('lineJump: 파일보다 큰 줄은 마지막 줄, 1보다 작거나 숫자가 아니면 첫 줄, 소수는 내림', () => {
    expect(lineJump(999, 10, 20, 100).line).toBe(10)
    expect(lineJump(0, 10, 20, 100).line).toBe(1)
    expect(lineJump(-5, 10, 20, 100).line).toBe(1)
    expect(lineJump(Number.NaN, 10, 20, 100).line).toBe(1)
    expect(lineJump(2.9, 10, 20, 100).line).toBe(2)
    expect(lineJump(5, 0, 20, 100)).toEqual({ line: 1, top: 0, scrollTop: 0 })
  })
})

describe('HTML 미리보기 문서', () => {
  it('CSP — 인라인 스크립트·스타일만, 연결·외부 리소스·하위 frame·폼 전송은 막는다', () => {
    expect(HTML_PREVIEW_CSP).toContain("default-src 'none'")
    expect(HTML_PREVIEW_CSP).toContain("script-src 'unsafe-inline' 'unsafe-eval' blob:")
    expect(HTML_PREVIEW_CSP).toContain("connect-src 'none'")
    expect(HTML_PREVIEW_CSP).toContain("frame-src 'none'")
    expect(HTML_PREVIEW_CSP).toContain("form-action 'none'")
    expect(HTML_PREVIEW_CSP).not.toMatch(/https?:|\*/)
  })

  it('부트스트랩 맨 앞에 CSP, 원문은 base64 로 실려 </script> 가 문서를 깨지 않는다', () => {
    const html = '<script>document.title = "</script>"</script><p>한글</p>'
    const doc = buildHtmlDocument(html, [{ reference: 'a.js', text: 'x()' }])
    expect(doc.startsWith(`<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${HTML_PREVIEW_CSP}">`)).toBe(true)
    expect(doc).not.toContain('한글')
    expect(doc.match(/<\/script>/g)).toHaveLength(1)
    const payload = /atob\("([^"]+)"\)/.exec(doc)![1]
    const bundle = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(payload), (c) => c.charCodeAt(0))))
    expect(bundle).toEqual({ html, assets: [{ reference: 'a.js', text: 'x()' }], policy: HTML_PREVIEW_CSP })
  })
})

describe('경로 줄 종류', () => {
  it('확장자로', () => {
    expect(kindOf('a/tetris.html', 'Text')).toBe('HTML')
    expect(kindOf('README.md', 'Text')).toBe('Markdown')
    expect(kindOf('notes.txt', '텍스트')).toBe('텍스트')
    expect(kindOf('Makefile', '텍스트')).toBe('텍스트')
    expect(kindOf('x.rs', 'Text')).toBe('RS')
  })
})

// 이슈 #303 — 터미널이 오른쪽 패널의 탭: 파일 탭과 같은 탭 줄(열쇠 `\0term/<id>`), ⌘[·⌘] 이전/다음의 저장소 쪽 규칙
describe('터미널 탭', () => {
  const term = (id: number) => terminalTabKey(id)

  it('열쇠는 파일 탭(경로)과 겹치지 않고, 같은 번호는 한 탭 — 닫으면 이웃(오른쪽 → 왼쪽 → 파일 탭)', () => {
    expect(isTerminalTab(term(1))).toBe(true)
    expect(isTerminalTab('a.ts')).toBe(false)
    expect(terminalIdOf(term(2))).toBe(2)
    expect(terminalIdOf('a.ts')).toBeUndefined()
    openFilePreview('/term', 'a.ts')
    openTerminalTab('/term', 1)
    openTerminalTab('/term', 2)
    openTerminalTab('/term', 2)
    expect(read('/term')).toMatchObject({ directory: '/term', open: true, tabs: ['a.ts', term(1), term(2)], active: term(2) })
    closeTab(term(2), '/term')
    expect(read('/term')).toMatchObject({ tabs: ['a.ts', term(1)], active: term(1) })
    closeTab(term(1), '/term')
    expect(read('/term')).toMatchObject({ tabs: ['a.ts'], active: 'a.ts' })
    closeFilePreview('/term')
  })

  it('다른 프로젝트면 새로 — 다른 프로젝트의 탭은 건너가지 않는다', () => {
    openTerminalTab('/term-a', 1)
    openTerminalTab('/term-b', 1)
    expect(read('/term-b')).toMatchObject({ directory: '/term-b', tabs: [term(1)], active: term(1) })
    openFilePreview('/term-a', 'a.ts')
    expect(read('/term-a')).toMatchObject({ directory: '/term-a', tabs: [term(1), 'a.ts'], active: 'a.ts' })
    closeFilePreview('/term-a')
    closeFilePreview('/term-b')
  })

  it('quiet 로 열면(AI open(터미널)) focus 를 올리지 않는다 — 탭을 직접 고르면 풀린다', () => {
    openTerminalTab('/term-q', 1)
    const before = read('/term-q')!.focus
    openTerminalTab('/term-q', 2, { quiet: true })
    expect(read('/term-q')).toMatchObject({ active: term(2), quiet: true })
    expect(read('/term-q')!.focus).toBe(before)
    expect(panelTakesFocus(read('/term-q')!)).toBe(false)
    selectTab(term(1), '/term-q')
    expect(read('/term-q')!.quiet).toBe(false)
    expect(read('/term-q')!.active).toBe(term(1))
    expect(panelTakesFocus(read('/term-q')!)).toBe(true)
    closeFilePreview('/term-q')
  })

  it('cycleTerminalTab — ⌘[·⌘] 의 이전·다음(순환). 고른 것이 없으면 마지막, 하나 없으면 false', () => {
    openFilePreview('/term-c', 'a.ts')
    expect(cycleTerminalTab('/term-c', 1)).toBe(false)
    openTerminalTab('/term-c', 1)
    openTerminalTab('/term-c', 2)
    openTerminalTab('/term-c', 3)
    selectTab(undefined, '/term-c')
    expect(cycleTerminalTab('/term-c', 1)).toBe(true)
    expect(read('/term-c')!.active).toBe(term(3)) // 고른 터미널이 없으면 마지막 연 것
    expect(cycleTerminalTab('/term-c', 1)).toBe(true)
    expect(read('/term-c')!.active).toBe(term(1)) // 다음(순환)
    expect(cycleTerminalTab('/term-c', -1)).toBe(true)
    expect(read('/term-c')!.active).toBe(term(3)) // 이전
    expect(cycleTerminalTab('/term-c', -1)).toBe(true)
    expect(read('/term-c')!.active).toBe(term(2))
    closeFilePreview('/term-c')
  })
})

// 비교 보기 (이슈 #424) — 파일 탭 둘을 위아래로. 고른 탭(a)이 위, 후보(b)가 아래. 다른 탭을 고르거나
// 비교 탭을 닫거나 다른 파일을 열면 끝난다
describe('비교 보기 (A/B)', () => {
  const term = (id: number) => terminalTabKey(id)

  it('isFileTab — Git·터미널은 파일 탭이 아니다', () => {
    expect(isFileTab('src/a.ts')).toBe(true)
    expect(isFileTab(GIT_TAB)).toBe(false)
    expect(isFileTab(term(1))).toBe(false)
  })

  it('compareCandidates — 현재 탭을 뺀 다른 연 파일 탭만 (터미널·Git 제외)', () => {
    openFilePreview('/cmp', 'a.ts')
    openFilePreview('/cmp', 'b.ts')
    openTerminalTab('/cmp', 1)
    expect(compareCandidates(read('/cmp')!.tabs, 'a.ts')).toEqual(['b.ts'])
    expect(compareCandidates(read('/cmp')!.tabs, 'b.ts')).toEqual(['a.ts'])
  })

  it('startCompare — 위( a )는 고른 탭, 아래( b )는 후보, active 는 위 탭', () => {
    openFilePreview('/cmp', 'x.ts')
    openFilePreview('/cmp', 'y.ts')
    startCompare('/cmp', 'y.ts', 'x.ts')
    expect(read('/cmp')).toMatchObject({ compare: { a: 'y.ts', b: 'x.ts' }, active: 'y.ts' })
  })

  it('잘못된 startCompare 는 아무 일도 없다 — 같은 탭·비파일 탭·안 연 탭·다른 프로젝트', () => {
    startCompare('/cmp', 'y.ts', 'y.ts')
    startCompare('/cmp', 'y.ts', term(1))
    startCompare('/cmp', 'y.ts', 'gone.ts')
    startCompare('/other', 'y.ts', 'x.ts')
    expect(read('/cmp')!.compare).toEqual({ a: 'y.ts', b: 'x.ts' })
    expect(read('/cmp')!.active).toBe('y.ts')
  })

  it('다른 탭을 고르면 비교가 끝난다 — 위 탭(a) 을 재고르면 그대로', () => {
    selectTab('x.ts', '/cmp')
    expect(read('/cmp')).toMatchObject({ compare: undefined, active: 'x.ts' })
    startCompare('/cmp', 'y.ts', 'x.ts')
    selectTab('y.ts', '/cmp')
    expect(read('/cmp')!.compare).toEqual({ a: 'y.ts', b: 'x.ts' })
  })

  it('비교 중 다른 파일을 열면 끝난다 — 위 탭(a) 을 여는 것만 예외', () => {
    openFilePreview('/cmp', 'y.ts')
    expect(read('/cmp')!.compare).toEqual({ a: 'y.ts', b: 'x.ts' })
    openFilePreview('/cmp', 'a.ts')
    expect(read('/cmp')).toMatchObject({ compare: undefined, active: 'a.ts' })
  })

  it('비교 탭을 닫으면 끝난다 (active 는 이웃)', () => {
    startCompare('/cmp', 'a.ts', 'y.ts')
    closeTab('y.ts', '/cmp')
    expect(read('/cmp')!.compare).toBeUndefined()
  })

  it('exitCompare — 비교가 없으면 아무 일도 없다. 프로젝트를 옮기면 compare 도 초기화', () => {
    expect(read('/cmp')!.compare).toBeUndefined()
    exitCompare('/cmp')
    expect(read('/cmp')!.compare).toBeUndefined()
    startCompare('/cmp', 'a.ts', 'x.ts')
    openFilePreview('/cmp2', 'p.ts')
    expect(read('/cmp2')!.compare).toBeUndefined()
    expect(read('/cmp2')!.directory).toBe('/cmp2')
    closeFilePreview('/cmp')
    closeFilePreview('/cmp2')
  })
})

// "턴 작업" 탭 (이슈 #416) — 같은 이름의 탭은 하나뿐 (이슈 #456): 새 턴이 오면 열렸던 탭의 자리에 그 열쇠로 바뀐다
describe('턴 탭', () => {
  const turn = (conversationId: string, startedAt: number) => turnTabKey(conversationId, startedAt)

  it('새 턴을 열면 기존 턴 탭의 열쇠가 자리에 바뀐다 — 새 탭은 안 생기고 다른 탭은 그대로', () => {
    openFilePreview('/turn', 'a.ts', undefined, {}, 'turnc1')
    openTurnTab('/turn', 'turnc1', 1_000)
    expect(read('/turn', 'turnc1')).toMatchObject({ directory: '/turn', open: true, tabs: ['a.ts', turn('turnc1', 1_000)], active: turn('turnc1', 1_000) })
    openTurnTab('/turn', 'turnc1', 2_000)
    expect(read('/turn', 'turnc1')!.tabs).toEqual(['a.ts', turn('turnc1', 2_000)])
    expect(read('/turn', 'turnc1')!.active).toBe(turn('turnc1', 2_000))
    closeFilePreview('/turn', 'turnc1')
  })

  it('턴 탭이 없으면 마지막에 열고, 닫으면 다른 탭만 남는다', () => {
    openFilePreview('/turn2', 'a.ts', undefined, {}, 'turnc2')
    openTurnTab('/turn2', 'turnc2', 1)
    expect(read('/turn2', 'turnc2')!.tabs).toEqual(['a.ts', turn('turnc2', 1)])
    openTurnTab('/turn2', 'turnc2', 2)
    expect(read('/turn2', 'turnc2')!.tabs).toEqual(['a.ts', turn('turnc2', 2)])
    closeTab(turn('turnc2', 2), '/turn2', 'turnc2')
    expect(read('/turn2', 'turnc2')!.tabs).toEqual(['a.ts'])
    expect(read('/turn2', 'turnc2')!.active).toBe('a.ts')
    closeFilePreview('/turn2', 'turnc2')
  })
})

// 대화별 패널 (이슈 #579) — 같은 프로젝트의 다른 대화는 서로 다른 탭을 가질 수 있고, Git 탭은 프로젝트 공통
describe('대화별 패널', () => {
  it('같은 프로젝트의 다른 대화는 파일 탭이 달라진다', () => {
    openFilePreview('/conv', 'a.ts', undefined, {}, 'c1')
    openFilePreview('/conv', 'b.ts', undefined, {}, 'c2')
    const p1 = read('/conv', 'c1')!
    const p2 = read('/conv', 'c2')!
    expect(p1.tabs).toEqual(['a.ts'])
    expect(p2.tabs).toEqual(['b.ts'])
    expect(p1.active).toBe('a.ts')
    expect(p2.active).toBe('b.ts')
    closeFilePreview('/conv', 'c1')
    closeFilePreview('/conv', 'c2')
  })

  it('Git 탭 — 프로젝트 공통: openGitTab 이 모든 대화 패널을 Git 탭으로 열고, closeGitTab 은 Files 로', () => {
    openFilePreview('/git-conv', 'a.ts', undefined, {}, 'c1')
    openFilePreview('/git-conv', 'b.ts', undefined, {}, 'c2')
    openGitTab('/git-conv', 'changes')
    expect(getGitSub('/git-conv')).toMatchObject({ sub: 'changes' })
    // 두 대화 패널 모두 Git 탭이 선택됨
    expect(read('/git-conv', 'c1')?.active).toBe(GIT_TAB)
    expect(read('/git-conv', 'c2')?.active).toBe(GIT_TAB)
    closeGitTab('/git-conv')
    expect(read('/git-conv', 'c1')?.active).toBeUndefined()
    expect(read('/git-conv', 'c2')?.active).toBeUndefined()
    closeFilePreview('/git-conv', 'c1')
    closeFilePreview('/git-conv', 'c2')
  })

  it('allPanelsForProject — 같은 프로젝트의 모든 대화 패널 리턴', () => {
    openFilePreview('/proj', 'a.ts', undefined, {}, 'c1')
    openFilePreview('/proj', 'b.ts', undefined, {}, 'c2')
    const panels = allPanelsForProject('/proj')
    expect(panels).toHaveLength(2)
    closeFilePreview('/proj', 'c1')
    closeFilePreview('/proj', 'c2')
  })

  it('대화 A 파일을 닫으면 대화 B 에 영향 없음', () => {
    openFilePreview('/iso', 'a.ts', undefined, {}, 'cA')
    openFilePreview('/iso', 'b.ts', undefined, {}, 'cB')
    closeTab('a.ts', '/iso', 'cA')
    const pB = read('/iso', 'cB')!
    expect(pB.tabs).toEqual(['b.ts'])
    expect(pB.active).toBe('b.ts')
    closeFilePreview('/iso', 'cA')
    closeFilePreview('/iso', 'cB')
  })
})
