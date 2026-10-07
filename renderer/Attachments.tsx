import { useCallback, useState } from 'react'
import type { Attachment } from '../shared/ipc.ts'
import { sizeLabel } from './attachmentsView.ts'
import { useAttachmentPreview } from './imagePreview.ts'
import { ImageViewer } from './ImageViewer.tsx'
import { useT } from './settingsStore.ts'
import './attachments.css'

// 첨부 칩 줄 (이슈 #44, 시안 _workspace/mock-plus/Main.dc.html) — 입력 카드의 글 입력칸 위와 내 말풍선 위에 같은 칩을 쓴다.
// 파일 칩: 문서 아이콘 · 이름 · 크기, 이미지 칩: 미리보기(24px 타일) · 이름. onRemove 를 주면 × (입력 카드만).
// 이미지 타일 (이슈 #214): 화면은 파일을 읽지 않는다 — 메인이 칩으로 내준 경로만 data: 주소로 받아(imagePreview.ts) 그 이미지를 타일에 깔고,
// 누르면 크게 보기(ImageViewer). 주소가 없으면(다시 연 대화 등) 전처럼 자리만

/** `+` 메뉴의 "파일 추가" 와 파일 칩이 같이 쓰는 문서 아이콘 */
export const FILE_ICON_PATHS = ['M4 1.75H9.5L12.5 4.75V14.25H4Z', 'M9.5 1.75V4.75H12.5']

export function AttachmentChips({ items, onRemove }: { items: readonly Attachment[]; onRemove?(index: number): void }) {
  const t = useT()
  if (items.length === 0) return null
  return (
    <ul className="attach-chips" aria-label={t('attach.list')}>
      {items.map((item, index) => (
        <li key={index} className={`attach-chip attach-chip--${item.kind}`} data-attach={item.kind} title={item.name}>
          {item.kind === 'image' ? (
            <ImageThumb item={item} />
          ) : (
            <svg className="attach-chip__icon" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              {FILE_ICON_PATHS.map((d) => (
                <path key={d} d={d} />
              ))}
            </svg>
          )}
          <span className="attach-chip__name">{item.name}</span>
          {item.kind !== 'image' && item.size !== undefined && <span className="attach-chip__size">{sizeLabel(item.size)}</span>}
          {onRemove && (
            <button type="button" className="attach-chip__remove" aria-label={t('attach.remove', { name: item.name })} onClick={() => onRemove(index)}>
              <svg width="10" height="10" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
                <path d="M3 3l8 8M11 3l-8 8" />
              </svg>
            </button>
          )}
        </li>
      ))}
    </ul>
  )
}

/** 이미지 칩의 24px 타일 — 미리보기 주소가 있으면 그 이미지(누르면 크게 보기), 없으면 전처럼 자리만 (이슈 #214) */
function ImageThumb({ item }: { item: Attachment & { path?: string } }) {
  const t = useT()
  const url = useAttachmentPreview(item)
  const [open, setOpen] = useState(false)
  const close = useCallback(() => setOpen(false), [])
  if (!url)
    return (
      <span className="attach-chip__thumb" aria-hidden="true">
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
          <path d="M2.5 12l3.5-3.5 2.5 2.5 2-2 3 3" />
        </svg>
      </span>
    )
  return (
    <>
      <button type="button" className="attach-chip__thumb attach-chip__thumb--image" aria-label={t('attach.view', { name: item.name })} title={t('attach.view', { name: item.name })} onClick={() => setOpen(true)}>
        <img src={url} alt="" draggable={false} />
      </button>
      {open && <ImageViewer src={url} name={item.name} onClose={close} />}
    </>
  )
}
