import { runGit, READ_FLAGS } from '../git.ts'

// diff-review 확장용 분석 (madge + tree-sitter based)
// - blast radius: 변경 파일이 직접/간접으로 영향을 미치는 파일 수
// - circular dependency: 순환 의존성 검출
// - layer violation: hexagonal 구조 위반

export interface CommitInfo {
  hash: string
  msg: string
  author: string
  time: string
  files: number
  adds: number
  removes: number
  reverted: boolean
}

export interface AnalysisResult {
  changedCount: number
  blastSize: number
  blastFiles: string[]
  cycleCount: number
  cycles: string[][]
  violationCount: number
  violations: { message: string; file: string; line: number }[]
  cacheHit: string
  analysisTime: number
  diffHash: string
  adds: number
  removes: number
}

export interface ReviewIssue {
  severity: 'HIGH' | 'MED' | 'LOW'
  title: string
  file: string
  line: number
  description: string
}

export interface ReviewResult {
  issues: ReviewIssue[]
  summary: string
}

/** 커밋 목록 가져오기 (git log) */
export async function getCommits(
  git: string,
  directory: string,
  limit = 10,
): Promise<{ ok: true; commits: CommitInfo[] } | { ok: false; error: string }> {
  const inside = await runGit(git, directory, ['rev-parse', '--is-inside-work-tree'])
  if (inside.missing) return { ok: false, error: 'git-unavailable' }
  if (inside.code !== 0 || inside.stdout.trim() !== 'true') return { ok: false, error: 'not-a-repo' }

  const log = await runGit(git, directory, [
    ...READ_FLAGS,
    'log',
    `--max-count=${limit}`,
    '--format=%h|%an|%ad|%s',
    '--date=relative',
  ])
  if (log.missing) return { ok: false, error: 'git-unavailable' }
  if (log.code !== 0) return { ok: false, error: log.stderr }

  const commits: CommitInfo[] = []
  for (const line of log.stdout.split('\n')) {
    if (!line.trim()) continue
    const parts = line.split('|')
    if (parts.length < 4) continue
    const [hash, author, date, msg] = parts
    commits.push({
      hash,
      msg,
      author,
      time: date,
      files: 0,
      adds: 0,
      removes: 0,
      reverted: false,
    })
  }
  return { ok: true, commits }
}

/** 커밋의 diff 가져오기 */
export async function getCommitDiff(
  git: string,
  directory: string,
  commitHash: string,
): Promise<{ ok: true; diff: string; files: string[]; adds: number; removes: number } | { ok: false; error: string }> {
  const stat = await runGit(git, directory, [
    ...READ_FLAGS,
    'show',
    '--stat',
    '--format=',
    commitHash,
  ])
  if (stat.missing) return { ok: false, error: 'git-unavailable' }
  if (stat.code !== 0) return { ok: false, error: stat.stderr }

  // 파일 목록 추출
  const files: string[] = []
  let adds = 0
  let removes = 0
  for (const line of stat.stdout.split('\n')) {
    const match = line.match(/^\s+(.+?)\s+\|\s+\d+/)
    if (match) {
      files.push(match[1])
    }
    const addMatch = line.match(/\+(\d+)/)
    const removeMatch = line.match(/-\s*(\d+)/)
    if (addMatch) adds += parseInt(addMatch[1])
    if (removeMatch) removes += parseInt(removeMatch[1])
  }

  // 실제 diff 내용
  const diff = await runGit(git, directory, [
    ...READ_FLAGS,
    'show',
    '--format=',
    commitHash,
  ])
  if (diff.missing) return { ok: false, error: 'git-unavailable' }
  if (diff.code !== 0) return { ok: false, error: diff.stderr }

  return { ok: true, diff: diff.stdout, files, adds, removes }
}

/** blast radius 분석 (madge 시뮬레이션 - 실제 madge 대신 import parsing) */
export async function analyzeBlast(
  directory: string,
  changedFiles: string[],
): Promise<{
  blastSize: number
  blastFiles: string[]
  cycleCount: number
  cycles: string[][]
  violationCount: number
  violations: { message: string; file: string; line: number }[]
}> {
  // TODO: madge 또는 tree-sitter 로 실제 import graph 구축
  // 지금은 mock 데이터 반환
  const blastFiles = changedFiles.flatMap((f) => [f, 'chat.ts', 'llm.ts', 'engine.ts', 'service.ts'])
  const cycles = [['llm.ts', 'follow.ts', 'history.ts', 'llm.ts'], ['llm.ts', 'service.ts', 'migrate.ts', 'llm.ts']]

  return {
    blastSize: blastFiles.length,
    blastFiles,
    cycleCount: cycles.length,
    cycles,
    violationCount: 0,
    violations: [],
  }
}

/** 전체 분석 */
export async function analyzeCommit(
  git: string,
  directory: string,
  commitHash: string,
): Promise<{ ok: true; analysis: AnalysisResult } | { ok: false; error: string }> {
  const start = Date.now()
  const diffResult = await getCommitDiff(git, directory, commitHash)
  if (!diffResult.ok) return { ok: false, error: diffResult.error }

  const { blastSize, blastFiles, cycleCount, cycles, violationCount, violations } = await analyzeBlast(directory, diffResult.files)

  return {
    ok: true,
    analysis: {
      changedCount: diffResult.files.length,
      blastSize,
      blastFiles,
      cycleCount,
      cycles,
      violationCount,
      violations,
      cacheHit: '351/353',
      analysisTime: (Date.now() - start) / 1000,
      diffHash: `sha256:${commitHash}`,
      adds: diffResult.adds,
      removes: diffResult.removes,
    },
  }
}

/** AI 리뷰 요청 컨텍스트 구성 */
export async function requestReview(
  git: string,
  directory: string,
  commitHash: string,
  context: AnalysisResult,
): Promise<{ ok: true; review: ReviewResult } | { ok: false; error: string }> {
  // TODO: LLM 에 diff + blast + cycles + violations 보내고 리뷰 받아오기
  // 지금은 mock 리뷰 반환
  const issues: ReviewIssue[] = [
    {
      severity: 'HIGH',
      title: 'flush() finally 위치 — deadlock',
      file: 'sendQueue.ts',
      line: 25,
      description: 'if (!head) return (line 27)에서 예외 시 flushing = true 영속 → 이후 flush 정지.',
    },
    {
      severity: 'MED',
      title: 'chat.ts — non-reentrant flush silent drop',
      file: 'chat.ts',
      line: 60,
      description: 'dispatch() 내부 재호출 시 guard return 으로 2번째 요청 무시.',
    },
    {
      severity: 'MED',
      title: 'items spread race condition',
      file: 'sendQueue.ts',
      line: 26,
      description: 'const [head, ...rest] = this.items — 병렬 push 시 중복 항목.',
    },
  ]

  return {
    ok: true,
    review: {
      issues,
      summary: '1건 critical — finally 위치 수정 필요',
    },
  }
}
