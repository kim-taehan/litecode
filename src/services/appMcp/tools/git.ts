import type { Context } from 'cordis'
import type { AppMcpTool } from '../rpc.ts'
import type { GitResult, GitView } from '../../../../shared/git.ts'
import '../../appMcp.ts'
import '../../git.ts'

// git 도구 (이슈 #290) — ctx.git 을 모델에 연다. 읽기 넷(status·diff·log·branches)은 바로 돌고, 쓰기 여섯(stage·commit·branch_create·switch·push·pull)은
// 엔진 권한 규칙이 늘 승인 카드로 묻는다(engineConfig.ts GIT_WRITE_ASK — 전체 권한도). 되돌리기·브랜치 삭제·강제 push·rebase·reset 은 도구가 없다.
// 기능 git 의 묶음이 올린다 — 데스크탑 MCP(appMcp)가 꺼져 있으면 inject 를 못 채워 이 플러그인만 안 뜬다(화면은 그대로).
// 바꾸는 도구는 ctx.git 이 'git/changed' 를 내 Git 탭이 즉시 다시 읽는다. 설명·결과 글은 모델이 읽는다 — 영어

/** 모델에 돌려줄 diff 상한 — 화면보다 작게 */
const MODEL_DIFF_MAX = 60 * 1024

function viewText(view: GitView): string {
  if (view.state === 'missing') throw new Error('git is not installed on this computer.')
  if (view.state === 'not-repo') throw new Error('This project folder is not a git repository. Ask the user to run git init from the Git tab.')
  return JSON.stringify(view)
}

/** 실패면 던진다 — 모델이 사유를 읽는다 */
function done<T extends object>(result: GitResult<T>, success: (value: T) => string): string {
  if (!result.ok) {
    const conflicts = result.conflicts?.length ? ` Conflicted files: ${result.conflicts.join(', ')}. Resolve them, stage and commit — or tell the user.` : ''
    const login = result.reason === 'auth' ? ' The user must log in once in a terminal; litecode never asks for passwords.' : ''
    throw new Error(`git failed (${result.reason}): ${result.message}${conflicts}${login}`)
  }
  return success(result as T)
}

const text = (args: Record<string, unknown>, key: string): string => (typeof args[key] === 'string' ? (args[key] as string).trim() : '')

export function GitTools(ctx: Context): void {
  const tools: AppMcpTool[] = [
    {
      name: 'git_status',
      description: 'Git status of this project: current branch, upstream with ahead/behind, origin URL, and staged, changed (unstaged or untracked "U") and conflicted files with line counts.',
      inputSchema: { type: 'object', properties: {} },
      run: async (_args, { directory }) => viewText(await ctx.git.view(directory)),
    },
    {
      name: 'git_diff',
      description: 'Unified diff of the working tree (default) or of the staged changes (staged: true). Give path for one file (repository-relative); without path, the whole diff.',
      inputSchema: { type: 'object', properties: { path: { type: 'string' }, staged: { type: 'boolean' } } },
      async run(args, { directory }) {
        const diff = await ctx.git.diff(directory, text(args, 'path') || undefined, args['staged'] === true)
        if (!diff) return 'No differences.'
        return diff.length > MODEL_DIFF_MAX ? `${diff.slice(0, MODEL_DIFF_MAX)}\n[diff truncated — ask for one path at a time]` : diff
      },
    },
    {
      name: 'git_log',
      description: 'Recent commits on the current branch (newest first): short hash, subject, author, time and whether it was pushed.',
      inputSchema: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 50 } } },
      async run(args, { directory }) {
        const limit = typeof args['limit'] === 'number' ? Math.min(50, Math.max(1, Math.floor(args['limit']))) : 20
        const log = await ctx.git.log(directory, limit)
        return JSON.stringify(log.map(({ short, subject, author, time, pushed }) => ({ hash: short, subject, author, date: new Date(time).toISOString(), pushed })))
      },
    },
    {
      name: 'git_branches',
      description: 'Local branches: which is current, upstream with ahead/behind, and how many commits are not merged into the current branch.',
      inputSchema: { type: 'object', properties: {} },
      run: async (_args, { directory }) => JSON.stringify(await ctx.git.branches(directory)),
    },
    {
      name: 'git_stage',
      description: 'Stage files for the next commit (git add -A on the given paths, deletions included). Use ["."] for everything. The user approves each call.',
      inputSchema: { type: 'object', properties: { paths: { type: 'array', items: { type: 'string' }, minItems: 1 } }, required: ['paths'] },
      async run(args, { directory }) {
        const paths = Array.isArray(args['paths']) ? args['paths'].filter((path): path is string => typeof path === 'string' && path.trim() !== '') : []
        if (paths.length === 0) throw new Error('paths must list at least one file.')
        return done(await ctx.git.stage(directory, paths), () => `Staged: ${paths.join(', ')}.`)
      },
    },
    {
      name: 'git_commit',
      description: 'Commit the staged changes with this message (only staged files — stage first). The user approves each call.',
      inputSchema: { type: 'object', properties: { message: { type: 'string', description: 'First line is a short summary.' } }, required: ['message'] },
      async run(args, { directory }) {
        return done(await ctx.git.commit(directory, text(args, 'message')), (value) => `Committed ${value.short} (${value.files} files).`)
      },
    },
    {
      name: 'git_branch_create',
      description: 'Create a new branch from the current commit and switch to it. Uncommitted changes come along. The user approves each call.',
      inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
      async run(args, { directory }) {
        return done(await ctx.git.createBranch(directory, text(args, 'name')), (value) => `Created and switched to ${value.branch}.`)
      },
    },
    {
      name: 'git_switch',
      description: 'Switch to an existing local branch. If uncommitted changes would be overwritten, nothing changes and it fails. The user approves each call.',
      inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
      async run(args, { directory }) {
        return done(await ctx.git.switchBranch(directory, text(args, 'name')), (value) => `Switched to ${value.branch}.`)
      },
    },
    {
      name: 'git_push',
      description: 'Push the current branch to origin (sets the upstream the first time). Never forces. The user approves each call.',
      inputSchema: { type: 'object', properties: {} },
      async run(_args, { directory }) {
        return done(await ctx.git.push(directory), (value) => `Pushed ${value.branch} to origin.`)
      },
    },
    {
      name: 'git_pull',
      description: 'Pull from origin into the current branch with a merge (no rebase). On conflict it stops and lists the files; it does not resolve them. The user approves each call.',
      inputSchema: { type: 'object', properties: {} },
      async run(_args, { directory }) {
        return done(await ctx.git.pull(directory), () => 'Pulled.')
      },
    },
  ]
  for (const tool of tools) ctx.effect(() => ctx.appMcp.register(tool))
}
GitTools.inject = ['appMcp', 'git']
