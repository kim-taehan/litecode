import type { UnsafePathReason } from '../../../shared/extensions.ts'

// zip 항목 이름과 manifest 의 entry 가 같이 쓰는 경로 검사 (이슈 #478, zip-slip). 풀 곳 밖을 가리킬 수 있는 이름을 거른다

/** 위험한 경로면 그 종류, 아니면 undefined — 첫 번째로 걸린 종류 하나만 */
export function unsafePathReason(name: string): UnsafePathReason | undefined {
  if (name === '') return 'empty'
  if (name.includes('\0')) return 'nul'
  if (name.startsWith('/')) return 'absolute'
  if (/^[a-zA-Z]:/.test(name)) return 'drive'
  // 윈도에서는 `\` 도 구분자라 `a\..\..\x` 가 폴더 밖으로 나간다 — 바꿔 읽지 않고 통째로 거절한다
  if (name.includes('\\')) return 'backslash'
  if (name.split('/').includes('..')) return 'parent'
  return undefined
}

/** manifest 의 entry 로 쓸 수 있는 경로 — 안전하고, 빈 마디·`.` 마디가 없고(`./a`·`a//b`·`a/`), 파일을 가리킨다 */
export function isEntryPath(entry: string): boolean {
  return unsafePathReason(entry) === undefined && entry.split('/').every((part) => part !== '' && part !== '.')
}
