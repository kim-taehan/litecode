import type { GitAction, GitFailure, GitLastCommit, GitResult, GitStatus } from '../shared/git.ts'
import type { Translate } from './settingsStore.ts'

// Git 탭 아래 커밋 영역의 순수 규칙 (이슈 #387, 시안 Git 탭 재설계 ① Main.dc.html 맨 아래) — 버튼·체크를 언제 누를 수 있나, 커밋하고 올리기의 순서,
// 끝난 뒤 한 줄. 화면은 Git.tsx 의 CommitBox 가 그린다

/** 고치기 체크를 막는 이유 — 첫 커밋 전 · 가져오기가 충돌로 멈춤 · 마지막 커밋을 이미 올림 */
export type AmendBlock = 'noCommits' | 'merging' | 'pushed'
/** 올리기 버튼을 막는 이유 — origin 없음 · 분리된 HEAD */
export type PushBlock = 'no-remote' | 'detached'

export interface CommitControls {
  amendBlock?: AmendBlock
  /** 고치기 체크를 누를 수 있다 (마지막 커밋을 읽기 전엔 이유 없이 못 누른다) */
  amendable: boolean
  /** 체크했고 고칠 수 있다 — 버튼 글·보낼 작업이 고치기 */
  amending: boolean
  canCommit: boolean
  pushBlock?: PushBlock
  canPush: boolean
}

export function commitControls(view: GitStatus, last: GitLastCommit | undefined, amend: boolean, message: string, busy: boolean): CommitControls {
  const amendBlock: AmendBlock | undefined = !view.hasCommits ? 'noCommits' : view.merging ? 'merging' : last?.pushed ? 'pushed' : undefined
  const amendable = amendBlock === undefined && last !== undefined
  const amending = amend && amendable
  const canCommit = !busy && message.trim() !== '' && (amending || view.staged.length > 0)
  const pushBlock: PushBlock | undefined = !view.remote ? 'no-remote' : !view.branch ? 'detached' : undefined
  return { amendBlock, amendable, amending, canCommit, pushBlock, canPush: canCommit && pushBlock === undefined }
}

type Run = (action: GitAction) => Promise<GitResult<Record<string, unknown>> | undefined>

export interface CommitOutcome {
  short: string
  files: number
  amend: boolean
  /** 커밋하고 올리기였다 — push 의 결과 */
  push?: GitResult<Record<string, unknown>>
}

/** 커밋(또는 고치기) 뒤, push 면 이어서 올린다. 커밋이 실패하면 undefined (올리지 않는다). 올리기가 실패해도 커밋은 남는다 */
export async function commitThenPush(run: Run, message: string, amend: boolean, push: boolean): Promise<CommitOutcome | undefined> {
  const done = await run(amend ? { kind: 'amend', message } : { kind: 'commit', message })
  if (!done?.ok) return undefined
  const outcome: CommitOutcome = { short: String(done['short'] ?? ''), files: Number(done['files'] ?? 0), amend }
  if (!push) return outcome
  return { ...outcome, push: (await run({ kind: 'push' })) ?? { ok: false, reason: 'failed', message: '' } }
}

/** 원격 상태 카드(auth·network)·주소 칸(no-remote)·충돌 카드가 따로 뜨는 실패 — 한 줄은 커밋 결과만 */
const CARD_FAILURES: readonly GitFailure[] = ['auth', 'network', 'no-remote', 'conflict']

/** 끝난 뒤 한 줄 — 커밋만이면 [실행 취소](고치기는 없음), 올렸으면 [원격 주소로 열기], 올리기가 실패하면 "커밋은 남았다" + 이유 */
export function commitNotice(t: Translate, outcome: CommitOutcome): { tone: 'ok' | 'error'; text: string; detail?: string; undo?: boolean; remote?: boolean } {
  const hash = outcome.short
  const done = { tone: 'ok' as const, text: outcome.amend ? t('git.amended', { hash }) : t('git.committed', { hash, count: outcome.files }), undo: !outcome.amend }
  const push = outcome.push
  if (!push) return done
  if (push.ok) return { tone: 'ok', text: t('git.committedPushed', { hash, branch: String(push['branch'] ?? '') }), remote: true }
  if (CARD_FAILURES.includes(push.reason)) return done
  return { tone: 'error', text: t('git.pushFailedAfterCommit', { hash, reason: t(`git.error.${push.reason}`) }), detail: push.message }
}
