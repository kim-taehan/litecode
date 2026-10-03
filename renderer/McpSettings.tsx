import { useCallback, useEffect, useState } from 'react'
import type { McpServerInput, McpServerSummary, McpTestResult } from '../shared/ipc.ts'
import { reason } from './Settings.tsx'
import { useT } from './settingsStore.ts'
import './mcp.css'

// 설정 > MCP (이슈 #28). 모양은 모델 페이지(dsh ui-settings-models 의 카드 목록·편집 카드 하나·쓰기 전용 비밀·두 번 눌러 삭제)를 그대로 따르고,
// 줄 하나에 01u 화면 스케치 ①의 정보(이름·출처 배지·종류·주소/명령·상태·도구 수·켜기)를 담는다. 상태 점은 dsh ui-primitives 의 상태 점.
// - 앱 서버만 고칠 수 있다. 프로젝트(.mcp.json·opencode.json)·개인 설정(~/.config/opencode) 서버는 읽기 전용이고 값은 안 보인다(이름만)
// - 상태는 지금 프로젝트 폴더 기준이다 (opencode 는 폴더마다 서버를 띄운다). 프로젝트가 없으면 상태 없이
// - 비밀(헤더·env 값 중 "비밀" 표시)은 쓰기 전용 — 저장된 값은 안 보이고 "저장됨" 만. 빈 칸으로 두면 그대로 둔다
// - 연결 테스트는 저장하지 않고 앱이 직접 잠깐 붙어 도구 목록을 본다

const NEW = Symbol('new')

export function McpPage({ directory }: { directory?: string }) {
  const t = useT()
  const [servers, setServers] = useState<McpServerSummary[]>()
  const [error, setError] = useState<string>()
  const [editing, setEditing] = useState<string | typeof NEW>()
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

  return (
    <div className="models-page mcp-page">
      <h2 className="models-page__title">{t('mcp.title')}</h2>
      <p className="models-page__hint">{t('mcp.hint')}</p>
      {!directory && <p className="models-page__hint">{t('mcp.noProject')}</p>}
      {error && (
        <p className="settings-error" role="alert">
          {error}
        </p>
      )}
      {!servers && <p className="models-page__hint">{t('mcp.loading')}</p>}
      {servers?.length === 0 && editing !== NEW && <p className="models-page__hint">{t('mcp.empty')}</p>}
      {servers?.map((server) => (
        <div key={`${server.source}:${server.name}`} className="provider-card mcp-card" data-mcp={server.name} data-source={server.source}>
          <ServerRow
            server={server}
            editable={editing !== server.name}
            confirming={confirming === server.name}
            onEdit={() => setEditing(server.name)}
            onDelete={() => setConfirming(server.name)}
            onCancelDelete={() => setConfirming(undefined)}
            onConfirmDelete={() => {
              setConfirming(undefined)
              void act(() => window.litecode.removeMcp(server.name))
            }}
            onToggle={(on) => void act(() => window.litecode.setMcpEnabled(server.name, on))}
          />
          {editing === server.name && (
            <ServerEditor
              server={server}
              directory={directory}
              onDone={(saved) => {
                setEditing(undefined)
                if (saved) void reload()
              }}
            />
          )}
        </div>
      ))}
      {editing === NEW ? (
        <div className="provider-card mcp-card" data-mcp="">
          <div className="provider-card__head">
            <span className="provider-card__name">{t('mcp.newServer')}</span>
          </div>
          <ServerEditor
            directory={directory}
            onDone={(saved) => {
              setEditing(undefined)
              if (saved) void reload()
            }}
          />
        </div>
      ) : (
        <button type="button" className="models-page__add" onClick={() => setEditing(NEW)}>
          {t('mcp.add')}
        </button>
      )}
    </div>
  )
}

interface RowProps {
  server: McpServerSummary
  editable: boolean
  confirming: boolean
  onEdit(): void
  onDelete(): void
  onCancelDelete(): void
  onConfirmDelete(): void
  onToggle(on: boolean): void
}

function ServerRow({ server, editable, confirming, onEdit, onDelete, onCancelDelete, onConfirmDelete, onToggle }: RowProps) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const app = server.source === 'app'
  const target = server.type === 'remote' ? server.url : server.command?.join(' ')
  const status = server.status ?? (server.enabled ? undefined : 'disabled')
  const statusText = status ? (isKnownStatus(status) ? t(`mcp.status.${status}`) : status) : undefined
  return (
    <>
      <div className="provider-card__head mcp-card__head">
        <span className={`mcp-dot mcp-dot--${status ?? 'none'}`} aria-hidden="true" />
        <span className="provider-card__name mcp-card__name">{server.name}</span>
        <span className="provider-card__tag mcp-card__source">{t(`mcp.source.${server.source}`)}</span>
        <span className="provider-card__actions">
          {app && confirming ? (
            <>
              <button type="button" className="settings-button settings-button--danger" onClick={onConfirmDelete}>
                {t('mcp.confirmDelete')}
              </button>
              <button type="button" className="settings-button" onClick={onCancelDelete}>
                {t('mcp.cancel')}
              </button>
            </>
          ) : app && editable ? (
            <>
              <button type="button" className="settings-button" onClick={onEdit}>
                {t('mcp.edit')}
              </button>
              <button type="button" className="settings-button" onClick={onDelete}>
                {t('mcp.delete')}
              </button>
            </>
          ) : (
            !app && <span className="mcp-card__readonly">{t('mcp.readOnly')}</span>
          )}
          {app && (
            <button
              type="button"
              role="switch"
              className="settings-switch"
              aria-checked={server.enabled}
              aria-label={t('mcp.enabled', { name: server.name })}
              onClick={() => onToggle(!server.enabled)}
            >
              <span className="settings-switch__thumb" />
            </button>
          )}
        </span>
      </div>
      <div className="mcp-card__meta">
        {server.type && <span>{t(`mcp.type.${server.type}`)}</span>}
        {target && (
          <span className="mcp-card__target" title={target}>
            {target}
          </span>
        )}
      </div>
      <div className="mcp-card__state">
        {statusText && <span className="mcp-card__status">{statusText}</span>}
        {server.error && (
          <span className="mcp-card__error" title={server.error}>
            {server.error}
          </span>
        )}
        {server.shadowed && <span className="mcp-card__error">{t('mcp.shadowed')}</span>}
        {server.tools && (
          <button type="button" className="mcp-card__tools-toggle" aria-expanded={open} title={open ? t('mcp.hideTools') : t('mcp.showTools')} onClick={() => setOpen((now) => !now)}>
            {t('mcp.toolCount', { count: server.tools.length })}
          </button>
        )}
        {server.toolsError && (
          <span className="mcp-card__error" title={server.toolsError}>
            {server.toolsError}
          </span>
        )}
      </div>
      {open && server.tools && <ToolList tools={server.tools} />}
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

function ServerEditor({ server, directory, onDone }: { server?: McpServerSummary; directory?: string; onDone(saved: boolean): void }) {
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
    ...(server && { originalName: server.name }),
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
      await window.litecode.saveMcp(input())
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
