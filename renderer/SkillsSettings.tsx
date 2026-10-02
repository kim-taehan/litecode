import { useEffect, useState } from 'react'
import type { SkillInfo } from '../shared/ipc.ts'
import { Markdown } from './Markdown.tsx'
import { SkillBadge } from './SkillBadge.tsx'
import { updateSettings, useSettings, useT } from './settingsStore.ts'
import { reason } from './Settings.tsx'

// 설정 > 스킬 (이슈 #7, 사용자 결정 _workspace/00_next_skills.md) — 첫 버전은 읽기 전용: 맨 위 "Claude Code 스킬 함께 쓰기" 스위치(기본 꺼짐),
// 아래 지금 프로젝트에서 모델이 쓸 수 있는 스킬 목록(이름·설명·출처 배지, 누르면 본문). 만들기·편집·삭제는 다음 라운드.
// 행 모양은 설정 > 일반 행, 펼친 본문은 dsh ui-skill 의 Instructions 카드(260 높이 제한). 스위치를 바꾸면 메인(ctx.engine)이 opencode 를
// 다시 띄운다 — 목록은 다시 띄운 엔진에 묻는다(설정 값이 바뀌면 다시 읽는다).

export function SkillsPage({ directory }: { directory?: string }) {
  const t = useT()
  const settings = useSettings()
  const claude = settings.claudeSkills ?? false
  const [skills, setSkills] = useState<SkillInfo[]>()
  const [error, setError] = useState<string>()
  const [open, setOpen] = useState<string>()

  useEffect(() => {
    if (!directory) return
    let current = true
    setSkills(undefined)
    setError(undefined)
    window.litecode.listSkills(directory).then(
      (list) => current && setSkills(list),
      (failure: unknown) => current && setError(t('settings.skills.loadError', { message: reason(failure) })),
    )
    return () => {
      current = false
    }
  }, [directory, claude, t])

  function toggleClaude(): void {
    void updateSettings({ claudeSkills: !claude }).catch(() => setError(t('settings.saveError')))
  }

  return (
    <div className="skills-page">
      <div className="settings-row">
        <div className="settings-row__text">
          <div className="settings-row__title">{t('settings.skills.claude')}</div>
          <div className="settings-row__description">{t('settings.skills.claude.description')}</div>
        </div>
        <button type="button" role="switch" className="settings-switch" aria-checked={claude} aria-label={t('settings.skills.claude')} onClick={toggleClaude}>
          <span className="settings-switch__thumb" />
        </button>
      </div>
      <p className="skills-page__intro">{t('settings.skills.intro')}</p>
      {error && (
        <p className="settings-error" role="alert">
          {error}
        </p>
      )}
      {!directory ? (
        <p className="skills-page__note">{t('settings.skills.noProject')}</p>
      ) : !skills ? (
        !error && <p className="skills-page__note">{t('settings.skills.loading')}</p>
      ) : skills.length === 0 ? (
        <p className="skills-page__note">{t('settings.skills.empty')}</p>
      ) : (
        <ul className="skill-list">
          {skills.map((skill) => (
            <li key={skill.location} className="skill-item" data-skill={skill.name} data-source={skill.source}>
              <button
                type="button"
                className="skill-item__head"
                aria-expanded={open === skill.location}
                title={skill.location}
                onClick={() => setOpen((now) => (now === skill.location ? undefined : skill.location))}
              >
                <span className="skill-item__line">
                  <span className="skill-item__name">{skill.name}</span>
                  <SkillBadge source={skill.source} />
                  <svg className="skill-item__chevron" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M4 6L8 10L12 6" />
                  </svg>
                </span>
                {skill.description && <span className="skill-item__description">{skill.description}</span>}
              </button>
              {open === skill.location && (
                <div className="skill-item__body">
                  <Markdown text={skill.body} />
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
