import { useEffect, useState } from 'react'
import type { Project, SkillInfo, SkillScope } from '../shared/ipc.ts'
import { Markdown } from './Markdown.tsx'
import { PlusDialog, PlusGroup } from './PlusDialog.tsx'
import { byScope } from './plusView.ts'
import { SkillBadge } from './SkillBadge.tsx'
import { updateSettings, useSettings, useT } from './settingsStore.ts'
import { reason } from './ipcError.ts'

// 스킬 팝업 (이슈 #43 — 입력창 `+` 메뉴 > 스킬, 시안 _workspace/mock-plus/Skills.dc.html). 설정 > 스킬(이슈 #7)에 있던 것을 프로젝트 기준으로 옮겼다:
// 두 묶음 "이 프로젝트만"(프로젝트 폴더 아래의 스킬)·"모든 프로젝트"(앱 설정 폴더·홈의 스킬), 묶음 머리에 "폴더 열기", 줄을 누르면 지침 본문.
// 읽기 전용이다 — 만들기·편집·프로젝트별 켜기/끄기는 없다. 아래쪽 "Claude Code 스킬 함께 쓰기" 는 앱 전체 값이고 바꾸면 메인(ctx.engine)이
// opencode 를 다시 띄운다 — 목록은 다시 띄운 엔진에 묻는다(값이 바뀌면 다시 읽는다). 펼친 본문은 dsh ui-skill 의 Instructions 카드(260 높이 제한).

export function SkillsPopup({ project, onClose }: { project: Project; onClose(): void }) {
  const t = useT()
  const settings = useSettings()
  const claude = settings.claudeSkills ?? false
  const directory = project.path
  const [skills, setSkills] = useState<SkillInfo[]>()
  const [error, setError] = useState<string>()
  const [open, setOpen] = useState<string>()

  useEffect(() => {
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

  function openFolder(scope: SkillScope): void {
    window.litecode.openSkillsFolder(scope, directory).catch((failure: unknown) => setError(reason(failure)))
  }

  const groups = byScope(skills ?? [])
  const group = (scope: SkillScope) => (
    <PlusGroup
      label={t(`plus.scope.${scope}`)}
      hint={scope === 'project' ? <span className="plus-group__path">{`${project.path.split(/[\\/]/).pop()}/.opencode/skills`}</span> : t('skills.scope.all.hint')}
      action={
        <button type="button" className="plus-group__action" onClick={() => openFolder(scope)}>
          {t('skills.openFolder')}
        </button>
      }
    >
      {!skills ? (
        !error && <p className="plus-group__note">{t('settings.skills.loading')}</p>
      ) : groups[scope].length === 0 ? (
        <p className="plus-group__note">{t('settings.skills.empty')}</p>
      ) : (
        <ul className="skill-list plus-card">
          {groups[scope].map((skill) => (
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
    </PlusGroup>
  )

  return (
    <PlusDialog project={project} title={t('skills.title')} subtitle={t('skills.subtitle', { project: project.name })} onClose={onClose}>
      {error && (
        <p className="settings-error" role="alert">
          {error}
        </p>
      )}
      {group('project')}
      {group('all')}
      <p className="plus-dialog__footnote">{t('settings.skills.intro')}</p>
      <div className="settings-row plus-dialog__row">
        <div className="settings-row__text">
          <div className="settings-row__title">{t('settings.skills.claude')}</div>
          <div className="settings-row__description">{t('settings.skills.claude.description')}</div>
        </div>
        <button type="button" role="switch" className="settings-switch" aria-checked={claude} aria-label={t('settings.skills.claude')} onClick={toggleClaude}>
          <span className="settings-switch__thumb" />
        </button>
      </div>
    </PlusDialog>
  )
}
