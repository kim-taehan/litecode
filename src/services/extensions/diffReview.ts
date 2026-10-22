import fs from 'node:fs/promises'
import path from 'node:path'
import { runGit, READ_FLAGS } from '../git.ts'

// diff-review 확장용 실 분석
// - 커밋 목록·diff: git
// - blast radius·순환: 변경 파일과 1도 이웃의 import를 텍스트 파싱으로 (AST는 없으므로 import/export/from/require 패턴)
// - AI 리뷰: diff + 분석 결과를 JSON 명령 프롬프트로 LLM 에 보내고, 답을 JSON 으로 파싱
// - LLM 이 없으면(모델·프로바이더 미지정) 분석 컨텍스트만 담아 '수동 리뷰' 요약 반환

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

export interface DiffLine {
  type: 'cx' | 'ad' | 'de'
  num: number
  text: string
}

export interface CommitDiff {
  diff: string
  files: { path: string; adds: number; removes: number }[]
  lines: DiffLine[]
  adds: number
  removes: number
}

export interface Cycle {
  nodes: string[]
  severity: 'HIGH' | 'MED'
}

export interface Violation {
  file: string
  line: number
  message: string
}

export interface AnalysisResult {
  changedCount: number
  blastSize: number
  blastFiles: string[]
  cycleCount: number
  cycles: Cycle[]
  violationCount: number
  violations: Violation[]
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

export interface LlmReviewOptions {
  providerId?: string
  modelId?: string
  ask?: (input: { providerId: string; modelId: string; directory: string; prompt: string }) => Promise<{ ok: true; text: string } | { ok: false; error: string }>
}

// ── 커밋 ──

export async function getCommits(git: string, directory: string, limit = 10): Promise<{ ok: true; commits: CommitInfo[] } | { ok: false; error: string }> {
  const top = await runGit(git, directory, ['rev-parse', '--show-toplevel'])
  if (top.missing) return { ok: false, error: 'git-unavailable' }
  if (top.code !== 0) return { ok: false, error: 'not-a-repo' }

  const log = await runGit(git, directory, [
    ...READ_FLAGS,
    'log',
    `--max-count=${limit}`,
    '--format=%h%x1f%an%x1f%ad%x1f%s%x1e',
    '--date=relative',
  ])
  if (log.missing) return { ok: false, error: 'git-unavailable' }
  if (log.code !== 0) return { ok: false, error: log.stderr }

  const records = log.stdout
    .split('\x1e')
    .map((record) => record.trim())
    .filter(Boolean)
    .map((record) => {
      const [hash, author, time, msg] = record.split('\x1f')
      return {
        hash,
        author,
        time,
        msg,
        files: 0,
        adds: 0,
        removes: 0,
        reverted: /^\s*Revert\s/i.test(msg),
      }
    })
  if (records.length > 0) {
    for (const commit of records) {
      const stats = await getCommitStats(git, directory, commit.hash)
      if (stats.ok) {
        commit.files = stats.files.length
        commit.adds = stats.adds
        commit.removes = stats.removes
        commit.reverted = /^\s*Revert\s/i.test(commit.msg) || commit.reverted
      }
    }
  }
  return { ok: true, commits: records }
}

async function getCommitStats(
  git: string,
  directory: string,
  hash: string,
): Promise<{ ok: true; files: string[]; adds: number; removes: number } | { ok: false; error: string }> {
  const stat = await runGit(git, directory, [...READ_FLAGS, 'show', '--numstat', '--format=', hash])
  if (stat.missing) return { ok: false, error: 'git-unavailable' }
  if (stat.code !== 0) return { ok: false, error: stat.stderr }
  const files: string[] = []
  let adds = 0
  let removes = 0
  for (const line of stat.stdout.split('\n')) {
    const [addedRaw, removedRaw, file = ''] = line.split('\t')
    if (!file) continue
    files.push(file)
    if (addedRaw !== '-' && addedRaw !== '') adds += Number(addedRaw)
    if (removedRaw !== '-' && removedRaw !== '') removes += Number(removedRaw)
  }
  return { ok: true, files, adds, removes }
}

// ── 커밋 diff ──

export async function getCommitDiff(git: string, directory: string, commitHash: string): Promise<{ ok: true; diff: CommitDiff } | { ok: false; error: string }> {
  const stat = await getCommitStats(git, directory, commitHash)
  if (!stat.ok) return stat
  const show = await runGit(git, directory, [...READ_FLAGS, 'show', '--format=', '--no-color', commitHash])
  if (show.missing) return { ok: false, error: 'git-unavailable' }
  if (show.code !== 0) return { ok: false, error: show.stderr }
  const lines: DiffLine[] = []
  let contextNum = 1
  let addNum = 1
  let removeNum = 1
  for (const raw of show.stdout.split('\n')) {
    const header = raw.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/)
    if (header) {
      contextNum = parseInt(header[1] ?? '1', 10)
      addNum = parseInt(header[3] ?? '1', 10)
      removeNum = parseInt(header[1] ?? '1', 10)
      continue
    }
    if (raw.startsWith('diff --git a/')) {
      lines.push({ type: 'cx', num: 0, text: raw })
      continue
    }
    if (raw.startsWith('+') && !raw.startsWith('+++')) {
      lines.push({ type: 'ad', num: addNum++, text: raw.slice(1) })
    } else if (raw.startsWith('-') && !raw.startsWith('---')) {
      lines.push({ type: 'de', num: removeNum++, text: raw.slice(1) })
    } else if (raw.startsWith(' ') || raw === '') {
      lines.push({ type: 'cx', num: contextNum++, text: raw.startsWith(' ') ? raw.slice(1) : '' })
    }
  }
  const files = stat.files.map((filePath) => ({ path: filePath, adds: 0, removes: 0 }))
  return {
    ok: true,
    diff: { diff: show.stdout, files, lines, adds: stat.adds, removes: stat.removes },
  }
}

// ── import 파싱 ──

const IMPORT_RE = /(?:import\s+(?:[\w*{}\s,]+\s+from\s+)?|import\s*\(|require\s*\()\s*['"]([^'"\n]+)['"]/g
const EXPORT_RE = /export\s+(?:\*|\{[^}]*\})\s+from\s+['"]([^'"\n]+)['"]/g

export function parseImports(source: string): string[] {
  const found = new Set<string>()
  let match: RegExpExecArray | null
  for (const regex of [IMPORT_RE, EXPORT_RE]) {
    regex.lastIndex = 0
    while ((match = regex.exec(source)) !== null) found.add(match[1] ?? '')
  }
  return [...found]
}

async function resolveModule(root: string, fromFile: string, specifier: string): Promise<string | undefined> {
  if (!specifier.startsWith('.') && !specifier.startsWith('/')) return undefined
  const base = specifier.startsWith('/') ? path.join(root, specifier) : path.resolve(path.dirname(fromFile), specifier)
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    `${base}.jsx`,
    `${base}.mjs`,
    `${base}.cjs`,
    `${base}.json`,
    path.join(base, 'index.ts'),
    path.join(base, 'index.js'),
  ]
  const normalized = base.replace(/\\/g, '/')
  for (const candidate of candidates) {
    const norm = candidate.replace(/\\/g, '/')
    try {
      const stat = await fs.stat(candidate)
      if (stat.isFile()) return norm
    } catch {
      // 다음 후보
    }
  }
  return normalized
}

function fileSet(files: string[]): Set<string> {
  return new Set(files.map((file) => file.replace(/\\/g, '/')))
}

async function buildGraph(root: string, files: string[]): Promise<Map<string, string[]>> {
  const graph = new Map<string, string[]>()
  const known = fileSet(files)
  await Promise.all(
    files.map(async (file) => {
      const abs = path.join(root, file)
      let source = ''
      try {
        source = await fs.readFile(abs, 'utf8')
      } catch {
        graph.set(file, [])
        return
      }
      const specifiers = parseImports(source)
      const resolved: string[] = []
      for (const spec of specifiers) {
        const r = await resolveModule(root, abs, spec)
        if (r && known.has(r)) resolved.push(r)
      }
      graph.set(file, [...new Set(resolved)])
    }),
  )
  return graph
}

function shortestCycles(graph: Map<string, string[]>): Cycle[] {
  const seen = new Set<string>()
  const cycles: Cycle[] = []
  for (const start of graph.keys()) {
    const stack = [start]
    const pathSet = new Set([start])
    dfs(start, start, stack, pathSet, graph, seen, cycles)
  }
  return cycles.slice(0, 10)
}

function dfs(
  current: string,
  start: string,
  stack: string[],
  pathSet: Set<string>,
  graph: Map<string, string[]>,
  seen: Set<string>,
  out: Cycle[],
): void {
  for (const next of graph.get(current) ?? []) {
    if (pathSet.has(next)) {
      if (next === start) {
        const norm = normalizeCycle([...stack])
        if (norm && !seen.has(norm)) {
          seen.add(norm)
          out.push({ nodes: [...stack], severity: stack.length >= 5 ? 'HIGH' : 'MED' })
        }
      }
    } else {
      pathSet.add(next)
      stack.push(next)
      dfs(next, start, stack, pathSet, graph, seen, out)
      stack.pop()
      pathSet.delete(next)
    }
  }
}

function normalizeCycle(cycle: string[]): string | undefined {
  if (cycle.length < 2) return undefined
  let idx = 0
  const min = Math.min(...cycle.map((node) => node.length))
  for (let i = 1; i < cycle.length; i++) {
    if (cycle[i]!.length === min && cycle[i]! < cycle[idx]!) idx = i
  }
  return cycle.slice(idx).concat(cycle.slice(0, idx)).join('\u0000')
}

async function collectSources(root: string, changed: string[]): Promise<string[]> {
  const sources = new Set<string>(changed)
  const queue = [...changed]
  const visited = new Set<string>(changed)
  while (queue.length > 0) {
    const current = queue.shift()
    if (current === undefined) break
    const abs = path.join(root, current)
    let content = ''
    try {
      content = await fs.readFile(abs, 'utf8')
    } catch {
      continue
    }
    for (const spec of parseImports(content)) {
      const resolved = await resolveModule(root, abs, spec)
      if (resolved && !visited.has(resolved)) {
        visited.add(resolved)
        queue.push(resolved)
        sources.add(resolved)
      }
    }
  }
  return [...sources]
}

// ── blast radius ──

interface Blast {
  blastSize: number
  blastFiles: string[]
  cycleCount: number
  cycles: Cycle[]
  violationCount: number
  violations: Violation[]
}

export async function analyzeBlast(directory: string, changedFiles: string[]): Promise<Blast> {
  const root = path.resolve(directory)
  const changed = changedFiles.map((file) => file.replace(/\\/g, '/'))
  const sources = await collectSources(root, changed)
  const graph = await buildGraph(root, sources)
  const changedSet = new Set(changed)
  const direct = new Set<string>(changed)
  for (const file of sources) {
    if (changedSet.has(file)) continue
    for (const dep of graph.get(file) ?? []) {
      if (changedSet.has(dep)) {
        direct.add(file)
        break
      }
    }
  }
  const second = new Set<string>()
  for (const file of direct) {
    for (const dep of graph.get(file) ?? []) {
      if (!changedSet.has(dep)) second.add(dep)
    }
  }
  const blastFiles = [...changed.sort(), ...[...direct].sort(), ...[...second].sort()]
  const cycles = shortestCycles(graph)
  return {
    blastSize: blastFiles.length,
    blastFiles,
    cycleCount: cycles.length,
    cycles,
    violationCount: 0,
    violations: [],
  }
}

// ── 전체 분석 ──

const analysisCache = new Map<string, { ok: true; analysis: AnalysisResult } | { ok: false; error: string }>()

export async function analyzeCommit(
  git: string,
  directory: string,
  commitHash: string,
): Promise<{ ok: true; analysis: AnalysisResult } | { ok: false; error: string }> {
  const key = `${directory}\u0000${commitHash}`
  const cached = analysisCache.get(key)
  if (cached) return cached
  const start = Date.now()
  const diff = await getCommitDiff(git, directory, commitHash)
  if (!diff.ok) return diff
  const files = diff.diff.files.map((file) => file.path)
  const blast = await analyzeBlast(directory, files)
  const result = {
    ok: true as const,
    analysis: {
      changedCount: files.length,
      blastSize: blast.blastSize,
      blastFiles: blast.blastFiles,
      cycleCount: blast.cycleCount,
      cycles: blast.cycles,
      violationCount: blast.violationCount,
      violations: blast.violations,
      cacheHit: '',
      analysisTime: (Date.now() - start) / 1000,
      diffHash: `sha256:${commitHash}`,
      adds: diff.diff.adds,
      removes: diff.diff.removes,
    },
  }
  analysisCache.set(key, result)
  return result
}

// ── AI 리뷰 ──

export function reviewPrompt({ commit, diff, analysis }: { commit: string; diff: string; analysis: AnalysisResult }): string {
  const context = {
    commit,
    changedCount: analysis.changedCount,
    adds: analysis.adds,
    removes: analysis.removes,
    blastSize: analysis.blastSize,
    blastFiles: analysis.blastFiles,
    cycles: analysis.cycles.map((cycle) => cycle.nodes.join(' -> ')),
    violations: analysis.violations,
    diffHash: analysis.diffHash,
  }
  const maxDiff = 12_000
  const text = diff.length > maxDiff ? diff.slice(0, maxDiff) + '\n... (diff truncated)' : diff
  return [
    'You are a strict code reviewer. Review the diff and static analysis below.',
    'Reply with a single JSON object, no markdown, exactly:',
    '{ "issues": [ { "severity": "HIGH" | "MED" | "LOW", "title": "short title", "file": "path", "line": 123, "description": "one or two sentences" } ], "summary": "one sentence gate decision" }',
    'Rules: severity HIGH only for likely bugs/deadlocks/races/data loss; MED for risks; LOW for minor. If nothing, issues = []. Keep JSON valid.',
    '',
    '## Context',
    JSON.stringify(context, null, 2),
    '',
    '## Diff',
    '```diff',
    text,
    '```',
  ].join('\n')
}

export function parseReview(text: string): ReviewResult {
  const cleaned = text.replace(/```json|```/gi, '').trim()
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start === -1 || end <= start) return { issues: [], summary: 'AI 응답을 JSON 으로 못 받았습니다.' }
  try {
    const raw = JSON.parse(cleaned.slice(start, end + 1)) as { issues?: unknown; summary?: unknown }
    const issues: ReviewIssue[] = (Array.isArray(raw.issues) ? raw.issues : []).map((entry) => {
      const obj = (typeof entry === 'object' && entry !== null ? entry : {}) as Record<string, unknown>
      const severity = String(obj.severity ?? 'LOW').toUpperCase()
      return {
        severity: severity === 'HIGH' ? 'HIGH' : severity === 'MED' ? 'MED' : 'LOW',
        title: String(obj.title ?? 'issue'),
        file: String(obj.file ?? ''),
        line: Number(obj.line ?? 0),
        description: String(obj.description ?? ''),
      }
    })
    return { issues, summary: typeof raw.summary === 'string' ? raw.summary : `${issues.length}건 이슈` }
  } catch {
    return { issues: [], summary: 'AI 응답을 JSON 으로 못 받았습니다.' }
  }
}

export async function requestReview(
  git: string,
  directory: string,
  commitHash: string,
  context: AnalysisResult,
  options: LlmReviewOptions = {},
): Promise<{ ok: true; review: ReviewResult } | { ok: false; error: string }> {
  const diff = await getCommitDiff(git, directory, commitHash)
  if (!diff.ok) return diff
  if (options.providerId && options.modelId && options.ask) {
    const prompt = reviewPrompt({ commit: commitHash, diff: diff.diff.diff, analysis: context })
    const result = await options.ask({ providerId: options.providerId, modelId: options.modelId, directory, prompt })
    if (result.ok) return { ok: true, review: parseReview(result.text) }
    return { ok: false, error: result.error }
  }
  const issues: ReviewIssue[] = []
  if (context.blastSize > 5) {
    issues.push({
      severity: 'MED',
      title: '큰 blast radius',
      file: context.blastFiles[0] ?? '',
      line: 0,
      description: `변경이 ${context.blastSize}개 파일까지 전파됩니다. API·호출부 확인 필요.`,
    })
  }
  for (const cycle of context.cycles) {
    issues.push({
      severity: cycle.severity,
      title: '순환 의존',
      file: cycle.nodes[0] ?? '',
      line: 0,
      description: cycle.nodes.join(' → '),
    })
  }
  return { ok: true, review: { issues, summary: issues.length === 0 ? '문제의 소지가 없습니다.' : `${issues.length}건 확인 필요` } }
}
