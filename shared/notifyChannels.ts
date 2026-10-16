// 알림 채널 자 스위치 (이슈 #372) — 알림 기능(설정 > 기능)의 각 알람을 외부/내부로 나눠 따로 끄는 값.
//   system = **외부 알람** — 앱 창이 뒤일 때 뜨는 PC 알림(OS 알림) + dock 배지
//   app    = **내부 알람** — 창이 앞일 때 보이는 앱 안 토스트
// 둘 다 기본 켜짐 — features 와 같은 규칙으로, settings.json 에는 기본과 다른 값(false)만 남긴다.
// 대화 행·프로젝트의 점은 채널과 무관하다 — 점 은 상태 표시이지 알람이 아니라 토글로 안 꺼진다.
// 폰 다시 붙음 알림(#276)도 OS 알림이라 system 에 묶인다.

export type NotifyChannel = 'system' | 'app'
export const NOTIFY_CHANNELS: readonly NotifyChannel[] = ['system', 'app']

/** 저장된 값 — 없는 키는 기본(켜짐) */
export type NotifyChannels = Partial<Record<NotifyChannel, boolean>>

/** 각 채널의 실제 켜짐 — 없는 키는 켜짐 */
export function channelsOn(value: NotifyChannels | undefined): Record<NotifyChannel, boolean> {
  return { system: value?.system !== false, app: value?.app !== false }
}

export function isNotifyChannels(value: unknown): value is NotifyChannels {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  return Object.entries(value).every(([key, on]) => (NOTIFY_CHANNELS as readonly string[]).includes(key) && typeof on === 'boolean')
}
