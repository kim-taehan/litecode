import { useLayoutEffect, useRef, useState } from 'react'
import { Markdown } from './Markdown.tsx'
import { compactTokens, elapsed, lastLine } from './jobsView.ts'
import { useT } from './settingsStore.ts'
import { findTask, useTaskMap } from './tasksStore.ts'
import { fold, taskTitle, transcript, type TranscriptBlock } from './taskTabView.ts'
import { useNow } from './useNow.ts'
import './taskTab.css'

// 오른쪽 패널의 작업 탭 (이슈 #325, 시안 _workspace/mock-task-bg/Detail.html) — 백그라운드 하위 작업 하나의 전체 기록.
// Claude Code 에이전트 뷰처럼 작업 줄에서 훑어보고(peek) › 로 여기를 연다. 머리(상태 점·#번호 설명·종류·경과·■ 중지) / 지시문 /
// 생각 전문(길면 접힘) / 도구 카드(이름·입력 + 결과 앞부분, "전체 보기") / 응답 글 전문 / 실행 중이면 "작업 중 · 마지막 활동 N 전".
// 데이터는 작업 줄과 같은 저장소(tasksStore — chat:tasks 알림)라 실시간으로 이어 붙는다. 끝나도 탭은 남고 사용자가 닫는다.
// 도구 카드·접기의 모양은 dsh ui-tool(ToolCard 머리 + 접힌 출력)·ui-trajectory(생각 접기) 참조 — 코드는 새로 썼다

export function TaskTab({ taskId, directory }: { taskId: string; directory: string }) {
  const t = useT()
  const task = findTask(useTaskMap(), taskId)
  const live = task?.status === 'running' || task?.status === 'queued'
  const now = useNow(live)
  const body = useRef<HTMLDivElement>(null)
  const atBottom = useRef(true)
  // 이어 붙을 때 맨 아래를 보고 있었으면 따라 내려간다 — 위로 올려 읽는 중이면 그대로
  useLayoutEffect(() => {
    const element = body.current
    if (element && atBottom.current) element.scrollTop = element.scrollHeight
  }, [task?.items, task?.status])

  if (!task) {
    return (
      <div className="task-tab">
        <p className="file-preview__empty">{t('taskTab.gone')}</p>
      </div>
    )
  }
  const { number, description } = taskTitle(taskId, task)
  const blocks = transcript(task.items)
  const took = task.startedAt === undefined ? undefined : elapsed((live ? now : (task.endedAt ?? now)) - task.startedAt)
  const state =
    task.status === 'done'
      ? t('chat.completed')
      : task.status === 'error'
        ? t('chat.subtaskFailed')
        : task.status === 'stopped'
          ? t('chat.subtaskStopped')
          : task.status === 'queued'
            ? t('jobs.queued')
            : undefined
  const activity = lastLine(task.items)

  return (
    <div className="task-tab" data-status={task.status}>
      <div className="task-tab__head">
        <span className="task-tab__dot" aria-hidden="true" />
        <strong className="task-tab__title" title={description}>
          #{number} {description}
        </strong>
        {task.agent && <span className="task-tab__pill">{task.agent}</span>}
        {took && <span className="task-tab__pill task-tab__pill--num">{took}</span>}
        {task.tokens !== undefined && <span className="task-tab__pill task-tab__pill--num">{compactTokens(task.tokens)}</span>}
        {state && <span className="task-tab__pill task-tab__state">{state}</span>}
        {live && <StopButton taskId={task.id} />}
      </div>
      <div
        ref={body}
        className="task-tab__body"
        onScroll={(event) => {
          const element = event.currentTarget
          atBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 24
        }}
      >
        {task.prompt && <Prompt text={task.prompt} />}
        {!!task.omitted && <p className="task-tab__note">{t('taskTab.omitted', { count: task.omitted })}</p>}
        {blocks.map((block) => (
          <Block key={block.id} block={block} directory={directory} />
        ))}
        {task.error && (
          <div className="task-tab__error" role="note">
            {task.error}
          </div>
        )}
        {task.status === 'queued' && <div className="task-tab__live">{t('taskTab.queued')}</div>}
        {task.status === 'running' && (
          <div className="task-tab__live">
            <span className="task-tab__dot" aria-hidden="true" />
            {[t('taskTab.working'), task.lastActivityAt !== undefined && t('taskTab.lastActivity', { time: elapsed(now - task.lastActivityAt) }), activity?.text]
              .filter(Boolean)
              .join(' · ')}
          </div>
        )}
        {!live && blocks.length === 0 && !task.error && <p className="task-tab__note">{t('chat.subtaskEmpty')}</p>}
      </div>
    </div>
  )
}

/** ■ 중지 — 작업 줄의 중지와 같은 일 (그 작업만, 결과 턴으로 "중단됨") */
function StopButton({ taskId }: { taskId: string }) {
  const t = useT()
  const [stopping, setStopping] = useState(false)
  return (
    <button
      type="button"
      className="task-tab__stop"
      aria-label={t('jobs.stop')}
      title={t('jobs.stop')}
      disabled={stopping}
      onClick={() => {
        setStopping(true)
        void window.litecode.stopSubtask(taskId).then((stopped) => stopped || setStopping(false), () => setStopping(false))
      }}
    >
      <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
        <rect x="3" y="3" width="10" height="10" rx="2" />
      </svg>
      {stopping ? t('jobs.stopping') : t('jobs.stopShort')}
    </button>
  )
}

function Prompt({ text }: { text: string }) {
  const t = useT()
  return (
    <div className="task-tab__ask">
      <b className="task-tab__label">{t('taskTab.prompt')}</b>
      <FoldedText {...fold(text.trim())} />
    </div>
  )
}

/** 긴 글은 앞부분만 보이고 "펼치기" — 짧으면 그대로 */
function FoldedText({ text, preview }: { text: string; preview?: string }) {
  const t = useT()
  const [open, setOpen] = useState(false)
  return (
    <>
      <div className="task-tab__pre">{preview && !open ? preview : text}</div>
      {preview && (
        <button type="button" className="task-tab__more" aria-expanded={open} onClick={() => setOpen((was) => !was)}>
          {open ? t('taskTab.collapse') : t('taskTab.expand')}
        </button>
      )}
    </>
  )
}

function Block({ block, directory }: { block: TranscriptBlock; directory: string }) {
  const t = useT()
  if (block.kind === 'think') {
    return (
      <div className="task-tab__think">
        <b className="task-tab__label">{t('chat.think')}</b>
        <FoldedText text={block.text} preview={block.preview} />
      </div>
    )
  }
  if (block.kind === 'text') {
    return (
      <div className="task-tab__text">
        <Markdown text={block.text} directory={directory} />
      </div>
    )
  }
  return <ToolCard block={block} />
}

function ToolCard({ block }: { block: Extract<TranscriptBlock, { kind: 'tool' }> }) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const mark = block.status === 'done' ? '✓' : block.status === 'error' ? '✕' : '…'
  return (
    <div className="task-tab__tool" data-status={block.status}>
      <div className="task-tab__tool-head">
        <span className="task-tab__tick" aria-hidden="true">
          {mark}
        </span>
        <span className="task-tab__tool-name">{block.name}</span>
        {block.summary && <span className="task-tab__tool-summary">{block.summary}</span>}
      </div>
      {open && block.input && (
        <pre className="task-tab__code" data-part="input">
          {block.input}
        </pre>
      )}
      {(open ? block.result : block.head) && (
        <pre className="task-tab__code" data-part="result" data-folded={!open || undefined}>
          {open ? block.result : block.head}
        </pre>
      )}
      {block.error && <pre className="task-tab__code task-tab__code--error">{block.error}</pre>}
      {block.more && (
        <button type="button" className="task-tab__tool-more" aria-expanded={open} onClick={() => setOpen((was) => !was)}>
          {open ? t('taskTab.collapse') : block.lines > 0 ? t('taskTab.showAllLines', { count: block.lines }) : t('taskTab.showAll')}
        </button>
      )}
    </div>
  )
}
