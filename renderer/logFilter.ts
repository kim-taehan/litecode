// 기록 탭 필터 (#400 #409, 시안 ⑤) — 필터 상태와 git 쿼리 변환. 순수: DOM·IPC 를 모른다.

import type { GitLogPageQuery } from '../shared/git.ts'

export interface GitLogFilter {
  /** 검색 칸 — 빈 글 = 필터 아님 */
  text: string
  /** `.*` — 패턴으로 */
  regex: boolean
  /** `Cc` — 대소문자 구분 (기본 true) */
  caseSensitive: boolean
  /** 브랜치 — '' = 지금 브랜치(HEAD), 'all' = 전체, 그 밖 = 브랜치 이름(로컬·원격) */
  branch: string
  /** 작성자 */
  author: string
  date: 'all' | 'today' | 'week' | 'month'
  /** 경로(공백 구분) */
  paths: string[]
}

/** 기본 — 브랜치·경로만 없으면 비어 있고, 날짜는 'all' */
export function defaultLogFilter(): GitLogFilter {
  return { text: '', regex: false, caseSensitive: true, branch: '', author: '', date: 'all', paths: [] }
}

/** 필터가 기본에서 하나라도 다른가 — 그래프 폭 상한(maxLanes) 이 필요할 때 (부모가 목록에서 빠질 수 있으니까) */
export function isLogFilterActive(filter: GitLogFilter): boolean {
  return filter.text.trim() !== '' || filter.branch !== '' || filter.author.trim() !== '' || filter.date !== 'all' || filter.paths.length > 0
}

/** 16진 4~40자 — hash 처럼 보이는지 (서비스가 rev-parse 로 해석) */
export function isHashLike(text: string): boolean {
  return /^[0-9a-f]{4,40}$/i.test(text.trim())
}

/** 날짜 프리셋 → 로컬 시각 'YYYY-MM-DD HH:MM:SS' 범위로 */
export function logDateRange(date: GitLogFilter['date'], now: number): { since?: string; until?: string } {
  if (date === 'all') return {}
  const n = new Date(now)
  const days = date === 'today' ? 0 : date === 'week' ? 6 : 29
  const start = new Date(n.getFullYear(), n.getMonth(), n.getDate() - days)
  const end = date === 'today' ? new Date(n.getFullYear(), n.getMonth(), n.getDate() + 1) : undefined
  return { since: localStamp(start), until: end ? localStamp(end) : undefined }
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

export function localStamp(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/** 필터 + skip → 서비스 쿼리 */
export function buildLogQuery(filter: GitLogFilter, skip: number, now: number = Date.now()): GitLogPageQuery {
  const query: GitLogPageQuery = { skip }
  const text = filter.text.trim()
  if (text) {
    query.text = text
    if (filter.regex || !isHashLike(text)) {
      query.regex = filter.regex
      query.caseSensitive = filter.caseSensitive
    }
  }
  if (filter.branch) query.branch = filter.branch
  if (filter.author.trim()) query.author = filter.author.trim()
  const range = logDateRange(filter.date, now)
  if (range.since) query.since = range.since
  if (range.until) query.until = range.until
  const paths = filter.paths.map((path) => path.trim()).filter(Boolean)
  if (paths.length > 0) query.paths = paths
  return query
}
