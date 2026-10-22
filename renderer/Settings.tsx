import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { ModelCatalogEntry, ProviderInput, ProviderSummary } from '../shared/ipc.ts'
import { providerIdFor } from '../shared/providerId.ts'
import { engineModelKeys } from '../shared/engineModelId.ts'
import { GeneralPage } from './GeneralSettings.tsx'
import { FeaturesPage } from './FeaturesSettings.tsx'
import { MobilePage } from './MobileSettings.tsx'
import { ShortcutsPage } from './ShortcutsPage.tsx'
import { useFeatures } from './featuresStore.ts'
import { useT } from './settingsStore.ts'
import { COMPACTION_MIN_THRESHOLD, isLowContext } from './compaction.ts'
import { tokenLabel } from './tokenLabel.ts'
import './compaction.css'
import { defaultOutputLimit } from '../shared/outputLimit.ts'
import { ErrorBoundary } from './ErrorBoundary.tsx'
import { useFocusTrap } from './focusTrap.ts'
import { reason } from './ipcError.ts'
import './settings.css'

// 설정 모달 — 틀은 dsh ui-settings-general SettingsRoot(왼쪽 메뉴·오른쪽 머리줄[설정 파일 열기][×]·내용, 가림막 클릭·Esc 로 닫기),
// 치수는 01f 디자인 표 그대로(800×800 판·반경 28·메뉴 188 바탕 없음). 페이지는 일반(GeneralSettings.tsx)·모델·기능(FeaturesSettings.tsx),
// 그리고 기능 `remote` 가 켜졌을 때만 모바일(MobileSettings.tsx, 이슈 #56).
// 스킬·MCP 는 입력창 `+` 메뉴의 팝업으로 옮겼다 (이슈 #43 — 같은 것이 두 군데 있지 않게).
// 모델 페이지는 dsh ui-settings-models(ModelsSection·CustomProviderCard·ModelListEditor·ModelRow·EditorFooter)를 따른다:
// provider 카드 목록, 편집 카드는 한 번에 하나, API 키는 쓰기 전용(저장된 값은 안 보이고 설정 여부만), 삭제는 한 번 더 확인.
// dsh 와 다른 점: "모델 가져오기" 는 고르는 창 없이 없는 id 만 목록에 더한다(00_request 성공 기준 4).
// 처음 여는 페이지는 모델이다 — 일반 페이지가 생기기 전부터 설정 버튼이 모델을 열었다(실물 테스트가 그 동작을 지킨다). dsh 는 일반을 먼저 연다

type Page = 'general' | 'models' | 'features' | 'mobile' | 'shortcuts'

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

/** 16px 퍼즐 조각 — 기능 메뉴 (dsh Built-in plugins 메뉴 자리) */
function PuzzleIcon() {
  return (
    <svg className="settings-nav__icon" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" aria-hidden="true">
      <path d="M2.5 5.5H5.2A1.6 1.6 0 1 1 8.4 5.5H11V8.1A1.6 1.6 0 1 1 11 11.3V13.5H2.5Z" />
    </svg>
  )
}

/** 16px 키보드 — 단축키 메뉴 */
function KeyboardIcon() {
  return (
    <svg className="settings-nav__icon" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" aria-hidden="true">
      <rect x="1.5" y="4.5" width="13" height="7" rx="1.5" />
      <path d="M4 7h.01M7 7h.01M10 7h.01M4 9.5h8" />
    </svg>
  )
}

/** 16px 폰 — 모바일 메뉴 */
function PhoneIcon() {
  return (
    <svg className="settings-nav__icon" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" aria-hidden="true">
      <rect x="4.5" y="1.5" width="7" height="13" rx="1.6" />
      <path d="M7.2 12.4H8.8" />
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
  const [page, setPage] = useState<Page>('general') // 첫 페이지는 일반 (dsh)
  const mobileOn = useFeatures().has('remote')
  // aria-modal 인 판 — Tab 이 뒤 화면으로 나가지 않게 가둔다 (focusTrap.ts)
  const panelRef = useRef<HTMLDivElement>(null)
  useFocusTrap(panelRef)
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.isComposing) return // 한글 조합 중의 Esc 는 조합 취소다 — 판을 닫아 쓰던 폼을 날리지 않는다
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  const pages: { id: Page; label: string; icon: ReactNode }[] = [
    { id: 'general', label: t('settings.nav.general'), icon: <GearIcon /> },
    { id: 'models', label: t('settings.nav.models'), icon: <DataIcon /> },
    { id: 'features', label: t('settings.nav.features'), icon: <PuzzleIcon /> },
    { id: 'shortcuts', label: t('settings.nav.shortcuts'), icon: <KeyboardIcon /> },
    ...(mobileOn ? [{ id: 'mobile' as const, label: t('settings.nav.mobile'), icon: <PhoneIcon /> }] : []),
  ]
  // 모바일 페이지를 보다가 그 기능을 끄면(다른 창·설정 파일) 일반으로 돌아간다
  const shown = page === 'mobile' && !mobileOn ? 'general' : page

  return (
    <div className="settings-overlay" role="presentation">
      <div className="settings-mask" aria-hidden="true" onClick={onClose} />
      <div className="settings-panel" ref={panelRef} role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <nav className="settings-nav">
          <div className="settings-nav__title" id="settings-title">
            {t('settings.title')}
          </div>
          <div className="settings-nav__list">
            {pages.map((entry) => (
              <button
                key={entry.id}
                type="button"
                className={`settings-nav__item${entry.id === shown ? ' settings-nav__item--active' : ''}`}
                aria-current={entry.id === shown ? 'page' : undefined}
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
            {/* 페이지 하나의 그리기 오류가 앱을 내리지 않게 — 메뉴·닫기는 남고, 다른 페이지로 가면 풀린다 */}
            <ErrorBoundary scope="section" resetKey={shown}>
              {shown === 'general' ? (
                <GeneralPage />
              ) : shown === 'features' ? (
                <FeaturesPage />
              ) : shown === 'mobile' ? (
                <MobilePage />
              ) : shown === 'shortcuts' ? (
                <ShortcutsPage />
              ) : (
                <ModelsPage providers={providers} onProvidersChange={onProvidersChange} />
              )}
            </ErrorBoundary>
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

export function ModelsPage({ providers, onProvidersChange }: Omit<SettingsModalProps, 'onClose'>) {
  const t = useT()
  const [editing, setEditing] = useState<string | typeof NEW>()
  const [confirmingDelete, setConfirmingDelete] = useState<string>()
  const [error, setError] = useState<string>()
  // 키를 못 푼 기록(keyLocked, 이슈 #231)은 대화 도중에 생긴다 — 페이지를 열 때 목록을 다시 읽는다
  useEffect(() => {
    void window.litecode.listProviders().then(onProvidersChange, () => {})
  }, [])

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
      {providers.some((provider) => provider.keyLocked) && (
        <p className="settings-notice" role="status">
          {t('models.keyStoreLocked')}
        </p>
      )}
      {error && (
        <p className="settings-error" role="alert">
          {error}
        </p>
      )}
      {providers.map((provider) =>
        // 편집 중인 provider 는 머리줄 대신 편집기만(시안 A — 편집기가 자기 머리에 이름·상태를 그린다), 카드 틀 없이
        editing === provider.id ? (
          <div key={provider.id} className="provider-card provider-card--editing">
            <ProviderEditor
              provider={provider}
              taken={providers}
              onDone={(saved) => {
                if (saved) onProvidersChange(saved)
                setEditing(undefined)
              }}
            />
          </div>
        ) : (
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
                    <button type="button" className="settings-button settings-button--compact settings-button--danger" onClick={() => void remove(provider.id)}>
                      {t('models.confirmDelete')}
                    </button>
                    <button type="button" className="settings-button settings-button--compact" onClick={() => setConfirmingDelete(undefined)}>
                      {t('models.cancel')}
                    </button>
                  </>
                ) : (
                  <>
                    <button type="button" className="settings-button settings-button--compact" onClick={() => setEditing(provider.id)}>
                      {t('models.edit')}
                    </button>
                    <button type="button" className="settings-button settings-button--compact settings-button--ghost-danger" onClick={() => setConfirmingDelete(provider.id)}>
                      {t('models.delete')}
                    </button>
                  </>
                )}
              </span>
            </div>
          </div>
        ),
      )}
      {editing === NEW ? (
        <div className="provider-card provider-card--editing">
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

/** 모델 표의 아이콘 토글 — 켜면 연한 파랑 채움, 끄면 흐린 아이콘 (이슈 #477 → #542 시안 A) */
function ModelToggle({ on, icon, ariaLabel, title, disabled, onToggle }: { on: boolean; icon: ReactNode; ariaLabel: string; title: string; disabled: boolean; onToggle(on: boolean): void }) {
  return (
    <button type="button" className="model-row__toggle" aria-pressed={on} aria-label={ariaLabel} title={title} disabled={disabled} onClick={() => onToggle(!on)}>
      {icon}
    </button>
  )
}

function ImageIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="4" width="18" height="16" rx="3" />
      <circle cx="9" cy="10" r="1.6" />
      <path d="M21 16l-5-5-8 9" />
    </svg>
  )
}

function BulbIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9c.6.4 1 1.1 1 1.8V16h5v-.3c0-.7.4-1.4 1-1.8A6 6 0 0 0 12 3z" />
    </svg>
  )
}

/** 머리·고르는 칸의 프로토콜 이름 — 지금은 하나뿐 */
const PROTOCOL_LABEL = 'OpenAI Chat'

/** 표에서 눌러 고치는 칸 — 누른 칸에 포커스를 준다 */
type ModelField = 'id' | 'name' | 'context' | 'output'

interface ProviderEditorProps {
  /** 없으면 새 provider */
  provider?: ProviderSummary
  taken: ProviderSummary[]
  /** 적용했으면 바뀐 목록, 취소면 undefined */
  onDone(saved?: ProviderSummary[]): void
  /** 처음부터 편집 중인 줄 — 테스트가 입력칸을 그릴 때 */
  initialEditing?: number
}

// provider 편집 (이슈 #542 시안 A, _workspace/mock-models-redesign/Main.dc.html): 흰 바탕·카드 없이 큰 제목(표시 이름) + `키 상태 · id · 모델 N개`,
// 연결(프로토콜|Base URL 한 줄, API 키는 있으면 •••• [바꾸기]), 모델 표(id·표시 이름·컨텍스트·최대 출력·기능 아이콘·×). 칸을 누르면 그 줄이 편집 줄이 되어
// 제자리에서 입력한다(한 번에 한 줄). 긴 설명 문단은 표 아래 한 줄 + 열 이름·아이콘 툴팁으로. 동작(저장·검증·가져오기)은 그대로
export function ProviderEditor({ provider, taken, onDone, initialEditing }: ProviderEditorProps) {
  const t = useT()
  const [displayName, setDisplayName] = useState(provider?.displayName ?? '')
  const [baseURL, setBaseURL] = useState(provider?.baseURL ?? '')
  const [apiKey, setApiKey] = useState('')
  const [changingKey, setChangingKey] = useState(false)
  const [models, setModels] = useState<ModelCatalogEntry[]>(provider?.models ?? [])
  const [editing, setEditing] = useState<{ row: number; field?: ModelField } | undefined>(initialEditing === undefined ? undefined : { row: initialEditing })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const id = provider?.id ?? providerIdFor(displayName, (candidate) => taken.some((entry) => entry.id === candidate))
  // 키가 겹치는 항목 — 저장이 거절할 것을 id 칸 빨간 표시로 미리 (이슈 #497 시안 F → #500). 저장 검증과 같은 키 기준(같은 id, Thinking 모델의
  // 파생 키 id--think·id--nothink 와 같은 진짜 id), 빈 id 는 따로 거절된다
  const keys = models.map((model) => engineModelKeys({ ...model, id: model.id.trim() }))
  const clashes = (index: number) =>
    !!models[index]!.id.trim() && keys.some((other, at) => at !== index && other.some((key) => keys[index]!.includes(key)))

  function setModel(index: number, change: Partial<ModelCatalogEntry>): void {
    setModels((current) => current.map((model, at) => (at === index ? { ...model, ...change } : model)))
  }

  function removeModel(index: number): void {
    setModels((current) => current.filter((_, at) => at !== index))
    setEditing((now) => (now === undefined || now.row === index ? undefined : now.row > index ? { row: now.row - 1 } : now))
  }

  function addModel(): void {
    setModels((current) => [...current, { id: '', displayName: '' }])
    setEditing({ row: models.length, field: 'id' }) // 빈 줄은 고칠 것뿐이다 — 바로 id 칸에
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

  /** 편집 줄이 아닌 칸 — 누르면 그 줄이 편집 줄이 되고 누른 칸에 포커스 */
  const cell = (index: number, field: ModelField, text: ReactNode, className: string) => (
    <span role="cell">
      <button type="button" className={`model-row__cell ${className}`} disabled={busy} onClick={() => setEditing({ row: index, field })}>
        {text}
      </button>
    </span>
  )

  return (
    <div className="provider-editor">
      <div className="provider-head">
        <input
          className="provider-head__name"
          aria-label={t('models.displayName')}
          placeholder={t('models.newProvider')}
          value={displayName}
          disabled={busy}
          onChange={(event) => setDisplayName(event.target.value)}
        />
        <div className="provider-head__meta">
          {/* 상태는 앱이 아는 것만 — 키 유무 (연결 확인은 없다). 새 provider 는 아직 저장된 것이 없어 안 그린다 */}
          {provider && (
            <>
              <span className={`provider-head__status${provider.hasKey ? ' provider-head__status--ok' : ''}`}>
                <span className={`status-dot${provider.hasKey ? ' status-dot--ok' : ' status-dot--none'}`} aria-hidden="true" />
                {provider.hasKey ? t('models.keySet') : t('models.keyNone')}
              </span>
              <span aria-hidden="true">·</span>
            </>
          )}
          <span className="provider-head__id">{id}</span>
          <span aria-hidden="true">·</span>
          <span>{t('models.modelCount', { n: models.length })}</span>
        </div>
      </div>

      <section className="provider-conn">
        <h3 className="models-label">{t('models.connection')}</h3>
        <div className="provider-conn__endpoint">
          <select className="provider-conn__protocol" aria-label={t('models.protocol')} value="openai-chat-completions" disabled={busy} onChange={() => {}}>
            <option value="openai-chat-completions">{PROTOCOL_LABEL}</option>
          </select>
          <input
            className="provider-conn__url"
            aria-label="Base URL"
            value={baseURL}
            placeholder="https://gateway.example/v1"
            disabled={busy}
            onChange={(event) => setBaseURL(event.target.value)}
          />
        </div>
        <div className="provider-conn__key">
          <span className="provider-conn__key-label">{t('models.apiKey')}</span>
          {provider?.hasKey && !changingKey ? (
            <>
              <span className="provider-conn__dots" aria-hidden="true">
                ••••••••
              </span>
              <span className="provider-conn__key-state">{t('models.keyStored')}</span>
              <button type="button" className="models-text-button" disabled={busy} onClick={() => setChangingKey(true)}>
                {t('models.changeKey')}
              </button>
            </>
          ) : (
            <input
              className="settings-input provider-conn__key-input"
              aria-label={t('models.apiKey')}
              type="password"
              autoComplete="new-password"
              autoFocus={changingKey}
              value={apiKey}
              placeholder={provider?.hasKey ? t('models.keyPlaceholderSet') : t('models.keyPlaceholderNone')}
              disabled={busy}
              onChange={(event) => setApiKey(event.target.value)}
            />
          )}
        </div>
      </section>

      <section className="models-section">
        <div className="models-section__head">
          <h3 className="models-label">{t('models.models')}</h3>
          <button type="button" className="models-text-button" disabled={busy || !baseURL.trim()} onClick={() => void fetchModels()}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M20 11a8 8 0 1 0-2.3 5.7" />
              <path d="M20 4v7h-7" />
            </svg>
            {t('models.fetch')}
          </button>
        </div>
        <div className="model-table" role="table" aria-label={t('models.models')}>
          <div className="model-row model-row--header" role="row">
            <span role="columnheader">{t('models.modelIdPlaceholder')}</span>
            <span role="columnheader">{t('models.displayName')}</span>
            <span role="columnheader" className="model-row__end" title={t('models.contextLengthHint')}>
              {t('models.context')}
            </span>
            <span role="columnheader" className="model-row__end" title={t('models.maxOutputHint')}>
              {t('models.maxOutputPlaceholder')}
            </span>
            <span role="columnheader" className="model-row__center">
              {t('models.features')}
            </span>
            <span role="columnheader" />
          </div>
          {models.map((model, index) => {
            const n = index + 1
            const open = editing?.row === index
            const focus = (field: ModelField) => open && editing?.field === field
            const autoOutput = model.contextLength ? t('models.maxOutputAuto', { n: tokenLabel(defaultOutputLimit(model.contextLength)) }) : undefined
            return (
              <div key={index} className={`model-row${open ? ' model-row--editing' : ''}${clashes(index) ? ' model-row--clash' : ''}`} role="row">
                {open ? (
                  <>
                    <span role="cell">
                      <input
                        className={`settings-input model-row__input model-card__id${clashes(index) ? ' model-card__id--clash' : ''}`}
                        aria-invalid={clashes(index) || undefined}
                        aria-label={t('models.modelId', { n })}
                        placeholder={t('models.modelIdPlaceholder')}
                        autoFocus={focus('id')}
                        value={model.id}
                        disabled={busy}
                        onChange={(event) => setModel(index, { id: event.target.value })}
                      />
                    </span>
                    <span role="cell">
                      <input
                        className="settings-input model-row__input"
                        aria-label={t('models.modelName', { n })}
                        placeholder={t('models.modelNamePlaceholder')}
                        autoFocus={focus('name')}
                        value={model.displayName}
                        disabled={busy}
                        onChange={(event) => setModel(index, { displayName: event.target.value })}
                      />
                    </span>
                    {/* opencode 는 custom 모델의 한도를 모른다 — 적으면 엔진에 넘기고 입력창 통계 줄의 컨텍스트 % 가 보인다 (비우면 "—") */}
                    <span role="cell">
                      <input
                        className="settings-input model-row__input model-row__number"
                        aria-label={t('models.contextLength', { n })}
                        placeholder="—"
                        title={t('models.contextLengthTitle')}
                        type="number"
                        min={1}
                        step={1}
                        autoFocus={focus('context')}
                        value={model.contextLength ?? ''}
                        disabled={busy}
                        onChange={(event) => setModel(index, { contextLength: event.target.value === '' ? undefined : Number(event.target.value) })}
                      />
                    </span>
                    {/* 최대 출력 — 요청 max_tokens 이자 요약 문턱(컨텍스트 − 출력)의 몫. 비우면 엔진이 정하는 값을 흐리게 보인다 (이슈 #27) */}
                    <span role="cell">
                      <input
                        className="settings-input model-row__input model-row__number"
                        aria-label={t('models.maxOutput', { n })}
                        placeholder={autoOutput ?? t('models.auto')}
                        title={t('models.maxOutputTitle')}
                        type="number"
                        min={1}
                        step={1}
                        autoFocus={focus('output')}
                        value={model.maxOutput ?? ''}
                        disabled={busy}
                        onChange={(event) => setModel(index, { maxOutput: event.target.value === '' ? undefined : Number(event.target.value) })}
                      />
                    </span>
                  </>
                ) : (
                  <>
                    {cell(index, 'id', model.id || t('models.modelIdPlaceholder'), `model-card__id${model.id ? '' : ' model-row__cell--empty'}${clashes(index) ? ' model-row__cell--clash' : ''}`)}
                    {cell(index, 'name', model.displayName || '—', model.displayName ? '' : 'model-row__cell--empty')}
                    {cell(index, 'context', model.contextLength ? tokenLabel(model.contextLength) : '—', `model-row__end${model.contextLength ? ' model-row__cell--strong' : ' model-row__cell--empty'}`)}
                    {cell(index, 'output', model.maxOutput ? tokenLabel(model.maxOutput) : (autoOutput ?? '—'), `model-row__end${model.maxOutput ? '' : ' model-row__cell--empty'}`)}
                  </>
                )}
                <span role="cell" className="model-row__toggles">
                  {/* 이미지 입력 — 켠 모델만 엔진이 이미지를 받는 모델로 알린다 (이슈 #44, 01y: 이 표시 없이는 붙인 이미지가 오류 글로 바뀐다). 기본 꺼짐 */}
                  <ModelToggle
                    on={model.imageInput === true}
                    icon={<ImageIcon />}
                    ariaLabel={t('models.imageInput', { n })}
                    title={t('models.imageInputTitle')}
                    disabled={busy}
                    onToggle={(on) => setModel(index, { imageInput: on || undefined })}
                  />
                  {/* Thinking 모델 선언 (이슈 #500 시안) — 켠 모델은 입력창 모델 메뉴에서 대화마다 Thinking 을 디폴트·켬·끔으로 고른다. 기본 꺼짐 */}
                  <ModelToggle
                    on={model.thinking === true}
                    icon={<BulbIcon />}
                    ariaLabel={t('models.thinking', { n })}
                    title={t('models.thinkingTitle')}
                    disabled={busy}
                    onToggle={(on) => setModel(index, { thinking: on || undefined })}
                  />
                </span>
                <span role="cell">
                  <button type="button" className="model-row__remove" aria-label={t('models.removeModel', { n })} title={t('models.removeModelTitle')} disabled={busy} onClick={() => removeModel(index)}>
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true">
                      <path d="M6 6l12 12M18 6L6 18" />
                    </svg>
                  </button>
                </span>
                {/* 그 줄의 경고·안내는 줄 바로 아래 — 문턱(컨텍스트 − 출력)이 너무 작은 모델(01o 권고 ①), 편집 중인 Thinking 모델의 끌 때 안내
                    (#503 — 선언을 끄면 켬·끔 키가 풀리지 않는다, 접미 키를 디폴트로 푸는 폴백은 두지 않는다) */}
                {isLowContext(model) && (
                  <p className="model-row__note context-length-hint context-length-hint--warn" role="status">
                    {t('models.contextLengthLow', { model: model.id || '?', min: COMPACTION_MIN_THRESHOLD })}
                  </p>
                )}
                {open && model.thinking && (
                  <p className="model-row__note context-length-hint">
                    <strong className="context-length-hint__term" title={t('models.thinkingHint')}>
                      {t('models.thinkingLabel')}
                    </strong>{' '}
                    — {t('models.thinkingOffHint')}
                  </p>
                )}
              </div>
            )
          })}
          <button type="button" className="model-table__add" disabled={busy} onClick={addModel}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
              <path d="M12 5v14M5 12h14" />
            </svg>
            {t('models.addModel')}
          </button>
        </div>
        <p className="models-section__hint">{t('models.tableHint')}</p>
      </section>

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
