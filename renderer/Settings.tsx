import { useEffect, useState } from 'react'
import type { ModelCatalogEntry, ProviderInput, ProviderSummary } from '../shared/ipc.ts'
import { providerIdFor } from '../shared/providerId.ts'

// 설정 모달 — 틀은 dsh ui-settings-general SettingsRoot(왼쪽 탭 목록·오른쪽 페이지·×·가림막 클릭·Esc 로 닫기),
// 모델 페이지는 dsh ui-settings-models(ModelsSection·CustomProviderCard·ModelListEditor·ModelRow·EditorFooter)를 따른다:
// provider 카드 목록, 편집 카드는 한 번에 하나, API 키는 쓰기 전용(저장된 값은 안 보이고 설정 여부만), 삭제는 한 번 더 확인.
// dsh 와 다른 점: "모델 가져오기" 는 고르는 창 없이 없는 id 만 목록에 더한다(00_request 성공 기준 4). 탭은 지금 "모델" 하나뿐.

/** Electron 이 IPC 오류 앞에 붙이는 "Error invoking remote method '…': Error: " 를 떼고 사유만 */
function reason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}

interface SettingsModalProps {
  providers: ProviderSummary[]
  onProvidersChange(providers: ProviderSummary[]): void
  onClose(): void
}

export function SettingsModal({ providers, onProvidersChange, onClose }: SettingsModalProps) {
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  return (
    <div className="settings-overlay" role="presentation">
      <div className="settings-mask" aria-hidden="true" onClick={onClose} />
      <div className="settings-panel" role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <nav className="settings-nav">
          <div className="settings-nav__title" id="settings-title">
            설정
          </div>
          <button type="button" className="settings-nav__item settings-nav__item--active" aria-current="page">
            모델
          </button>
        </nav>
        <div className="settings-content">
          <button type="button" className="settings-close" aria-label="닫기" onClick={onClose}>
            ×
          </button>
          <ModelsPage providers={providers} onProvidersChange={onProvidersChange} />
        </div>
      </div>
    </div>
  )
}

/** 편집 중인 카드 — provider id, 새로 추가하는 중이면 NEW */
const NEW = Symbol('new')

function ModelsPage({ providers, onProvidersChange }: Omit<SettingsModalProps, 'onClose'>) {
  const [editing, setEditing] = useState<string | typeof NEW>()
  const [confirmingDelete, setConfirmingDelete] = useState<string>()
  const [error, setError] = useState<string>()

  async function remove(id: string): Promise<void> {
    setConfirmingDelete(undefined)
    try {
      onProvidersChange(await window.litecode.removeProvider(id))
    } catch (failure) {
      setError(reason(failure))
    }
  }

  return (
    <div className="models-page">
      <h2 className="models-page__title">모델</h2>
      <p className="models-page__hint">모델을 제공하는 게이트웨이(OpenAI 호환)를 설정합니다.</p>
      {error && (
        <p className="settings-error" role="alert">
          {error}
        </p>
      )}
      {providers.map((provider) => (
        <div key={provider.id} className="provider-card">
          <div className="provider-card__head">
            <span className="provider-card__name">{provider.displayName}</span>
            {provider.custom && <span className="provider-card__tag">Custom</span>}
            <span
              className={`status-dot${provider.hasKey ? ' status-dot--ok' : ' status-dot--none'}`}
              title={provider.hasKey ? 'API 키 설정됨' : 'API 키 없음'}
              role="img"
              aria-label={provider.hasKey ? 'API 키 설정됨' : 'API 키 없음'}
            />
            <span className="provider-card__actions">
              {confirmingDelete === provider.id ? (
                <>
                  <button type="button" className="settings-button settings-button--danger" onClick={() => void remove(provider.id)}>
                    삭제 확인
                  </button>
                  <button type="button" className="settings-button" onClick={() => setConfirmingDelete(undefined)}>
                    취소
                  </button>
                </>
              ) : (
                editing !== provider.id && (
                  <>
                    <button type="button" className="settings-button" onClick={() => setEditing(provider.id)}>
                      편집
                    </button>
                    <button type="button" className="settings-button" onClick={() => setConfirmingDelete(provider.id)}>
                      삭제
                    </button>
                  </>
                )
              )}
            </span>
          </div>
          {editing === provider.id && (
            <ProviderEditor
              provider={provider}
              taken={providers}
              onDone={(saved) => {
                if (saved) onProvidersChange(saved)
                setEditing(undefined)
              }}
            />
          )}
        </div>
      ))}
      {editing === NEW ? (
        <div className="provider-card">
          <div className="provider-card__head">
            <span className="provider-card__name">새 provider</span>
          </div>
          <ProviderEditor
            taken={providers}
            onDone={(saved) => {
              if (saved) onProvidersChange(saved)
              setEditing(undefined)
            }}
          />
        </div>
      ) : (
        <button type="button" className="models-page__add" onClick={() => setEditing(NEW)}>
          + provider 추가
        </button>
      )}
    </div>
  )
}

interface ProviderEditorProps {
  /** 없으면 새 provider */
  provider?: ProviderSummary
  taken: ProviderSummary[]
  /** 적용했으면 바뀐 목록, 취소면 undefined */
  onDone(saved?: ProviderSummary[]): void
}

function ProviderEditor({ provider, taken, onDone }: ProviderEditorProps) {
  const [displayName, setDisplayName] = useState(provider?.displayName ?? '')
  const [baseURL, setBaseURL] = useState(provider?.baseURL ?? '')
  const [apiKey, setApiKey] = useState('')
  const [models, setModels] = useState<ModelCatalogEntry[]>(provider?.models ?? [])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const id = provider?.id ?? providerIdFor(displayName, (candidate) => taken.some((entry) => entry.id === candidate))

  function setModel(index: number, change: Partial<ModelCatalogEntry>): void {
    setModels((current) => current.map((model, at) => (at === index ? { ...model, ...change } : model)))
  }

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

  const fetchModels = () =>
    run(async () => {
      const fetched = await window.litecode.fetchProviderModels({ id: provider?.id, baseURL, apiKey })
      setModels((current) => [...current, ...fetched.filter((model) => !current.some((entry) => entry.id === model.id))])
    })

  const apply = () =>
    run(async () => {
      const input: ProviderInput = { id: provider?.id, displayName, baseURL, protocol: 'openai-chat-completions', models, apiKey }
      onDone(await window.litecode.saveProvider(input))
    })

  return (
    <div className="provider-editor">
      <label className="settings-field">
        <span className="settings-field__label">표시 이름</span>
        <input className="settings-input" aria-label="표시 이름" value={displayName} disabled={busy} onChange={(event) => setDisplayName(event.target.value)} />
      </label>
      <label className="settings-field">
        <span className="settings-field__label">id</span>
        <input className="settings-input settings-input--readonly" aria-label="id" value={id} readOnly tabIndex={-1} />
      </label>
      <label className="settings-field">
        <span className="settings-field__label">API 키</span>
        <input
          className="settings-input"
          aria-label="API 키"
          type="password"
          autoComplete="new-password"
          value={apiKey}
          placeholder={provider?.hasKey ? '설정됨 — 바꾸려면 새 키 입력' : 'API 키 (없으면 비워 두기)'}
          disabled={busy}
          onChange={(event) => setApiKey(event.target.value)}
        />
      </label>
      <label className="settings-field">
        <span className="settings-field__label">Base URL</span>
        <input
          className="settings-input"
          aria-label="Base URL"
          value={baseURL}
          placeholder="https://gateway.example/v1"
          disabled={busy}
          onChange={(event) => setBaseURL(event.target.value)}
        />
      </label>
      <label className="settings-field">
        <span className="settings-field__label">API 프로토콜</span>
        <select className="settings-input" aria-label="API 프로토콜" value="openai-chat-completions" disabled={busy} onChange={() => {}}>
          <option value="openai-chat-completions">OpenAI Chat Completions</option>
        </select>
      </label>

      <div className="settings-field__label">모델</div>
      {models.map((model, index) => (
        <div key={index} className="model-row">
          <input
            className="settings-input"
            aria-label={`모델 id ${index + 1}`}
            placeholder="모델 id"
            value={model.id}
            disabled={busy}
            onChange={(event) => setModel(index, { id: event.target.value })}
          />
          <input
            className="settings-input"
            aria-label={`모델 이름 ${index + 1}`}
            placeholder="표시 이름"
            value={model.displayName}
            disabled={busy}
            onChange={(event) => setModel(index, { displayName: event.target.value })}
          />
          {/* opencode 는 custom 모델의 한도를 모른다 — 적으면 엔진에 넘기고 입력창 통계 줄의 컨텍스트 % 가 보인다 (비우면 "—") */}
          <input
            className="settings-input"
            aria-label={`컨텍스트 길이 ${index + 1}`}
            placeholder="컨텍스트 길이"
            title="컨텍스트 길이 (토큰, 선택)"
            type="number"
            min={1}
            step={1}
            value={model.contextLength ?? ''}
            disabled={busy}
            onChange={(event) => setModel(index, { contextLength: event.target.value === '' ? undefined : Number(event.target.value) })}
          />
          <button
            type="button"
            className="settings-icon-button"
            aria-label={`모델 삭제 ${index + 1}`}
            title="모델 삭제"
            disabled={busy}
            onClick={() => setModels((current) => current.filter((_, at) => at !== index))}
          >
            ×
          </button>
        </div>
      ))}
      <div className="provider-editor__model-actions">
        <button type="button" className="settings-button" disabled={busy} onClick={() => setModels((current) => [...current, { id: '', displayName: '' }])}>
          + 모델 추가
        </button>
        <button type="button" className="settings-button" disabled={busy || !baseURL.trim()} onClick={() => void fetchModels()}>
          사용 가능한 모델 가져오기
        </button>
      </div>

      {error && (
        <p className="settings-error" role="alert">
          {error}
        </p>
      )}
      <div className="provider-editor__footer">
        <button type="button" className="settings-button" disabled={busy} onClick={() => onDone()}>
          취소
        </button>
        <button
          type="button"
          className="settings-button settings-button--primary"
          disabled={busy || !displayName.trim() || !baseURL.trim() || models.length === 0}
          onClick={() => void apply()}
        >
          {busy ? '적용 중…' : '적용'}
        </button>
      </div>
    </div>
  )
}
