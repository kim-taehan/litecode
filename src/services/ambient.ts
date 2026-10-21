import { Context, Service } from 'cordis'
import os from 'node:os'
import './llm.ts'
import './speech.ts'
import './settings.ts'
import './providers.ts'
import './projects.ts'
import type { AmbientEvent } from '../../shared/ambient.ts'

// AMBIENT MEMO (이슈 #494) — 화면이 돌리는 구간 루프(열기 → 조각 흘림 → 정지 → 다시 열기)를 받아 누적 전사를 쥐고,
// 각 구간이 확정되면 ctx.llm.askOnce 로 롤링 요약을 새로 쓴다. 녹음은 화면 쪽(voiceRecorder)에서 돌리고 speech 스트림
// 한 개를 쓴다. 세션을 메인에 두는 이유: 요약은 main 에서만 쓸 수 있는 ctx.llm 이 필요하고, 전사 누적은 화면이 새로
// 고쳐져도 지워지면 안 된다.
// - askOnce 는 임시 세션(autoTitle 과 같은 길) — 대화 목록·통계·알림·훅·대기열과 무관
// - 요약 실패·시간 초과·빈 답이면 조용히 이전 요약을 둔다 — 화면 오류는 없다
// - 모델: ctx.providers 의 첫 provider 의 첫 model — 없으면 segment 만 보내고 summary 는 안 보낸다
// - directory: 최근 프로젝트 첫 것 — 없으면 os.homedir(). askOnce 는 "진짜 폴더"를 요구해 임시 세션이 그 안에서 열린다

/** 요약에 주는 전사 바이트 상한 — 최근 글만 실린다 (전체 전사는 화면이 직접 보여 준다) */
const SUMMARY_INPUT_BYTES = 16_000
/** 요약 한 줄 상한 (글자 단위) */
const SUMMARY_MAX = 300
/** 요약 요청 기한 */
const SUMMARY_TIMEOUT_MS = 30_000

interface Session {
  running: boolean
  stream: number
  transcript: string
  summary: string
}

export class AmbientService extends Service {
  private session?: Session

  constructor(ctx: Context) {
    super(ctx, 'ambient')
    ctx.effect(() => () => (this.session = undefined))
  }

  /** 새 세션을 연다 — 이미 열려 있으면 그 세션 그대로 (탭을 다시 여는 것) */
  start(): void {
    if (this.session?.running) return
    this.session = { running: true, stream: 0, transcript: '', summary: '' }
  }

  /** 그 스트림에 구간 글이 왔다 — 누적하고 segment 로 흘린다. summary 는 refresh 로 별개로 온다 */
  segment(text: string): void {
    const session = this.session
    if (!session?.running) return
    if (!text.trim()) return
    session.transcript = session.transcript ? `${session.transcript}\n${text}` : text
      this.ctx.emit('ambient/event', { channel: 'segment', transcript: session.transcript } satisfies AmbientEvent)
  }

  /** 그 스트림 번호를 새로 받는 것 — 다음 구간에 다시 쓴다 */
  nextStream(stream: number): void {
    if (this.session?.running) this.session.stream = stream
  }

  /** 세션을 끝낸다 — 다음 시작까지 전사·요약을 지운다. 마지막 segment 를 흘려 화면이 닫기 전에 붙잡게 한다 */
  stop(): void {
    const session = this.session
    this.session = undefined
    if (session?.running && session.transcript.trim()) {
    this.ctx.emit('ambient/event', { channel: 'segment', transcript: session.transcript } satisfies AmbientEvent)
    }
  }

  isRunning(): boolean {
    return this.session?.running === true
  }

  /** 구간이 확정된 뒤 부른다 — 전사와 함께 롤링 요약을 새로 쓴다. 실패는 조용히 (이전 요약 유지) */
  refresh(): void {
    const session = this.session
    if (!session?.running || !session.transcript.trim()) return
    const model = this.pickModel()
    if (!model) return
    const stop = AbortSignal.timeout(SUMMARY_TIMEOUT_MS)
    const timedOut = new Promise<unknown>((resolve) => stop.addEventListener('abort', () => resolve(undefined), { once: true }))
    const asked = this.ctx.llm
      .askOnce({ ...model, directory: this.directory(), prompt: summaryPrompt(session.transcript), stop })
      .catch((error: unknown) => ({ ok: false as const, error: (error as Error).message }))
    void (async () => {
      const first = await Promise.race([asked, timedOut])
      if (!this.session?.running || this.session !== session) return
      const answer = first as { ok: boolean; text?: string }
      if (!answer.ok) return
      const summary = cleanSummary(answer.text?.trim() ?? '')
      if (summary) {
        session.summary = summary
        this.ctx.emit('ambient/event', { channel: 'summary', summary } satisfies AmbientEvent)
      }
    })()
  }

  private pickModel(): { providerId: string; modelId: string } | undefined {
    const provider = this.ctx.providers.all().find((p) => p.models.length > 0)
    if (!provider) return undefined
    return { providerId: provider.id, modelId: provider.models[0]!.id }
  }

  /** askOnce 의 directory — home. 항상 진짜 폴더. (진짜 프로젝트는 async list 로만 볼 수 있어, 요약은 home 에서 열린다) */
  private directory(): string {
    try {
      return os.homedir() ?? '/'
    } catch {
      return '/'
    }
  }
}

/** 요약을 묻는 글 — 전사만 준다 (요약은 언어에 무관하게 구조적인) */
export function summaryPrompt(transcript: string): string {
  return [
    `Write a concise rolling summary of the conversation below.`,
    `- At most ${SUMMARY_MAX} characters`,
    `- Reply with the summary text only: no heading, no quotes, no trailing punctuation, no explanation`,
    '',
    '<transcript>',
    clipBytes(transcript, SUMMARY_INPUT_BYTES),
    '</transcript>',
  ].join('\n')
}

/** 모델이 준 글을 요약 한 줄로 — 생각 블록을 빼고 첫 줄, 머리표·굵게·"Summary:"·앞뒤 따옴표를 떼고 */
export function cleanSummary(raw: string): string {
  const line = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').split('\n').map((p) => p.trim()).find(Boolean) ?? ''
  const summary = line
    .replace(/^#+\s*/, '')
    .replace(/^\*\*(.*)\*\*$/, '$1')
    .replace(/^(?:summary|요약)\s*[:：]\s*/i, '')
    .replace(/^["'`“”‘’「『«]+|["'`“”‘’」』»]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return [...summary].slice(0, SUMMARY_MAX).join('')
}

function clipBytes(text: string, max: number): string {
  const bytes = Buffer.from(text, 'utf8')
  if (bytes.length <= max) return text
  return bytes.subarray(0, max).toString('utf8').replace(/�+$/, '')
}

declare module 'cordis' {
  interface Context {
    ambient: AmbientService
  }
  interface Events {
    'ambient/event'(event: AmbientEvent): void
  }
}
