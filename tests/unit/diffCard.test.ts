import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { DiffCard } from '../../renderer/DiffCard.tsx'
import type { FileDiff } from '../../shared/ipc.ts'
import { translate } from '../../shared/i18n/index.ts'

vi.mock('../../renderer/settingsStore.ts', () => ({ useT: () => (key: Parameters<typeof translate>[1], vars?: Record<string, string | number>) => translate('ko', key, vars) }))

// diff 카드의 문법 색 (이슈 #81) — 줄의 종류(추가·삭제 바탕)는 그대로 두고 글자만 토큰 요소로
const PATCH = '@@ -1,2 +1,2 @@\n const a = 1\n-const b = 2\n+const b = 3\n'
const card = (path: string) => renderToStaticMarkup(createElement(DiffCard, { diffs: [{ path, patch: PATCH, added: 1, removed: 1 } as FileDiff] }))

describe('DiffCard 문법 색', () => {
  it('아는 확장자면 줄 종류는 그대로, 글자는 토큰으로 나뉜다', () => {
    const out = card('src/a.ts')
    expect(out).toContain('<div class="diff-line" data-kind="add"><span class="diff-line__code"><span class="hljs-keyword">const</span> b = <span class="hljs-number">3</span></span></div>')
    expect(out).toContain('<div class="diff-line" data-kind="del"><span class="diff-line__code"><span class="hljs-keyword">const</span> b = <span class="hljs-number">2</span></span></div>')
    expect(out).toContain('data-kind="context"')
  })

  it('모르는 확장자면 예전처럼 글자 그대로', () => {
    const out = card('notes.txt')
    expect(out).toContain('<div class="diff-line" data-kind="add">const b = 3</div>')
    expect(out).not.toContain('hljs-')
  })
})
