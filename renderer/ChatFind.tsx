import { createContext, useContext, useEffect, useRef, useState, type RefObject } from 'react'
import { FIND_LIMIT, findCount, findInChunks, stepIndex } from './findView.ts'
import { useT } from './settingsStore.ts'
import './find.css'

// 대화 안 찾기 (이슈 #79) — ⌘F / Ctrl+F 로 대화 칸 오른쪽 위에 작은 찾기 줄. Enter 다음, Shift+Enter 이전, Esc 닫기.
// 화면이 직접 찾는다: 대화 칸의 글자 노드를 훑어 일치 자리(findView.ts)를 Range 로 만들고 CSS Custom Highlight API 로 칠한다
// (Electron 33 = Chromium 130). DOM 을 고치지 않으므로 React 가 그린 것과 부딪히지 않고, 찾기 줄 자신의 입력 글은 대상이 아니다
// (메인의 webContents.findInPage 는 페이지 전체가 대상이라 찾기 줄·사이드바·입력창까지 센다).
// 대상: 내 말·답(.bubble)과 작업 줄(.turn__work). 접힌 작업 줄은 평소엔 그리지 않지만 찾는 동안에는 숨긴 채(hidden) 그려 두고
// (useFindFold), 지금 일치가 그 안에 있으면 펼친다 — dsh ui-chat 의 hidden="until-found" + beforematch 와 같은 동작을 직접 한다

/** 찾는 중인가 (찾기 줄이 열려 있고 찾는 말이 있다) — 접힌 칸이 숨긴 채 그려 둘지를 정한다 */
const FindingContext = createContext(false)
export const FindingProvider = FindingContext.Provider

const REVEAL = 'litecode-find-reveal'
const FOLD = '[data-find-fold][hidden]'
/** 찾을 곳 — 내 말·답, 작업 줄 */
const SCOPE = '.bubble, .turn__work'
/** 글이 아닌 부품 — 코드 블록 머리(언어 이름·버튼) */
const SKIP = '.md-code__head'
/** 한 문단으로 볼 조상 — 일치는 문단을 넘지 않는다 */
const BLOCK = 'p, li, pre, td, th, h1, h2, h3, h4, h5, h6, blockquote, button, div'
const ALL = 'litecode-find'
const CURRENT = 'litecode-find-current'

/**
 * 접히는 칸(작업 줄 묶음·줄의 본문)이 쓴다. open 이 아니어도 찾는 중이면 mounted — fold 를 그 칸에 펼쳐 넣으면 숨긴 채 DOM 에 있다.
 * 찾기가 그 안의 일치로 가면 reveal 을 부른다 (그 칸을 펼치는 함수 — 펼친 채로 남는다)
 */
export function useFindFold(open: boolean, reveal: () => void) {
  const finding = useContext(FindingContext)
  const ref = useRef<HTMLDivElement>(null)
  const latest = useRef(reveal)
  latest.current = reveal
  const mounted = open || finding
  useEffect(() => {
    const element = ref.current
    if (!element) return
    const onReveal = () => latest.current()
    element.addEventListener(REVEAL, onReveal)
    return () => element.removeEventListener(REVEAL, onReveal)
  }, [mounted])
  return { mounted, fold: { ref, hidden: !open, 'data-find-fold': '' } as const }
}

/** 대화 칸의 글에서 일치 자리를 Range 로 — 문단(가장 가까운 BLOCK 조상)마다 글자 노드를 이어 찾는다. 상한(FIND_LIMIT)에 닿으면 capped */
function collectRanges(root: HTMLElement, query: string): { ranges: Range[]; capped: boolean } {
  const groups: Text[][] = []
  let block: Element | null = null
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const parent = node.parentElement
    if (!parent?.closest(SCOPE) || parent.closest(SKIP)) continue
    const own = parent.closest(BLOCK)
    if (groups.length === 0 || own !== block) groups.push([])
    block = own
    groups.at(-1)!.push(node as Text)
  }
  const ranges: Range[] = []
  for (const group of groups) {
    for (const match of findInChunks(group.map((node) => node.data), query)) {
      if (ranges.length === FIND_LIMIT) return { ranges, capped: true }
      const range = document.createRange()
      range.setStart(group[match.start.chunk]!, match.start.offset)
      range.setEnd(group[match.end.chunk]!, match.end.offset)
      ranges.push(range)
    }
  }
  return { ranges, capped: false }
}

/** 숨긴 칸 안의 글은 크기가 없다 */
const isShown = (rect: DOMRect) => rect.width > 0 || rect.height > 0

/** 새로 찾기 시작할 자리 — 지금 보이는 곳부터 (긴 대화의 맨 아래에서 찾아도 맨 위로 끌려가지 않게). 없으면 처음 */
function firstInView(ranges: Range[], root: HTMLElement): number {
  const top = root.getBoundingClientRect().top
  return Math.max(
    0,
    ranges.findIndex((range) => {
      const rect = range.getBoundingClientRect()
      return isShown(rect) && rect.bottom > top
    }),
  )
}

function clearHighlights(): void {
  CSS.highlights.delete(ALL)
  CSS.highlights.delete(CURRENT)
}

interface ChatFindProps {
  /** 대화 스크롤 칸 (.main__messages) */
  scroller: RefObject<HTMLElement | null>
  /** 찾는 중인지 알린다 — App 이 FindingProvider 로 턴에 내려 준다 */
  onFinding(finding: boolean): void
}

/** 찾기 줄 — 대화 칸(.chat-pane) 안에 둔다. 대화를 바꾸면 닫히게 App 이 대화 id 를 key 로 준다 */
export function ChatFind({ scroller, onFinding }: ChatFindProps) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  const [count, setCount] = useState({ total: 0, capped: false })
  /** ⌘F 를 다시 누르면 입력칸으로 돌아가 글을 고른다 */
  const [focusTick, setFocusTick] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  /** 열기 전에 포커스가 있던 곳 — 닫으면 돌려준다 */
  const returnTo = useRef<Element | null>(null)
  const ranges = useRef<Range[]>([])
  const indexRef = useRef(0)
  /** 지금 일치로 가야 한다 (찾는 말이 바뀜·다음·이전) — 접힌 칸을 펼치고, 보이게 되면 그 자리로 옮긴다. 내용만 바뀐 다시 찾기는 안 옮긴다 */
  const wantScroll = useRef(false)
  const finding = open && query.trim() !== ''

  /** 지금 일치를 바꿔 칠하고, 가야 하면 펼치고 옮긴다 */
  function show(next: number): void {
    indexRef.current = next
    setIndex(next)
    const range = ranges.current[next]
    if (!range) return void CSS.highlights.delete(CURRENT)
    const current = new Highlight(range)
    current.priority = 1 // 다른 일치의 칠 위에
    CSS.highlights.set(CURRENT, current)
    if (!wantScroll.current) return
    // 접힌 칸 안이면 펼친다 — 다시 그려지면(hidden 이 빠지면) 아래 MutationObserver 가 다시 불러 그때 옮긴다
    for (let fold = range.startContainer.parentElement?.closest(FOLD); fold; fold = fold.parentElement?.closest(FOLD)) fold.dispatchEvent(new Event(REVEAL))
    const root = scroller.current
    const rect = range.getBoundingClientRect()
    if (!root || !isShown(rect)) return
    wantScroll.current = false
    const box = root.getBoundingClientRect()
    // 찾기 줄(위 48px)에 가리지 않게. 이미 보이면 그대로 둔다
    if (rect.top < box.top + 48 || rect.bottom > box.bottom - 24) root.scrollTop += rect.top - box.top - box.height / 3
  }

  function move(delta: number): void {
    if (ranges.current.length === 0) return
    wantScroll.current = true
    show(stepIndex(indexRef.current, ranges.current.length, delta))
  }

  function close(): void {
    setOpen(false)
    if (returnTo.current instanceof HTMLElement && returnTo.current.isConnected) returnTo.current.focus()
  }

  // ⌘F / Ctrl+F — 터미널 칸(xterm)·입력창이 키를 먹기 전에. 설정 같은 모달이 떠 있으면 건드리지 않는다
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      const command = navigator.platform.startsWith('Mac') ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey
      // 한글 자판에서는 key 가 'ㄹ' 로 온다
      if (!command || event.shiftKey || event.altKey || !['f', 'F', 'ㄹ'].includes(event.key)) return
      if (document.querySelector('[aria-modal="true"]')) return
      event.preventDefault()
      event.stopPropagation()
      if (!inputRef.current) returnTo.current = document.activeElement
      setOpen(true)
      setFocusTick((tick) => tick + 1)
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [])

  useEffect(() => {
    if (!open) return
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [open, focusTick])

  useEffect(() => {
    onFinding(finding)
    return () => onFinding(false)
  }, [finding])

  // 찾기 — 찾는 말이 바뀌면 처음부터, 대화 내용이 바뀌면(답이 오는 중·칸이 펼쳐짐) 순번을 지키며 다시
  useEffect(() => {
    const root = scroller.current
    if (!finding || !root) return
    function refresh(fresh: boolean): void {
      const previous = ranges.current[indexRef.current]
      const found = collectRanges(root!, query)
      ranges.current = found.ranges
      if (found.ranges.length > 0) CSS.highlights.set(ALL, new Highlight(...found.ranges))
      else CSS.highlights.delete(ALL)
      setCount((now) => (now.total === found.ranges.length && now.capped === found.capped ? now : { total: found.ranges.length, capped: found.capped }))
      if (fresh) return show(firstInView(found.ranges, root!))
      // 같은 자리의 일치를 지킨다 — 앞에 일치가 새로 생겨도(접힌 칸이 숨긴 채 그려짐) 지금 일치가 다른 것으로 넘어가지 않게
      const same = previous ? found.ranges.findIndex((range) => range.startContainer === previous.startContainer && range.startOffset === previous.startOffset) : -1
      show(same !== -1 ? same : Math.min(indexRef.current, Math.max(0, found.ranges.length - 1)))
    }
    wantScroll.current = true
    refresh(true)
    let frame = 0
    const observer = new MutationObserver(() => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => refresh(false))
    })
    observer.observe(root, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['hidden'] })
    return () => {
      observer.disconnect()
      cancelAnimationFrame(frame)
      ranges.current = []
      clearHighlights()
      setCount((now) => (now.total === 0 ? now : { total: 0, capped: false }))
    }
  }, [finding, query])

  if (!open) return null
  return (
    <div className="chat-find" role="search" aria-label={t('find.label')}>
      <input
        ref={inputRef}
        className="chat-find__input"
        aria-label={t('find.label')}
        placeholder={t('find.placeholder')}
        value={query}
        spellCheck={false}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing || event.keyCode === 229) return // 한글 조합 확정 Enter
          if (event.key === 'Enter') {
            event.preventDefault()
            move(event.shiftKey ? -1 : 1)
          }
          if (event.key === 'Escape') {
            event.preventDefault() // Esc 두 번(답변 중지)에 세지 않게 (stopTurn.tsx)
            close()
          }
        }}
      />
      <span className="chat-find__count" aria-live="polite">
        {finding ? findCount(index, count.total, count.capped) : ''}
      </span>
      <button type="button" className="chat-find__button" aria-label={t('find.previous')} title={t('find.previous')} disabled={count.total === 0} onClick={() => move(-1)}>
        <FindIcon d="M4 10L8 6L12 10" />
      </button>
      <button type="button" className="chat-find__button" aria-label={t('find.next')} title={t('find.next')} disabled={count.total === 0} onClick={() => move(1)}>
        <FindIcon d="M4 6L8 10L12 6" />
      </button>
      <button type="button" className="chat-find__button" aria-label={t('find.close')} title={t('find.close')} onClick={close}>
        <FindIcon d="M4 4L12 12M12 4L4 12" />
      </button>
    </div>
  )
}

function FindIcon({ d }: { d: string }) {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  )
}
