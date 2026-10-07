import { Context, Service } from 'cordis'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { realDirectory } from './llm.ts'
import { trajectoryRecords, type TrajectoryRecord } from './trajectory.ts'
import { redactSecrets } from './logFile.ts'
import type { Conversation } from './sessions.ts'
import './sessions.ts'
import './settings.ts'
import './features.ts'
import './providers.ts'
import './engine.ts'
import './mcp.ts' // ctx.mcp 선언 (선택 의존 — 아래)
import { tr } from '../i18n.ts'

// 대화 내보내기 · 문제 신고 묶음 (ctx.report, 이슈 #177 — dsh session-log-export·feedback 의 아이디어만, 코드는 새로 썼다).
// **밖으로는 아무것도 보내지 않는다** — 사용자가 고른 자리에 파일로만 쓴다. 담당자에게 건네는 것은 사용자다.
//
// - 대화 내보내기: 대화 하나의 엔진 기록을 Trajectory 탭과 같은 중립 레코드(trajectory.ts trajectoryRecords — 말·도구 호출·결과·시각,
//   하위 작업 포함)로 바꿔 JSON 파일 하나에 쓴다. 대화 내용 그대로다(가리지 않는다 — 사용자가 고른 대화를 사용자가 고른 곳에)
// - 문제 신고 묶음: 고른 폴더 안에 litecode-report-<시각>/ 을 만들고 **허용 목록(BUNDLE_FILES)의 파일만** 쓴다. 들어가지 않는 것:
//   API 키·비밀번호·토큰, MCP 서버 정의(헤더·env 값), 대화 내용(대화 목록도 읽지 않는다). 모든 글은 쓰기 직전에 scrubSecrets 를 지난다 —
//   알려진 비밀 값(provider 키·MCP env/헤더 값)을 글자 그대로 지우고, 모양 그물(logFile.ts redactSecrets)을 한 번 더 건다.
//   main.log 는 쓸 때 이미 가렸지만(logFile.ts) 모양 그물만이라 키 모양이 아닌 값은 못 잡는다 — 그래서 여기서 알려진 값으로 다시 본다
//
// 대화상자·폴더 열기는 host(electron/reportHost.ts)로 받는다 — 서비스는 Electron 을 모른다. ctx.mcp 는 기능 묶음(꺼질 수 있다)이라
// inject 하지 않고 쓸 때 ctx.get 으로 본다 (quit.ts 의 remote 와 같은 방식)

declare module 'cordis' {
  interface Context {
    report: ReportService
  }
}

/** 묶음에 들어가는 파일 — 이것 말고는 쓰지 않는다 */
export const BUNDLE_FILES = ['about.json', 'providers.json', 'engine.log', 'main.log'] as const
type BundleFile = (typeof BUNDLE_FILES)[number]

/** 이보다 짧은 알려진 값은 글자 그대로 찾지 않는다 — "true"·"core" 같은 값이 로그를 망가뜨린다 (모양 그물은 그대로 돈다) */
const MIN_KNOWN_SECRET = 6

/** 저장했다(경로) 또는 대화상자를 취소했다 */
export type ReportResult = { saved: string } | { canceled: true }

/** 창·OS 쪽 — 메인이 Electron 으로 채운다. owner 는 다리가 넘긴 IPC 요청의 sender 그대로다(대화상자를 붙일 창을 host 가 찾는다) */
export interface ReportHost {
  /** 대화 내보내기 — 저장할 파일 경로를 묻는다. 취소면 undefined */
  chooseSaveFile(defaultName: string, owner?: unknown): Promise<string | undefined>
  /** 문제 신고 묶음 — 묶음 폴더를 만들 자리를 묻는다. 취소면 undefined */
  chooseFolder(owner?: unknown): Promise<string | undefined>
  /** 폴더를 OS 파일 관리자로 연다. 못 열면 던진다 */
  openFolder(dir: string): Promise<void>
}

export interface ReportOptions {
  host: ReportHost
  /** 앱 로그 파일 (userData/logs/main.log — logFile.ts) */
  logFile: string
  /** 앱 버전 (package.json version) */
  appVersion: string
  /** 테스트가 시각을 고정한다 */
  now?: () => Date
}

/** 폴더·파일 이름의 시각 — 지역 시각 YYYY-MM-DD-HHmm */
export function reportStamp(date: Date): string {
  const two = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}-${two(date.getHours())}${two(date.getMinutes())}`
}

/** 알려진 비밀 값을 글자 그대로(JSON 이스케이프 꼴도) 지우고, 모양 그물(redactSecrets)을 건다 */
export function scrubSecrets(text: string, known: readonly string[]): string {
  let scrubbed = text
  for (const value of known) {
    if (value.length < MIN_KNOWN_SECRET) continue
    for (const form of new Set([value, JSON.stringify(value).slice(1, -1)])) scrubbed = scrubbed.split(form).join('[redacted]')
  }
  return redactSecrets(scrubbed)
}

export class ReportService extends Service {
  static readonly inject = ['llm', 'sessions', 'settings', 'features', 'providers', 'engine']

  /** 이 실행에서 만든 묶음 폴더 — 화면이 연다고 해도 이것만 연다 (아무 경로나 OS 로 열지 않게) */
  private bundles = new Set<string>()

  constructor(
    ctx: Context,
    private opts: ReportOptions,
  ) {
    super(ctx, 'report')
  }

  private now(): Date {
    return this.opts.now?.() ?? new Date()
  }

  /** 대화 하나를 JSON 파일 하나로 — 저장 위치를 먼저 묻고(취소면 엔진에 묻지 않는다), 기록을 읽어 쓴다. 못 읽으면 사유를 던지고 파일은 만들지 않는다 */
  async exportConversation(conversationId: string, owner?: unknown): Promise<ReportResult> {
    const conversation = (await this.ctx.sessions.list()).find((entry) => entry.id === conversationId)
    if (!conversation) throw new Error(tr('error.noConversation'))
    const exportedAt = this.now()
    const file = await this.opts.host.chooseSaveFile(`litecode-chat-${reportStamp(exportedAt)}.json`, owner)
    if (!file) return { canceled: true }
    const records = await this.records(conversation)
    const { id, title, project, model, mode, updatedAt } = conversation
    const body = {
      format: 'litecode-conversation',
      formatVersion: 1,
      exportedAt: exportedAt.toISOString(),
      app: { version: this.opts.appVersion },
      conversation: { id, title, project, model, mode, updatedAt },
      records,
    }
    await fs.promises.writeFile(file, `${JSON.stringify(body, null, 2)}\n`)
    return { saved: file }
  }

  /** 엔진 기록 → 중립 레코드. 엔진 세션이 없으면(첫 메시지 전) 빈 기록. 폴더는 ctx.llm 의 문(engineFolder)을 지난다 */
  private async records(conversation: Conversation): Promise<TrajectoryRecord[]> {
    if (!conversation.engineSessionId) return []
    const workdir = await realDirectory(conversation.project)
    if (!workdir) throw new Error(tr('error.noWorkdir', { dir: conversation.project }))
    try {
      const raw = await this.ctx.llm.readMessages(workdir, conversation.engineSessionId)
      return trajectoryRecords(raw, workdir, this.ctx.llm.mcpTool(workdir), await this.ctx.llm.readSubtasks(workdir, raw))
    } catch (error) {
      throw new Error(tr('error.exportRead', { message: (error as Error).message }))
    }
  }

  /** 문제 신고 묶음 — 고른 자리 안에 litecode-report-<시각>/ (있으면 -2, -3 …)을 만들고 허용 목록의 파일만 쓴다 */
  async createBundle(owner?: unknown): Promise<ReportResult> {
    const parent = await this.opts.host.chooseFolder(owner)
    if (!parent) return { canceled: true }
    const createdAt = this.now()
    const dir = makeFreshDir(path.join(parent, `litecode-report-${reportStamp(createdAt)}`))
    const known = this.knownSecrets()
    const write = (name: BundleFile, text: string) => fs.writeFileSync(path.join(dir, name), scrubSecrets(text, known))

    const engine = this.ctx.engine
    write('about.json', `${JSON.stringify({
      createdAt: createdAt.toISOString(),
      app: { version: this.opts.appVersion },
      os: { platform: os.platform(), release: os.release(), arch: os.arch() },
      runtime: { node: process.versions.node, ...(process.versions['electron'] && { electron: process.versions['electron'] }) },
      language: this.ctx.settings.get().language,
      features: this.ctx.features.enabled(),
      engine: { name: 'opencode', version: (await engine.version().catch(() => undefined)) ?? null },
    }, null, 2)}\n`)
    // provider 는 이름·주소·모델 id 와 키를 넣었는지만 — 키 값은 싣지 않는다 (주소 안 비밀번호·토큰은 scrubSecrets 가 가린다)
    write('providers.json', `${JSON.stringify(this.ctx.providers.all().map((provider) => ({
      id: provider.id,
      name: provider.displayName,
      baseURL: provider.baseURL,
      protocol: provider.protocol,
      models: provider.models.map((model) => model.id),
      hasKey: this.ctx.providers.apiKey(provider.id) !== undefined,
    })), null, 2)}\n`)
    write('engine.log', engine.outputTail())
    const mainLog = await fs.promises.readFile(this.opts.logFile, 'utf8').catch(() => undefined)
    if (mainLog !== undefined) write('main.log', mainLog)

    this.bundles.add(dir)
    return { saved: dir }
  }

  /** 이 실행에서 만든 묶음 폴더를 연다 — 다른 경로는 거절한다 */
  async openBundle(dir: string): Promise<void> {
    if (typeof dir !== 'string' || !this.bundles.has(dir)) throw new Error(tr('report.openFailed'))
    await this.opts.host.openFolder(dir)
  }

  /** 글자 그대로 지울 비밀 값 — provider 키, MCP 서버의 env·헤더 값(비밀 표시와 무관하게 전부) */
  private knownSecrets(): string[] {
    const keys = this.ctx.providers.all().flatMap((provider) => this.ctx.providers.apiKey(provider.id) ?? [])
    return [...keys, ...(this.ctx.get('mcp')?.varValues() ?? [])]
  }
}

/** 없으면 만들고, 있으면 -2, -3 … 을 붙여 새로 만든다 (덮어쓰지 않는다) */
function makeFreshDir(base: string): string {
  for (let index = 1; ; index++) {
    const dir = index === 1 ? base : `${base}-${index}`
    try {
      fs.mkdirSync(dir)
      return dir
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
  }
}
