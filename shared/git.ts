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
  | { kind: 'createBranch' | 'switchBranch' | 'deleteBranch'; name: string }
  /** 브랜치 팝업 (#386) — switchRemote: `origin/x` → 같은 이름 로컬 브랜치로(없으면 추적 브랜치를 만든다) · switchRevision: 태그·커밋 해시 → 분리된 HEAD */
  | { kind: 'switchRemote' | 'switchRevision'; name: string }
  | { kind: 'addRemote'; url: string }
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
