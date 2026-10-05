import { useCallback, useEffect, useState } from 'react'
import { HOOK_EVENTS, HOOK_TIMEOUT_MAX } from '../shared/hooks.ts'
import type { HookCandidate, HookRecent, HookRow, HookScope, HookTestResult, Project } from '../shared/ipc.ts'
import { HookBadge, HooksImport } from './HooksImport.tsx'
import { candidateFiles, defaultSeconds, formDraft, formOf, formUnreachable, recentOf, usesMatcher, type HookForm } from './hooksView.ts'
import { PlusDialog, PlusGroup } from './PlusDialog.tsx'
import { byScope } from './plusView.ts'
import { reason } from './Settings.tsx'
import { useT } from './settingsStore.ts'
import { clockTime } from './turnView.ts'
import './hooks.css'

// 훅 팝업 (이슈 #102 3단계 — 입력창 `+` 메뉴 > 훅, 시안 _workspace/mock-hooks/Main.dc.html). 설정이 아니라 프로젝트 기준 팝업이다 (스킬·MCP 와 같은 자리,
// 사용자 결정) — 판·묶음·줄 카드의 치수는 그 둘(PlusDialog)과 같고 구성·문구는 시안에서:
// - 머리 아래 설명 한 줄 + [훅 추가]
// - 가져오기 띠: 프로젝트 폴더가 가진 훅 정의가 있으면 "이 폴더에 훅 정의 N개가 있습니다 — 자동으로 실행하지 않습니다" + [확인하고 가져오기]
//   (HooksImport — 고른 것만 복사한다. 이미 가져온 것은 메인이 후보에서 뺀다)
// - 두 묶음 "이 프로젝트만" / "모든 프로젝트": 줄마다 이벤트 배지 · 매처 · 명령 · 기한 · 스위치. **스위치는 이 프로젝트에서만** 바뀐다
//   (모든 프로젝트 훅도). 줄을 누르면 그 자리에 편집 판이 펼쳐진다 (한 번에 하나)
// - 편집 판(시안 없음 — MCP 편집 카드처럼 줄 아래 폼): 이벤트 · 매처(도구 훅만) · 명령 · 기한 · 범위, 안내 글, [시험 실행] 과 결과,
//   그 훅의 최근 실행, [삭제](두 번 눌러 확인) · [취소] · [저장]. 검증은 메인과 같은 함수 — 틀리면 저장을 못 누르고 메인도 거절한다
// 채널은 기능 `hooks` 가 켜져 있을 때만 걸려 있다 — 이 팝업은 `+` 메뉴의 훅 줄로만 열리고 그 줄은 기능이 켜져 있을 때만 있다.

const NEW = 'new'
const rowId = (row: Pick<HookRow, 'scope' | 'key'>): string => `${row.scope}:${row.key}`

export function HooksPopup({ project, onClose }: { project: Project; onClose(): void }) {
  const t = useT()
  const directory = project.path
  const [rows, setRows] = useState<HookRow[]>()
  const [candidates, setCandidates] = useState<HookCandidate[]>([])
  const [error, setError] = useState<string>()
  /** 편집 중인 줄 (rowId) 또는 새 훅(NEW) — 한 번에 하나 */
  const [editing, setEditing] = useState<string>()
  const [importing, setImporting] = useState(false)

  const reload = useCallback(async () => {
    try {
      const [list, found] = await Promise.all([window.litecode.listHooks(directory), window.litecode.hookCandidates(directory)])
      setRows(list)
      setCandidates(found)
      setError(undefined)
    } catch (failure) {
      setError(reason(failure))
      setRows((now) => now ?? [])
    }
  }, [directory])
  useEffect(() => void reload(), [reload])

  const done = (saved: boolean): void => {
    setEditing(undefined)
    if (saved) void reload()
  }
  const toggle = (row: HookRow): void =>
    void window.litecode.setHookEnabled(row.key, !row.on, directory).then(reload, (failure: unknown) => setError(reason(failure)))

  if (importing)
    return (
      <HooksImport
        directory={directory}
        candidates={candidates}
        onClose={(imported) => {
          setImporting(false)
          if (imported) void reload()
        }}
      />
    )

  const groups = byScope(rows ?? [])
  const group = (scope: HookScope) => (
    <PlusGroup label={t(`plus.scope.${scope}`)} hint={t(`hooks.popup.scope.${scope}.hint`, { project: project.name })}>
      {!rows && <p className="plus-group__note">{t('hooks.popup.loading')}</p>}
      {rows && groups[scope].length === 0 && <p className="plus-group__note">{t(`hooks.popup.empty.${scope}`)}</p>}
      {groups[scope].length > 0 && (
        <div className="plus-card hook-list">
          {groups[scope].map((row) => (
            <div key={rowId(row)} className="hook-row" data-hook-key={row.key} data-scope={row.scope} data-event={row.event} data-on={row.on}>
              <div className="hook-row__main">
                <button
                  type="button"
                  className="hook-row__open"
                  aria-expanded={editing === rowId(row)}
                  aria-label={t('hooks.popup.edit', { event: t(`hooks.event.${row.event}`), command: row.command })}
                  onClick={() => setEditing((now) => (now === rowId(row) ? undefined : rowId(row)))}
                >
                  <HookBadge event={row.event} />
                  <span className="hook-row__matcher" data-all={!row.matcher || undefined}>
                    {row.matcher || t('hooks.popup.matcherAll')}
                  </span>
                  <span className="hook-row__command" title={row.command}>
                    {row.command}
                  </span>
                  <span className="hook-row__timeout">{t('hooks.popup.seconds', { seconds: row.seconds })}</span>
                </button>
                <button type="button" role="switch" className="settings-switch" aria-checked={row.on} aria-label={t('hooks.popup.enabled', { command: row.command })} onClick={() => toggle(row)}>
                  <span className="settings-switch__thumb" />
                </button>
              </div>
              {row.unreachable && <div className="hook-row__warn">{t('hooks.popup.unreachable')}</div>}
              {editing === rowId(row) && <HookEditor row={row} directory={directory} onDone={done} />}
            </div>
          ))}
        </div>
      )}
    </PlusGroup>
  )

  return (
    <PlusDialog project={project} title={t('hooks.title')} subtitle={t('hooks.popup.subtitle', { project: project.name })} onClose={onClose}>
      <div className="hooks-intro">
        <p className="hooks-intro__text">{t('hooks.popup.intro')}</p>
        <button type="button" className="settings-button settings-button--primary" data-hooks="add" disabled={editing === NEW} onClick={() => setEditing(NEW)}>
          {t('hooks.popup.add')}
        </button>
      </div>
      {error && (
        <p className="settings-error" role="alert">
          {error}
        </p>
      )}
      {candidates.length > 0 && (
        <div className="hooks-candidates" data-hooks="candidates">
          <div className="hooks-candidates__text">
            <div className="hooks-candidates__title">{t('hooks.popup.candidates', { count: candidates.length })}</div>
            <div className="hooks-candidates__note">{t('hooks.popup.candidates.note', { files: candidateFiles(candidates) })}</div>
          </div>
          <button type="button" className="settings-button settings-button--primary" onClick={() => setImporting(true)}>
            {t('hooks.popup.candidates.open')}
          </button>
        </div>
      )}
      {editing === NEW && (
        <div className="plus-card hook-row" data-hook-key="">
          <div className="hook-row__new">{t('hooks.popup.new')}</div>
          <HookEditor directory={directory} onDone={done} />
        </div>
      )}
      {group('project')}
      {group('all')}
      <p className="plus-dialog__footnote">{t('hooks.popup.footer')}</p>
    </PlusDialog>
  )
}

/** row 가 있으면 그 훅을 고치고, 없으면 새 훅 */
function HookEditor({ row, directory, onDone }: { row?: HookRow; directory: string; onDone(saved: boolean): void }) {
  const t = useT()
  const [form, setForm] = useState<HookForm>(() => formOf(row))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [testing, setTesting] = useState(false)
  const [tested, setTested] = useState<HookTestResult>()
  const [confirming, setConfirming] = useState(false)
  const [recent, setRecent] = useState<HookRecent[]>([])
  const set = (change: Partial<HookForm>): void => setForm((now) => ({ ...now, ...change }))

  useEffect(() => {
    if (!row) return
    let current = true
    window.litecode.recentHooks(directory).then((records) => current && setRecent(recentOf(records, row)), () => {})
    return () => {
      current = false
    }
  }, [directory, row])

  const checked = formDraft(form, row)
  const problem = 'error' in checked ? checked.error : undefined
  // 빈 명령은 아직 안 쓴 것 — 사유를 띄우지 않고 버튼만 막는다
  const problemText = problem && problem !== 'command' ? t(`hooks.error.${problem}`, { max: HOOK_TIMEOUT_MAX }) : undefined

  async function run(action: () => Promise<void>): Promise<void> {
    setBusy(true)
    setError(undefined)
    try {
      await action()
    } catch (failure) {
      setError(reason(failure))
    } finally {
      setBusy(false)
    }
  }
  const save = () =>
    run(async () => {
      if (!('draft' in checked)) return
      await window.litecode.saveHook(checked.draft, directory)
      onDone(true)
    })
  const test = () =>
    run(async () => {
      if (!('draft' in checked)) return
      setTested(undefined)
      setTesting(true)
      try {
        setTested(await window.litecode.testHook(checked.draft, directory))
      } finally {
        setTesting(false)
      }
    })
  const remove = () =>
    run(async () => {
      if (!row) return
      await window.litecode.removeHook(row.scope, row.key, directory)
      onDone(true)
    })

  return (
    <div className="provider-editor hook-editor">
      <div className="settings-field">
        <span className="settings-field__label">{t('hooks.form.event')}</span>
        <div className="hook-editor__choices" role="radiogroup" aria-label={t('hooks.form.event')}>
          {HOOK_EVENTS.map((event) => (
            <button
              key={event}
              type="button"
              role="radio"
              aria-checked={form.event === event}
              data-event={event}
              className={`settings-button${form.event === event ? ' settings-button--primary' : ''}`}
              disabled={busy}
              onClick={() => set({ event })}
            >
              {t(`hooks.event.${event}`)}
            </button>
          ))}
        </div>
      </div>
      {usesMatcher(form.event) && (
        <label className="settings-field">
          <span className="settings-field__label">{t('hooks.form.matcher')}</span>
          <input
            className="settings-input hook-editor__mono"
            aria-label={t('hooks.form.matcher')}
            placeholder={t('hooks.form.matcher.placeholder')}
            value={form.matcher}
            disabled={busy}
            spellCheck={false}
            onChange={(event) => set({ matcher: event.target.value })}
          />
        </label>
      )}
      {formUnreachable(form) && (
        <p className="hook-editor__warn" role="status">
          {t('hooks.popup.unreachable')}
        </p>
      )}
      <label className="settings-field">
        <span className="settings-field__label">{t('hooks.form.command')}</span>
        <textarea
          className="settings-input hook-editor__mono hook-editor__command"
          aria-label={t('hooks.form.command')}
          placeholder={t('hooks.form.command.placeholder')}
          rows={3}
          value={form.command}
          disabled={busy}
          spellCheck={false}
          onChange={(event) => set({ command: event.target.value })}
        />
      </label>
      <div className="hook-editor__pair">
        <label className="settings-field hook-editor__timeout">
          <span className="settings-field__label">{t('hooks.form.timeout')}</span>
          <input
            className="settings-input"
            aria-label={t('hooks.form.timeout')}
            inputMode="numeric"
            placeholder={t('hooks.form.timeout.placeholder', { seconds: defaultSeconds(form.event) })}
            value={form.timeout}
            disabled={busy}
            onChange={(event) => set({ timeout: event.target.value })}
          />
        </label>
        <div className="settings-field">
          <span className="settings-field__label">{t('hooks.form.scope')}</span>
          <div className="hook-editor__choices" role="radiogroup" aria-label={t('hooks.form.scope')}>
            {(['project', 'all'] as const).map((scope) => (
              <button
                key={scope}
                type="button"
                role="radio"
                aria-checked={form.scope === scope}
                data-scope={scope}
                className={`settings-button${form.scope === scope ? ' settings-button--primary' : ''}`}
                disabled={busy}
                onClick={() => set({ scope })}
              >
                {t(`plus.scope.${scope}`)}
              </button>
            ))}
          </div>
        </div>
      </div>
      <ul className="hook-editor__notes">
        <li>{t('hooks.form.note.exit')}</li>
        <li>{t('hooks.form.note.input')}</li>
        {form.event === 'PreToolUse' && <li>{t('hooks.form.note.preTool')}</li>}
        <li>{t('hooks.form.note.apply')}</li>
      </ul>

      <div className="hook-editor__test-row">
        <button type="button" className="settings-button" data-hooks="test" disabled={busy || !!problem} onClick={() => void test()}>
          {testing ? t('hooks.form.testing') : t('hooks.form.test')}
        </button>
        <span className="hook-editor__test-note">{t('hooks.form.test.note')}</span>
      </div>
      {tested && (
        <div className="hook-test" role="status" data-outcome={tested.outcome}>
          <div className="hook-test__status">
            {t('hooks.form.test.status', {
              outcome: t(`hooks.outcome.${tested.outcome}`),
              code: tested.exitCode ?? t('hooks.form.test.noCode'),
              seconds: tested.seconds,
            })}
          </div>
          {tested.reason && <div className="hook-test__reason">{tested.reason}</div>}
          {tested.stdout && <TestOutput label={t('hooks.form.test.stdout')} text={tested.stdout} />}
          {tested.stderr && <TestOutput label={t('hooks.form.test.stderr')} text={tested.stderr} />}
          <details className="hook-test__stdin">
            <summary>{t('hooks.form.test.stdin')}</summary>
            <pre className="hook-test__output">{tested.stdin}</pre>
          </details>
        </div>
      )}

      {recent.length > 0 && (
        <div className="hook-recent">
          <div className="settings-field__label">{t('hooks.form.recent')}</div>
          <ul className="hook-recent__list">
            {recent.map((record) => (
              <li key={record.at} className="hook-recent__item" data-outcome={record.outcome}>
                <time dateTime={new Date(record.at).toISOString()}>{clockTime(record.at)}</time>
                <span className="hook-recent__outcome">{t(`hooks.outcome.${record.outcome}`)}</span>
                <span>{t('hooks.popup.seconds', { seconds: record.seconds })}</span>
                {record.reason && <span className="hook-recent__reason">{record.reason}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}

      {(error ?? problemText) && (
        <p className="settings-error" role="alert">
          {error ?? problemText}
        </p>
      )}
      <div className="provider-editor__footer hook-editor__footer">
        {row &&
          (confirming ? (
            <button type="button" className="settings-button settings-button--danger" data-hooks="confirm-delete" disabled={busy} onClick={() => void remove()}>
              {t('hooks.form.confirmDelete')}
            </button>
          ) : (
            <button type="button" className="settings-button" data-hooks="delete" disabled={busy} onClick={() => setConfirming(true)}>
              {t('hooks.form.delete')}
            </button>
          ))}
        <span className="hook-editor__spacer" />
        <button type="button" className="settings-button" disabled={busy} onClick={() => onDone(false)}>
          {t('hooks.form.cancel')}
        </button>
        <button type="button" className="settings-button settings-button--primary" data-hooks="save" disabled={busy || !!problem} onClick={() => void save()}>
          {busy && !testing ? t('hooks.form.saving') : t('hooks.form.save')}
        </button>
      </div>
    </div>
  )
}

function TestOutput({ label, text }: { label: string; text: string }) {
  return (
    <div>
      <div className="hook-test__label">{label}</div>
      <pre className="hook-test__output">{text}</pre>
    </div>
  )
}
