import { describe, expect, it } from 'vitest'
import { changeDraft, draftOf, restoreInto, withoutDrafts, type Drafts } from '../../renderer/drafts.ts'
import { QuestionDrafts } from '../../renderer/questionDrafts.ts'
import { ScrollMemory } from '../../renderer/scrollMemory.ts'
import type { PickedAttachment } from '../../shared/ipc.ts'

// 대화별 초안 — 입력창의 글·첨부 칩을 대화 id 마다 따로 둔다 (dsh ui-conversation "대화마다 편집기 하나").
// 전에는 창 전체에 하나라 대화를 바꾸면 쓰던 글이 따라가 엉뚱한 대화에 보낼 수 있었다

const file = (path: string): PickedAttachment => ({ kind: 'file', name: path.split('/').pop()!, path, size: 1 })

describe('대화별 초안', () => {
  it('한 대화에 쓴 글·칩은 다른 대화에 보이지 않고, 돌아오면 그대로 있다', () => {
    let drafts: Drafts = {}
    drafts = changeDraft(drafts, 'a', (draft) => ({ ...draft, text: 'a 에 쓰던 글' }))
    drafts = changeDraft(drafts, 'a', (draft) => ({ ...draft, attached: [file('/p/x.ts')] }))
    expect(draftOf(drafts, 'b')).toEqual({ text: '', attached: [] })
    drafts = changeDraft(drafts, 'b', (draft) => ({ ...draft, text: 'b 글' }))
    expect(draftOf(drafts, 'a')).toEqual({ text: 'a 에 쓰던 글', attached: [file('/p/x.ts')] })
    expect(draftOf(drafts, 'b').text).toBe('b 글')
  })

  it('대화가 없으면(프로젝트를 열기 전) 빈 초안이다', () => {
    expect(draftOf({ a: { text: 'x', attached: [] } }, undefined)).toEqual({ text: '', attached: [] })
  })

  it('보내면 그 대화 것만 비운다 — 빈 초안은 맵에 남기지 않는다', () => {
    let drafts: Drafts = { a: { text: 'a', attached: [] }, b: { text: 'b', attached: [file('/p/y.ts')] } }
    drafts = changeDraft(drafts, 'a', () => ({ text: '', attached: [] }))
    expect(drafts).toEqual({ b: { text: 'b', attached: [file('/p/y.ts')] } })
  })

  it('바뀐 게 없으면 같은 맵을 돌려준다 (다시 그리지 않는다)', () => {
    const drafts: Drafts = { a: { text: 'a', attached: [] } }
    expect(changeDraft(drafts, 'a', (draft) => draft)).toBe(drafts)
    expect(changeDraft(drafts, 'b', (draft) => draft)).toBe(drafts)
  })

  it('지운 대화의 초안은 버린다', () => {
    const drafts: Drafts = { a: { text: 'a', attached: [] }, b: { text: 'b', attached: [] } }
    expect(withoutDrafts(drafts, ['a', 'zz'])).toEqual({ b: { text: 'b', attached: [] } })
    expect(withoutDrafts(drafts, ['zz'])).toBe(drafts)
  })
})

describe('대기열 되돌리기 → 초안', () => {
  it('되돌린 글은 쓰던 글 앞에, 첨부는 겹치지 않게 앞에 합친다', () => {
    const draft = { text: ' 쓰던 글 ', attached: [file('/p/a.ts'), file('/p/b.ts')] }
    const merged = restoreInto(draft, { text: '풀린 글', display: '/hi', attachments: [file('/p/b.ts'), file('/p/c.ts')] })
    expect(merged.text).toBe('/hi\n쓰던 글')
    expect(merged.attached.map((item) => item.path)).toEqual(['/p/b.ts', '/p/c.ts', '/p/a.ts'])
  })

  it('보일 글이 없으면 본문을, 쓰던 글이 없으면 되돌린 글만', () => {
    expect(restoreInto({ text: '', attached: [] }, { text: '본문' })).toEqual({ text: '본문', attached: [] })
  })
})

// 질문 카드에 쓰던 답(고른 보기·직접 쓴 글) — 카드는 대화를 바꾸면 내려가므로 요청 id 로 따로 쥔다 (dsh ui-user-questions 의 초안 보존).
// 요청이 풀리면(답했다·턴이 끝났다) 버린다
describe('질문 카드 초안', () => {
  it('요청 id 마다 따로 기억한다', () => {
    const drafts = new QuestionDrafts<string>()
    drafts.save('que_1', '쓰던 답')
    drafts.save('que_2', '다른 답')
    expect(drafts.load('que_1')).toBe('쓰던 답')
    expect(drafts.load('que_2')).toBe('다른 답')
    expect(drafts.load('que_3')).toBeUndefined()
  })

  it('기다리는 요청만 남긴다 — 풀린 요청의 초안은 지운다', () => {
    const drafts = new QuestionDrafts<string>()
    drafts.save('que_1', 'a')
    drafts.save('que_2', 'b')
    drafts.keepOnly(['que_2', 'per_9'])
    expect(drafts.load('que_1')).toBeUndefined()
    expect(drafts.load('que_2')).toBe('b')
  })
})

// 대화별 읽던 자리 (dsh ui-chat "Scroll ownership") — 전에는 대화를 바꾸면 늘 맨 아래로 갔다.
// 맨 아래를 따라가던 대화는 자리를 적지 않는다(돌아오면 맨 아래 — 그사이 답이 늘었어도 끝을 본다)
describe('대화별 읽던 자리', () => {
  it('처음 여는 대화는 기억이 없다 (맨 아래)', () => {
    expect(new ScrollMemory().recall('a:chat')).toBeUndefined()
  })

  it('위로 올려 읽던 자리를 대화마다 기억한다', () => {
    const memory = new ScrollMemory()
    memory.remember('a:chat', false, 1200)
    memory.remember('b:chat', false, 40)
    expect(memory.recall('a:chat')).toBe(1200)
    expect(memory.recall('b:chat')).toBe(40)
  })

  it('맨 아래로 돌아가면 기억을 지운다', () => {
    const memory = new ScrollMemory()
    memory.remember('a:chat', false, 1200)
    memory.remember('a:chat', true, 5000)
    expect(memory.recall('a:chat')).toBeUndefined()
  })
})
