import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { Markdown } from '../../renderer/Markdown.tsx'
import { translate } from '../../shared/i18n/index.ts'
import { isWebUrl } from '../../shared/webUrl.ts'

// 화면 설정 저장소는 메인에서 값을 받아야 해서 여기선 한국어 사전으로 바로 번역한다
vi.mock('../../renderer/settingsStore.ts', () => ({ useT: () => (key: Parameters<typeof translate>[1], vars?: Record<string, string | number>) => translate('ko', key, vars) }))

// 답 말풍선 마크다운 — mdast → React 요소. 원문 HTML 은 DOM 에 들어가지 않고 글자로만 보인다 (dsh ui-primitives markdown 방식).
const html = (text: string) => renderToStaticMarkup(createElement(Markdown, { text }))

describe('Markdown', () => {
  it('제목·굵게·목록·가로줄·인라인 코드가 요소로 나온다', () => {
    const out = html('## 요약\n\n**굵게** 와 `code`\n\n- 하나\n- 둘\n\n1. 첫째\n\n---\n\n> 인용')
    expect(out).toContain('<h2>요약</h2>')
    expect(out).toContain('<strong>굵게</strong>')
    expect(out).toContain('<code>code</code>')
    expect(out).toMatch(/<ul><li>하나<\/li><li>둘<\/li><\/ul>/)
    expect(out).toContain('<ol><li>첫째</li></ol>')
    expect(out).toContain('<hr/>')
    expect(out).toContain('<blockquote><p>인용</p></blockquote>')
  })

  it('한글 + 문장부호 옆 굵게도 닫힌다 (CommonMark 만으로는 ** 가 글자로 남는다)', () => {
    expect(html('**프로젝트명:**라이트코드')).toContain('<strong>프로젝트명:</strong>라이트코드')
    expect(html('**목표:**폐쇄망 원클릭')).toContain('<strong>목표:</strong>폐쇄망 원클릭')
    expect(html('이것은**"인용"**입니다')).toContain('<strong>&quot;인용&quot;</strong>입니다')
    // 영어 문장의 일반 규칙은 그대로
    expect(html('a **b** c')).toContain('a <strong>b</strong> c')
    expect(html('2*3*4')).toContain('2<em>3</em>4')
  })

  it('표·체크박스·취소선(GFM) 이 요소로 나온다', () => {
    const out = html('| 이름 | 값 |\n|:--|--:|\n| a | 1 |\n\n- [x] 끝\n- [ ] 남음\n\n~~취소~~')
    expect(out).toContain('<table>')
    expect(out).toContain('<th style="text-align:left">이름</th>')
    expect(out).toContain('<td style="text-align:right">1</td>')
    expect(out).toMatch(/<input type="checkbox" disabled="" checked=""\/>끝/)
    expect(out).toMatch(/<input type="checkbox" disabled=""\/>남음/)
    expect(out).toContain('<del>취소</del>')
  })

  it('코드 블록은 머리(언어) + 아이콘 버튼 둘(줄바꿈·복사) + 고정폭 본문이다. 줄바꿈은 켠 채로 시작한다', () => {
    const out = html('```ts\nconst a = 1 < 2\n```')
    expect(out).toContain('<span class="md-code__lang">ts</span>')
    expect(out).toContain('aria-label="복사"')
    expect(out).toMatch(/aria-pressed="true" aria-label="줄바꿈 끄기"/)
    expect(out).toContain('data-wrap="true"')
    expect(out).toContain('<pre><code>const a = 1 &lt; 2</code></pre>')
    // 언어가 없으면 머리에 "코드 블록"
    expect(html('```\nplain\n```')).toContain('<span class="md-code__lang">코드 블록</span>')
  })

  it('원문 HTML 은 요소가 아니라 글자로 보인다', () => {
    const out = html('앞 <script>window.__pwned=1</script> 뒤\n\n<img src=x onerror="window.__pwned=2">\n\n<b>굵게?</b>')
    expect(out).not.toMatch(/<script|<img|<b>/)
    // 문단 안의 태그는 조각마다 글자 — 보이는 글자로는 원문 그대로
    expect(out.replace(/<[^>]+>/g, '')).toContain('앞 &lt;script&gt;window.__pwned=1&lt;/script&gt; 뒤')
    expect(out).toContain('&lt;img src=x onerror=&quot;window.__pwned=2&quot;&gt;')
  })

  it('링크는 http(s) 만 a 로, 그 밖(javascript:·file:·상대 경로)은 글자로', () => {
    expect(html('[문서](https://example.com/doc)')).toContain('<a href="https://example.com/doc" title="https://example.com/doc">문서</a>')
    expect(html('주소 https://example.com/x 끝')).toContain('<a href="https://example.com/x"')
    for (const bad of ['javascript:alert(1)', 'file:///etc/passwd', './a.md', 'mailto:a@b.c']) {
      const out = html(`[누름](${bad})`)
      expect(out, bad).not.toContain('<a')
      expect(out, bad).toContain('누름')
    }
  })

  it('이미지는 불러오지 않고 대체 글자만 보인다 (원격 이미지 차단)', () => {
    const out = html('![로고](https://example.com/logo.png) ![로컬](./a.png)')
    expect(out).not.toContain('<img')
    expect(out).toContain('로고')
    expect(out).toContain('로컬')
  })

  it('빈 줄이 여러 개 이어져도 문단 사이는 하나다 (text 조각 이어 붙이기의 빈 줄)', () => {
    // 사이의 \n 은 화면에선 접히고 textContent 에만 남는다
    expect(html('\n\n첫 문단\n\n\n\n\n\n둘째 문단\n\n')).toBe('<div class="md"><p>첫 문단</p>\n<p>둘째 문단</p></div>')
  })

  it('빈 답은 빈 껍데기', () => {
    expect(html('')).toBe('<div class="md"></div>')
  })
})

describe('isWebUrl', () => {
  it('절대 http(s) 만 참', () => {
    expect(isWebUrl('https://example.com/a?b=1')).toBe(true)
    expect(isWebUrl('http://127.0.0.1:8080')).toBe(true)
    for (const bad of ['javascript:alert(1)', 'file:///etc/passwd', 'mailto:a@b.c', '/abs', 'example.com', '', 'data:text/html,x']) {
      expect(isWebUrl(bad), bad).toBe(false)
    }
  })
})
