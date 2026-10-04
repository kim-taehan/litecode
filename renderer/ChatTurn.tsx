import { useEffect, useState, type ReactNode } from 'react'
import type { Attachment, Attention, AttentionAnswer, Subtask, TurnItem } from '../shared/ipc.ts'
import { AttachmentChips } from './Attachments.tsx'
import { AttentionCard } from './Attention.tsx'
import { DiffCard, DiffStat } from './DiffCard.tsx'
import { CompactionMark } from './Compaction.tsx'
import { takeCompactions } from './compaction.ts'
import { CheckIcon, CopyIcon, Markdown } from './Markdown.tsx'
import { useT } from './settingsStore.ts'
import { answerText, clockTime, formatDuration, skillInstructions, splitTurn, thinkSummary, toolTitle, turnHeadText } from './turnView.ts'
import { SKILL_ICON_PATH, SkillBadge } from './SkillBadge.tsx'
import './chat.css'

// 대화 한 턴의 모양 (dsh ui-chat 참조 — 모양·동작만 가져와 새로 썼다):
// - 내 말: 오른쪽 연파랑 말풍선 + 아래 시각·복사 아이콘
// - 답: 말풍선이 아니라 본문 폭 전체의 글. 위에 턴 머리 "완료 · 2초 ⌄" 와 얇은 구분선 — 펼치면 그 턴의 작업 줄(생각·도구·중간 글)
// - 진행 중: 작업 줄이 실시간으로 쌓이고(답 글도 그 사이에 끼어 나온다) 맨 아래 파란 "작업 중 · N초 ···". 끝나면 머리 아래로 접힌다
// 접기 규칙(dsh TurnProcessNodeView): 잘 끝난 턴만 접는다. 실패한 턴은 작업을 펼친 채로 두고 접기 버튼이 없다

/** 내 말 — 말풍선 아래에 보낸 시각과 복사 */
export function UserMessage({ text, at, attachments }: { text: string; at?: number; attachments?: readonly Attachment[] }) {
  const t = useT()
  const [copied, setCopied] = useCopied()
  return (
    <div className="user-turn">
      {/* 붙인 파일·이미지 칩 (이슈 #44) — 글 없이 첨부만 보냈으면 말풍선 없이 칩만 */}
      {attachments && <AttachmentChips items={attachments} />}
      {text.trim() && <div className="bubble bubble--user">{text.trim()}</div>}
      <div className="user-turn__meta">
        {at !== undefined && <time dateTime={new Date(at).toISOString()}>{clockTime(at)}</time>}
        <button
          type="button"
          className="user-turn__copy"
          aria-label={copied ? t('chat.messageCopied') : t('chat.copyMessage')}
          title={copied ? t('chat.messageCopied') : t('chat.copyMessage')}
          onClick={() => void navigator.clipboard.writeText(text.trim()).then(() => setCopied(true), () => {})}
        >
          {copied ? <CheckIcon /> : <CopyIcon />}
        </button>
      </div>
    </div>
  )
}

function useCopied(): [boolean, (value: boolean) => void] {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1_500)
    return () => clearTimeout(timer)
  }, [copied])
  return [copied, setCopied]
}

interface AssistantTurnProps {
  /** 이 턴의 진행 줄 (처음 나타난 순서) */
  items: readonly TurnItem[]
  /** 답 글 — 실패면 `⚠️ 사유`. 진행 줄로 답을 못 가르면 이것을 그대로 쓴다 */
  text: string
  failed?: boolean
  /** 실패 중에서도 끊겨서 끝났다 — 머리가 "중단됨" */
  interrupted?: boolean
  /** 승인·질문을 거절해 끝났다 — 실패가 아니다, 머리가 "거절함" */
  declined?: boolean
  /** 끝난 턴의 걸린 시간(ms) */
  duration?: number
  /** 답을 기다리는 중 — startedAt 부터 시계가 돈다 */
  running?: boolean
  startedAt?: number
  /** 파일 언급 칩을 찾을 프로젝트 */
  directory: string
  /** 진행 중 턴이 기다리는 승인·질문 — 작업 줄 아래 카드로 */
  attention?: readonly Attention[]
  onAnswer?(request: Attention, answer: AttentionAnswer): Promise<void>
}

export function AssistantTurn({ items, text, failed = false, interrupted = false, declined = false, duration, running = false, startedAt, directory, attention = [], onAnswer }: AssistantTurnProps) {
  // 자동 요약 줄 — 진행 중엔 작업 줄 사이 그 자리에, 끝나면 머리 위 구분선으로 (다시 열어도 같다). 재시도 줄은 진행 중에만 뜻이 있다
  const { compactions, rest } = takeCompactions(running ? items : items.filter((item) => item.kind !== 'retry'))
  const { work, answer } = running ? { work: [...items], answer: [] } : splitTurn(rest)
  const foldable = !running && !failed && work.length > 0
  const [open, setOpen] = useState(false)
  const t = useT()
  const showWork = running || failed || open

  return (
    <div className="turn" data-state={running ? 'running' : interrupted ? 'interrupted' : failed ? 'failed' : 'done'}>
      {!running && compactions.map((item) => <CompactionMark key={item.id} item={item} />)}
      {!running &&
        (foldable ? (
          <button
            type="button"
            className="turn__head"
            aria-expanded={open}
            title={open ? t('chat.hideWork') : t('chat.showWork')}
            onClick={() => setOpen((now) => !now)}
          >
            <span className="turn__head-label">{turnHeadText(t, duration, failed, interrupted, declined)}</span>
            <Chevron />
          </button>
        ) : (
          <div className="turn__head">
            <span className="turn__head-label">{turnHeadText(t, duration, failed, interrupted, declined)}</span>
          </div>
        ))}
      {showWork && work.length > 0 && (
        <div className="turn__work">
          {work.map((item) =>
            item.kind === 'compaction' ? <CompactionMark key={item.id} item={item} /> : <WorkRow key={item.id} item={item} directory={directory} turnRunning={running} />,
          )}
        </div>
      )}
      {/* 답 — 기존 셀렉터(.bubble--assistant)를 그대로 쓴다. 모양은 말풍선이 아니다. 모델이 빈 줄로 답을 시작하기도 해서 앞뒤 공백은 뗀다 */}
      {!running && (
        <div className="bubble bubble--assistant">
          {failed ? text : <Markdown text={answerText(answer, text).trim()} directory={directory} />}
        </div>
      )}
      {running &&
        attention.map((request) => <AttentionCard key={request.id} request={request} onAnswer={(answer) => onAnswer?.(request, answer) ?? Promise.resolve()} />)}
      {running && <RunningStatus startedAt={startedAt} />}
    </div>
  )
}

/** 작업 줄 하나 — 생각·도구는 눌러 펼치고, 중간 글은 그대로 마크다운. turnRunning: 그 턴이 아직 도는 중 (끝난 턴의 하위 작업은 더 돌지 않는다) */
function WorkRow({ item, directory, turnRunning }: { item: Exclude<TurnItem, { kind: 'compaction' }>; directory: string; turnRunning: boolean }) {
  const [open, setOpen] = useState(false)
  const t = useT()
  if (item.kind === 'subtask') return <SubtaskRow item={item} directory={directory} turnRunning={turnRunning} />
  if (item.kind === 'text') {
    if (!item.text.trim()) return null
    return (
      <div className="turn-row turn-row--text" data-kind="text">
        <Markdown text={item.text.trim()} directory={directory} />
      </div>
    )
  }
  if (item.kind === 'retry') {
    if (item.status !== 'waiting') return null
    // 엔진이 LLM 요청을 다시 보내려고 기다린다 (게이트웨이 500 등 — 레거시는 5번까지, 합계 ~71초) — 사유는 펼치지 않고 줄에 그대로
    return (
      <div className="turn-row" data-kind="retry" data-live role="status">
        <div className="turn-row__line">
          <RetryIcon />
          <span className="turn-row__title">{t('chat.retrying', { attempt: item.attempt })}</span>
          {item.message && (
            <>
              <span className="turn-row__dot" aria-hidden="true" />
              <span className="turn-row__summary">{item.message}</span>
            </>
          )}
        </div>
      </div>
    )
  }
  if (item.kind === 'context') {
    return (
      <div className="turn-row" data-kind="context">
        <div className="turn-row__line">
          <ContextIcon />
          <span className="turn-row__title">{item.text}</span>
        </div>
      </div>
    )
  }

  const think = item.kind === 'think'
  // 스킬 줄 (이슈 #7, dsh ui-skill): "스킬 · 이름" + 출처 배지, 펼치면 지침 본문 (260 높이 제한). 기록(도구 결과)만으로 그린다
  const skill = item.kind === 'tool' ? item.skill : undefined
  // MCP 도구(`<서버>_<도구>`)는 "MCP · 서버 · 도구" (이슈 #28)
  const mcp = item.kind === 'tool' ? item.mcp : undefined
  const title = think ? t('chat.think') : skill ? t('chat.skill') : mcp ? `${t('mcp.chat')} · ${mcp.server} · ${mcp.tool}` : toolTitle(item.name)
  const summary = think
    ? thinkSummary(item.text, item.done) || (item.done ? '' : t('chat.thinking'))
    : (item.summary ?? (item.status === 'preparing' ? t('chat.toolPreparing') : ''))
  const live = think ? !item.done : item.status === 'preparing' || item.status === 'running'
  const body: ReactNode = think ? (
    item.text.trim() && <Markdown text={item.text.trim()} />
  ) : item.diffs && !item.error ? (
    <DiffCard diffs={item.diffs} />
  ) : skill && item.result && !item.error ? (
    <div className="turn-row__instructions" aria-label={t('chat.skillInstructions')}>
      <Markdown text={skillInstructions(item.result)} />
    </div>
  ) : (
    (item.input || item.result || item.error) && (
      <>
        {item.input && <pre className="turn-row__code">{item.input}</pre>}
        {item.error ? <pre className="turn-row__code turn-row__code--error">{item.error}</pre> : item.result && <pre className="turn-row__code">{item.result}</pre>}
      </>
    )
  )

  return (
    <div
      className="turn-row"
      data-kind={item.kind}
      data-done={think ? item.done : undefined}
      data-status={think ? undefined : item.status}
      data-live={live || undefined}
      data-mcp={!think && item.mcp ? `${item.mcp.server}/${item.mcp.tool}` : undefined}
    >
      <button type="button" className="turn-row__line" aria-expanded={body ? open : undefined} disabled={!body} onClick={() => setOpen((now) => !now)}>
        {think ? <ThinkIcon /> : <ToolIcon name={item.mcp ? 'mcp' : item.name} />}
        <span className="turn-row__title">{title}</span>
        {summary && (
          <>
            <span className="turn-row__dot" aria-hidden="true" />
            <span className="turn-row__summary">{summary}</span>
          </>
        )}
        {skill && <SkillBadge source={skill.source} />}
        {!think && item.diffs && item.status === 'done' && <DiffStat diffs={item.diffs} />}
      </button>
      {open && body && <div className="turn-row__body">{body}</div>}
    </div>
  )
}

/** 하위 작업 한 줄 (task — 엔진이 자식 세션에서 따로 돌린다, 이슈 #31). 여럿이 동시에 돌면 줄마다 제 초가 오른다. 펼치면 그 자식의 생각·도구·글 줄이
 *  (진행 중엔 실시간으로) 들여 쌓인다. 모양은 dsh ui-subagent 의 목록 행(상태 · 이름 · 설명 … 오른쪽에 걸린 시간·토큰)과 Claude Code 의 Task 블록 참조.
 *  끝난 턴에 아직 running 으로 남은 줄(중지·엔진 재시작으로 끝 신호를 못 받음)은 "중단됨" 이다 */
function SubtaskRow({ item, directory, turnRunning }: { item: Subtask; directory: string; turnRunning: boolean }) {
  const [open, setOpen] = useState(false)
  const t = useT()
  const unfinished = item.status === 'running' || item.status === 'preparing'
  const live = turnRunning && unfinished
  const now = useNow(live)
  const stopped = item.status === 'stopped' || (!turnRunning && unfinished)
  const state = stopped ? 'stopped' : item.status
  const status =
    item.status === 'error'
      ? t('chat.subtaskFailed')
      : stopped
        ? t('chat.subtaskStopped')
        : item.status === 'done'
          ? item.startedAt !== undefined && item.endedAt !== undefined
            ? t('chat.subtaskDone', { duration: formatDuration(t, item.endedAt - item.startedAt) })
            : t('chat.completed')
          : item.startedAt !== undefined
            ? t('chat.subtaskRunning', { duration: formatDuration(t, now - item.startedAt) })
            : t('chat.toolPreparing')
  const name = [item.agent, item.description].filter(Boolean).join(' · ')
  const rows = item.items.filter((child): child is Exclude<TurnItem, { kind: 'compaction' }> => child.kind !== 'compaction')
  return (
    <div className="turn-row turn-subtask" data-kind="subtask" data-status={state} data-live={live || undefined}>
      <button type="button" className="turn-row__line" aria-expanded={open} onClick={() => setOpen((was) => !was)}>
        <SubtaskIcon />
        <span className="turn-row__title">{t('chat.subtask')}</span>
        {name && (
          <>
            <span className="turn-row__dot" aria-hidden="true" />
            <span className="turn-row__summary">{name}</span>
          </>
        )}
        <span className="turn-subtask__status">
          {status}
          {item.tokens !== undefined && <span className="turn-subtask__tokens"> · {t('chat.subtaskTokens', { count: item.tokens.toLocaleString() })}</span>}
        </span>
      </button>
      {open && (
        <div className="turn-subtask__body">
          {rows.map((child) => <WorkRow key={child.id} item={child} directory={directory} turnRunning={turnRunning} />)}
          {rows.length === 0 && !item.error && <p className="turn-subtask__empty">{t('chat.subtaskEmpty')}</p>}
          {item.error && <pre className="turn-row__code turn-row__code--error">{item.error}</pre>}
        </div>
      )}
    </div>
  )
}

/** 1초마다 지금 시각 — on 일 때만 돈다 */
export function useNow(on: boolean): number {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (!on) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1_000)
    return () => clearInterval(timer)
  }, [on])
  return now
}

/** 진행 중 맨 아래 파란 줄 — 보낸 시각부터 초가 올라가고 점이 움직인다 (dsh RunningStatus). 시계는 이 줄만 다시 그린다 */
function RunningStatus({ startedAt }: { startedAt?: number }) {
  const t = useT()
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000)
    return () => clearInterval(timer)
  }, [])
  return (
    <div className="turn-running">
      <span className="turn-running__divider" aria-hidden="true" />
      <span className="turn-running__content">
        <SparkIcon />
        <span className="turn-running__text">
          {startedAt === undefined ? t('chat.working') : t('chat.workingFor', { duration: formatDuration(t, now - startedAt) })}
        </span>
        <span className="turn-running__dots" aria-hidden="true">
          <span>·</span>
          <span>·</span>
          <span>·</span>
        </span>
      </span>
    </div>
  )
}

function Chevron() {
  return (
    <svg className="turn__chevron" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 6L8 10L12 6" />
    </svg>
  )
}

function Icon({ children }: { children: ReactNode }) {
  return (
    <svg className="turn-row__icon" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  )
}

function RetryIcon() {
  return (
    <Icon>
      <path d="M13.25 8A5.25 5.25 0 1 1 11.6 4.2" />
      <path d="M12.25 1.75V4.75H9.25" />
    </Icon>
  )
}

function ThinkIcon() {
  return (
    <Icon>
      <path d="M8 1.75C5.38 1.75 3.5 3.6 3.5 6C3.5 7.6 4.35 8.6 5.25 9.4V11.25H10.75V9.4C11.65 8.6 12.5 7.6 12.5 6C12.5 3.6 10.62 1.75 8 1.75Z" />
      <path d="M6 13.75H10" />
    </Icon>
  )
}

/** 도구 종류별 아이콘 — bash 는 >_, 파일 읽기·쓰기는 문서, 찾기는 돋보기, 그 밖은 톱니 */
function ToolIcon({ name }: { name: string }) {
  if (name === 'bash')
    return (
      <Icon>
        <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="2" />
        <path d="M4.5 6L6.5 8L4.5 10M8 10.5H11" />
      </Icon>
    )
  if (['read', 'write', 'edit', 'apply_patch', 'list'].includes(name))
    return (
      <Icon>
        <path d="M4 1.75H9.5L12.5 4.75V14.25H4Z" />
        <path d="M9.5 1.75V4.75H12.5" />
      </Icon>
    )
  if (name === 'skill')
    return (
      <Icon>
        <path d={SKILL_ICON_PATH} />
      </Icon>
    )
  if (name === 'mcp')
    return (
      <Icon>
        <path d="M5.5 1.75V4.5M10.5 1.75V4.5M3.75 4.5H12.25V7.5A4.25 4.25 0 0 1 3.75 7.5ZM8 11.75V14.25" />
      </Icon>
    )
  if (['grep', 'glob', 'codesearch', 'websearch'].includes(name))
    return (
      <Icon>
        <circle cx="7" cy="7" r="4.25" />
        <path d="M10.25 10.25L14 14" />
      </Icon>
    )
  return (
    <Icon>
      <circle cx="8" cy="8" r="2.25" />
      <path d="M8 1.75V3.5M8 12.5V14.25M1.75 8H3.5M12.5 8H14.25M3.6 3.6L4.8 4.8M11.2 11.2L12.4 12.4M3.6 12.4L4.8 11.2M11.2 4.8L12.4 3.6" />
    </Icon>
  )
}

/** 하위 작업 — 갈라지는 가지 */
function SubtaskIcon() {
  return (
    <Icon>
      <circle cx="4" cy="3.5" r="1.75" />
      <circle cx="12" cy="8" r="1.75" />
      <circle cx="4" cy="12.5" r="1.75" />
      <path d="M5.75 3.5H7.5C8.6 3.5 9 4.2 9 5.25V6.75C9 7.6 9.4 8 10.25 8M5.75 12.5H7.5C8.6 12.5 9 11.8 9 10.75V9.25C9 8.4 9.4 8 10.25 8" />
    </Icon>
  )
}

function ContextIcon() {
  return (
    <Icon>
      <path d="M3.25 2.25H12.75V13.75H3.25Z" />
      <path d="M5.5 5.5H10.5M5.5 8H10.5M5.5 10.5H8.5" />
    </Icon>
  )
}

function SparkIcon() {
  return (
    <svg className="turn-running__icon" width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M8 1L9.6 6.4L15 8L9.6 9.6L8 15L6.4 9.6L1 8L6.4 6.4Z" />
    </svg>
  )
}
