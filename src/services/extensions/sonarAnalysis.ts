import fs from 'node:fs'
import path from 'node:path'
import { scopedScanArgs } from './scannerScope.ts'

// SonarQube 분석 (이슈 #545) — 내장 서버(admin: sonarqube)를 쓰는 확장의 [분석]. 앱이 아는 동봉 배치(server/scanner·server/runtime)로 스캐너를 띄운다(servers.ts).
// 여기는 순수 계산만: 프로젝트 키 · 스캐너 인자 · 분석 작업 id. 근거 실측 _workspace/01_probe_537.md §8·§11

/** SonarQube 프로젝트 키에 쓸 수 있는 글자 — 영문·숫자·`-_.:`, 숫자만은 안 된다 */
const KEY = /^[A-Za-z0-9_.:-]+$/

/** 프로젝트 키 — 프로젝트 폴더의 sonar-project.properties 의 sonar.projectKey, 없거나 쓸 수 없으면 프로젝트 이름에서 만든다 */
export function sonarProjectKey(projectDir: string, name: string): string {
  try {
    const text = fs.readFileSync(path.join(projectDir, 'sonar-project.properties'), 'utf8')
    const found = /^\s*sonar\.projectKey\s*[=:]\s*(.*?)\s*$/m.exec(text)?.[1]
    if (found && KEY.test(found) && !/^\d+$/.test(found)) return found
  } catch {
    // 파일이 없다
  }
  const made = name.replace(/[^A-Za-z0-9_.:-]+/g, '-').replace(/^-+|-+$/g, '')
  if (made === '') return 'project'
  return /^\d+$/.test(made) ? `p${made}` : made
}

export interface ScanTarget {
  serverUrl: string
  projectKey: string
  projectDir: string
  /** 스캐너 작업 폴더 — 데이터 폴더 안. 프로젝트에 .scannerwork 를 남기지 않는다 */
  workDir: string
  /** TypeScript 분석기에 줄 tsconfig.json 목록(프로젝트 기준) — projectTsconfigs */
  tsconfigs?: readonly string[]
}

/** 숨김 폴더·node_modules 밖의 tsconfig.json (이슈 #548). TypeScript 분석기는 분석 범위와 상관없이 프로젝트 폴더의 tsconfig.json 을 전부 찾아
 *  타입 정보를 만든다 — 숨김 폴더에 레포 사본(.claude/worktrees 43개 → 88개)이 있으면 범위 하나만 골라도 Node 가 4GB 를 넘겨 죽었다(실측 2026-10-20).
 *  찾은 것만 넘기면 같은 분석이 12초에 끝났다. 깊이·개수에 상한을 둔다 */
export function projectTsconfigs(projectDir: string, maxDepth = 6, maxCount = 50): string[] {
  const found: string[] = []
  const walk = (relative: string, depth: number): void => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(path.join(projectDir, relative), { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (found.length >= maxCount) return
      const child = relative === '' ? entry.name : `${relative}/${entry.name}`
      if (entry.isFile() && entry.name === 'tsconfig.json') found.push(child)
      else if (entry.isDirectory() && depth < maxDepth && !entry.name.startsWith('.') && entry.name !== 'node_modules') walk(child, depth + 1)
    }
  }
  walk('', 0)
  return found
}

/** 스캐너 인자 — paths 가 없으면 전체(프로젝트 키 그대로), 있으면 범위(`<키>__scope`, scopedScanArgs). 토큰은 인자가 아니라 env(SONAR_TOKEN)로 — ps 에 보인다 */
export function sonarScanArgs(
  target: ScanTarget,
  paths: readonly string[] | undefined,
  exists: (path: string) => boolean,
): { ok: true; projectKey: string; args: string[]; skipped: string[] } | { ok: false; error: 'scope-empty' } {
  const common = [
    `-Dsonar.host.url=${target.serverUrl}`,
    `-Dsonar.projectBaseDir=${target.projectDir}`,
    `-Dsonar.working.directory=${target.workDir}`,
    // 동봉 런타임으로 돈다 — 서버에서 JRE 를 내려받지 않는다
    '-Dsonar.scanner.skipJreProvisioning=true',
    // 쉼표가 든 경로는 목록을 깨므로 뺀다
    ...(target.tsconfigs?.length ? [`-Dsonar.typescript.tsconfigPaths=${target.tsconfigs.filter((file) => !file.includes(',')).join(',')}`] : []),
  ]
  if (paths === undefined) return { ok: true, projectKey: target.projectKey, skipped: [], args: [...common, `-Dsonar.projectKey=${target.projectKey}`, '-Dsonar.sources=.'] }
  const scoped = scopedScanArgs(target.projectKey, paths, exists)
  return scoped.ok ? { ok: true, projectKey: scoped.projectKey, skipped: scoped.skipped, args: [...common, ...scoped.args] } : scoped
}

/** 분석 작업 id — 스캐너가 작업 폴더에 남기는 report-task.txt 의 ceTaskId. 서버가 결과를 처리하는 동안 패널이 api/ce/task 로 본다 */
export function reportTaskId(workDir: string): string | undefined {
  try {
    return /^ceTaskId=(.+)$/m.exec(fs.readFileSync(path.join(workDir, 'report-task.txt'), 'utf8'))?.[1]?.trim()
  } catch {
    return undefined
  }
}
