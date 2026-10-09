// 새 버전 알림 (기능 `updates`, 이슈 #273 — 알림만, 받아서 설치하지 않는다: mac 은 ad-hoc 서명이라 자동 교체가 안 된다).
// 순수 로직 — 메인(ctx.updates)과 화면(설정 > 일반·사이드바 알림)이 같이 쓴다. 네트워크·Electron 을 모른다.

/** 확인 주소 기본값 — GitHub 릴리즈의 최신(정식) 하나. 설정 `updateUrl` 이 있으면 그것 */
export const DEFAULT_UPDATE_URL = 'https://api.github.com/repos/kim-taehan/litecode/releases/latest'

export type UpdateState = 'idle' | 'checking' | 'up-to-date' | 'available' | 'failed'

/** 메인이 화면에 밀어 주는 확인 상태. latest 는 릴리즈 태그 그대로(`v0.1.3`), url 은 릴리즈 페이지(html_url) */
export interface UpdateStatus {
  state: UpdateState
  latest?: string
  url?: string
  checkedAt?: number
}

/** 쓸 확인 주소 — 비었으면 기본값 */
export function updateUrlOf(settings: { updateUrl?: string }): string {
  return settings.updateUrl?.trim() || DEFAULT_UPDATE_URL
}

/** 설정에 넣을 수 있는 확인 주소 — 빈 글(기본값) 또는 http(s) 주소 */
export function isUpdateUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false
  if (!value.trim()) return true
  try {
    const url = new URL(value.trim())
    return url.protocol === 'https:' || url.protocol === 'http:'
  } catch {
    return false
  }
}

/** `v0.1.3`·`0.1.3` → [0, 1, 3]. 꼬리표(`-beta` 등 — 정식이 아니다)나 다른 모양이면 undefined */
export function parseVersion(text: string): [number, number, number] | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(text.trim())
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined
}

/** 메이저·마이너·패치 숫자 비교 — a 가 새것이면 양수, 같으면 0, 낡았으면 음수. 둘 중 하나라도 못 읽으면 undefined */
export function compareVersions(a: string, b: string): number | undefined {
  const left = parseVersion(a)
  const right = parseVersion(b)
  if (!left || !right) return undefined
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i]! - right[i]!
  return 0
}

/** 릴리즈 응답 하나를 판정한다 — 모양이 다르면 failed, draft·prerelease 는 무시(최신으로 본다), 현재보다 새것이면 available */
export function judgeRelease(body: unknown, current: string): Omit<UpdateStatus, 'checkedAt'> {
  if (!body || typeof body !== 'object') return { state: 'failed' }
  const { tag_name: tag, html_url: url, draft, prerelease } = body as Record<string, unknown>
  if (draft === true || prerelease === true) return { state: 'up-to-date', latest: `v${current}` }
  if (typeof tag !== 'string' || typeof url !== 'string') return { state: 'failed' }
  const order = compareVersions(tag, current)
  if (order === undefined) return { state: 'failed' }
  return order > 0 ? { state: 'available', latest: tag, url } : { state: 'up-to-date', latest: tag }
}

/** [내려받기] 로 열어도 되는 주소 — https 이고 호스트가 github.com 이거나 확인 주소의 호스트 (임의 스킴·다른 호스트 거부) */
export function releaseUrlAllowed(url: unknown, updateUrl: string): boolean {
  if (typeof url !== 'string') return false
  let target: URL
  try {
    target = new URL(url)
  } catch {
    return false
  }
  if (target.protocol !== 'https:') return false
  let source: string | undefined
  try {
    source = new URL(updateUrl).host
  } catch {
    source = undefined
  }
  return target.host === 'github.com' || target.host === source
}
