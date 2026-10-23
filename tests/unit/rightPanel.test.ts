import { describe, expect, it } from 'vitest'
import {
  GIT_TAB,
  closeFilePreview,
  closeTab,
  compareCandidates,
  cycleTerminalTab,
  exitCompare,
  isFileTab,
  isTerminalTab,
  openFilePreview,
  openFilesTab,
  openTerminalTab,
  startCompare,
  panelTakesFocus,
  requestFilesSearch,
  revealPanel,
  selectTab,
  tabKey,
  terminalIdOf,
  terminalTabKey,
  toggleFullscreen,
  getPanelState,
} from '../../renderer/filePreviewStore.ts'
import { buildHtmlDocument, HTML_PREVIEW_CSP } from '../../renderer/htmlPreview.ts'
import { kindOf } from '../../renderer/FilePreview.tsx'
import { lineJump } from '../../renderer/lineJump.ts'

// 오른쪽 패널(이슈 #29) — 탭 저장소의 규칙(같은 파일 한 탭, 닫으면 이웃, 닫아도 탭 유지, 다른 프로젝트면 새로)과 HTML 미리보기 문서의 격리 정책

const read = getPanelState

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
    expect(read()).toMatchObject({ directory: '/p', open: true, tabs: ['a.ts', 'b.ts', 'c.ts'], active: 'c.ts' })
    selectTab('b.ts')
    closeTab('b.ts')
    expect(read()).toMatchObject({ tabs: ['a.ts', 'c.ts'], active: 'c.ts' })
    closeTab('c.ts')
    expect(read()).toMatchObject({ tabs: ['a.ts'], active: 'a.ts' })
    closeTab('a.ts')
    expect(read()).toMatchObject({ tabs: [], active: undefined })
  })

  it('닫아도 탭은 남아 다시 열면 그대로, 전체 화면은 풀린다. "+" 는 파일 탭으로. 다른 프로젝트면 새로', () => {
    openFilePreview('/p', 'a.ts')
    toggleFullscreen()
    expect(read()?.fullscreen).toBe(true)
    closeFilePreview()
    expect(read()).toMatchObject({ open: false, fullscreen: false, tabs: ['a.ts'], active: 'a.ts' })
    revealPanel('/p')
    expect(read()).toMatchObject({ open: true, tabs: ['a.ts'], active: 'a.ts' })
    openFilesTab('/p')
    expect(read()).toMatchObject({ tabs: ['a.ts'], active: undefined })
    openFilePreview('/q', 'z.ts')
    expect(read()).toMatchObject({ directory: '/q', tabs: ['z.ts'], active: 'z.ts', fullscreen: false })
  })
})

// 감사 E4 — AI 의 open_file 은 탭만 열고 고른다. 치던 입력창의 포커스는 가져가지 않는다 (open_terminal 의 quiet 와 같게)
describe('조용히 열기 (AI 의 open_file)', () => {
  it('quiet 로 열면 탭은 열리고 골라지지만 focus 는 오르지 않고, 패널은 포커스를 잡지 않는다 — 닫혀 있던 패널이 새로 뜰 때도', () => {
    openFilePreview('/quiet', 'a.ts', undefined, { quiet: true })
    const opened = read()!
    expect(opened).toMatchObject({ open: true, tabs: ['a.ts'], active: 'a.ts', focus: 0 })
    expect(panelTakesFocus(opened)).toBe(false)
    closeFilePreview()
  })

  it('사용자가 연 뒤(칩·Files 버튼·머리 버튼)에는 다시 포커스를 잡는다', () => {
    openFilePreview('/quiet2', 'a.ts')
    const byUser = read()!
    expect(panelTakesFocus(byUser)).toBe(true)
    openFilePreview('/quiet2', 'b.ts', undefined, { quiet: true })
    expect(read()).toMatchObject({ active: 'b.ts', focus: byUser.focus })
    expect(panelTakesFocus(read()!)).toBe(false)
    openFilePreview('/quiet2', 'a.ts')
    expect(read()!.focus).toBe(byUser.focus + 1)
    expect(panelTakesFocus(read()!)).toBe(true)
    openFilePreview('/quiet2', 'b.ts', undefined, { quiet: true })
    openFilesTab('/quiet2')
    expect(panelTakesFocus(read()!)).toBe(true)
    openFilePreview('/quiet2', 'b.ts', undefined, { quiet: true })
    closeFilePreview()
    revealPanel('/quiet2')
    expect(panelTakesFocus(read()!)).toBe(true)
    closeFilePreview()
  })

  it('quiet 로 같은 줄을 다시 열어도 다시 간다 — 줄 이동의 seq 는 focus 와 따로 오른다', () => {
    openFilePreview('/quiet3', 'a.ts', 7, { quiet: true })
    const first = read()!.jump!
    openFilePreview('/quiet3', 'a.ts', 7, { quiet: true })
    expect(read()!.jump).toEqual({ key: 'a.ts', line: 7, seq: first.seq + 1 })
    closeFilePreview()
  })
})

// 이슈 #51 — AI 의 open_file 이 줄을 주면 그 탭을 그 줄로. 화면 계산은 순수 함수(lineJump)
describe('줄 이동', () => {
  it('저장소: 줄을 주고 열면 그 탭에 jump 가 남고, 같은 줄을 다시 열어도 다시 간다(seq), 줄 없이 다시 열면 지워진다', () => {
    openFilePreview('/jump', 'a.ts', 12)
    const first = read()!
    expect(first).toMatchObject({ active: 'a.ts', jump: { key: 'a.ts', line: 12 } })
    openFilePreview('/jump', './a.ts', 12)
    expect(read()!.jump).toEqual({ key: 'a.ts', line: 12, seq: first.jump!.seq + 1 })
    openFilePreview('/jump', 'b.ts')
    expect(read()).toMatchObject({ active: 'b.ts', tabs: ['a.ts', 'b.ts'], jump: { key: 'a.ts', line: 12 } }) // 다른 탭을 열어도 a.ts 의 줄은 남는다
    openFilePreview('/jump', 'a.ts')
    expect(read()!.jump).toBeUndefined()
    closeFilePreview()
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
    expect(read()).toMatchObject({ directory: '/term', open: true, tabs: ['a.ts', term(1), term(2)], active: term(2) })
    closeTab(term(2))
    expect(read()).toMatchObject({ tabs: ['a.ts', term(1)], active: term(1) })
    closeTab(term(1))
    expect(read()).toMatchObject({ tabs: ['a.ts'], active: 'a.ts' })
  })

  it('다른 프로젝트면 새로 — 다른 프로젝트의 탭은 건너가지 않는다 (떠나는 프로젝트의 셸 끝내는 것은 앱이 한다 — App.tsx)', () => {
    openTerminalTab('/term-a', 1)
    openTerminalTab('/term-b', 1)
    expect(read()).toMatchObject({ directory: '/term-b', tabs: [term(1)], active: term(1) })
    openFilePreview('/term-a', 'a.ts')
    expect(read()).toMatchObject({ directory: '/term-a', tabs: ['a.ts'] })
  })

  it('quiet 로 열면(AI open(터미널)) focus 를 올리지 않는다 — 탭을 직접 고르면 풀린다', () => {
    openTerminalTab('/term-q', 1)
    const before = read()!.focus
    openTerminalTab('/term-q', 2, { quiet: true })
    expect(read()).toMatchObject({ active: term(2), quiet: true })
    expect(read()!.focus).toBe(before)
    expect(panelTakesFocus(read()!)).toBe(false)
    selectTab(term(1))
    expect(read()!.quiet).toBe(false)
    expect(read()!.active).toBe(term(1))
    expect(panelTakesFocus(read()!)).toBe(true)
  })

  it('cycleTerminalTab — ⌘[·⌘] 의 이전·다음(순환). 고른 것이 없으면 마지막, 하나 없으면 false', () => {
    openFilePreview('/term-c', 'a.ts')
    expect(cycleTerminalTab('/term-c', 1)).toBe(false)
    openTerminalTab('/term-c', 1)
    openTerminalTab('/term-c', 2)
    openTerminalTab('/term-c', 3)
    selectTab(undefined)
    expect(cycleTerminalTab('/term-c', 1)).toBe(true)
    expect(read()!.active).toBe(term(3)) // 고른 터미널이 없으면 마지막 연 것
    expect(cycleTerminalTab('/term-c', 1)).toBe(true)
    expect(read()!.active).toBe(term(1)) // 다음(순환)
    expect(cycleTerminalTab('/term-c', -1)).toBe(true)
    expect(read()!.active).toBe(term(3)) // 이전
    expect(cycleTerminalTab('/term-c', -1)).toBe(true)
    expect(read()!.active).toBe(term(2))
    closeFilePreview()
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
    expect(compareCandidates(read()!.tabs, 'a.ts')).toEqual(['b.ts'])
    expect(compareCandidates(read()!.tabs, 'b.ts')).toEqual(['a.ts'])
  })

  it('startCompare — 위( a )는 고른 탭, 아래( b )는 후보, active 는 위 탭', () => {
    openFilePreview('/cmp', 'x.ts')
    openFilePreview('/cmp', 'y.ts')
    startCompare('/cmp', 'y.ts', 'x.ts')
    expect(read()).toMatchObject({ compare: { a: 'y.ts', b: 'x.ts' }, active: 'y.ts' })
  })

  it('잘못된 startCompare 는 아무 일도 없다 — 같은 탭·비파일 탭·안 연 탭·다른 프로젝트', () => {
    startCompare('/cmp', 'y.ts', 'y.ts')
    startCompare('/cmp', 'y.ts', term(1))
    startCompare('/cmp', 'y.ts', 'gone.ts')
    startCompare('/other', 'y.ts', 'x.ts')
    expect(read()!.compare).toEqual({ a: 'y.ts', b: 'x.ts' })
    expect(read()!.active).toBe('y.ts')
  })

  it('다른 탭을 고르면 비교가 끝난다 — 위 탭(a) 을 재고르면 그대로', () => {
    selectTab('x.ts')
    expect(read()).toMatchObject({ compare: undefined, active: 'x.ts' })
    startCompare('/cmp', 'y.ts', 'x.ts')
    selectTab('y.ts')
    expect(read()!.compare).toEqual({ a: 'y.ts', b: 'x.ts' })
  })

  it('비교 중 다른 파일을 열면 끝난다 — 위 탭(a) 을 여는 것만 예외', () => {
    openFilePreview('/cmp', 'y.ts')
    expect(read()!.compare).toEqual({ a: 'y.ts', b: 'x.ts' })
    openFilePreview('/cmp', 'a.ts')
    expect(read()).toMatchObject({ compare: undefined, active: 'a.ts' })
  })

  it('비교 탭을 닫으면 끝난다 (active 는 이웃)', () => {
    startCompare('/cmp', 'a.ts', 'y.ts')
    closeTab('y.ts')
    expect(read()!.compare).toBeUndefined()
  })

  it('exitCompare — 비교가 없으면 아무 일도 없다. 프로젝트를 옮기면 compare 도 초기화', () => {
    expect(read()!.compare).toBeUndefined()
    exitCompare()
    expect(read()!.compare).toBeUndefined()
    startCompare('/cmp', 'a.ts', 'x.ts')
    openFilePreview('/cmp2', 'p.ts')
    expect(read()!.compare).toBeUndefined()
    expect(read()!.directory).toBe('/cmp2')
  })
})

// 파일 찾기 (이슈 #528) — ⌘P: Files 탭으로 열고 filesSearch seq 를 올린다. 원샷 리스너가 아니라 seq 인 이유:
// 패널이 닫혀 있을 때(FilesView 미마운트) 요청이 통째로 손실됐고, 닫히면 seq 를 비워 버튼·⌘B 로 다시 열 때는
// ⌘P 신호가 아닌 걸로 만든다 (filesSearch prop 으로 받는 쪽은 FilePreview.tsx FilesView)
describe('파일 찾기 (⌘P, issue #528)', () => {
  it('requestFilesSearch — Files 탭으로 열고, seq 와 포커스를 올리고 quiet 가 아니다', () => {
    requestFilesSearch('/fs')
    expect(read()).toMatchObject({ directory: '/fs', open: true, active: undefined, filesSearch: 1, quiet: false, focus: 1 })
    expect(panelTakesFocus(read()!)).toBe(true)
    requestFilesSearch('/fs')
    expect(read()!.filesSearch).toBe(2)
    expect(read()!.focus).toBe(2)
  })

  it('닫으면 seq 가 비워진다 — 다시 열 때(버튼·⌘B) 는 포커스 신호가 아니다, ⌘P 가 또 오면 다시 1 부터', () => {
    requestFilesSearch('/fs2')
    expect(read()!.filesSearch).toBe(1)
    closeFilePreview()
    expect(read()!.filesSearch).toBeUndefined()
    revealPanel('/fs2')
    expect(read()).toMatchObject({ open: true, filesSearch: undefined })
    requestFilesSearch('/fs2')
    expect(read()!.filesSearch).toBe(1)
  })

  it('"+"(openFilesTab) 과 파일·Git 탭은 seq 를 올리지 않는다 — Files 탭을 여는 것만은 ⌘P 가 아니다', () => {
    openFilesTab('/fs3')
    expect(read()).toMatchObject({ open: true, active: undefined })
    expect(read()!.filesSearch).toBeUndefined()
    openFilePreview('/fs3', 'a.ts')
    expect(read()!.filesSearch).toBeUndefined()
  })
})
