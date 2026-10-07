import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useFocusTrap } from './focusTrap.ts'
import { useT } from './settingsStore.ts'
import './attachments.css'

// 이미지 크게 보기 (이슈 #214) — 첨부 칩의 썸네일을 누르면 가림막 위에 원본 크기(창에 맞춰 줄임)로. dsh ui-primitives ImageLightbox 참조:
// Esc·가림막 클릭·닫기 버튼으로 닫고, 닫으면 누른 자리로 포커스가 돌아간다. 가림막·닫기 버튼·Esc·포커스 가두기는 `+` 팝업(PlusDialog)·설정 모달과 같다.
// 그림은 <img> 하나 — 주소는 메인이 준 data: 뿐이다(바깥 요청 0)

interface ImageViewerProps {
  src: string
  name: string
  onClose(): void
}

/** body 에 붙인다(포털) — 입력 카드·말풍선의 겹침 맥락·넘침에 갇히지 않게 */
export function ImageViewer(props: ImageViewerProps) {
  return createPortal(<ImageViewerOverlay {...props} />, document.body)
}

/** 판 자체 (포털 없이 — 단위 테스트가 이 모양을 그린다) */
export function ImageViewerOverlay({ src, name, onClose }: ImageViewerProps) {
  const t = useT()
  const panel = useRef<HTMLDivElement>(null)
  useFocusTrap(panel)
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key !== 'Escape' || event.isComposing) return
      event.preventDefault() // 입력창의 Esc 두 번(답변 중지)은 이미 쓰인 Esc 를 세지 않는다 (stopTurn.tsx)
      onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  return (
    <div className="settings-overlay" role="presentation">
      <div className="settings-mask" aria-hidden="true" onClick={onClose} />
      <div className="image-viewer" ref={panel} role="dialog" aria-modal="true" aria-label={t('attach.viewer', { name })}>
        <img className="image-viewer__image" src={src} alt={name} draggable={false} />
        <div className="image-viewer__bar">
          <span className="image-viewer__name" title={name}>
            {name}
          </span>
          <button type="button" className="settings-close" aria-label={t('settings.close')} onClick={onClose}>
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" aria-hidden="true">
              <path d="M3 3L11 11M11 3L3 11" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  )
}
