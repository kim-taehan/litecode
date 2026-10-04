import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { FileDiff, TurnItem } from '../../shared/contract.ts'
import { AssistantTurn } from '../../renderer/ChatTurn.tsx'
import { changedFiles, splitPath, CHANGED_FILES_FOLD } from '../../renderer/changedFiles.ts'
import { translate } from '../../shared/i18n/index.ts'

// 화면 설정 저장소는 메인에서 값을 받아야 해서 여기선 한국어 사전으로 바로 번역한다
vi.mock('../../renderer/settingsStore.ts', () => ({ useT: () => (key: Parameters<typeof translate>[1], vars?: Record<string, string | number>) => translate('ko', key, vars) }))

// 턴 끝 "AI 가 고친 파일" 카드 (이슈 #82) — 엔진 snapshot 은 꺼져 있어(01ad) 데이터는 성공한 도구 줄의 diff 를 턴 단위로 모은 것뿐이다

const diff = (path: string, added: number, removed: number, extra: Partial<FileDiff> = {}): FileDiff => ({ path, status: 'modified', added, removed, patch: `@@ ${path} +${added} -${removed} @@\n`, ...extra })
const tool = (id: string, diffs?: FileDiff[], status: 'done' | 'error' | 'running' = 'done', name = 'edit'): TurnItem => ({ kind: 'tool', id, name, status, ...(diffs && { diffs }) })
const text = (id: string): TurnItem => ({ kind: 'text', id, text: '끝', done: true })

describe('changedFiles — 턴의 줄에서 파일별로 묶기', () => {
  it('고친 파일이 없으면 undefined', () => {
    expect(changedFiles([text('t'), tool('a', undefined, 'done', 'bash')])).toBeUndefined()
  })

  it('같은 파일을 여러 번 고치면 한 줄 — 줄 수는 합, 횟수와 diff 는 시간순', () => {
    const first = diff('src/a.ts', 2, 1)
    const second = diff('src/a.ts', 3, 0)
    const other = diff('b.txt', 1, 1)
    const changes = changedFiles([tool('1', [first]), tool('2', [other]), text('t'), tool('3', [second])])!
    expect(changes.files.map((file) => file.path)).toEqual(['src/a.ts', 'b.txt'])
    expect(changes.files[0]).toEqual({ path: 'src/a.ts', status: 'modified', added: 5, removed: 1, unknownBefore: false, edits: 2, diffs: [first, second] })
    expect(changes).toMatchObject({ added: 6, removed: 2, unknownBefore: false, source: 'tools' })
  })

  it('실패했거나 아직 도는 도구 줄은 뺀다', () => {
    const changes = changedFiles([tool('1', [diff('a.ts', 1, 0)], 'error'), tool('2', [diff('b.ts', 1, 0)], 'running'), tool('3', [diff('c.ts', 1, 0)])])!
    expect(changes.files.map((file) => file.path)).toEqual(['c.ts'])
  })

  it('하위 작업 안의 줄도 모은다', () => {
    const sub: TurnItem = { kind: 'subtask', id: 's', agent: 'general', description: '', status: 'done', items: [tool('c1', [diff('a.ts', 1, 1)]), tool('c2', [diff('child.ts', 4, 0)])] }
    const changes = changedFiles([tool('1', [diff('a.ts', 1, 0)]), sub])!
    expect(changes.files.map((file) => [file.path, file.edits, file.added, file.removed])).toEqual([
      ['a.ts', 2, 2, 1],
      ['child.ts', 1, 4, 0],
    ])
  })

  it('상태 — 이 턴에 만든 파일은 뒤에 고쳐도 새 파일, 끝이 삭제면 삭제', () => {
    const changes = changedFiles([
      tool('1', [diff('new.ts', 3, 0, { status: 'added' })]),
      tool('2', [diff('new.ts', 1, 1)]),
      tool('3', [diff('gone.ts', 1, 1)], 'done', 'apply_patch'),
      tool('4', [diff('gone.ts', 0, 5, { status: 'deleted' })], 'done', 'apply_patch'),
    ])!
    expect(changes.files.map((file) => [file.path, file.status])).toEqual([
      ['new.ts', 'added'],
      ['gone.ts', 'deleted'],
    ])
  })

  it('덮어쓴 파일(옛 내용 모름)이 끼면 삭제 줄 수를 모른다고 표시한다', () => {
    const changes = changedFiles([tool('1', [diff('a.ts', 9, 0, { unknownBefore: true })], 'done', 'write'), tool('2', [diff('b.ts', 1, 2)])])!
    expect(changes.files[0]!.unknownBefore).toBe(true)
    expect(changes.files[1]!.unknownBefore).toBe(false)
    expect(changes.unknownBefore).toBe(true)
  })

  it('한 도구가 여러 파일을 바꾸면(apply_patch) 파일마다 한 번씩 센다', () => {
    const changes = changedFiles([tool('1', [diff('a.ts', 1, 0), diff('b.ts', 0, 1)], 'done', 'apply_patch')])!
    expect(changes.files.map((file) => [file.path, file.edits])).toEqual([
      ['a.ts', 1],
      ['b.ts', 1],
    ])
  })
})

describe('splitPath — 이름과 흐리게 보일 폴더', () => {
  it('폴더가 있으면 가른다', () => {
    expect(splitPath('src/services/llm.ts')).toEqual({ name: 'llm.ts', folder: 'src/services' })
    expect(splitPath('a.ts')).toEqual({ name: 'a.ts', folder: '' })
    expect(splitPath('/tmp/out/a.ts')).toEqual({ name: 'a.ts', folder: '/tmp/out' })
  })
})

describe('AssistantTurn 의 고친 파일 카드', () => {
  const render = (items: TurnItem[], props: Record<string, unknown> = {}) => renderToStaticMarkup(createElement(AssistantTurn, { items, text: '끝', directory: '/p', ...props }))
  const edits = [tool('1', [diff('src/a.ts', 2, 1)]), tool('2', [diff('b.txt', 3, 0, { status: 'added' })]), tool('3', [diff('src/a.ts', 1, 0)]), text('t')]

  it('끝난 턴 — 머리에 파일 수와 줄 수, 줄마다 이름·폴더·상태·횟수. diff 는 접혀 있다', () => {
    const out = render(edits)
    expect(out).toContain('class="changed-files"')
    expect(out).toContain('AI 가 고친 파일 2')
    expect(out).toContain('+6 −1')
    expect(out).toContain('<span class="changed-files__name">a.ts</span>')
    expect(out).toContain('<span class="changed-files__folder">src</span>')
    expect(out).toContain('2번')
    expect(out).toContain('새 파일')
    expect(out).toContain('명령으로 바꾼 파일은')
    // 카드의 diff 는 눌러야 그린다 — 작업 줄이 접힌 끝난 턴에는 diff 카드가 하나도 없다
    expect(out).not.toContain('diff-card')
  })

  it('실패·중단된 턴에도 뜬다', () => {
    expect(render(edits, { failed: true, text: '⚠️ 실패' })).toContain('class="changed-files"')
    expect(render(edits, { failed: true, interrupted: true, text: '⚠️ 중단됨' })).toContain('class="changed-files"')
  })

  it('도는 중인 턴과 고친 파일이 없는 턴에는 없다', () => {
    expect(render(edits, { running: true, startedAt: 0 })).not.toContain('changed-files')
    expect(render([tool('1', undefined, 'done', 'bash'), text('t')])).not.toContain('changed-files')
  })

  it(`파일이 ${CHANGED_FILES_FOLD}개를 넘으면 접고 "N개 더"`, () => {
    const many = Array.from({ length: CHANGED_FILES_FOLD + 3 }, (_, index) => tool(`e${index}`, [diff(`f${index}.ts`, 1, 0)]))
    const out = render([...many, text('t')])
    expect(out.match(/class="changed-files__row"/g)).toHaveLength(CHANGED_FILES_FOLD)
    expect(out).toContain('3개 더')
    expect(out).toContain(`AI 가 고친 파일 ${CHANGED_FILES_FOLD + 3}`)
  })

  it('삭제된 파일에는 열기 버튼이 없다', () => {
    const out = render([tool('1', [diff('gone.ts', 0, 2, { status: 'deleted' })], 'done', 'apply_patch'), text('t')])
    expect(out).toContain('삭제됨')
    expect(out).not.toContain('changed-files__open')
  })
})
