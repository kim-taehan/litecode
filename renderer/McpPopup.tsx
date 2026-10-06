import { useCallback, useEffect, useState } from 'react'
import type { McpScope, McpServerInput, McpServerSummary, McpTestResult, McpToolSelection, Project } from '../shared/ipc.ts'
import { ALL_TOOLS_OFF, serverCost, shortTokens, toolBudget, TOOL_BUDGET_MAX_TOKENS, withTool } from '../shared/mcpTools.ts'
import { PlusDialog, PlusGroup } from './PlusDialog.tsx'
import { byScope, mcpState, toolPicking, toolRows } from './plusView.ts'
import { reason } from './ipcError.ts'
import { useSettings, useT } from './settingsStore.ts'
import './mcp.css'

// MCP 서버 팝업 (이슈 #43 — 입력창 `+` 메뉴 > MCP 서버, 시안 _workspace/mock-plus/Mcp.dc.html). 설정 > MCP(이슈 #28)에 있던 것을 프로젝트 기준으로 옮겼다.
// - 두 묶음: "이 프로젝트만"(앱이 이 프로젝트에만 저장한 서버 + 프로젝트 폴더의 .mcp.json·opencode.json 정의) · "모든 프로젝트"(앱 서버 + 개인 설정).
//   묶음마다 "+ 서버 추가" — 그 묶음에 저장된다. 묶음은 메인(ctx.mcp)이 정한 scope 로 가른다
// - 줄: 이름(+ 출처 배지: 폴더 정의는 파일 이름, 개인 설정) · 명령/주소 · 상태(연결됨 · 도구 N / 실패 · 사유 / 꺼짐) · 스위치.
//   **스위치는 이 프로젝트에서만** 켜고 끈다. 줄을 누르면 도구 목록·편집·삭제가 펼쳐진다
// - 앱 서버만 고칠 수 있다. 폴더 정의·개인 설정 서버는 읽기 전용이고 값은 안 보인다(이름만)
// - 서버 안의 도구 고르기 (이슈 #164, 시안 _workspace/mock-tools/Main·List.dc.html): 목록 머리에 "AI 에게 가는 도구 N개 · 요청마다 약 M 토큰"
//   (많으면 주황 띠), 줄마다 "도구 켠 수 / 전체" 와 토큰 어림. 펼치면 체크 목록(검색·전부 켜기·전부 끄기). 고른 값은 이 프로젝트에만 (ctx.mcp)
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

  /** 도구 고르기 — 화면을 먼저 바꾸고 저장한다 (체크마다 목록을 다시 읽지 않게). 실패하면 다시 읽는다 */
  const setTools = (server: McpServerSummary, selection: McpToolSelection | undefined): void => {
    setServers((now) => now?.map((entry) => (entry === server ? { ...entry, toolSelection: selection } : entry)))
    window.litecode.setMcpTools(server.name, selection, directory).catch((failure: unknown) => {
      setError(reason(failure))
      void reload()
    })
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
            projectName={project.name}
            onTools={(selection) => setTools(server, selection)}
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
      {servers && <ToolBudget servers={servers} />}
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
  projectName: string
  onTools(selection: McpToolSelection | undefined): void
}

/** 목록 머리 띠 — AI 에게 가는 도구 합계 (내장 서버 포함, 꺼진 서버·꺼 둔 도구 제외). 아는 도구가 없으면(연결 전) 안 보인다 */
function ToolBudget({ servers }: { servers: McpServerSummary[] }) {
  const t = useT()
  const { language } = useSettings()
  if (!servers.some((server) => mcpState(server) === 'connected' && server.tools)) return null
  const budget = toolBudget(servers)
  return (
    <div className="mcp-budget" data-heavy={budget.heavy}>
      <span className="mcp-budget__title">{t('mcp.tools.budget', { count: budget.count, tokens: shortTokens(budget.tokens, language) })}</span>
      {budget.heavy && <span className="mcp-budget__hint">{t('mcp.tools.budgetHint')}</span>}
    </div>
  )
}

function ServerRow({ server, editing, confirming, onEdit, onDelete, onCancelDelete, onConfirmDelete, onToggle, projectName, onTools }: RowProps) {
  const t = useT()
  const { language } = useSettings()
  const [open, setOpen] = useState(false)
  const app = server.source === 'app'
  const target = maskCredentials(server.type === 'remote' ? server.url : server.command?.join(' '))
  const state = mcpState(server)
  const picking = toolPicking(server)
  const cost = state === 'connected' ? serverCost(server) : undefined
  // 출처 배지 — 폴더 정의는 그 파일 이름(시안의 ".mcp.json"), 개인 설정은 "개인 설정". 앱에서 만든 서버는 배지 없음
  // 내장 = 앱 자신의 MCP 서버(이슈 #51) — 읽기 전용, 주소 없음
  const badge =
    server.source === 'project' ? server.origin : server.source === 'personal' ? t('mcp.source.personal') : server.source === 'builtin' ? t('mcp.source.builtin') : undefined
  const stateText =
    state === 'shadowed'
      ? t('mcp.shadowed')
      : state === 'connected' && cost && cost.count < cost.total
        ? t('mcp.tools.state', { on: cost.count, total: cost.total })
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
        {(stateText || cost) && (
          <span className="mcp-row__meta">
            {stateText && (
              <span className="mcp-row__state" data-state={state} title={stateText}>
                {stateText}
              </span>
            )}
            {cost && (
              <span className="mcp-row__cost" data-heavy={cost.tokens > TOOL_BUDGET_MAX_TOKENS}>
                {t('mcp.tools.cost', { tokens: shortTokens(cost.tokens, language) })}
              </span>
            )}
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
          {picking === 'pick' && server.tools ? (
            <ToolPicker tools={server.tools} selection={server.toolSelection} onChange={onTools} />
          ) : picking === 'waiting' ? (
            <div className="mcp-row__line mcp-picker__waiting">{t('mcp.tools.waiting')}</div>
          ) : (
            server.tools && <ToolList tools={server.tools} />
          )}
          <div className="mcp-row__actions">
            {picking === 'pick' && <span className="mcp-row__scope-note">{t('mcp.tools.projectOnly', { project: projectName })}</span>}
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

/** 서버 안의 도구 고르기 (이슈 #164, 시안 _workspace/mock-tools/Main.dc.html) — 검색·전부 켜기/끄기·체크 목록(이름 + 설명 한 줄 + 토큰 어림).
 *  많으면 목록 높이를 묶고 안에서 스크롤. dsh ui-tool 의 도구 줄처럼 이름은 고정폭 */
function ToolPicker({ tools, selection, onChange }: { tools: NonNullable<McpServerSummary['tools']>; selection?: McpToolSelection; onChange(selection: McpToolSelection | undefined): void }) {
  const t = useT()
  const { language } = useSettings()
  const [query, setQuery] = useState('')
  const rows = toolRows(tools, selection, query)
  const used = serverCost({ tools, toolSelection: selection })!
  const all = serverCost({ tools })!
  return (
    <div className="mcp-picker">
      <div className="mcp-picker__head">
        <span className="mcp-picker__title">{t('mcp.tools.title')}</span>
        <span className="mcp-picker__summary">{t('mcp.tools.summary', { tokens: shortTokens(used.tokens, language), all: shortTokens(all.tokens, language) })}</span>
      </div>
      <div className="mcp-picker__bar">
        <input className="settings-input mcp-picker__search" aria-label={t('mcp.tools.search')} placeholder={t('mcp.tools.searchPlaceholder')} value={query} onChange={(event) => setQuery(event.target.value)} />
        <button type="button" className="settings-button" disabled={!selection} onClick={() => onChange(undefined)}>
          {t('mcp.tools.allOn')}
        </button>
        <button type="button" className="settings-button" disabled={!!selection?.only && selection.only.length === 0} onClick={() => onChange(ALL_TOOLS_OFF)}>
          {t('mcp.tools.allOff')}
        </button>
      </div>
      <ul className="mcp-picker__list">
        {rows.map((row) => (
          <li key={row.name}>
            <label className="mcp-picker__item" data-on={row.on} data-tool={row.name}>
              <input type="checkbox" checked={row.on} onChange={(event) => onChange(withTool(selection, row.name, event.target.checked))} />
              <span className="mcp-picker__text">
                <span className="mcp-tools__name">{row.name}</span>
                {row.description && (
                  <span className="mcp-picker__description" title={row.description}>
                    {row.description}
                  </span>
                )}
              </span>
              <span className="mcp-picker__cost">{t('mcp.tools.toolCost', { tokens: shortTokens(row.tokens, language) })}</span>
            </label>
          </li>
        ))}
        {rows.length === 0 && <li className="mcp-picker__empty">{t('mcp.tools.noMatch')}</li>}
      </ul>
      <div className="mcp-picker__note">
        <span className="mcp-picker__note-label">{t('mcp.tools.newLabel')}</span>
        <span>{t(selection?.only ? 'mcp.tools.newOff' : 'mcp.tools.newOn')}</span>
      </div>
    </div>
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

/** 줄에 보이는 명령·주소 안의 `scheme://사용자:비밀번호@` 의 비밀번호를 가린다 (DB 접속 문자열 등이 화면에 그대로 나오지 않게 — 편집 폼에는 원본이 그대로 있다) */
export function maskCredentials(text: string | undefined): string | undefined {
  return text?.replace(/(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]+@/gi, '$1••••@')
}

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
