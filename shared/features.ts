// 끌 수 있는 기능 (이슈 #8, 사용자 결정 2026-10-02 — _workspace/00_next_features.md). 메인(ctx.features — 묶음 올리고 내리기)과
// 화면(설정 > 기능, 꺼진 기능의 버튼·탭 숨기기)이 같이 쓴다. 기본은 켜짐 — settings.json 의 features 에 false 로 적힌 것만 꺼진다
// (새 기능이 생겨도 기본 켜짐). FEATURE_DEFAULT_OFF 에 든 기능만 기본 꺼짐이고 true 로 적어야 켜진다. 파일에는 기본값과 다른 값만 남긴다.
// 바탕(대화·엔진·설정·provider·프로젝트·대화 저장)은 여기에 없다 — 끌 수 없다.

import type { MessageKey } from './i18n/ko.ts'

// skills(이슈 #7)는 묶음(ctx.skills — `+` 메뉴의 스킬 팝업 목록(#43)·`/` 후보·본문 붙이기)과 엔진 설정(끄면 opencode skill 도구 deny — ctx.engine 이 재시작) 둘 다다
export const FEATURES = ['at', 'slash', 'bang', 'shell', 'terminal', 'trajectory', 'notifications', 'openIn', 'skills', 'mcp', 'web', 'remote', 'lan', 'bluetooth', 'appMcp', 'hooks', 'voice', 'browser'] as const
export type FeatureId = (typeof FEATURES)[number]

/** 고정 — 사용자가 못 바꾼다 (사용자 결정 2026-10-03). 저장된 값이 있어도 이 값이 이기고, 설정 > 기능에 카드가 없다.
 *  필수(늘 켜짐): 입력 트리거 @ · / · ! 와 !명령 실행, 스킬, MCP */
const FIXED = { at: true, slash: true, bang: true, shell: true, skills: true, mcp: true } as const satisfies Partial<Record<FeatureId, boolean>>
export const FEATURE_FIXED: Partial<Record<FeatureId, boolean>> = FIXED

/** 사용자가 켜고 끄는 기능의 id — 카드의 이름·설명 글(`feature.<id>`)은 이것에만 있다 */
export type ChoosableFeatureId = Exclude<FeatureId, keyof typeof FIXED>

/** 사용자가 켜고 끄는 기능 (설정 > 기능의 카드) */
export const CHOOSABLE_FEATURES: readonly FeatureId[] = FEATURES.filter((feature) => !(feature in FEATURE_FIXED))

/** 설정 > 기능에 카드를 두지 않는 기능 — 모바일 연결의 길(사내망·블루투스)은 설정 > 모바일 한 곳에서만 켜고 끈다 (사용자 결정 2026-10-09: "기능 화면에서는 하나만") */
export const MOBILE_PATH_FEATURES: readonly FeatureId[] = ['lan', 'bluetooth']

/** 설정 > 기능의 중분류 (사용자 결정 2026-10-06, 시안 B — 네 묶음) — 고르는 기능을 빠짐없이 한 번씩 담는다(단위 테스트가 댄다). 묶음 안 순서가 카드 순서 */
export const FEATURE_GROUPS: readonly { id: 'screen' | 'ai' | 'automation' | 'devices'; features: readonly ChoosableFeatureId[] }[] = [
  { id: 'screen', features: ['terminal', 'trajectory', 'openIn'] },
  { id: 'ai', features: ['appMcp', 'web', 'browser'] },
  { id: 'automation', features: ['hooks'] },
  { id: 'devices', features: ['voice', 'remote', 'notifications'] },
]

/** 고르는 기능 중 기본 꺼짐 — 알림 (사용자 결정 2026-10-03), 모바일 연결(remote, 이슈 #56 — 포트를 여는 기능이라 사용자가 켠다),
 *  웹 가져오기(web — opencode 내장 webfetch, 이슈 #14·#103: 2026-10-03 에 늘 꺼짐으로 고정했다가 2026-10-05 사용자 결정으로 다시 고르게.
 *  폐쇄망에선 바깥 주소에 멈추므로 사내 주소용이다. 레거시 경로엔 websearch 가 없다).
 *  나머지(터미널 칸·추론 과정·다른 앱에서 열기·데스크탑 MCP)는 기본 켜짐.
 *  데스크탑 MCP(appMcp, 이슈 #99)는 앱 내장 MCP 서버(ctx.appMcp)와 그 도구 — 끄면 서버가 내려가고 다음 턴부터 엔진에서 `litecode_*` 도구가 빠진다.
 *  훅(hooks, 이슈 #102)은 기본 꺼짐 — 사용자 셸 명령을 AI 의 행동에 걸어 돌리는 기능이라 사용자가 켠다.
 *  음성 입력(voice — ctx.speech)도 기본 꺼짐 — 마이크 권한을 묻고 쓰는 동안 메모리 ~1GB 인 기능이라 사용자가 켠다. 꺼져 있으면 마이크 권한도 거절한다.
 *  브라우저(browser — ctx.browser, 이슈 #147)도 기본 꺼짐 — AI 가 Chrome 창을 조종하고, 켜면 도구 25개의 스키마(26KB)가 매 요청에 실린다.
 *  모바일 연결의 길은 둘이다 (이슈 #210, 설계 01ab "연결 수단 고르기" — 길마다 토글): 사내망 연결(lan — TLS 리스너, 기본 켜짐: 모바일 연결을 켜면 전처럼 열린다)과
 *  블루투스 연결(bluetooth — 기본 꺼짐: 켜는 순간 macOS 가 블루투스 허용을 묻고, 네이티브 모듈을 그때 읽는다). 둘 다 모바일 연결(remote)이 켜져 있어야 한다 */
export const FEATURE_DEFAULT_OFF: readonly FeatureId[] = ['notifications', 'remote', 'web', 'hooks', 'voice', 'browser', 'bluetooth']

/** 저장된 값이 없을 때의 켜짐 */
export function featureDefault(feature: FeatureId): boolean {
  return !FEATURE_DEFAULT_OFF.includes(feature)
}

/** 그 기능이 쓰려면 같이 켜져 있어야 하는 기능 — `!` 입력은 `!명령` 실행(ctx.shell)이 돌린다 */
export const FEATURE_REQUIRES: Partial<Record<FeatureId, readonly FeatureId[]>> = { bang: ['shell'], appMcp: ['mcp'], browser: ['mcp'], lan: ['remote'], bluetooth: ['remote'] }

/** 켜지 못한 사유 (이슈 #224) — 글(묶음이 던진 오류 메시지를 한 줄로 정리한 것) 또는 화면 언어로 번역할 문구 키 */
export type FeatureReason = string | { key: MessageKey; vars?: Record<string, string | number> }

/** 켜진 기능의 상태 (이슈 #224) — mounting: 묶음을 올리는 중 · on: 떴다 · failed: 묶음이 던졌거나 스스로 문제를 알렸다(ctx.features.problem).
 *  꺼진 기능은 상태가 없다(목록에서 빠진다). 화면은 failed 만 그린다 — 정상 상태엔 태그를 달지 않는다 */
export type FeatureStatus = { state: 'mounting' } | { state: 'on' } | { state: 'failed'; reason: FeatureReason }
export type FeatureStatuses = Partial<Record<FeatureId, FeatureStatus>>

/** 기능별 켜기 값 — 없는 키는 기본값(featureDefault) */
export type FeatureSwitches = Partial<Record<FeatureId, boolean>>

export function isFeature(value: unknown): value is FeatureId {
  return (FEATURES as readonly unknown[]).includes(value)
}

export function isFeatureSwitches(value: unknown): value is FeatureSwitches {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.entries(value).every(([key, on]) => isFeature(key) && typeof on === 'boolean')
  )
}

/** 저장된 값으로 본 실제 켜짐 — 고정된 기능은 고정 값, 그 밖엔 꺼졌거나 필요한 기능이 꺼졌으면 false */
export function featureOn(switches: FeatureSwitches | undefined, feature: FeatureId): boolean {
  const fixed = FEATURE_FIXED[feature]
  if (fixed !== undefined) return fixed
  return (switches?.[feature] ?? featureDefault(feature)) && (FEATURE_REQUIRES[feature] ?? []).every((needed) => featureOn(switches, needed))
}
