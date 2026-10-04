import { Context, Service } from 'cordis'
import fs from 'node:fs'
import path from 'node:path'
import { providerIdFor } from '../../shared/providerId.ts'
import { tr } from '../i18n.ts'
import { readJsonFileSync } from './jsonFile.ts'
import { describeHttpError, errorDetail } from '../../shared/httpError.ts'

// 모델 provider 설정 — dsh 의 Settings > Models 화면과 같은 모양을 따른다.
// baseURL 을 직접 지정할 수 있어야 폐쇄망 내부 게이트웨이(LiteLLM 등)를 붙일 수 있다.
//
// 정본은 이 서비스다 (00_request 리더 결정). 앱에서는 userData 의 providers.json(키 제외)에 두고,
// API 키는 cipher(Electron safeStorage)로 암호화해 provider-keys.json 에 따로 둔다 — 밖으로는 설정 여부(hasKey)만 보인다.
// cipher 를 못 쓰는 환경이면 키 저장을 거부한다 (평문으로 떨어뜨리지 않는다).
// 파일은 작고 쓰기가 드물어 동기로 읽고 쓴다 — 시작 직후 ctx.llm 의 get() 이 곧바로 목록을 봐야 한다.

export interface ModelCatalogEntry {
  id: string
  displayName: string
  /** 컨텍스트 길이(토큰, 선택) — opencode 는 custom 모델의 한도를 모른다(01_probe). 엔진이 opencode.json 의 limit 으로 넘기고
   *  통계 줄의 컨텍스트 % 에 쓴다. 없으면 % 는 "—" */
  contextLength?: number
  /** 최대 출력(토큰, 선택, 이슈 #27) — opencode limit.output 으로 넘어가 요청의 max_tokens 이자 자동 요약 문턱(context − 출력)의 몫이 된다.
   *  비우면 엔진이 컨텍스트 길이의 1/4(최대 32000)를 넣는다 (shared/outputLimit.ts) */
  maxOutput?: number
  /** 이미지 입력(선택, 이슈 #44) — 켠 모델만 엔진이 opencode.json 모델 정의에 modalities.input 의 image 를 싣는다. 그게 없으면 opencode 가
   *  붙인 이미지를 "ERROR: Cannot read …(this model does not support image input)" 글로 바꿔 보낸다 (01y). 기본 꺼짐 */
  imageInput?: boolean
}

export interface ProviderConfig {
  id: string
  displayName: string
  baseURL: string
  protocol: 'openai-chat-completions'
  models: ModelCatalogEntry[]
  /** 사용자가 설정 화면에서 추가한 것 — 화면에 "Custom" 으로 보인다 */
  custom?: boolean
}

/** 화면에 주는 모양 — 키 자체는 없고 설정 여부만 */
export interface ProviderSummary extends ProviderConfig {
  custom: boolean
  hasKey: boolean
}

/** 설정 화면의 [적용] — id 가 없거나 모르는 id 면 새 provider. apiKey 가 비었으면 저장된 키를 그대로 둔다 */
export interface ProviderInput {
  id?: string
  displayName: string
  baseURL: string
  protocol: 'openai-chat-completions'
  models: ModelCatalogEntry[]
  apiKey?: string
}

/** 키 암호화 — 앱에서는 Electron safeStorage. 메인 프로세스 밖(테스트)에서도 서비스를 돌릴 수 있게 주입받는다 */
export interface KeyCipher {
  available(): boolean
  encrypt(plain: string): Buffer
  decrypt(sealed: Buffer): string
}

export interface ProviderRegistryOptions {
  /** provider 목록 JSON (키 제외). 없으면 메모리에만 둔다 */
  file?: string
  /** 암호화한 키 JSON (id → base64) */
  keysFile?: string
  cipher?: KeyCipher
  /** file 이 아직 없을 때(첫 실행)의 목록 */
  defaults?: ProviderConfig[]
}

declare module 'cordis' {
  interface Context {
    providers: ProviderRegistry
  }
  interface Events {
    /** save·remove 로 설정이 바뀌었다 — ctx.engine 이 opencode 를 다시 띄운다 */
    'providers/changed'(): void
  }
}

export class ProviderRegistry extends Service {
  private entries = new Map<string, ProviderConfig>()
  /** id → 암호문(base64) */
  private keys: Record<string, string> = {}

  constructor(
    ctx: Context,
    private opts: ProviderRegistryOptions = {},
  ) {
    super(ctx, 'providers')
    const stored = opts.file ? (readJsonFileSync(opts.file, 'array') as ProviderConfig[] | undefined) : undefined
    for (const config of stored?.filter((config) => typeof config?.id === 'string') ?? opts.defaults ?? []) this.entries.set(config.id, config)
    this.keys = (opts.keysFile && (readJsonFileSync(opts.keysFile, 'object') as Record<string, string> | undefined)) || {}
  }

  /** 되돌릴 수 있는 등록 — 호출부가 반환값을 불러 해제한다 (Cordis effect 원칙). 파일에는 안 쓴다 */
  register(config: ProviderConfig): () => void {
    this.entries.set(config.id, config)
    return () => this.entries.delete(config.id)
  }

  get(id: string): ProviderConfig | undefined {
    return this.entries.get(id)
  }

  all(): ProviderConfig[] {
    return [...this.entries.values()]
  }

  list(): ProviderSummary[] {
    return this.all().map((config) => ({ ...config, custom: config.custom ?? false, hasKey: config.id in this.keys }))
  }

  save(input: ProviderInput): ProviderSummary[] {
    const displayName = input.displayName.trim()
    const baseURL = input.baseURL.trim()
    if (!displayName) throw new Error(tr('error.displayNameRequired'))
    if (!isHttpUrl(baseURL)) throw new Error(tr('error.baseUrlInvalid'))
    const models = input.models.map((model) => ({
      id: model.id.trim(),
      displayName: model.displayName.trim() || model.id.trim(),
      ...(model.contextLength !== undefined && { contextLength: model.contextLength }),
      ...(model.maxOutput !== undefined && { maxOutput: model.maxOutput }),
      ...(model.imageInput === true && { imageInput: true }),
    }))
    if (models.some((model) => model.contextLength !== undefined && !(Number.isSafeInteger(model.contextLength) && model.contextLength > 0))) {
      throw new Error(tr('error.contextLength'))
    }
    // 컨텍스트 길이 이상이면 문턱이 0 이하라 요약이 끝없이 돈다
    const badOutput = (model: ModelCatalogEntry) =>
      model.maxOutput !== undefined &&
      !(Number.isSafeInteger(model.maxOutput) && model.maxOutput > 0 && (model.contextLength === undefined || model.maxOutput < model.contextLength))
    if (models.some(badOutput)) throw new Error(tr('error.maxOutput'))
    if (models.length === 0 || models.some((model) => !model.id)) throw new Error(tr('error.modelsRequired'))
    if (new Set(models.map((model) => model.id)).size !== models.length) throw new Error(tr('error.modelIdDuplicate'))
    const apiKey = input.apiKey?.trim()
    // 키는 키 프록시가 Authorization 헤더로 싣는다 — 헤더에 못 쓰는 문자(줄바꿈·제어 문자·U+200B 같은 보이지 않는 문자·비ASCII)는
    // 붙여넣기 실수이고, 저장되면 요청마다 실패한다 (03_qa 2차). 메시지에 키 값은 넣지 않는다
    if (apiKey && !/^[\x20-\x7e]+$/.test(apiKey)) throw new Error(tr('error.keyChars'))
    const cipher = this.opts.cipher
    if (apiKey && !cipher?.available()) throw new Error(tr('error.keyStorage'))

    const existing = input.id ? this.entries.get(input.id) : undefined
    // 저장 키는 저장된 주소에만 묶인다 — 키 없이 주소만 바꿔 저장하면 이후 가져오기(·엔진 전달)로 저장 키가 새 주소로 간다 (03_qa)
    if (existing && !apiKey && existing.id in this.keys && normalizeBaseURL(existing.baseURL) !== normalizeBaseURL(baseURL)) {
      throw new Error(tr('error.keyReenter'))
    }
    const id = existing?.id ?? providerIdFor(displayName, (candidate) => this.entries.has(candidate))
    this.entries.set(id, { id, displayName, baseURL, protocol: input.protocol, models, custom: existing ? existing.custom : true })
    if (apiKey) this.keys[id] = cipher!.encrypt(apiKey).toString('base64')
    this.persist()
    this.ctx.emit('providers/changed')
    return this.list()
  }

  remove(id: string): ProviderSummary[] {
    this.entries.delete(id)
    delete this.keys[id]
    this.persist()
    this.ctx.emit('providers/changed')
    return this.list()
  }

  /** dsh 화면의 "Fetch available models" — `GET {baseURL}/models` (OpenAI 호환). 메인 프로세스에서 돈다 — 키가 렌더러로 안 간다.
   *  입력한 키는 이 요청에만 쓴다. 입력한 키가 없으면 id 의 저장된 키를 싣되, **저장된 Base URL 과 같은 주소일 때만** —
   *  편집 중 주소만 바꾼 채 가져오면 저장 키가 새 주소로 샌다(03_qa 차단). 그때는 요청을 보내지 않고 거부한다 */
  async fetchAvailableModels(draft: { id?: string; baseURL: string; apiKey?: string }): Promise<ModelCatalogEntry[]> {
    const baseURL = normalizeBaseURL(draft.baseURL)
    let key = draft.apiKey?.trim()
    if (!key && draft.id && draft.id in this.keys) {
      if (normalizeBaseURL(this.entries.get(draft.id)?.baseURL ?? '') !== baseURL) throw new Error(tr('error.keyReenter'))
      key = this.storedKey(draft.id)
    }
    // 키가 실린다 — 서버가 다른 주소로 넘겨도 따라가지 않는다 (참고 레포 검토 02x B)
    const res = await fetch(`${baseURL}/models`, { headers: key ? { authorization: `Bearer ${key}` } : {}, redirect: 'manual' })
    if (res.status >= 300 && res.status < 400) {
      await res.body?.cancel()
      throw new Error(tr('error.redirected', { status: res.status }))
    }
    if (!res.ok) throw new Error(tr('error.fetchModels', { reason: describeHttpError(tr, res.status, errorDetail(await res.text().catch(() => ''))) }))
    const body = (await res.json()) as { data?: { id?: unknown; name?: unknown }[] }
    return (body.data ?? [])
      .filter((model): model is { id: string; name?: unknown } => typeof model.id === 'string')
      .map((model) => ({ id: model.id, displayName: typeof model.name === 'string' ? model.name : model.id }))
  }

  /** 복호화한 키 — ctx.engine 이 opencode 자식 프로세스 env 에만 싣는다. 화면·파일·로그로 내보내지 않는다 */
  apiKey(id: string): string | undefined {
    return this.storedKey(id)
  }

  private storedKey(id?: string): string | undefined {
    const sealed = id ? this.keys[id] : undefined
    return sealed && this.opts.cipher ? this.opts.cipher.decrypt(Buffer.from(sealed, 'base64')) : undefined
  }

  private persist(): void {
    if (this.opts.file) writeJson(this.opts.file, this.all())
    if (this.opts.keysFile) writeJson(this.opts.keysFile, this.keys)
  }
}

/** 앞뒤 공백·끝 슬래시만 뗀다 — 저장 키를 실어도 되는 주소인지 비교할 때와 요청 주소에 같이 쓴다 */
export function normalizeBaseURL(value: string): string {
  return value.trim().replace(/\/+$/, '')
}

function isHttpUrl(value: string): boolean {
  try {
    return ['http:', 'https:'].includes(new URL(value).protocol)
  } catch {
    return false
  }
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(temp, JSON.stringify(value))
  fs.renameSync(temp, file) // 쓰다 죽어도 이전 파일이 남게
}
