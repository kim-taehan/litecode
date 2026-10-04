import { useEffect, useRef, useState } from 'react'

// 첨부 붙여넣기·끌어다 놓기 (이슈 #80, dsh `ui-attachment` 참조 — 창 위로 끌면 안내 막, 받을지는 주인이 정한다).
// 화면은 File 객체를 그대로 preload 에 넘길 뿐 경로도 내용도 읽지 않는다 — 경로는 preload 가 `webUtils.getPathForFile` 로 얻고
// 종류·상한·거절 사유는 메인이 정한다 (src/services/attachments.ts). 여기는 "이것이 파일인가" 판정과 놓을 자리 표시만

/** 끌고 있는 것에 파일이 있나 — 글·링크를 끄는 것은 아니다 (끄는 동안엔 종류 목록만 보인다) */
export function carriesFiles(types: readonly string[]): boolean {
  return types.includes('Files')
}

/** 붙여넣기를 첨부로 받을까 글로 둘까. 파일이 없으면 글(지금처럼). 파일이 있어도 글과 서식(html·rtf)이 같이 있으면 문서 앱에서
 *  복사한 글이다(그 글을 그림으로 본 모양이 파일로 딸려 온다) — 글로 둔다. Finder 에서 복사한 파일은 이름이 글로 같이 오지만 서식은 없다 */
export function pasteIntent(types: readonly string[], fileCount: number): 'attach' | 'text' {
  if (fileCount === 0) return 'text'
  const rich = types.includes('text/html') || types.includes('text/rtf')
  return types.includes('text/plain') && rich ? 'text' : 'attach'
}

/** 끌기가 창 안에 있는 깊이 — dragenter·dragleave 는 자식 요소마다 짝으로 와서 세어야 "창을 떠났다" 를 안다 */
export function dragDepth(depth: number, event: 'enter' | 'leave' | 'drop'): number {
  if (event === 'drop') return 0
  return Math.max(0, depth + (event === 'enter' ? 1 : -1))
}

/** 창 전체의 파일 끌기를 듣는다. 파일을 창 위로 끄는 동안 true 를 주고, zone(CSS 선택자) 안에 놓으면 onFiles 로 넘긴다.
 *  **어디에 놓든 기본 동작을 막는다** — 안 막으면 창이 놓인 파일로 이동한다(설치본은 file:// 출처라 메인의 will-navigate 가 못 거른다).
 *  onFiles 가 없으면(쓸 수 없는 대화) 표시도 받기도 안 하고 막기만 한다 */
export function useFileDrop(zone: string, onFiles: ((files: File[]) => void) | undefined): boolean {
  const [dragging, setDragging] = useState(false)
  const handler = useRef(onFiles)
  handler.current = onFiles
  useEffect(() => {
    let depth = 0
    const inZone = (event: DragEvent): boolean => event.target instanceof Element && !!event.target.closest(zone)
    const files = (event: DragEvent): boolean => !!event.dataTransfer && carriesFiles(event.dataTransfer.types)
    const move = (kind: 'enter' | 'leave' | 'drop') => (event: DragEvent) => {
      if (!files(event)) return
      depth = dragDepth(depth, kind)
      setDragging(depth > 0 && !!handler.current)
    }
    const enter = move('enter')
    const leave = move('leave')
    const end = move('drop')
    function over(event: DragEvent): void {
      if (!files(event)) return
      event.preventDefault()
      event.dataTransfer!.dropEffect = handler.current && inZone(event) ? 'copy' : 'none'
    }
    function drop(event: DragEvent): void {
      if (!files(event)) return
      event.preventDefault()
      end(event)
      const dropped = [...event.dataTransfer!.files]
      if (dropped.length > 0 && inZone(event)) handler.current?.(dropped)
    }
    window.addEventListener('dragenter', enter)
    window.addEventListener('dragleave', leave)
    window.addEventListener('dragover', over)
    window.addEventListener('drop', drop)
    return () => {
      window.removeEventListener('dragenter', enter)
      window.removeEventListener('dragleave', leave)
      window.removeEventListener('dragover', over)
      window.removeEventListener('drop', drop)
    }
  }, [zone])
  return dragging
}
