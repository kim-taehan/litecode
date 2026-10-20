import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { ModelCatalogEntry, ProviderInput, ProviderSummary } from '../shared/ipc.ts'
import { providerIdFor } from '../shared/providerId.ts'
import { engineModelKeys } from '../shared/engineModelId.ts'
import { GeneralPage } from './GeneralSettings.tsx'
import { FeaturesPage } from './FeaturesSettings.tsx'
import { MobilePage } from './MobileSettings.tsx'
import { useFeatures } from './featuresStore.ts'
import { useT } from './settingsStore.ts'
import { COMPACTION_MIN_THRESHOLD, isLowContext } from './compaction.ts'
import { modelBudget, providerInitials, tokenLabel } from './modelBudget.ts'
import { MoreMenu } from './ExtensionsSettings.tsx'
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

type Page = 'general' | 'models' | 'features' | 'mobile'

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
        // 편집 중인 provider 는 머리줄 대신 편집기(시안 E — 자기 머리에 이름·상태를 그린다)만 회색 바탕 카드에
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

/** 모델 카드의 알약 토글 — 켜면 연한 파랑 채움 + 체크, 끄면 점선 (이슈 #477 → #542 시안 E) */
function ModelToggle({ on, label, ariaLabel, title, disabled, onToggle }: { on: boolean; label: string; ariaLabel: string; title: string; disabled: boolean; onToggle(on: boolean): void }) {
  return (
    <button type="button" className="model-card__toggle" aria-pressed={on} aria-label={ariaLabel} title={title} disabled={disabled} onClick={() => onToggle(!on)}>
      {label}
      {on && (
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M5 12l5 5L20 7" />
        </svg>
      )}
    </button>
  )
}

/** 모델 카드의 컨텍스트·출력 숫자와 막대 — 대화 몫(연한 파랑) | 출력 몫(진한 파랑), 아래 요약 지점. 컨텍스트가 비면 빗금 막대 (시안 E) */
function ModelBudgetView({ model }: { model: ModelCatalogEntry }) {
  const t = useT()
  const budget = modelBudget(model)
  return (
    <span className="model-budget">
      <span className="model-budget__numbers">
        <span>
          {t('models.context')} <b>{budget.context ? tokenLabel(budget.context) : '—'}</b>
        </span>
        <span>
          {t('models.output')} {budget.output !== undefined && <b>{tokenLabel(budget.output)}</b>} {budget.outputAuto && t('models.auto')}
        </span>
      </span>
      {budget.percent !== undefined ? (
        <>
          <span className="model-budget__bar" aria-hidden="true">
            <span className="model-budget__chat" style={{ width: `${budget.percent}%` }} />
          </span>
          <span className="model-budget__mark">
            {/* 눈금 글은 지점에 걸치되 카드 밖으로 안 나가게 — 0% 면 왼쪽 맞춤, 100% 면 오른쪽 맞춤 */}
            <span style={{ left: `${budget.percent}%`, transform: `translateX(-${budget.percent}%)` }}>{t('models.summarizeAt', { n: tokenLabel(budget.summarizeAt!) })}</span>
          </span>
        </>
      ) : (
        <>
          <span className="model-budget__bar model-budget__bar--unknown" aria-hidden="true" />
          <span className="model-budget__mark">
            <span>{t('models.summarizeOnReject')}</span>
          </span>
        </>
      )}
    </span>
  )
}

/** 머리·고르는 칸의 프로토콜 이름 — 지금은 하나뿐 */
const PROTOCOL_LABEL = 'OpenAI Chat'

/** 컨텍스트 빠른 버튼 (시안 E) */
const CONTEXT_PRESETS = [32_768, 131_072, 262_144]

interface ProviderEditorProps {
  /** 없으면 새 provider */
  provider?: ProviderSummary
  taken: ProviderSummary[]
  /** 적용했으면 바뀐 목록, 취소면 undefined */
  onDone(saved?: ProviderSummary[]): void
  /** 처음 펼쳐 둘 모델 — 테스트가 편집 영역을 그릴 때 */
  initialOpen?: number
}

// provider 편집 (이슈 #542 시안 E, _workspace/mock-models-redesign/Combo.dc.html): 흰 상자 안에 머리(이니셜 타일·이름·id·키 상태)와 연결(프로토콜|Base URL 한 줄,
// API 키는 있으면 •••• [바꾸기]), 상자 밖에 "모델 N" 줄과 2열 모델 카드. 카드를 누르면 아래에 그 모델의 편집 영역(한 번에 하나).
// 긴 설명 문단은 칸 이름의 title 툴팁으로 옮겼다. 동작(저장·검증·가져오기)은 그대로
export function ProviderEditor({ provider, taken, onDone, initialOpen }: ProviderEditorProps) {
  const t = useT()
  const [displayName, setDisplayName] = useState(provider?.displayName ?? '')
  const [baseURL, setBaseURL] = useState(provider?.baseURL ?? '')
  const [apiKey, setApiKey] = useState('')
  const [changingKey, setChangingKey] = useState(false)
  const [models, setModels] = useState<ModelCatalogEntry[]>(provider?.models ?? [])
  const [open, setOpen] = useState(initialOpen)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const id = provider?.id ?? providerIdFor(displayName, (candidate) => taken.some((entry) => entry.id === candidate))
  // 키가 겹치는 항목 — 저장이 거절할 것을 카드·id 칸 빨간 표시로 미리 (이슈 #497 시안 F → #500). 저장 검증과 같은 키 기준(같은 id, Thinking 모델의
  // 파생 키 id--think·id--nothink 와 같은 진짜 id), 빈 id 는 따로 거절된다
  const keys = models.map((model) => engineModelKeys({ ...model, id: model.id.trim() }))
  const clashes = (index: number) =>
    !!models[index]!.id.trim() && keys.some((other, at) => at !== index && other.some((key) => keys[index]!.includes(key)))
  const modelName = (model: ModelCatalogEntry) => model.displayName || model.id || t('models.untitledModel')

  function setModel(index: number, change: Partial<ModelCatalogEntry>): void {
    setModels((current) => current.map((model, at) => (at === index ? { ...model, ...change } : model)))
  }

  function removeModel(index: number): void {
    setModels((current) => current.filter((_, at) => at !== index))
    setOpen((now) => (now === undefined || now === index ? undefined : now > index ? now - 1 : now))
  }

  function addModel(): void {
    setModels((current) => [...current, { id: '', displayName: '' }])
    setOpen(models.length) // 빈 카드는 고칠 것뿐이다 — 바로 펼친다
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

  const editing = open !== undefined ? models[open] : undefined

  return (
    <div className="provider-editor">
      <div className="provider-box">
        <div className="provider-box__head">
          <span className="provider-box__tile" aria-hidden="true">
            {providerInitials(displayName) || '+'}
          </span>
          <span className="provider-box__title">
            <input
              className="provider-box__name"
              aria-label={t('models.displayName')}
              placeholder={t('models.newProvider')}
              value={displayName}
              disabled={busy}
              onChange={(event) => setDisplayName(event.target.value)}
            />
            <span className="provider-box__sub">
              {id} · {PROTOCOL_LABEL}
            </span>
          </span>
          {/* 상태 알약은 앱이 아는 것만 — 키 유무 (연결 확인은 없다). 새 provider 는 아직 저장된 것이 없어 안 그린다 */}
          {provider && (
            <span className={`provider-box__status${provider.hasKey ? ' provider-box__status--ok' : ''}`}>
              <span className={`status-dot${provider.hasKey ? ' status-dot--ok' : ' status-dot--none'}`} aria-hidden="true" />
              {provider.hasKey ? t('models.keySet') : t('models.keyNone')}
            </span>
          )}
        </div>
        <section className="provider-box__section">
          <h3 className="models-label">{t('models.connection')}</h3>
          <div className="provider-box__endpoint">
            <select className="provider-box__protocol" aria-label={t('models.protocol')} value="openai-chat-completions" disabled={busy} onChange={() => {}}>
              <option value="openai-chat-completions">{PROTOCOL_LABEL}</option>
            </select>
            <input
              className="provider-box__url"
              aria-label="Base URL"
              value={baseURL}
              placeholder="https://gateway.example/v1"
              disabled={busy}
              onChange={(event) => setBaseURL(event.target.value)}
            />
          </div>
          <div className="provider-box__key">
            <span className="provider-box__key-label">{t('models.apiKey')}</span>
            {provider?.hasKey && !changingKey ? (
              <>
                <span className="provider-box__dots" aria-hidden="true">
                  ••••••••
                </span>
                <span className="provider-box__key-state">{t('models.keyStored')}</span>
                <button type="button" className="models-text-button" disabled={busy} onClick={() => setChangingKey(true)}>
                  {t('models.changeKey')}
                </button>
              </>
            ) : (
              <input
                className="settings-input provider-box__key-input"
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
      </div>

      <section className="models-section">
        <div className="models-section__head">
          <h3 className="models-label">
            {t('models.models')} <span className="models-label__count">{models.length}</span>
          </h3>
          <button type="button" className="models-text-button" disabled={busy || !baseURL.trim()} onClick={() => void fetchModels()}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M20 11a8 8 0 1 0-2.3 5.7" />
              <path d="M20 4v7h-7" />
            </svg>
            {t('models.fetch')}
          </button>
          <button type="button" className="models-dark-button" disabled={busy} onClick={addModel}>
            {t('models.addModel')}
          </button>
        </div>
        {models.length > 0 && (
          <div className="model-grid">
            {models.map((model, index) => (
              <article key={index} className={`model-card${open === index ? ' model-card--open' : ''}${clashes(index) ? ' model-card--clash' : ''}`}>
                <div className="model-card__head">
                  {/* 이름·id·막대를 누르면 아래 편집 영역이 이 모델로 펼쳐진다 (다시 누르면 접힌다) */}
                  <button
                    type="button"
                    className="model-card__open"
                    aria-expanded={open === index}
                    aria-controls={open === index ? 'model-edit' : undefined}
                    onClick={() => setOpen(open === index ? undefined : index)}
                  >
                    <span className="model-card__name">{modelName(model)}</span>
                    <span className="model-card__model-id">{model.id}</span>
                    <ModelBudgetView model={model} />
                  </button>
                  <MoreMenu
                    label={t('models.modelMenu', { name: modelName(model) })}
                    items={[
                      { label: t('models.edit'), onSelect: () => setOpen(index) },
                      { label: t('models.removeModelTitle'), danger: true, onSelect: () => removeModel(index) },
                    ]}
                  />
                </div>
                <div className="model-card__toggles">
                  {/* 이미지 입력 — 켠 모델만 엔진이 이미지를 받는 모델로 알린다 (이슈 #44, 01y: 이 표시 없이는 붙인 이미지가 오류 글로 바뀐다). 기본 꺼짐 */}
                  <ModelToggle
                    on={model.imageInput === true}
                    label={t('models.imageInputLabel')}
                    ariaLabel={t('models.imageInput', { n: index + 1 })}
                    title={t('models.imageInputTitle')}
                    disabled={busy}
                    onToggle={(on) => setModel(index, { imageInput: on || undefined })}
                  />
                  {/* Thinking 모델 선언 (이슈 #500 시안) — 켠 모델은 입력창 모델 메뉴에서 대화마다 Thinking 을 디폴트·켬·끔으로 고른다. 기본 꺼짐 */}
                  <ModelToggle
                    on={model.thinking === true}
                    label={t('models.thinkingLabel')}
                    ariaLabel={t('models.thinking', { n: index + 1 })}
                    title={t('models.thinkingTitle')}
                    disabled={busy}
                    onToggle={(on) => setModel(index, { thinking: on || undefined })}
                  />
                </div>
              </article>
            ))}
          </div>
        )}
        {editing && open !== undefined && (
          <div className="model-edit" id="model-edit">
            <span className="model-edit__title">{t('models.editModel', { name: modelName(editing) })}</span>
            <div className="model-edit__names">
              <label className="model-edit__field">
                <span className="model-edit__label">{t('models.modelIdPlaceholder')}</span>
                <input
                  className={`settings-input model-card__id${clashes(open) ? ' model-card__id--clash' : ''}`}
                  aria-invalid={clashes(open) || undefined}
                  aria-label={t('models.modelId', { n: open + 1 })}
                  value={editing.id}
                  disabled={busy}
                  onChange={(event) => setModel(open, { id: event.target.value })}
                />
              </label>
              <label className="model-edit__field">
                <span className="model-edit__label">{t('models.displayName')}</span>
                <input
                  className="settings-input"
                  aria-label={t('models.modelName', { n: open + 1 })}
                  placeholder={t('models.modelNamePlaceholder')}
                  value={editing.displayName}
                  disabled={busy}
                  onChange={(event) => setModel(open, { displayName: event.target.value })}
                />
              </label>
            </div>
            <div className="model-edit__limits">
              {/* opencode 는 custom 모델의 한도를 모른다 — 적으면 엔진에 넘기고 입력창 통계 줄의 컨텍스트 % 가 보인다 (비우면 "—") */}
              <label className="model-edit__field">
                <span className="model-edit__label" title={t('models.contextLengthHint')}>
                  {t('models.context')}
                </span>
                <span className="model-edit__number">
                  <input
                    aria-label={t('models.contextLength', { n: open + 1 })}
                    title={t('models.contextLengthTitle')}
                    type="number"
                    min={1}
                    step={1}
                    value={editing.contextLength ?? ''}
                    disabled={busy}
                    onChange={(event) => setModel(open, { contextLength: event.target.value === '' ? undefined : Number(event.target.value) })}
                  />
                  <span className="model-edit__unit">{t('models.tokens')}</span>
                </span>
              </label>
              {CONTEXT_PRESETS.map((tokens) => (
                <button
                  key={tokens}
                  type="button"
                  className="model-edit__preset"
                  aria-pressed={editing.contextLength === tokens}
                  disabled={busy}
                  onClick={() => setModel(open, { contextLength: tokens })}
                >
                  {tokenLabel(tokens)}
                </button>
              ))}
              {/* 최대 출력 — 요청 max_tokens 이자 요약 문턱(컨텍스트 − 출력)의 몫. 비우면 엔진이 정하는 값을 흐리게 보인다 (이슈 #27) */}
              <label className="model-edit__field model-edit__field--end">
                <span className="model-edit__label" title={t('models.maxOutputHint')}>
                  {t('models.maxOutputPlaceholder')}
                </span>
                <span className="model-edit__number">
                  <input
                    aria-label={t('models.maxOutput', { n: open + 1 })}
                    placeholder={editing.contextLength ? t('models.maxOutputAuto', { n: tokenLabel(defaultOutputLimit(editing.contextLength)) }) : t('models.auto')}
                    title={t('models.maxOutputTitle')}
                    type="number"
                    min={1}
                    step={1}
                    value={editing.maxOutput ?? ''}
                    disabled={busy}
                    onChange={(event) => setModel(open, { maxOutput: event.target.value === '' ? undefined : Number(event.target.value) })}
                  />
                  <span className="model-edit__unit">{t('models.tokens')}</span>
                </span>
              </label>
            </div>
            {/* 문턱(컨텍스트 − 출력)이 너무 작은 모델만 경고 (01o 권고 ①) */}
            {isLowContext(editing) && (
              <p className="context-length-hint context-length-hint--warn" role="status">
                {t('models.contextLengthLow', { model: editing.id || '?', min: COMPACTION_MIN_THRESHOLD })}
              </p>
            )}
            {/* 선언을 끄면 켬·끔 키가 풀리지 않는다 — 다시 고르라는 안내만 (#503, 접미 키를 디폴트로 푸는 폴백은 두지 않는다) */}
            {editing.thinking && (
              <p className="context-length-hint">
                <strong className="context-length-hint__term" title={t('models.thinkingHint')}>
                  {t('models.thinkingLabel')}
                </strong>{' '}
                — {t('models.thinkingOffHint')}
              </p>
            )}
            <div className="model-edit__foot">
              <button type="button" className="models-text-button models-text-button--danger" disabled={busy} onClick={() => removeModel(open)}>
                {t('models.deleteThisModel')}
              </button>
              <button type="button" className="models-text-button models-text-button--quiet" onClick={() => setOpen(undefined)}>
                {t('models.collapse')}
              </button>
            </div>
          </div>
        )}
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
