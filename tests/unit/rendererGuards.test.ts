import { createElement, type ComponentType } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { stripAnsi } from '../../shared/ansi.ts'
import { shellContext } from '../../src/services/shell.ts'
import { ShellCard } from '../../renderer/ShellCard.tsx'
import { AssistantTurn, UserMessage } from '../../renderer/ChatTurn.tsx'
import { ErrorBoundary, ErrorFallback, errorText } from '../../renderer/ErrorBoundary.tsx'
import { trapTarget } from '../../renderer/focusTrap.ts'
import { translate } from '../../shared/i18n/index.ts'

// 화면 설정 저장소는 메인에서 값을 받아야 해서 여기선 한국어 사전으로 바로 번역한다
vi.mock('../../renderer/settingsStore.ts', () => ({ useT: () => (key: Parameters<typeof translate>[1], vars?: Record<string, string | number>) => translate('ko', key, vars) }))

const ESC = '\x1b'

describe('stripAnsi — `!명령` 출력의 색 코드', () => {
  it('색(SGR)·커서 이동·줄 지우기를 뗀다', () => {
    expect(stripAnsi(`${ESC}[31mFAIL${ESC}[0m x`)).toBe('FAIL x')
    expect(stripAnsi(`${ESC}[1;38;5;208mwarn${ESC}[m`)).toBe('warn')
    expect(stripAnsi(`a${ESC}[2K${ESC}[1Gb`)).toBe('ab')
    expect(stripAnsi(`${ESC}[?25lhidden${ESC}[?25h`)).toBe('hidden')
  })

  it('OSC(제목·링크)와 두 글자 이스케이프도 뗀다', () => {
    expect(stripAnsi(`${ESC}]0;title\x07text`)).toBe('text')
    expect(stripAnsi(`${ESC}]8;;https://x.test${ESC}\\link${ESC}]8;;${ESC}\\`)).toBe('link')
    expect(stripAnsi(`${ESC}(Bplain${ESC}=`)).toBe('plain')
  })

  it('조각 끝에서 잘린 코드는 글자로 새지 않는다 (도는 카드)', () => {
    expect(stripAnsi(`done${ESC}[3`)).toBe('done')
    expect(stripAnsi(`done${ESC}`)).toBe('done')
  })

  it('색 코드가 없는 글·줄바꿈·한글은 그대로', () => {
    expect(stripAnsi('한글 [31m 아님\n둘째 줄\t탭')).toBe('한글 [31m 아님\n둘째 줄\t탭')
  })
})

describe('`!명령` 카드', () => {
  const card = { id: 'r1', command: 'npm test', output: `${ESC}[32mPASS${ESC}[39m a.test.ts\n`, exitCode: 0, status: 'done' as const, truncated: false, at: 1, position: 0 }

  it('카드에 색 코드가 글자로 찍히지 않는다', () => {
    const html = renderToStaticMarkup(createElement(ShellCard, { card, onStop: () => {}, onShare: async () => undefined }))
    expect(html).toContain('PASS a.test.ts')
    expect(html).not.toContain('[32m')
    expect(html).not.toContain('[39m')
  })

  it('"AI 에게 보내기" 로 가는 글도 색 코드가 없다', () => {
    const text = shellContext(card, '/p')
    expect(text).toContain('```\nPASS a.test.ts\n```')
    expect(text).not.toContain(ESC)
  })
})

describe('답 전체 복사', () => {
  const turn = (props: Partial<Parameters<typeof AssistantTurn>[0]>) =>
    renderToStaticMarkup(createElement(AssistantTurn, { items: [], text: '## 답\n\n**굵게**', directory: '/p', ...props }))

  it('끝난 답 아래에 복사 버튼이 있다', () => {
    const html = turn({})
    expect(html).toContain('class="turn__copy"')
    expect(html).toContain('aria-label="답 복사"')
  })

  it('도는 턴·글 없는 답에는 없다', () => {
    expect(turn({ running: true, text: '' })).not.toContain('turn__copy')
    expect(turn({ text: '  ' })).not.toContain('turn__copy')
  })
})

describe('타자가 본문을 다시 그리지 않게 — 답·내 말은 memo', () => {
  it('AssistantTurn·UserMessage 가 memo 컴포넌트다', () => {
    const memo = Symbol.for('react.memo')
    expect((AssistantTurn as unknown as { $$typeof: symbol }).$$typeof).toBe(memo)
    expect((UserMessage as unknown as { $$typeof: symbol }).$$typeof).toBe(memo)
  })
})

describe('흰 화면 방어 (ErrorBoundary)', () => {
  it('그리기 오류를 잡아 상태로 바꾼다', () => {
    const error = new Error('boom')
    expect(ErrorBoundary.getDerivedStateFromError(error)).toEqual({ error })
  })

  it('오류 글 — 이름·사유·스택, 던진 것이 Error 가 아니어도 글로', () => {
    const error = new TypeError("Cannot read properties of undefined (reading 'x')")
    error.stack = 'TypeError: Cannot read…\n    at Foo (App.tsx:1:1)'
    expect(errorText(error, '\n    at Foo\n    at App')).toBe('TypeError: Cannot read…\n    at Foo (App.tsx:1:1)\n\nComponent stack:\n    at Foo\n    at App')
    const bare = new Error('no stack')
    bare.stack = undefined
    expect(errorText(bare)).toBe('Error: no stack')
    expect(errorText('문자열을 던짐')).toBe('문자열을 던짐')
  })

  it('앱 전체가 내려가면 "문제가 생겼습니다" + 다시 불러오기 + 오류 글(복사)', () => {
    const html = renderToStaticMarkup(createElement(ErrorFallback, { scope: 'app', detail: 'Error: boom', onRetry: () => {} }))
    expect(html).toContain('role="alert"')
    expect(html).toContain('문제가 생겼습니다')
    expect(html).toContain('다시 불러오기')
    expect(html).toContain('Error: boom')
    expect(html).toContain('오류 내용 복사')
  })

  it('한 구역만 내려가면 그 자리에 "다시 시도" — 앱 나머지는 그대로다', () => {
    const html = renderToStaticMarkup(createElement(ErrorFallback, { scope: 'section', detail: 'Error: boom', onRetry: () => {} }))
    expect(html).toContain('이 영역을 그리지 못했습니다')
    expect(html).toContain('다시 시도')
    expect(html).toContain('다시 불러오기')
  })

  it('오류가 없으면 자식을 그대로 그린다', () => {
    const Child: ComponentType = () => createElement('p', null, 'ok')
    expect(renderToStaticMarkup(createElement(ErrorBoundary, { scope: 'section' }, createElement(Child)))).toBe('<p>ok</p>')
  })
})

describe('모달 포커스 가두기 — Tab 이 갈 자리', () => {
  it('마지막에서 Tab 은 처음으로, 처음에서 Shift+Tab 은 마지막으로', () => {
    expect(trapTarget(3, 2, false)).toBe(0)
    expect(trapTarget(3, 0, true)).toBe(2)
  })

  it('가운데에서는 브라우저에 맡긴다', () => {
    expect(trapTarget(3, 1, false)).toBeUndefined()
    expect(trapTarget(3, 1, true)).toBeUndefined()
    expect(trapTarget(3, 0, false)).toBeUndefined()
  })

  it('포커스가 모달 밖(뒤 화면)에 있으면 안으로 끌어온다', () => {
    expect(trapTarget(3, -1, false)).toBe(0)
    expect(trapTarget(3, -1, true)).toBe(2)
  })

  it('포커스 받을 것이 없으면 모달 자신(-1)에 둔다 — 뒤로 못 나간다', () => {
    expect(trapTarget(0, -1, false)).toBe(-1)
  })
})
