// 스킬의 출처 (이슈 #7, 사용자 결정 2026-10-02 — _workspace/00_next_skills.md). 배지: 앱(없음) · "프로젝트" · "Claude" 하나.
// 출처는 opencode 가 주는 파일 위치(레거시 GET /skill 의 location, skill 도구 결과 metadata.dir)의 경로로 가른다 (01r 출처 판별 —
// 레거시 재실측 2026-10-02 에도 같다): `.claude/skills/` 아래(홈·프로젝트 둘 다) = Claude, `.opencode/skill(s)/` 아래 = 프로젝트, 그 밖(앱 설정 폴더) = 앱.
// 메인(목록·도구 줄)이 정하고 화면은 값만 그린다.

export type SkillSource = 'app' | 'project' | 'claude'

/** 스킬 파일(SKILL.md)이나 그 폴더의 경로 → 출처 */
export function skillSource(location: string): SkillSource {
  const normalized = `${location.replace(/\\/g, '/')}/`
  if (normalized.includes('/.claude/skills/')) return 'claude'
  if (/\/\.opencode\/skills?\//.test(normalized)) return 'project'
  return 'app'
}
