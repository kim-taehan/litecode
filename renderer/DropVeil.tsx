import { useT } from './settingsStore.ts'
import './dropVeil.css'

/** 파일을 대화 영역 위로 끄는 동안의 놓을 자리 표시 (이슈 #80, dsh `ui-attachment` 의 안내 막 참조) — 보이기만 한다.
 *  끌기 이벤트를 가로채지 않는다(pointer-events: none): 받기는 창 단위로 듣는 useFileDrop 이 한다 */
export function DropVeil() {
  const t = useT()
  return (
    <div className="drop-veil" role="status">
      <div className="drop-veil__card">
        <svg width="20" height="20" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M8 10.5V3M5 6l3-3 3 3M3 10.5v2a.5.5 0 0 0 .5.5h9a.5.5 0 0 0 .5-.5v-2" />
        </svg>
        <span className="drop-veil__title">{t('attach.drop.title')}</span>
        <span className="drop-veil__hint">{t('attach.drop.hint')}</span>
      </div>
    </div>
  )
}
