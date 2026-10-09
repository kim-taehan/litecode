import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { translate } from '../../shared/i18n/index.ts'
import type { FeatureId } from '../../shared/ipc.ts'
import { AttachmentChips } from '../../renderer/Attachments.tsx'
import { ImageViewerOverlay } from '../../renderer/ImageViewer.tsx'
import { ImagePreviewBody, PdfNotice } from '../../renderer/FilePreview.tsx'
import { forgetPreviews, previewOf, rememberPreview } from '../../renderer/imagePreview.ts'

// 이미지 보기 (이슈 #214) 의 첫 모양 — 첨부 타일의 썸네일, 크게 보기 판, 오른쪽 패널의 이미지·PDF 본문.
// 미리보기 주소를 받아 오는 IPC(효과)는 renderToStaticMarkup 에서 돌지 않는다 — 캐시를 직접 채워 그린다. 메인 쪽 판정은 imagePreview.test.ts 등
vi.mock('../../renderer/settingsStore.ts', () => ({ useT: () => (key: Parameters<typeof translate>[1], vars?: Record<string, string | number>) => translate('ko', key, vars) }))
const features = vi.hoisted(() => ({ on: new Set<string>() }))
vi.mock('../../renderer/featuresStore.ts', () => ({ useFeatures: () => features.on as ReadonlySet<FeatureId> }))

const URL_A = 'data:image/png;base64,iVBORw0KGgo='
const picked = { kind: 'image' as const, name: 'shot.png', size: 1234, path: '/tmp/x/shot.png' }

beforeEach(() => {
  forgetPreviews()
  features.on = new Set()
})

describe('첨부 칩 — 이미지 썸네일', () => {
  it('주소가 아직 없으면 전처럼 자리만 (그림 아이콘, 누를 것 없음)', () => {
    const html = renderToStaticMarkup(createElement(AttachmentChips, { items: [picked] }))
    expect(html).toContain('class="attach-chip__thumb"')
    expect(html).not.toContain('<img')
    expect(html).not.toContain('크게 보기')
  })

  it('주소가 있으면 24px 타일 안에 그 이미지 — 타일은 크게 보기 버튼', () => {
    rememberPreview(picked, URL_A)
    const html = renderToStaticMarkup(createElement(AttachmentChips, { items: [picked], onRemove: () => {} }))
    expect(html).toMatch(/<button type="button" class="attach-chip__thumb attach-chip__thumb--image" aria-label="shot.png 크게 보기"[^>]*><img src="data:image\/png;base64,iVBORw0KGgo=" alt=""/)
    expect(html).toContain('aria-label="shot.png 빼기"') // × 는 그대로
  })

  it('말풍선 칩(경로 없음)은 보낼 때의 이름·크기로 같은 이미지를 찾는다 — 크기가 없는 칩(다시 연 대화)은 자리만', () => {
    rememberPreview(picked, URL_A)
    const sent = { kind: 'image' as const, name: 'shot.png', size: 1234 }
    expect(renderToStaticMarkup(createElement(AttachmentChips, { items: [sent] }))).toContain(`src="${URL_A}"`)
    const reopened = { kind: 'image' as const, name: 'shot.png' }
    expect(renderToStaticMarkup(createElement(AttachmentChips, { items: [reopened] }))).not.toContain('<img')
  })

  it('글 파일 칩은 썸네일을 찾지 않는다', () => {
    rememberPreview({ kind: 'image', name: 'notes.md', size: 10 }, URL_A)
    const html = renderToStaticMarkup(createElement(AttachmentChips, { items: [{ kind: 'file', name: 'notes.md', size: 10 }] }))
    expect(html).not.toContain('<img')
  })

  it('캐시는 오래된 것부터 버린다 (상한)', () => {
    for (let index = 0; index < 100; index++) rememberPreview({ kind: 'image', name: `${index}.png`, size: index }, URL_A)
    expect(previewOf({ kind: 'image', name: '0.png', size: 0 })).toBeUndefined()
    expect(previewOf({ kind: 'image', name: '99.png', size: 99 })).toBe(URL_A)
  })
})

describe('크게 보기 판', () => {
  it('가림막 위 aria-modal 판 — 이미지(<img>, 대체 글 = 이름)·이름·닫기', () => {
    const html = renderToStaticMarkup(createElement(ImageViewerOverlay, { src: URL_A, name: 'shot.png', onClose: () => {} }))
    expect(html).toContain('class="settings-overlay"')
    expect(html).toContain('class="settings-mask"')
    expect(html).toMatch(/role="dialog" aria-modal="true" aria-label="이미지 shot.png"/)
    expect(html).toContain(`<img class="image-viewer__image" src="${URL_A}" alt="shot.png"`)
    expect(html).toContain('>shot.png<')
    expect(html).toContain('aria-label="닫기"')
  })
})

describe('오른쪽 패널 — 이미지·PDF 본문', () => {
  it('이미지는 <img> 하나로 (svg 도 인라인으로 넣지 않는다)', () => {
    const svg = 'data:image/svg+xml;base64,PHN2Zy8+'
    const html = renderToStaticMarkup(createElement(ImagePreviewBody, { src: svg, path: 'img/logo.svg' }))
    expect(html).toContain(`<img src="${svg}" alt="img/logo.svg"`)
    expect(html).not.toContain('<svg')
  })

  it('PDF — 이 패널에서 미리보지 않는다는 안내 + (다른 앱에서 열기 기능이 켜졌으면) 기본 앱에서 열기', () => {
    features.on = new Set(['openIn'])
    const html = renderToStaticMarkup(createElement(PdfNotice, { directory: '/p', token: 'doc.pdf', size: 2048 }))
    expect(html).toContain('PDF 는 이 패널에서 미리보지 않습니다 (2.0 KB)')
    expect(html).toContain('>기본 앱에서 열기<')
  })

  it('PDF — 다른 앱에서 열기 기능이 꺼졌으면 안내만', () => {
    const html = renderToStaticMarkup(createElement(PdfNotice, { directory: '/p', token: 'doc.pdf', size: 2048 }))
    expect(html).toContain('PDF 는 이 패널에서 미리보지 않습니다')
    expect(html).not.toContain('<button')
  })
})
