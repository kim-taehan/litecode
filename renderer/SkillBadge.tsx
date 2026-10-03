import type { SkillSource } from '../shared/ipc.ts'
import { useT } from './settingsStore.ts'
import './skills.css'

// 스킬 출처 배지 (이슈 #7, 사용자 결정): 앱 스킬은 배지 없음, "프로젝트"(.opencode/skills), "Claude"(~/.claude/skills·.claude/skills 구분 없이 하나).
// 설정 > 스킬 목록과 대화의 스킬 줄이 같이 쓴다. 남이 쓴 지시문(프로젝트·Claude)을 알아보게 하는 것이 목적이다 (01r 보안 절)

/** 스킬 아이콘 — 네 갈래 별 (`/` 메뉴·대화 줄 공용) */
export const SKILL_ICON_PATH = 'M8 2L9.4 6.6L14 8L9.4 9.4L8 14L6.6 9.4L2 8L6.6 6.6Z'

export function SkillBadge({ source }: { source?: SkillSource }) {
  const t = useT()
  if (!source || source === 'app') return null
  return (
    <span className="skill-badge" data-source={source}>
      {t(source === 'project' ? 'skill.source.project' : 'skill.source.claude')}
    </span>
  )
}
