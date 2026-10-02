import { Context, Service } from 'cordis'
import { tr } from '../i18n.ts'

// 입력창 트리거 등록소 (ctx.triggers) — `@`·`/`·`!` 같은 트리거 문자와 그 후보·실행을 플러그인이 등록한다
// (사용자 결정 2026-10-01, _workspace/00_next_triggers.md). 화면은 어떤 트리거가 있는지 모르고 IPC 로 "이 입력의 후보" /
// "이 항목 골라" / "이 줄 내기" 만 묻는다 — 감지도 여기서 한다(dsh ui-input-trigger core/detect 의 규칙을 새로 썼다).
// 플러그인은 effect 로 register 하고, 내려가면 해제 함수가 불려 그 문자는 다시 평범한 글자가 된다.
// opencode 는 여기도 플러그인도 모른다 — 후보·실행에 필요한 엔진 호출은 ctx.llm 메서드로만 한다.

declare module 'cordis' {
  interface Context {
    triggers: TriggerRegistry
  }
}

/** 입력창이 요청마다 넘기는 맥락 */
export interface TriggerScope {
  /** 프로젝트 폴더 (ctx.projects 의 path) */
  directory: string
}

/** 입력 안에서 트리거가 걸린 구간 — [start, end) 를 고른 결과로 바꾼다 */
export interface TriggerSpan {
  char: string
  /** 트리거 문자 뒤부터 캐럿까지 (따옴표는 뺀다) */
  query: string
  start: number
  end: number
}

export interface TriggerCandidate {
  /** 그 트리거 안에서 유일. pick 에 그대로 돌아온다 (경로·명령 이름) */
  id: string
  label: string
  /** 오른쪽 설명 (명령 설명, 파일의 상위 폴더) */
  detail?: string
  icon: 'file' | 'folder' | 'command'
  /** 그룹 제목 */
  group?: string
  /** Tab 으로 한 단계 들어갈 수 있다 (폴더) */
  drill?: boolean
}

export type TriggerResult =
  /** 구간을 text 로 바꾸고 메뉴를 닫는다 */
  | { kind: 'insert'; text: string }
  /** 구간을 text 로 바꾸고 메뉴는 열어 둔다 (폴더로 들어가기) */
  | { kind: 'drill'; text: string }
  /** text 를 평소 전송 경로로 보낸다. 말풍선·대화 기록에는 display 가 보인다 */
  | { kind: 'send'; text: string; display: string }
  /** 그 폴더에서 command 를 한 번 돌려 결과 카드로 — 화면이 대화에 카드를 붙이고 메인(ctx.shell)이 돌린다. 맥락에는 안 들어간다 */
  | { kind: 'shell'; directory: string; command: string }
  /** 막고 알린다 (모르는 명령 등) */
  | { kind: 'error'; message: string }

export interface TriggerQuery {
  span: TriggerSpan
  candidates: TriggerCandidate[]
  /** 입력창 아래 한 줄 안내 */
  hint?: string
  /** danger: 되돌릴 수 없는 일을 하는 입력 — 입력창 색으로 경고한다 (closed-code composerMode: `!rm -rf` 를 질문으로 착각하지 않게) */
  tone?: 'danger'
}

export interface TriggerSource {
  /** 한 글자 */
  char: string
  /** boundary: 글 첫머리·공백·구두점 뒤 (낱말·경로 중간의 `a@b`·`src/@x` 는 아니다). start: 입력의 첫 글자일 때만 */
  opensAt: 'boundary' | 'start'
  /** 공백에서 닫히지 않고 입력 끝까지가 구간이다 (`!` 셸 명령) */
  wholeLine?: boolean
  hint?: string
  tone?: 'danger'
  candidates(scope: TriggerScope, query: string, signal: AbortSignal): Promise<TriggerCandidate[]>
  pick(scope: TriggerScope, id: string, action: 'pick' | 'drill'): Promise<TriggerResult>
  /** 후보를 고르지 않고 Enter 로 입력 전체를 낸다. 없거나 undefined 면 평범한 프롬프트로 간다 */
  submit?(scope: TriggerScope, line: string): Promise<TriggerResult | undefined>
}

export type TriggerHit = TriggerSpan & { source: TriggerSource }

const escape = (char: string) => char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** 캐럿 자리의 트리거. 여럿이 걸리면 캐럿에 가장 가까운 것 */
export function detect(sources: Iterable<TriggerSource>, draft: string, caret: number): TriggerHit | null {
  const before = draft.slice(0, caret)
  let best: TriggerHit | null = null
  for (const source of sources) {
    const char = escape(source.char)
    let hit: TriggerHit | null = null
    if (source.opensAt === 'start') {
      const match = (source.wholeLine ? new RegExp(`^(\\s*)${char}([\\s\\S]*)$`).exec(draft) : new RegExp(`^(\\s*)${char}(\\S*)$`).exec(before))
      if (match && (source.wholeLine || caret > match[1]!.length)) {
        hit = { source, char: source.char, query: match[2]!, start: match[1]!.length, end: source.wholeLine ? draft.length : caret }
      }
    } else {
      // `@"공백 있는 경로` 는 닫는 따옴표 전까지 하나의 토큰이다 (dsh detect)
      const match = new RegExp(`(?<![\\w/])${char}("[^"]*|[^\\s"]*)$`).exec(before)
      if (match) {
        const token = match[1]!
        hit = { source, char: source.char, query: token.startsWith('"') ? token.slice(1) : token, start: match.index, end: caret }
      }
    }
    if (hit && (!best || hit.start > best.start)) best = hit
  }
  return best
}

export class TriggerRegistry extends Service {
  private sources = new Map<string, TriggerSource>()
  /** 새 질의가 오면 이전 후보 조회를 멈춘다 */
  private inflight?: AbortController

  constructor(ctx: Context) {
    super(ctx, 'triggers')
  }

  /** 되돌릴 수 있는 등록 — 플러그인이 effect 로 부른다. 같은 문자 두 번은 크게 실패한다 (dsh: 이름 충돌) */
  register(source: TriggerSource): () => void {
    if (this.sources.has(source.char)) throw new Error(`트리거 ${source.char} 가 이미 등록돼 있습니다`)
    this.sources.set(source.char, source)
    return () => {
      if (this.sources.get(source.char) === source) this.sources.delete(source.char)
    }
  }

  /** 캐럿 자리의 트리거와 후보. 후보 조회가 실패하면 빈 목록 (dsh: 실패한 소스는 조용히 뺀다) */
  async query(scope: TriggerScope, draft: string, caret: number): Promise<TriggerQuery | null> {
    this.inflight?.abort()
    const hit = detect(this.sources.values(), draft, caret)
    if (!hit) return null
    const controller = (this.inflight = new AbortController())
    const { source, ...span } = hit
    let candidates: TriggerCandidate[] = []
    try {
      candidates = await source.candidates(scope, hit.query, controller.signal)
    } catch (error) {
      if (!controller.signal.aborted) console.warn(`[triggers] ${source.char} 후보 조회 실패`, (error as Error).message)
    }
    return { span, candidates, hint: source.hint, tone: source.tone }
  }

  async pick(scope: TriggerScope, char: string, id: string, action: 'pick' | 'drill'): Promise<TriggerResult> {
    const source = this.sources.get(char)
    if (!source) return { kind: 'error', message: tr('error.noTrigger', { char }) }
    return source.pick(scope, id, action)
  }

  /** 입력 전체를 Enter 로 낼 때. 첫 글자 트리거(start)만 본다 — null 이면 평범한 프롬프트 */
  async submit(scope: TriggerScope, draft: string): Promise<TriggerResult | null> {
    const source = this.sources.get(draft.trimStart().charAt(0))
    if (source?.opensAt !== 'start' || !source.submit) return null
    return (await source.submit(scope, draft.trim())) ?? null
  }
}
