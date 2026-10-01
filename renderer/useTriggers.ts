import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import type { TriggerQuery, TriggerResult } from '../shared/ipc.ts'

// 입력창 트리거의 화면 쪽 — 어떤 문자가 트리거인지 모르고, 입력·캐럿이 바뀔 때마다 메인(ctx.triggers)에 "이 입력의 후보" 를 묻는다.
// 상호작용은 dsh ui-input-trigger 를 따른다: 포커스는 입력창에 남고(aria-activedescendant) ↑↓ 이동, Enter·Tab 고르기, 폴더는 Tab 으로
// 들어가기, Esc 는 닫기(쓰던 글은 그대로). 같은 자리·같은 질의로 닫은 메뉴는 다시 열지 않는다. 늦게 온 응답은 세대 번호로 버리고,
// 한글 조합 중에는 묻지 않는다 (조합이 끝나면 묻는다).

export interface TriggerOptions {
  /** 프로젝트 폴더 — 없으면 묻지 않는다 */
  directory?: string
  draft: string
  setDraft(text: string): void
  /** `/` 명령: text 를 보내고 말풍선엔 display */
  onSend(text: string, display: string): void
  /** `!`: 그 폴더 터미널 칸을 편다 */
  onShell(directory: string): void
}

export interface Triggers {
  inputRef: React.RefObject<HTMLTextAreaElement | null>
  /** 입력창에 붙일 것 */
  inputProps: {
    onSelect(event: React.SyntheticEvent<HTMLTextAreaElement>): void
    onCompositionStart(): void
    onCompositionEnd(event: React.CompositionEvent<HTMLTextAreaElement>): void
    'aria-activedescendant'?: string
  }
  query: TriggerQuery | null
  /** 메뉴가 열려 있다 (후보가 있고 닫지 않았다) */
  open: boolean
  active: number
  notice?: string
  setActive(index: number): void
  /** 메뉴가 쓴 키면 true — 입력창은 그 키를 더 다루지 않는다 */
  onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): boolean
  choose(index: number, action: 'pick' | 'drill'): void
  dismiss(): void
  /** Enter 로 입력 전체를 낸다 — 트리거가 다뤘으면 true, 아니면 평범하게 보낸다 */
  submit(): Promise<boolean>
}

export const optionId = (index: number) => `trigger-option-${index}`

export function useTriggers({ directory, draft, setDraft, onSend, onShell }: TriggerOptions): Triggers {
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const [caret, setCaret] = useState(0)
  const [query, setQuery] = useState<TriggerQuery | null>(null)
  const [active, setActive] = useState(0)
  const [notice, setNotice] = useState<string>()
  const [dismissed, setDismissed] = useState<string>()
  const [composing, setComposing] = useState(false)
  const generation = useRef(0)
  /** 고른 뒤 놓을 캐럿 — 그린 다음에 입력창에 건다 */
  const nextCaret = useRef<number>(undefined)

  useEffect(() => {
    setNotice(undefined)
    if (!directory || composing) return
    const ask = ++generation.current
    void window.litecode.queryTrigger({ directory }, draft, caret).then(
      (result) => {
        if (ask !== generation.current) return
        setQuery(result)
        setActive(0)
      },
      () => ask === generation.current && setQuery(null),
    )
  }, [directory, draft, caret, composing])

  useLayoutEffect(() => {
    const input = inputRef.current
    if (nextCaret.current === undefined || !input) return
    input.focus()
    input.setSelectionRange(nextCaret.current, nextCaret.current)
    setCaret(nextCaret.current)
    nextCaret.current = undefined
  })

  const key = query && `${query.span.start}:${query.span.query}`
  const open = !!query && query.candidates.length > 0 && key !== dismissed

  function replaceSpan(text: string): void {
    if (!query) return
    setDraft(draft.slice(0, query.span.start) + text + draft.slice(query.span.end))
    nextCaret.current = query.span.start + text.length
  }

  function apply(result: TriggerResult): void {
    // 넣은 글은 공백으로 끝나 구간이 닫힌다 — 메뉴가 저절로 닫힌다. 들어가기(drill)는 구간이 이어져 새 후보로 다시 열린다
    if (result.kind === 'insert' || result.kind === 'drill') replaceSpan(result.text)
    else if (result.kind === 'send') onSend(result.text, result.display)
    else if (result.kind === 'shell') {
      setDraft('')
      onShell(result.directory)
    } else setNotice(result.message)
  }

  function choose(index: number, action: 'pick' | 'drill'): void {
    const candidate = query?.candidates[index]
    if (!query || !candidate || !directory) return
    void window.litecode.pickTrigger({ directory }, query.span.char, candidate.id, action).then(apply)
  }

  function dismiss(): void {
    if (key) setDismissed(key)
  }

  return {
    inputRef,
    inputProps: {
      onSelect: (event) => setCaret(event.currentTarget.selectionStart),
      onCompositionStart: () => setComposing(true),
      onCompositionEnd: (event) => {
        setComposing(false)
        setCaret(event.currentTarget.selectionStart)
      },
      'aria-activedescendant': open ? optionId(active) : undefined,
    },
    query,
    open,
    active,
    notice,
    setActive,
    choose,
    dismiss,
    onKeyDown(event) {
      if (!open || !query) return false
      const count = query.candidates.length
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        setActive((active + (event.key === 'ArrowDown' ? 1 : count - 1)) % count)
      } else if ((event.key === 'Enter' && !event.shiftKey) || (event.key === 'Tab' && !event.shiftKey)) {
        choose(active, event.key === 'Tab' && query.candidates[active]?.drill ? 'drill' : 'pick')
      } else if (event.key === 'Escape' || (event.key === 'Tab' && event.shiftKey)) {
        dismiss()
      } else return false
      event.preventDefault()
      return true
    },
    async submit() {
      if (!directory) return false
      const result = await window.litecode.submitTrigger({ directory }, draft)
      if (!result) return false
      apply(result)
      return true
    },
  }
}
