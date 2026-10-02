import { useEffect, useState, type ReactNode } from 'react'
import type { ModelCatalogEntry, ProviderInput, ProviderSummary } from '../shared/ipc.ts'
import { providerIdFor } from '../shared/providerId.ts'
import { GeneralPage } from './GeneralSettings.tsx'
import { useT } from './settingsStore.ts'
import './settings.css'

// 설정 모달 — 틀은 dsh ui-settings-general SettingsRoot(왼쪽 메뉴·오른쪽 머리줄[설정 파일 열기][×]·내용, 가림막 클릭·Esc 로 닫기),
// 치수는 01f 디자인 표 그대로(800×800 판·반경 28·메뉴 188 바탕 없음). 페이지는 일반(GeneralSettings.tsx)·모델.
// 모델 페이지는 dsh ui-settings-models(ModelsSection·CustomProviderCard·ModelListEditor·ModelRow·EditorFooter)를 따른다:
// provider 카드 목록, 편집 카드는 한 번에 하나, API 키는 쓰기 전용(저장된 값은 안 보이고 설정 여부만), 삭제는 한 번 더 확인.
// dsh 와 다른 점: "모델 가져오기" 는 고르는 창 없이 없는 id 만 목록에 더한다(00_request 성공 기준 4).
// 처음 여는 페이지는 모델이다 — 일반 페이지가 생기기 전부터 설정 버튼이 모델을 열었다(실물 테스트가 그 동작을 지킨다). dsh 는 일반을 먼저 연다

/** Electron 이 IPC 오류 앞에 붙이는 "Error invoking remote method '…': Error: " 를 떼고 사유만 */
function reason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}

type Page = 'general' | 'models'

interface SettingsModalProps {
  providers: ProviderSummary[]
  onProvidersChange(providers: ProviderSummary[]): void
  onClose(): void
}

/** 16px 외곽선 톱니 — 일반 메뉴 */
function GearIcon() {
  return (
    <svg className="settings-nav__icon" width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" aria-hidden="true">
      <path d="M15.64 8.26L17.35 8.51L17.35 11.49L15.64 11.74L15.22 12.75L16.25 14.14L14.14 16.25L12.75 15.22L11.74 15.64L11.49 17.35L8.51 17.35L8.26 15.64L7.25 15.22L5.86 16.25L3.75 14.14L4.78 12.75L4.36 11.74L2.65 11.49L2.65 8.51L4.36 8.26L4.78 7.25L3.75 5.86L5.86 3.75L7.25 4.78L8.26 4.36L8.51 2.65L11.49 2.65L11.74 4.36L12.75 4.78L14.14 3.75L16.25 5.86L15.22 7.25Z" />
      <circle cx="10" cy="10" r="2.5" />
    </svg>
  )
}

/** 16px 데이터(원통) — 모델 메뉴 */
function DataIcon() {
  return (
    <svg className="settings-nav__icon" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden="true">
      <ellipse cx="8" cy="3.8" rx="5.5" ry="2.3" />
      <path d="M2.5 3.8V12.2C2.5 13.5 4.96 14.5 8 14.5S13.5 13.5 13.5 12.2V3.8M2.5 8C2.5 9.3 4.96 10.3 8 10.3S13.5 9.3 13.5 8" />
    </svg>
  )
}

function CloseIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" aria-hidden="true">
      <path d="M3 3L11 11M11 3L3 11" />
    </svg>
  )
}

export function SettingsModal({ providers, onProvidersChange, onClose }: SettingsModalProps) {
  const t = useT()
  const [page, setPage] = useState<Page>('models')
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  const pages: { id: Page; label: string; icon: ReactNode }[] = [
    { id: 'general', label: t('settings.nav.general'), icon: <GearIcon /> },
    { id: 'models', label: t('settings.nav.models'), icon: <DataIcon /> },
  ]

  return (
    <div className="settings-overlay" role="presentation">
      <div className="settings-mask" aria-hidden="true" onClick={onClose} />
      <div className="settings-panel" role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <nav className="settings-nav">
          <div className="settings-nav__title" id="settings-title">
            {t('settings.title')}
          </div>
          <div className="settings-nav__list">
            {pages.map((entry) => (
              <button
                key={entry.id}
                type="button"
                className={`settings-nav__item${entry.id === page ? ' settings-nav__item--active' : ''}`}
                aria-current={entry.id === page ? 'page' : undefined}
                onClick={() => setPage(entry.id)}
              >
                {entry.icon}
                <span>{entry.label}</span>
              </button>
            ))}
          </div>
        </nav>
        <div className="settings-content">
          <div className="settings-header">
            <OpenFileAction />
            <button type="button" className="settings-close" aria-label={t('settings.close')} onClick={onClose}>
              <CloseIcon />
            </button>
          </div>
          <div className="settings-body">
            {page === 'general' ? <GeneralPage /> : <ModelsPage providers={providers} onProvidersChange={onProvidersChange} />}
          </div>
        </div>
      </div>
    </div>
  )
}

/** 머리줄의 "설정 파일 열기" (dsh SettingsDocumentAction) — 못 열면 버튼 왼쪽에 사유, 버튼은 남는다 */
function OpenFileAction() {
  const t = useT()
  const [opening, setOpening] = useState(false)
  const [error, setError] = useState<string>()
  async function open(): Promise<void> {
    setOpening(true)
    setError(undefined)
    try {
      await window.litecode.openSettingsFile()
    } catch (failure) {
      setError(reason(failure))
    } finally {
      setOpening(false)
    }
  }
  return (
    <div className="settings-header__actions">
      {error && (
        <span className="settings-header__error" role="alert" title={error}>
          {error}
        </span>
      )}
      <button type="button" className="settings-outline-button" disabled={opening} onClick={() => void open()}>
        {t('settings.openFile')}
      </button>
    </div>
  )
}

/** 편집 중인 카드 — provider id, 새로 추가하는 중이면 NEW */
const NEW = Symbol('new')

function ModelsPage({ providers, onProvidersChange }: Omit<SettingsModalProps, 'onClose'>) {
  const t = useT()
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
      <h2 className="models-page__title">{t('models.title')}</h2>
      <p className="models-page__hint">{t('models.hint')}</p>
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
              title={provider.hasKey ? t('models.keySet') : t('models.keyNone')}
              role="img"
              aria-label={provider.hasKey ? t('models.keySet') : t('models.keyNone')}
            />
            <span className="provider-card__actions">
              {confirmingDelete === provider.id ? (
                <>
                  <button type="button" className="settings-button settings-button--danger" onClick={() => void remove(provider.id)}>
                    {t('models.confirmDelete')}
                  </button>
                  <button type="button" className="settings-button" onClick={() => setConfirmingDelete(undefined)}>
                    {t('models.cancel')}
                  </button>
                </>
              ) : (
                editing !== provider.id && (
                  <>
                    <button type="button" className="settings-button" onClick={() => setEditing(provider.id)}>
                      {t('models.edit')}
                    </button>
                    <button type="button" className="settings-button" onClick={() => setConfirmingDelete(provider.id)}>
                      {t('models.delete')}
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
            <span className="provider-card__name">{t('models.newProvider')}</span>
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
          {t('models.addProvider')}
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
  const t = useT()
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
        <span className="settings-field__label">{t('models.displayName')}</span>
        <input className="settings-input" aria-label={t('models.displayName')} value={displayName} disabled={busy} onChange={(event) => setDisplayName(event.target.value)} />
      </label>
      <label className="settings-field">
        <span className="settings-field__label">id</span>
        <input className="settings-input settings-input--readonly" aria-label="id" value={id} readOnly tabIndex={-1} />
      </label>
      <label className="settings-field">
        <span className="settings-field__label">{t('models.apiKey')}</span>
        <input
          className="settings-input"
          aria-label={t('models.apiKey')}
          type="password"
          autoComplete="new-password"
          value={apiKey}
          placeholder={provider?.hasKey ? t('models.keyPlaceholderSet') : t('models.keyPlaceholderNone')}
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
        <span className="settings-field__label">{t('models.protocol')}</span>
        <select className="settings-input" aria-label={t('models.protocol')} value="openai-chat-completions" disabled={busy} onChange={() => {}}>
          <option value="openai-chat-completions">OpenAI Chat Completions</option>
        </select>
      </label>

      <div className="settings-field__label">{t('models.models')}</div>
      {models.map((model, index) => (
        <div key={index} className="model-row">
          <input
            className="settings-input"
            aria-label={t('models.modelId', { n: index + 1 })}
            placeholder={t('models.modelIdPlaceholder')}
            value={model.id}
            disabled={busy}
            onChange={(event) => setModel(index, { id: event.target.value })}
          />
          <input
            className="settings-input"
            aria-label={t('models.modelName', { n: index + 1 })}
            placeholder={t('models.modelNamePlaceholder')}
            value={model.displayName}
            disabled={busy}
            onChange={(event) => setModel(index, { displayName: event.target.value })}
          />
          {/* opencode 는 custom 모델의 한도를 모른다 — 적으면 엔진에 넘기고 입력창 통계 줄의 컨텍스트 % 가 보인다 (비우면 "—") */}
          <input
            className="settings-input"
            aria-label={t('models.contextLength', { n: index + 1 })}
            placeholder={t('models.contextLengthPlaceholder')}
            title={t('models.contextLengthTitle')}
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
            aria-label={t('models.removeModel', { n: index + 1 })}
            title={t('models.removeModelTitle')}
            disabled={busy}
            onClick={() => setModels((current) => current.filter((_, at) => at !== index))}
          >
            ×
          </button>
        </div>
      ))}
      <div className="provider-editor__model-actions">
        <button type="button" className="settings-button" disabled={busy} onClick={() => setModels((current) => [...current, { id: '', displayName: '' }])}>
          {t('models.addModel')}
        </button>
        <button type="button" className="settings-button" disabled={busy || !baseURL.trim()} onClick={() => void fetchModels()}>
          {t('models.fetch')}
        </button>
      </div>

      {error && (
        <p className="settings-error" role="alert">
          {error}
        </p>
      )}
      <div className="provider-editor__footer">
        <button type="button" className="settings-button" disabled={busy} onClick={() => onDone()}>
          {t('models.cancel')}
        </button>
        <button
          type="button"
          className="settings-button settings-button--primary"
          disabled={busy || !displayName.trim() || !baseURL.trim() || models.length === 0}
          onClick={() => void apply()}
        >
          {busy ? t('models.applying') : t('models.apply')}
        </button>
      </div>
    </div>
  )
}
