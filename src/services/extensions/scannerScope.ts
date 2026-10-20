import { unsafePathReason } from './paths.ts'

// 검토 범위 분석 (이슈 #537) — 폴더·파일·"내 변경"(브랜치에서 바뀐 + 커밋 안 한 파일)만 분석하는 스캐너 인자. 근거 실측 _workspace/01_probe_537.md §11:
// - 같은 프로젝트 키로 일부만 분석하면 나머지 파일의 이슈가 전부 CLOSED(FIXED)로 닫히고 측정값도 그 일부로 바뀐다 → 범위 분석은 `<키>__scope` 로 따로 올린다
// - sonar.sources 는 글자 그대로의 경로 목록이다(sonar.inclusions 는 패턴이라 `*`·`[` 가 든 이름이 어긋난다). 쉼표가 든 경로는 큰따옴표로 감싸면 된다
// - 목록에 없는 경로가 하나라도 있으면 분석 전체가 실패한다 → 있는 것만 넣고 나머지는 skipped 로 돌려준다
// - 폴더와 그 안의 파일을 같이 주면 두 번 색인될 수 있어 폴더만 남긴다

/** paths: 프로젝트 기준 `/` 구분 상대 경로(파일이나 폴더). exists: 그 경로가 지금 있나 */
export function scopedScanArgs(
  projectKey: string,
  paths: readonly string[],
  exists: (path: string) => boolean,
): { ok: true; projectKey: string; args: string[]; skipped: string[] } | { ok: false; error: 'scope-empty' } {
  const skipped: string[] = []
  const kept: string[] = []
  for (const raw of paths) {
    const path = raw.replace(/^(\.\/)+/, '').replace(/\/+$/, '')
    if (path === '' || path === '.') continue // 프로젝트 전체는 범위가 아니다
    if (unsafePathReason(path) !== undefined || path.includes('"') || !exists(path)) {
      skipped.push(raw)
      continue
    }
    if (!kept.includes(path)) kept.push(path)
  }
  const sources = kept.filter((path) => !kept.some((other) => other !== path && path.startsWith(`${other}/`)))
  if (sources.length === 0) return { ok: false, error: 'scope-empty' }
  const scopeKey = `${projectKey}__scope`
  const list = sources.map((path) => (path.includes(',') ? `"${path}"` : path)).join(',')
  return { ok: true, projectKey: scopeKey, args: [`-Dsonar.projectKey=${scopeKey}`, `-Dsonar.sources=${list}`], skipped }
}
