// Git (ctx.git, 이슈 #290 — 시안 _workspace/mock-git/Git.dc.html). 메인(서비스·AI 도구)과 화면(Git 탭·브랜치 알약·승인 카드)이 같이 쓰는 모양.
// 시스템 git 을 그대로 쓴다 — 인증·서명은 사용자의 git 설정(키체인·SSH)에 맡기고, 강제 push·rebase·reset --hard 는 없다.

/** 파일 상태 글자 — M 고침 · A 새로 더함(stage) · D 지움 · R 이름 바꿈 · U 새 파일(untracked) · C 충돌 */
export type GitFileKind = 'M' | 'A' | 'D' | 'R' | 'U' | 'C'

export interface GitFile {
  /** 저장소 루트 기준 경로 */
  path: string
  kind: GitFileKind
  /** 이름 바꾸기의 옛 경로 */
  from?: string
  /** 줄 수 — 모르면(새 파일·바이너리) 없다 */
  added?: number
  removed?: number
}

export interface GitStatus {
  state: 'ok'
  /** 지금 브랜치 — 분리된 HEAD 면 없다 */
  branch?: string
  upstream?: string
  ahead: number
  behind: number
  /** origin 주소 — 없으면 원격이 없다 */
  remote?: string
  hasCommits: boolean
  /** 가져오기(merge)가 충돌로 멈춰 있다 */
  merging: boolean
  staged: GitFile[]
  changed: GitFile[]
  conflicts: GitFile[]
}

/** missing: git 을 찾지 못했다 · not-repo: 이 폴더는 저장소가 아니다 */
export type GitView = { state: 'missing' } | { state: 'not-repo' } | GitStatus

export interface GitCommit {
  hash: string
  short: string
  subject: string
  author: string
  /** ms */
  time: number
  /** 원격 브랜치 어디에도 있다 (올렸다) */
  pushed: boolean
}

/** 마지막 커밋 (#387 마지막 커밋 고치기) — 전체 메시지와 올렸는지 */
export interface GitLastCommit {
  message: string
  /** 원격 브랜치 어디에 있다 — 고칠 수 없다 */
  pushed: boolean
}

/** 보관(stash) 한 개 (#389 보관함) — index 는 `stash@{index}`, hash 는 그 보관 커밋 (적용·삭제 때 같은 것인지 확인) */
export interface GitStash {
  index: number
  hash: string
  message: string
  /** 보관한 브랜치 — 분리된 HEAD 였으면 없다 */
  branch?: string
  /** ms */
  time: number
}

/** 무시된 것 한 줄 (#390 .gitignore 연계) — path 는 저장소 루트 기준(폴더는 `/` 로 끝난다). 어느 규칙이 가렸는지는 git check-ignore 의 답:
 *  source = 규칙 파일(루트 기준 — `.gitignore`·`sub/.gitignore`·`.git/info/exclude`, 전역 설정이면 절대 경로), line = 줄 번호, pattern = 그 줄 */
export interface GitIgnored {
  path: string
  source: string
  line: number
  pattern: string
}

/** 무시에 추가할 파일 (#390, IntelliJ 의 Add to .gitignore · Add to .git/info/exclude) */
export type GitIgnoreWhere = 'gitignore' | 'exclude'

/** 새 파일 경로(저장소 루트 기준, 폴더는 `/` 로 끝남) → .gitignore 에 쓸 한 줄 (#390). 경로 그대로 쓰되:
 *  - 그 자리에만 걸리게 — 중간에 `/` 가 없으면 맨 앞에 `/` (git: 앞·가운데에 / 가 있으면 .gitignore 자리 기준, 없으면 아무 깊이의 같은 이름까지 가린다)
 *  - `* ? [ ] \` 는 앞에 `\`, (앞에 / 가 없을 때) 맨 앞 `!`·`#` 는 `\`, 끝 공백은 `\ ` (git 이 끝 공백을 지운다) */
export function ignoreLine(path: string): string {
  const folder = path.endsWith('/')
  const target = folder ? path.slice(0, -1) : path
  const text = target.replace(/[*?[\]\\]/g, '\\$&')
  const anchored = target.includes('/') ? text.replace(/^[!#]/, '\\$&') : `/${text}`
  return folder ? `${anchored}/` : anchored.replace(/ +$/, (spaces) => '\\ '.repeat(spaces.length))
}

export interface GitBranch {
  name: string
  current: boolean
  /** 마지막 커밋 시각 ms */
  time: number
  upstream?: string
  ahead: number
  behind: number
  /** 지금 브랜치에 합쳐지지 않은 커밋 수 */
  unmerged: number
}

/** 실패 사유 — 화면이 `git.error.<reason>` 으로 옮긴다
 *  auth: 원격 로그인이 필요하다 · network: 원격에 닿지 못했다 · rejected: 원격에 새 커밋이 있다(먼저 가져오기) · conflict: 가져오기가 충돌로 멈췄다 ·
 *  overwrite: 지금 변경이 덮여 멈췄다(아무것도 안 바뀜) · no-remote: origin 이 없다 · pushed: 이미 올린 커밋이다 · nothing: stage 된 것이 없다 ·
 *  identity: 커밋할 이름·이메일이 없다 · invalid: 잘못된 이름·주소 · missing · not-repo · failed: 그 밖 (message 에 git 의 글) */
export type GitFailure = 'auth' | 'network' | 'rejected' | 'conflict' | 'overwrite' | 'no-remote' | 'pushed' | 'nothing' | 'identity' | 'invalid' | 'missing' | 'not-repo' | 'failed'

export type GitResult<T extends object = object> = ({ ok: true } & T) | { ok: false; reason: GitFailure; message: string; conflicts?: string[] }

/** 화면이 부르는 바꾸는 작업 (git:run 채널 하나로) — 메인이 ctx.git 의 같은 이름 메서드로 잇는다 */
export type GitAction =
  | { kind: 'stage' | 'unstage' | 'discard'; paths: string[] }
  | { kind: 'commit'; message: string }
  /** 마지막 커밋 고치기 (#387) — stage 된 것을 합치고 메시지를 바꾼다. 원격 어디에도 없는 커밋만 (아니면 pushed) */
  | { kind: 'amend'; message: string }
  | { kind: 'switchBranch' | 'deleteBranch'; name: string }
  /** from(로컬 브랜치)을 주면 그 끝에서 만든다 — 브랜치 팝업 줄 메뉴의 '여기서 새 브랜치' (#399). 없으면 지금 HEAD 에서 */
  | { kind: 'createBranch'; name: string; from?: string }
  /** 브랜치 팝업 (#386) — switchRemote: `origin/x` → 같은 이름 로컬 브랜치로(없으면 추적 브랜치를 만든다) · switchRevision: 태그·커밋 해시 → 분리된 HEAD */
  | { kind: 'switchRemote' | 'switchRevision'; name: string }
  | { kind: 'addRemote'; url: string }
  /** 변경 파일 우클릭 메뉴 (#389) — commitPaths: 그 파일만 커밋(다른 stage 는 그대로, 새 파일은 add 해서) · stash: 그 파일만 보관(새 파일 포함) */
  | { kind: 'commitPaths' | 'stash'; paths: string[]; message: string }
  /** 보관함 (#389) — stashPop: 적용(충돌이면 멈추고 보관은 남는다) · stashDrop: 삭제. hash 가 그 번호의 보관과 다르면 invalid */
  | { kind: 'stashPop' | 'stashDrop'; index: number; hash: string }
  /** 무시에 추가 (#390) — 새 파일 path(저장소 루트 기준)의 ignoreLine 한 줄을 where 파일 끝에 덧붙인다 */
  | { kind: 'addIgnore'; path: string; where: GitIgnoreWhere }
  | { kind: 'undoCommit' | 'push' | 'pull' | 'abortMerge' | 'init' }

/** 앱 MCP 서버의 git 도구 (모델이 보는 이름은 `litecode_<이름>`) — 읽기는 바로, 쓰기는 늘 승인 카드 (engineConfig.ts·modes.ts 의 규칙) */
export const GIT_READ_TOOLS = ['git_status', 'git_diff', 'git_log', 'git_branches'] as const
export const GIT_WRITE_TOOLS = ['git_stage', 'git_commit', 'git_branch_create', 'git_switch', 'git_push', 'git_pull'] as const
export type GitWriteTool = (typeof GIT_WRITE_TOOLS)[number]

/** 원격 주소 → 브라우저로 열 https 주소 ("원격 주소로 열기"). 모르는 모양이면 undefined.
 *  `git@host:a/b.git` · `ssh://git@host[:port]/a/b.git` · `https://user@host/a/b.git` → `https://host/a/b` */
export function gitWebUrl(remote: string | undefined): string | undefined {
  if (!remote) return undefined
  const trimmed = remote.trim().replace(/\.git\/?$/, '').replace(/\/$/, '')
  const scp = /^[\w.-]+@([\w.-]+):(?!\/)(.+)$/.exec(trimmed)
  if (scp) return `https://${scp[1]}/${scp[2]}`
  const url = /^(?:ssh|git|https?):\/\/(?:[^@/]+@)?([\w.-]+)(?::\d+)?\/(.+)$/.exec(trimmed)
  if (url) return `https://${url[1]}/${url[2]}`
  return undefined
}

/** 앱 MCP 서버의 git 쓰기 도구인가 (서버 이름은 src/services/mcp.ts 의 APP_MCP_NAME 과 같다 — 화면은 서비스 파일을 import 못 한다) */
export function isGitWriteTool(mcp: { server: string; tool: string } | undefined): mcp is { server: string; tool: GitWriteTool } {
  return mcp?.server === 'litecode' && (GIT_WRITE_TOOLS as readonly string[]).includes(mcp.tool)
}

/** AI 의 git 쓰기 도구 승인 카드에 보일 것 — 무엇을(tool) 무엇으로(text: 커밋 메시지·브랜치 이름·파일 목록) */
export function gitApprovalText(tool: string, input: string | undefined): string | undefined {
  let args: Record<string, unknown> = {}
  try {
    const parsed: unknown = input ? JSON.parse(input) : {}
    if (parsed && typeof parsed === 'object') args = parsed as Record<string, unknown>
  } catch {
    return input
  }
  if (tool === 'git_commit') return typeof args['message'] === 'string' ? args['message'] : undefined
  if (tool === 'git_branch_create' || tool === 'git_switch') return typeof args['name'] === 'string' ? args['name'] : undefined
  if (tool === 'git_stage') return Array.isArray(args['paths']) ? args['paths'].filter((path) => typeof path === 'string').join('\n') : undefined
  return undefined
}
