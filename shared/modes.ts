// 대화 모드 — 입력창 칩 하나 (사용자 결정 2026-10-02, _workspace/00_next_modes.md). 메인(검증·엔진)과 화면(칩·설정)이 같이 쓴다.
// 엔진 쪽 뜻(opencode 에이전트·권한)은 ctx.engine 만 안다 (engine.ts MODE_AGENT) — 화면은 이 이름만 안다.
// plan: 읽기·검색만 / build: opencode 기본(편집·명령 허용, 폴더 밖·.env 는 묻는다) / ask: 편집·명령·웹마다 묻는다 / full: 다 묻지 않는다

export const MODES = ['plan', 'build', 'ask', 'full'] as const
export type Mode = (typeof MODES)[number]

export const DEFAULT_MODE: Mode = 'build'

/** Shift+Tab 이 도는 모드 — 전체 권한은 확인 대화상자를 거쳐 메뉴로만 고른다 */
export const CYCLE_MODES: readonly Mode[] = ['plan', 'build', 'ask']

export function isMode(value: unknown): value is Mode {
  return (MODES as readonly unknown[]).includes(value)
}
