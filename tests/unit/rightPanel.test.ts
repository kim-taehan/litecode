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
