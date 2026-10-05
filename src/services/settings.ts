import { Context, Service } from 'cordis'
import fs from 'node:fs'
import path from 'node:path'
import { isLanguage, type Language } from '../../shared/i18n/index.ts'
import { setMainLanguage, tr } from '../i18n.ts'
import { readJsonFileSync } from './jsonFile.ts'
import { FONT_SIZE_MAX, FONT_SIZE_MIN } from '../../shared/fontSize.ts'
import { DEFAULT_MODE, isMode, type Mode } from '../../shared/modes.ts'
import { isFeatureSwitches, type FeatureSwitches } from '../../shared/features.ts'
import { isSpeechLanguage, type SpeechLanguage } from '../../shared/speech.ts'

// 앱 설정(설정 > 일반) — 언어·테마·대화 글자 크기·코딩 뷰. 정본은 이 서비스, 앱에서는 userData 의 settings.json 하나
// ("설정 파일 열기" 가 여는 파일 — dsh 처럼 사용자가 텍스트로 고칠 수 있다). 손으로 고친 값은 다음 실행 때 읽는다(파일 감시 없음).
// 잘못된 값은 그 값만 기본값으로 돌린다 — 파일 하나를 잘못 고쳐 앱이 안 뜨면 안 된다.
// Electron 을 모른다: 테마를 nativeTheme 에 넣는 일은 electron/main.ts 가 'settings/changed' 를 듣고 한다.

export type Appearance = 'light' | 'dark' | 'system'

export interface Settings {
  language: Language
  appearance: Appearance
  /** 대화 본문 글자 크기(px) — FONT_SIZE_MIN~MAX 정수 (dsh ui-theme 와 같은 범위) */
  fontSize: number
  /** 본문의 추론 과정(Trajectory) 탭을 보인다 (dsh "Coding Tools") */
  codingView: boolean
  /** PC 알림(OS 알림)을 띄운다 — 끄면 PC 알림만 없고 앱 안 토스트·점은 그대로 (ctx.notifications, 결정 Q9) */
  notifications: boolean
  /** 새 대화가 시작하는 모드 (입력창 칩의 처음 값). 대화마다의 모드는 ctx.sessions 에 */
  defaultMode: Mode
  /** "다른 앱에서 열기" 의 기본 앱 id — 메뉴에서 마지막으로 고른 앱 (dsh 방식, 설정 화면 없음). 없으면 목록 첫 앱 (ctx.openIn) */
  openInApp?: string
  /** 기능별 켜기 (설정 > 기능, 이슈 #8) — false 로 적힌 기능만 꺼진다. 없으면 모두 켜짐 (ctx.features 가 묶음을 올리고 내린다) */
  features?: FeatureSwitches
  /** "Claude Code 스킬 함께 쓰기" (설정 > 스킬, 이슈 #7) — 켜면 엔진이 ~/.claude/skills·프로젝트 .claude/skills 를 싣는다(ctx.engine 재시작). 없으면 꺼짐(사용자 결정) */
  claudeSkills?: boolean
  /** "창을 닫아도 계속 실행" (설정 > 일반, 이슈 #92 — Windows·Linux 만) — 창 닫기가 숨기기가 되고 앱은 트레이에 남는다. 없으면 켜짐. false 면 창 닫기 = 종료 (ctx.quit) */
  keepRunning?: boolean
  /** 처음 창을 숨길 때의 "트레이에서 계속 실행됩니다" 안내를 이미 띄웠다 — 다시 안 띄운다 (ctx.quit 이 적는다) */
  trayNoticeShown?: boolean
  /** 받아쓰기(음성 입력, ctx.speech) 언어 힌트 — 없으면 화면 언어를 따른다 (shared/speech.ts speechLanguage) */
  speechLanguage?: SpeechLanguage
}

/** 사용자 결정 2026-10-01: 영어·라이트. 글자 크기는 dsh 기본 14. 코딩 뷰는 지금 화면 그대로(켬). 알림 기본 켬(Q9). 새 대화는 기본 모드(01k §6) */
const DEFAULTS: Settings = { language: 'en', appearance: 'light', fontSize: 14, codingView: true, notifications: true, defaultMode: DEFAULT_MODE }

export interface SettingsOptions {
  /** settings.json 경로. 없으면 메모리에만 둔다 */
  file?: string
  /** 파일에 값이 없을 때 — 실물 테스트가 언어를 한국어로 고정할 때 쓴다 */
  defaults?: Partial<Settings>
}

declare module 'cordis' {
  interface Context {
    settings: SettingsService
  }
  interface Events {
    'settings/changed'(settings: Settings): void
  }
}

const valid: { [K in keyof Settings]-?: (value: unknown) => value is Settings[K] } = {
  language: isLanguage,
  appearance: (value): value is Appearance => value === 'light' || value === 'dark' || value === 'system',
  fontSize: (value): value is number => Number.isInteger(value) && (value as number) >= FONT_SIZE_MIN && (value as number) <= FONT_SIZE_MAX,
  codingView: (value): value is boolean => typeof value === 'boolean',
  notifications: (value): value is boolean => typeof value === 'boolean',
  defaultMode: isMode,
  openInApp: (value): value is string => typeof value === 'string',
  features: isFeatureSwitches,
  claudeSkills: (value): value is boolean => typeof value === 'boolean',
  keepRunning: (value): value is boolean => typeof value === 'boolean',
  trayNoticeShown: (value): value is boolean => typeof value === 'boolean',
  speechLanguage: isSpeechLanguage,
}
const KEYS = Object.keys(valid) as (keyof Settings)[]

export class SettingsService extends Service {
  private current: Settings

  constructor(
    ctx: Context,
    private opts: SettingsOptions = {},
  ) {
    super(ctx, 'settings')
    const base = { ...DEFAULTS, ...opts.defaults }
    const stored = (opts.file && readJson(opts.file)) || {}
    this.current = Object.fromEntries(KEYS.map((key) => [key, valid[key](stored[key]) ? stored[key] : base[key]])) as unknown as Settings
    setMainLanguage(this.current.language)
  }

  get(): Settings {
    return { ...this.current }
  }

  /** 바꿀 값만. 하나라도 잘못이면 아무것도 안 바꾸고 던진다 */
  set(patch: Partial<Settings>): Settings {
    for (const key of Object.keys(patch) as (keyof Settings)[]) {
      if (!(key in valid) || !valid[key](patch[key])) throw new Error(tr('error.settingInvalid', { name: key }))
    }
    this.current = { ...this.current, ...patch }
    setMainLanguage(this.current.language)
    if (this.opts.file) writeJson(this.opts.file, this.current)
    this.ctx.emit('settings/changed', this.get())
    return this.get()
  }

  /** "설정 파일 열기" — 아직 없으면 지금 값으로 만든다 (dsh SettingsDocumentAction). 메모리 전용이면 undefined */
  ensureFile(): string | undefined {
    const file = this.opts.file
    if (!file) return undefined
    if (!fs.existsSync(file)) writeJson(file, this.current)
    return file
  }
}

/** 없으면 undefined. 손상됐으면 옆에 옮겨 두고 undefined (jsonFile.ts) */
function readJson(file: string): Record<string, unknown> | undefined {
  return readJsonFileSync(file, 'object') as Record<string, unknown> | undefined
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`) // 사람이 열어 고치는 파일이라 들여 쓴다
  fs.renameSync(temp, file)
}
