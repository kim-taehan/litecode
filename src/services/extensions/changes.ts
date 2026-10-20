import type { ExtensionCallError } from '../../../shared/extensions.ts'
import { READ_FLAGS, runGit } from '../git.ts'

// project.changedFiles (이슈 #538) — "내 변경" = 기준 브랜치와의 merge-base 대비 바뀐 파일(이 브랜치의 커밋 + 스테이지 + 작업 트리) ∪ 추적 안 하는 새 파일.
// 선택 기능 git(ctx.git)이 꺼져 있어도 돈다 — 그 서비스에 기대지 않고 같은 실행기(git.ts runGit: 셸 없음·기한·안전 env)와 읽기 플래그를 쓴다.
// 경로는 프로젝트 폴더 기준(`--relative` — 프로젝트가 저장소의 하위 폴더면 그 아래만), `-z` 로 읽어 공백·한글·따옴표가 그대로다.
// 지운 파일은 뺀다(`--diff-filter=d` — 고를 범위로 쓸 파일 목록이라 없는 파일은 쓸모가 없다), 이름 바뀜은 새 이름만(`--no-renames` 로 지움 + 더함).
// 기준 브랜치가 없으면 커밋 안 한 변경만(HEAD 대비), 커밋이 하나도 없으면 빈 트리 대비

/** git 의 빈 트리 — 커밋이 없는 저장소의 비교 기준 */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'
const DEFAULT_BRANCHES = ['dev', 'main', 'master']

/** 기준 브랜치 — origin/HEAD(원격의 기본 브랜치) → dev → main → master (로컬 브랜치, 없으면 origin 의 같은 이름). 없으면 undefined */
export async function pickBase(probe: { originHead(): Promise<string | undefined>; exists(ref: string): Promise<boolean> }): Promise<string | undefined> {
  const head = await probe.originHead()
  if (head) return head
  for (const name of DEFAULT_BRANCHES) {
    if (await probe.exists(`refs/heads/${name}`)) return name
    if (await probe.exists(`refs/remotes/origin/${name}`)) return `origin/${name}`
  }
  return undefined
}

/** maxOutput — git 한 번의 출력 상한(기본은 runGit 의 4MB, 테스트가 줄인다). 넘으면 반토막 목록을 주지 않고 too-many-changes (QA 03_qa_538) —
 *  범위로 쓰는 목록이라 일부만 주면 조용히 틀린 범위가 된다. 4MB 는 경로 수만 개(무시하지 않은 빌드 산출물 폴더 등)다 */
export async function changedFiles(
  binary: string,
  directory: string,
  maxOutput?: number,
): Promise<{ ok: true; base: string | null; files: string[] } | { ok: false; error: ExtensionCallError }> {
  const git = (args: readonly string[]) => runGit(binary, directory, args, { maxOutput })
  const inside = await git(['rev-parse', '--is-inside-work-tree'])
  if (inside.missing) return { ok: false, error: 'git-unavailable' }
  if (inside.code !== 0 || inside.stdout.trim() !== 'true') return { ok: false, error: 'not-a-repo' }

  const verify = async (ref: string) => (await git(['rev-parse', '-q', '--verify', `${ref}^{commit}`])).code === 0
  const base = await pickBase({
    originHead: async () => {
      const found = await git(['symbolic-ref', '-q', '--short', 'refs/remotes/origin/HEAD'])
      return found.code === 0 && found.stdout.trim() ? found.stdout.trim() : undefined
    },
    exists: verify,
  })
  const hasHead = await verify('HEAD')
  let from = hasHead ? 'HEAD' : EMPTY_TREE
  if (base && hasHead) {
    const mergeBase = await git(['merge-base', base, 'HEAD'])
    if (mergeBase.code === 0 && mergeBase.stdout.trim()) from = mergeBase.stdout.trim()
  }

  const [diff, untracked] = await Promise.all([
    git([...READ_FLAGS, 'diff', '--name-only', '-z', '--relative', '--no-renames', '--diff-filter=d', '--no-ext-diff', '--no-textconv', from, '--']),
    git([...READ_FLAGS, 'ls-files', '-z', '--others', '--exclude-standard']),
  ])
  if (diff.missing || untracked.missing) return { ok: false, error: 'git-unavailable' }
  if (diff.code !== 0 || untracked.code !== 0) return { ok: false, error: 'git-failed' }
  if (diff.truncated || untracked.truncated) return { ok: false, error: 'too-many-changes' }
  const files = [...new Set([...diff.stdout.split('\0'), ...untracked.stdout.split('\0')].filter(Boolean))].sort()
  return { ok: true, base: base ?? null, files }
}
