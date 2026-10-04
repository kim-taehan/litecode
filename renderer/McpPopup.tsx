import { useCallback, useEffect, useState } from 'react'
import type { McpScope, McpServerInput, McpServerSummary, McpTestResult, Project } from '../shared/ipc.ts'
import { PlusDialog, PlusGroup } from './PlusDialog.tsx'
import { byScope, mcpState } from './plusView.ts'
import { reason } from './Settings.tsx'
import { useT } from './settingsStore.ts'
import './mcp.css'

// MCP 서버 팝업 (이슈 #43 — 입력창 `+` 메뉴 > MCP 서버, 시안 _workspace/mock-plus/Mcp.dc.html). 설정 > MCP(이슈 #28)에 있던 것을 프로젝트 기준으로 옮겼다.
// - 두 묶음: "이 프로젝트만"(앱이 이 프로젝트에만 저장한 서버 + 프로젝트 폴더의 .mcp.json·opencode.json 정의) · "모든 프로젝트"(앱 서버 + 개인 설정).
//   묶음마다 "+ 서버 추가" — 그 묶음에 저장된다. 묶음은 메인(ctx.mcp)이 정한 scope 로 가른다
// - 줄: 이름(+ 출처 배지: 폴더 정의는 파일 이름, 개인 설정) · 명령/주소 · 상태(연결됨 · 도구 N / 실패 · 사유 / 꺼짐) · 스위치.
//   **스위치는 이 프로젝트에서만** 켜고 끈다. 줄을 누르면 도구 목록·편집·삭제가 펼쳐진다
// - 앱 서버만 고칠 수 있다. 폴더 정의·개인 설정 서버는 읽기 전용이고 값은 안 보인다(이름만)
// - 편집 폼은 #28 그대로(dsh ui-settings-models 의 편집 카드 하나·쓰기 전용 비밀·두 번 눌러 삭제): 비밀(헤더·env 값 중 "비밀" 표시)은 쓰기 전용 —
//   저장된 값은 안 보이고 "저장됨" 만, 빈 칸으로 두면 그대로 둔다. 연결 테스트는 저장하지 않고 앱이 직접 잠깐 붙어 도구 목록을 본다

export function McpPopup({ project, onClose }: { project: Project; onClose(): void }) {
  const t = useT()
  const directory = project.path
  const [servers, setServers] = useState<McpServerSummary[]>()
  const [error, setError] = useState<string>()
  /** 편집 중인 카드 — 서버 이름, 새로 추가하는 중이면 그 묶음 (`new:project`·`new:all`). 한 번에 하나 */
  const [editing, setEditing] = useState<string>()
  const [confirming, setConfirming] = useState<string>()

  const reload = useCallback(async () => {
    try {
      setServers(await window.litecode.listMcp(directory))
      setError(undefined)
    } catch (failure) {
      setError(reason(failure))
      setServers((now) => now ?? [])
    }
  }, [directory])
  useEffect(() => void reload(), [reload])

  const act = async (action: () => Promise<void>): Promise<void> => {
    try {
      await action()
      await reload()
    } catch (failure) {
      setError(reason(failure))
    }
  }
  const done = (saved: boolean): void => {
    setEditing(undefined)
    if (saved) void reload()
  }

  const groups = byScope(servers ?? [])
  const group = (scope: McpScope) => (
    <PlusGroup
      label={t(`plus.scope.${scope}`)}
      hint={t(`mcp.scope.${scope}.hint`, { project: project.name })}
      action={
        <button type="button" className="plus-group__action" disabled={editing === `new:${scope}`} onClick={() => setEditing(`new:${scope}`)}>
          {t('mcp.add')}
        </button>
      }
    >
      {!servers && <p className="plus-group__note">{t('mcp.loading')}</p>}
      {servers && groups[scope].length === 0 && editing !== `new:${scope}` && <p className="plus-group__note">{t('mcp.empty')}</p>}
      {groups[scope].map((server) => (
        <div key={`${server.source}:${server.name}`} className="plus-card mcp-row" data-mcp={server.name} data-source={server.source} data-scope={server.scope}>
          <ServerRow
            server={server}
            editing={server.source === 'app' && editing === server.name}
            confirming={confirming === server.name}
            onEdit={() => setEditing(server.name)}
            onDelete={() => setConfirming(server.name)}
            onCancelDelete={() => setConfirming(undefined)}
            onConfirmDelete={() => {
              setConfirming(undefined)
              void act(() => window.litecode.removeMcp(server.name, directory))
            }}
            onToggle={(on) => void act(() => window.litecode.setMcpEnabled(server.name, on, directory))}
          />
          {server.source === 'app' && editing === server.name && <ServerEditor server={server} directory={directory} onDone={done} />}
        </div>
      ))}
      {editing === `new:${scope}` && (
        <div className="plus-card mcp-row" data-mcp="">
          <div className="mcp-row__new">{t('mcp.newServer')}</div>
          <ServerEditor scope={scope} directory={directory} onDone={done} />
        </div>
      )}
    </PlusGroup>
  )

  return (
    <PlusDialog project={project} title={t('mcp.title')} subtitle={t('mcp.subtitle', { project: project.name })} onClose={onClose}>
      {error && (
        <p className="settings-error" role="alert">
          {error}
        </p>
      )}
      {group('project')}
      {group('all')}
      <p className="plus-dialog__footnote">{t('mcp.footer')}</p>
    </PlusDialog>
  )
}

interface RowProps {
  server: McpServerSummary
  editing: boolean
  confirming: boolean
  onEdit(): void
  onDelete(): void
  onCancelDelete(): void
  onConfirmDelete(): void
  onToggle(on: boolean): void
}

function ServerRow({ server, editing, confirming, onEdit, onDelete, onCancelDelete, onConfirmDelete, onToggle }: RowProps) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const app = server.source === 'app'
  const target = server.type === 'remote' ? server.url : server.command?.join(' ')
  const state = mcpState(server)
  // 출처 배지 — 폴더 정의는 그 파일 이름(시안의 ".mcp.json"), 개인 설정은 "개인 설정". 앱에서 만든 서버는 배지 없음
  const badge = server.source === 'project' ? server.origin : server.source === 'personal' ? t('mcp.source.personal') : undefined
  const stateText =
    state === 'shadowed'
      ? t('mcp.shadowed')
      : state === 'connected' && server.tools
        ? t('mcp.testOk', { count: server.tools.length })
        : state === 'failed' && server.error
          ? `${t('mcp.status.failed')} · ${server.error}`
          : state
            ? isKnownStatus(state)
              ? t(`mcp.status.${state}`)
              : state
            : undefined
  return (
    <>
      <div className="mcp-row__main">
        <button type="button" className="mcp-row__toggle" aria-expanded={open} title={t('mcp.expand', { name: server.name })} onClick={() => setOpen((now) => !now)}>
          <span className="mcp-row__name">
            {server.name}
            {badge && <span className="provider-card__tag mcp-row__badge">{badge}</span>}
          </span>
          {target && <span className="mcp-row__target">{target}</span>}
        </button>
        {stateText && (
          <span className="mcp-row__state" data-state={state} title={stateText}>
            {stateText}
          </span>
        )}
        <button
          type="button"
          role="switch"
          className="settings-switch"
          aria-checked={server.enabled}
          aria-label={t('mcp.enabled', { name: server.name })}
          disabled={!!server.shadowed}
          onClick={() => onToggle(!server.enabled)}
        >
          <span className="settings-switch__thumb" />
        </button>
      </div>
      {open && (
        <div className="mcp-row__detail">
          {server.type && target && (
            <div className="mcp-row__line">
              <span>{t(`mcp.type.${server.type}`)}</span>
              <span className="mcp-row__full-target">{target}</span>
            </div>
          )}
          {server.error && <div className="mcp-row__line mcp-row__line--error">{server.error}</div>}
          {server.toolsError && <div className="mcp-row__line mcp-row__line--error">{server.toolsError}</div>}
          {server.tools && <ToolList tools={server.tools} />}
          <div className="mcp-row__actions">
            {!app ? (
              <span className="mcp-card__readonly">{t('mcp.readOnly')}</span>
            ) : confirming ? (
              <>
                <button type="button" className="settings-button settings-button--danger" onClick={onConfirmDelete}>
                  {t('mcp.confirmDelete')}
                </button>
                <button type="button" className="settings-button" onClick={onCancelDelete}>
                  {t('mcp.cancel')}
                </button>
              </>
            ) : (
              !editing && (
                <>
                  <button type="button" className="settings-button" onClick={onEdit}>
                    {t('mcp.edit')}
                  </button>
                  <button type="button" className="settings-button" onClick={onDelete}>
                    {t('mcp.delete')}
                  </button>
                </>
              )
            )}
          </div>
        </div>
      )}
    </>
  )
}

function ToolList({ tools }: { tools: NonNullable<McpServerSummary['tools']> }) {
  return (
    <ul className="mcp-tools">
      {tools.map((tool) => (
        <li key={tool.name} className="mcp-tools__item">
          <span className="mcp-tools__name">{tool.name}</span>
          {tool.description && <span className="mcp-tools__description">{tool.description}</span>}
        </li>
      ))}
    </ul>
  )
}

function isKnownStatus(status: string): status is 'connected' | 'failed' | 'disabled' | 'needs_auth' | 'needs_client_registration' | 'pending' {
  return ['connected', 'failed', 'disabled', 'needs_auth', 'needs_client_registration', 'pending'].includes(status)
}

interface VarDraft {
  name: string
  value: string
  secret: boolean
  /** 저장된 비밀이 있다 — 빈 값이면 그대로 둔다 */
  stored: boolean
}

const SECRET_NAME = /KEY|TOKEN|SECRET|PASSWORD|AUTH|CREDENTIAL/i

/** server 가 있으면 그 서버를 고치고, 없으면 scope 묶음에 새로 넣는다 */
function ServerEditor({ server, scope, directory, onDone }: { server?: McpServerSummary; scope?: McpScope; directory: string; onDone(saved: boolean): void }) {
  const t = useT()
  const [name, setName] = useState(server?.name ?? '')
  const [type, setType] = useState<'local' | 'remote'>(server?.type ?? 'local')
  const [command, setCommand] = useState(server?.command?.[0] ?? '')
  const [args, setArgs] = useState(server?.command?.slice(1).join('\n') ?? '')
  const [url, setUrl] = useState(server?.url ?? '')
  const [vars, setVars] = useState<VarDraft[]>(
    () => server?.vars.map((entry) => ({ name: entry.name, value: entry.value ?? '', secret: entry.secret, stored: entry.secret && entry.hasValue })) ?? [],
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [tested, setTested] = useState<McpTestResult>()
  const [testing, setTesting] = useState(false)

  const input = (): McpServerInput => ({
    ...(server ? { originalName: server.name } : { scope }),
    name,
    type,
    ...(type === 'local'
      ? { command: [command, ...args.split('\n')].map((part) => part.trim()).filter(Boolean) }
      : { url }),
    vars: vars.map(({ name: varName, value, secret }) => ({ name: varName, value, secret })),
  })

  const setVar = (index: number, change: Partial<VarDraft>): void =>
    setVars((now) =>
      now.map((entry, at) => {
        if (at !== index) return entry
        const next = { ...entry, ...change }
        // 이름을 처음 적을 때 비밀다운 이름이면 비밀로 (사용자가 바꿀 수 있다)
        if (change.name !== undefined && !entry.name && !entry.value) next.secret = SECRET_NAME.test(change.name) || type === 'remote'
        return next
      }),
    )

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

  const test = () =>
    run(async () => {
      setTested(undefined)
      setTesting(true)
      try {
        setTested(await window.litecode.testMcp(input(), directory))
      } finally {
        setTesting(false)
      }
    })
  const save = () =>
    run(async () => {
      await window.litecode.saveMcp(input(), directory)
      onDone(true)
    })

  const ready = !!name.trim() && (type === 'local' ? !!command.trim() : !!url.trim())
  return (
    <div className="provider-editor mcp-editor">
      <label className="settings-field">
        <span className="settings-field__label">{t('mcp.name')}</span>
        <input className="settings-input" aria-label={t('mcp.name')} placeholder={t('mcp.namePlaceholder')} value={name} disabled={busy} onChange={(event) => setName(event.target.value)} />
      </label>
      <div className="settings-field">
        <span className="settings-field__label">{t('mcp.type')}</span>
        <div className="mcp-editor__types" role="radiogroup" aria-label={t('mcp.type')}>
          {(['local', 'remote'] as const).map((option) => (
            <button
              key={option}
              type="button"
              role="radio"
              aria-checked={type === option}
              className={`settings-button${type === option ? ' settings-button--primary' : ''}`}
              disabled={busy}
              onClick={() => setType(option)}
            >
              {t(`mcp.type.${option}`)}
            </button>
          ))}
        </div>
      </div>
      {type === 'local' ? (
        <>
          <label className="settings-field">
            <span className="settings-field__label">{t('mcp.command')}</span>
            <input className="settings-input" aria-label={t('mcp.command')} placeholder={t('mcp.commandPlaceholder')} value={command} disabled={busy} onChange={(event) => setCommand(event.target.value)} />
          </label>
          <p className="models-page__hint">{t('mcp.hint')}</p>
          <label className="settings-field">
            <span className="settings-field__label">{t('mcp.args')}</span>
            <textarea className="settings-input mcp-editor__args" aria-label={t('mcp.args')} rows={2} value={args} disabled={busy} onChange={(event) => setArgs(event.target.value)} />
          </label>
        </>
      ) : (
        <label className="settings-field">
          <span className="settings-field__label">{t('mcp.url')}</span>
          <input className="settings-input" aria-label={t('mcp.url')} placeholder={t('mcp.urlPlaceholder')} value={url} disabled={busy} onChange={(event) => setUrl(event.target.value)} />
        </label>
      )}

      <div className="settings-field__label">{type === 'local' ? t('mcp.env') : t('mcp.headers')}</div>
      {vars.map((entry, index) => (
        <div key={index} className="model-row mcp-var">
          <input
            className="settings-input"
            aria-label={`${t('mcp.varName')} ${index + 1}`}
            placeholder={t('mcp.varName')}
            value={entry.name}
            disabled={busy}
            onChange={(event) => setVar(index, { name: event.target.value })}
          />
          <input
            className="settings-input"
            aria-label={`${t('mcp.varValue')} ${index + 1}`}
            type={entry.secret ? 'password' : 'text'}
            autoComplete="new-password"
            placeholder={entry.stored ? t('mcp.varSecretSet') : t('mcp.varValue')}
            value={entry.value}
            disabled={busy}
            onChange={(event) => setVar(index, { value: event.target.value })}
          />
          <label className="mcp-var__secret">
            <input type="checkbox" aria-label={`${t('mcp.varSecret')} ${index + 1}`} checked={entry.secret} disabled={busy} onChange={(event) => setVar(index, { secret: event.target.checked, stored: false })} />
            {t('mcp.varSecret')}
          </label>
          <button
            type="button"
            className="settings-icon-button"
            aria-label={`${t('mcp.removeVar')} ${index + 1}`}
            disabled={busy}
            onClick={() => setVars((now) => now.filter((_, at) => at !== index))}
          >
            ×
          </button>
        </div>
      ))}
      <div className="provider-editor__model-actions">
        <button type="button" className="settings-button" disabled={busy} onClick={() => setVars((now) => [...now, { name: '', value: '', secret: type === 'remote', stored: false }])}>
          {t('mcp.addVar')}
        </button>
        <button type="button" className="settings-button" disabled={busy || !ready} onClick={() => void test()}>
          {testing ? t('mcp.testing') : t('mcp.test')}
        </button>
      </div>
      {tested && (
        <div className="mcp-editor__test" role="status" data-ok={tested.ok}>
          {tested.ok ? t('mcp.testOk', { count: tested.tools?.length ?? 0 }) : t('mcp.testFailed', { reason: tested.error ?? '' })}
          {tested.ok && tested.tools && tested.tools.length > 0 && <ToolList tools={tested.tools} />}
        </div>
      )}
      {error && (
        <p className="settings-error" role="alert">
          {error}
        </p>
      )}
      <div className="provider-editor__footer">
        <button type="button" className="settings-button" disabled={busy} onClick={() => onDone(false)}>
          {t('mcp.cancel')}
        </button>
        <button type="button" className="settings-button settings-button--primary" disabled={busy || !ready} onClick={() => void save()}>
          {busy ? t('mcp.saving') : t('mcp.save')}
        </button>
      </div>
    </div>
  )
}
