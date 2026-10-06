import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import type { TriggerQuery, TriggerResult } from '../shared/ipc.ts'

// 입력창 트리거의 화면 쪽 — 어떤 문자가 트리거인지 모르고, 입력·캐럿이 바뀔 때마다 메인(ctx.triggers)에 "이 입력의 후보" 를 묻는다.
// 상호작용은 dsh ui-input-trigger 를 따른다: 포커스는 입력창에 남고(aria-activedescendant) ↑↓ 이동, Enter·Tab 고르기, 폴더는 Tab 으로
// 들어가기, Esc 는 닫기(쓰던 글은 그대로). 같은 자리·같은 질의로 닫은 메뉴는 다시 열지 않는다. 늦게 온 응답은 세대 번호로 버리고,
// 한글 조합 중에는 묻지 않는다 (조합이 끝나면 묻는다).

export interface TriggerOptions {
  /** 프로젝트 폴더 — 없으면 묻지 않는다 */
  directory?: string
  /** 보고 있는 대화 — 바뀌면 캐럿 자리·닫은 메뉴 표시를 새로 잡는다 (초안이 대화별이라) */
  conversation?: string
  draft: string
  setDraft(text: string): void
  /** `/` 명령: text 를 보내고 말풍선엔 display */
  onSend(text: string, display: string): void
  /** `!`: 그 폴더에서 command 를 돌려 대화에 결과 카드로 */
  onShell(directory: string, command: string): void
}

export interface Triggers {
  inputRef: React.RefObject<HTMLTextAreaElement | null>
  /** 입력창에 붙일 것 */
  inputProps: {
    onSelect(event: React.SyntheticEvent<HTMLTextAreaElement>): void
    onFocus(event: React.FocusEvent<HTMLTextAreaElement>): void
    onBlur(): void
    onInput(event: React.FormEvent<HTMLTextAreaElement>): void
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

/** 닫은 메뉴의 표시 — 같은 자리·같은 질의 */
const spanKey = (query: Pick<TriggerQuery, 'span'>): string => `${query.span.start}:${query.span.query}`

/** 메뉴를 그리는가 — 후보가 있고, 그 자리·질의로 닫지 않았고, 입력창에 포커스가 있다 (초안이 `/he` 로 끝난 대화로 돌아오기만 해서는 뜨지 않는다) */
export function triggerOpen(query: Pick<TriggerQuery, 'span' | 'candidates'> | null, dismissed: string | undefined, focused: boolean): boolean {
  return !!query && focused && query.candidates.length > 0 && spanKey(query) !== dismissed
}

export function useTriggers({ directory, conversation, draft, setDraft, onSend, onShell }: TriggerOptions): Triggers {
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const [caret, setCaret] = useState(0)
  const [query, setQuery] = useState<TriggerQuery | null>(null)
  const [active, setActive] = useState(0)
  const [notice, setNotice] = useState<string>()
  const [dismissed, setDismissed] = useState<string>()
  const [composing, setComposing] = useState(false)
  const [focused, setFocused] = useState(false)
  const generation = useRef(0)
  /** 고른 뒤 놓을 캐럿 — 그린 다음에 입력창에 건다 */
  const nextCaret = useRef<number>(undefined)

  // 대화(프로젝트)가 바뀌면 입력창의 글이 그 대화의 초안으로 바뀐다 — 앞 대화의 캐럿 자리·닫은 표시로 묻지 않는다
  useLayoutEffect(() => {
    setDismissed(undefined)
    setCaret(inputRef.current?.selectionStart ?? 0)
  }, [directory, conversation])

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

  const key = query && spanKey(query)
  const open = triggerOpen(query, dismissed, focused)

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
      onShell(result.directory, result.command)
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
      onFocus: (event) => {
        setFocused(true)
        setCaret(event.currentTarget.selectionStart)
      },
      onBlur: () => {
        setFocused(false)
        setComposing(false)
      },
      // 조합 끝(compositionend)을 한 번 놓치면 composing 이 참으로 남아 후보를 영영 안 묻는다 (이슈 #138) — 입력 이벤트가 알려 주는 값으로 매번 맞춘다
      onInput: (event) => setComposing((event.nativeEvent as InputEvent).isComposing === true),
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
