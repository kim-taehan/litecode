import { describe, expect, it } from 'vitest'
import { scopedScanArgs } from '../../src/services/extensions/scannerScope.ts'

// 검토 범위 분석 (이슈 #537) — 폴더·파일·"내 변경" 을 스캐너 인자로. 실측 _workspace/01_probe_537.md §11:
// 같은 프로젝트 키로 일부만 분석하면 나머지 파일의 이슈가 전부 CLOSED(FIXED)가 된다 → 범위 분석은 `<키>__scope` 로 따로 올린다.
// sonar.sources 는 글자 그대로의 경로 목록(쉼표로 가름, 쉼표가 든 경로는 큰따옴표로 감싸면 됨), 없는 경로가 하나라도 있으면 분석 전체가 실패한다

const all = () => true

describe('scopedScanArgs', () => {
  it('별도 키(<키>__scope)와 sources 목록', () => {
    expect(scopedScanArgs('my-app', ['src/a.ts', 'renderer'], all)).toEqual({
      ok: true,
      projectKey: 'my-app__scope',
      args: ['-Dsonar.projectKey=my-app__scope', '-Dsonar.sources=src/a.ts,renderer'],
      skipped: [],
    })
  })

  it('쉼표가 든 경로는 큰따옴표로 감싼다 — 빈칸은 그대로 된다', () => {
    const result = scopedScanArgs('k', ['odd dir/a,b.js', 'odd dir/c d.js'], all)
    expect(result).toMatchObject({ ok: true, args: ['-Dsonar.projectKey=k__scope', '-Dsonar.sources="odd dir/a,b.js",odd dir/c d.js'] })
  })

  // "내 변경" 에는 지운 파일이 섞인다 — 없는 경로 하나가 분석 전체를 실패시킨다 (실측: "The folder 'gone/deleted.ts' does not exist")
  it('없는 경로·위험한 경로·큰따옴표가 든 경로는 빼고 skipped 로', () => {
    const exists = (p: string) => p !== 'gone/deleted.ts'
    const result = scopedScanArgs('k', ['src/a.ts', 'gone/deleted.ts', '../outside', '/abs', 'a\\b', 'q"uote.ts'], exists)
    expect(result).toEqual({
      ok: true,
      projectKey: 'k__scope',
      args: ['-Dsonar.projectKey=k__scope', '-Dsonar.sources=src/a.ts'],
      skipped: ['gone/deleted.ts', '../outside', '/abs', 'a\\b', 'q"uote.ts'],
    })
  })

  it('같은 경로·이미 고른 폴더 안의 경로는 한 번만 (두 번 색인하지 않게)', () => {
    expect(scopedScanArgs('k', ['src', 'src/a.ts', './src/b.ts', 'src/', 'srcx/c.ts', 'srcx/c.ts'], all)).toMatchObject({
      args: ['-Dsonar.projectKey=k__scope', '-Dsonar.sources=src,srcx/c.ts'],
    })
  })

  it('남는 경로가 없으면 scope-empty', () => {
    expect(scopedScanArgs('k', [], all)).toEqual({ ok: false, error: 'scope-empty' })
    expect(scopedScanArgs('k', ['gone.ts'], () => false)).toEqual({ ok: false, error: 'scope-empty' })
  })

  it('프로젝트 전체(.)는 범위가 아니다 — scope-empty', () => {
    expect(scopedScanArgs('k', ['.', './'], all)).toEqual({ ok: false, error: 'scope-empty' })
  })
})
