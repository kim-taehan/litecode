import { describe, expect, it } from 'vitest'
import {
  closeFilePreview,
  closeTab,
  openFilePreview,
  openFilesTab,
  revealPanel,
  selectTab,
  tabKey,
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

// 이슈 #51 — AI 의 open_file 이 줄을 주면 그 탭을 그 줄로. 화면 계산은 순수 함수(lineJump)
describe('줄 이동', () => {
  it('저장소: 줄을 주고 열면 그 탭에 jump 가 남고, 같은 줄을 다시 열어도 다시 간다(seq), 줄 없이 다시 열면 지워진다', () => {
    openFilePreview('/jump', 'a.ts', 12)
    const first = read()!
    expect(first).toMatchObject({ active: 'a.ts', jump: { key: 'a.ts', line: 12, seq: first.focus } })
    openFilePreview('/jump', './a.ts', 12)
    expect(read()!.jump).toEqual({ key: 'a.ts', line: 12, seq: first.focus + 1 })
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
