import { describe, expect, it } from 'vitest'
import { matchFiles } from '../../shared/fileMatch.ts'
import { markText, QUICK_LIMIT } from '../../renderer/fileQuickOpen.ts'

// 파일 퀵오픈 (⌘P, 이슈 #624) — 검색은 shared/fileMatch.matchFiles (이전 pathsContaining, `@` 메뉴와 같은 규칙) 이라 여기에서 검증.
// 표시용 분할(markText) 도 함께.

describe('matchFiles — 퀵오픈 매칭 (이름에 든 것이 먼저, 짧은 경로가 먼저, 대소문자 무시)', () => {
  const files = ['src/app.ts', 'src/app/index.ts', 'a.ts', 'z/src/app.ts', 'deep/nested/components/app/index.ts', 'src/util.ts']

  it('빈 글이면 아무것도 아니다', () => {
    expect(matchFiles(files, '')).toEqual([])
    expect(matchFiles(files, '   ')).toEqual([])
  })

  it('파일명에 든 것이 먼저 — 짧은(짧은 길이의) 경로가 먼저, 대소문자 무시', () => {
    expect(matchFiles(files, 'App.TS')).toEqual(['src/app.ts', 'z/src/app.ts'])
  })

  it('이름에 들어가는 것만으로도 — 짧은 경로가 먼저', () => {
    expect(matchFiles(files, 'index')).toEqual(['src/app/index.ts', 'deep/nested/components/app/index.ts'])
  })

  it('경로(폴더) 마디에만 들어가는 건 뒤에 온다', () => {
    expect(matchFiles(files, 'components')).toEqual(['deep/nested/components/app/index.ts'])
    expect(matchFiles(files, 'app')).toEqual(['src/app.ts', 'z/src/app.ts', 'src/app/index.ts', 'deep/nested/components/app/index.ts'])
  })

  it('limit 으로 잘른다', () => {
    expect(matchFiles(files, 's', QUICK_LIMIT + 5)).toHaveLength(files.length)
    expect(matchFiles(files, 's', 2)).toHaveLength(2)
  })
})

describe('markText — 매칭 글자 표시 (모든 곳, 대소문자 무시)', () => {
  it('글자가 없거나 안 들어가면 통째로 미고정', () => {
    expect(markText('App.ts', '')).toEqual([{ text: 'App.ts', hit: false }])
    expect(markText('App.ts', 'zz')).toEqual([{ text: 'App.ts', hit: false }])
  })

  it('모든 매칭 부분이 고정되고 나머지는 순서대로', () => {
    expect(markText('App/app.ts', 'app')).toEqual([
      { text: 'App', hit: true },
      { text: '/', hit: false },
      { text: 'app', hit: true },
      { text: '.ts', hit: false },
    ])
  })

  it('맨 앞이 매칭이면 빈 조각 없이 시작한다', () => {
    expect(markText('app.ts', 'app')).toEqual([
      { text: 'app', hit: true },
      { text: '.ts', hit: false },
    ])
  })
})
