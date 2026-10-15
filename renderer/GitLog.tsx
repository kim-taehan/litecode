// 기록 탭 (#400 #405, 시안 ⑤) — #403 의 logPage(페이징)·layoutGraph(레인) 를 줄로 그린다.
// 줄 높이 고정(46px)이라 보이는 줄만 그리는 창 처리: scrollTop 로 범위 잡고, 스크롤이 끝에 가까우면 다음 200개를
// 이어서 읽는다. 다시 읽기는 gitView 의 다시 읽는 때(git:changed·턴 끝·창 포커스·패널 열기 — gitStore 가 다시 읽을 때
// view 가 바뀜) + 마운트(패널 열림). 다시 읽으면 commits 가 처음부터라 레이인 상태도 처음부터 다시 계산된다.

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { GitBranch, GitLogCommit, GitStatus } from '../shared/git.ts'
import { BranchIcon, TagIcon } from './GitIcons.tsx'
import { LANE_CAP, laneColor, layoutGraph, type GraphRow } from './gitGraph.ts'
import { isLogFilterActive } from './logFilter.ts'
import { logChips, logWhen } from './logLine.ts'
import { LogFilterBar } from './LogFilterBar.tsx'
import { appendLogGit, refreshLogGit, setLogFilter, useLogFilter, useLogGit } from './gitStore.ts'
import { useT } from './settingsStore.ts'

/** 줄 높이 (시안 ⑤) */
export const LOG_ROW_H = 46
const LANE_W = 13
const PAD = 8
const MID = LOG_ROW_H / 2
export const LOG_GUTTER = PAD * 2 + LANE_W * LANE_CAP
/** 보이는 줄보다 위·아래로 더 그리는 줄 수 — 스크롤이 끊기지 않게 */
const BUFFER = 10

export function GitLog({ directory, view, now = Date.now() }: { directory: string; view: GitStatus; now?: number }) {
  const t = useT()
  const log = useLogGit(directory)
  const filter = useLogFilter(directory)
  const [scrollTop, setScrollTop] = useState(0)
  const [height, setHeight] = useState(0)
  const boxRef = useRef<HTMLDivElement>(null)
  // 필터 바용 목록 — 브랜치·원격은 git 이 알려 주고, 사용자는 최근 커밋에서
  const [branches, setBranches] = useState<GitBranch[]>()
  const [remotes, setRemotes] = useState<string[]>([])
  const [authors, setAuthors] = useState<string[]>()

  // view 바뀜 = 다시 읽는 때(git:changed·턴 끝·포커스·패널 열기 때 gitStore 가 다시 읽는다) + 마운트(패널 열림)
  useEffect(() => {
    void refreshLogGit(directory)
  }, [directory, view])

  useEffect(() => {
    let live = true
    window.litecode.gitBranches(directory).then((list) => live && setBranches(list), () => live && setBranches([]))
    window.litecode.gitRemoteBranches(directory).then((list) => live && setRemotes(list), () => live && setRemotes([]))
    window.litecode.gitLogAuthors(directory).then((list) => live && setAuthors(list), () => live && setAuthors([]))
    return () => {
      live = false
    }
  }, [directory, view])

  // 보이는 줄 범위는 박스 높이에 의존 — 마운트 때(그리고 줄이 생기는 때) 재는 것
  const n0 = log?.commits.length ?? 0
  useLayoutEffect(() => {
    const box = boxRef.current
    if (box) setHeight(box.clientHeight)
  }, [n0])

  const commits = log?.commits ?? []
  // commits 이 바뀌면(첫 페이지·덧붙인 페이지·다시 읽기) 그래프를 처음부터 다시 — 레이인 상태가 여기 있다.
  // 필터가 켜 있으면 부모가 목록에서 빠질 수 있으니 레인 폭을 상한으로 막는다(#409)
  const filtered = isLogFilterActive(filter)
  const rows = useMemo(() => layoutGraph(commits, undefined, filtered ? { maxLanes: LANE_CAP * 2 } : undefined).rows, [commits, filtered])
  const n = commits.length
  const reading = Boolean(log?.reading)

  if (!view.hasCommits) return <p className="git-empty">{t('git.logEmpty')}</p>
  if (log === undefined || (n === 0 && reading)) return <p className="git-empty">{t('filePreview.loading')}</p>
  if (n === 0) return <p className="git-empty">{t('git.logEmpty')}</p>

  const from = Math.max(0, Math.floor(scrollTop / LOG_ROW_H) - BUFFER)
  const to = Math.min(n, Math.ceil((scrollTop + height) / LOG_ROW_H) + BUFFER)
  const slice = commits.slice(from, to)
  return (
    <div className="git-log2">
      <LogFilterBar
        key={directory} // 프로젝트이 바뀌면(칸의 디바운스 타이머가 새 프로젝트에 쓰이는 것 막기) 새로 시작
        filter={filter}
        currentBranch={view.branch ?? ''}
        branches={branches}
        remotes={remotes}
        authors={authors}
        onChange={(patch) => void setLogFilter(directory, patch)}
      />
      <div
        ref={boxRef}
        className="git-log2__scroll"
        onScroll={(e) => {
          const box = e.currentTarget
          setScrollTop(box.scrollTop)
          setHeight((h) => (h === box.clientHeight ? h : box.clientHeight))
          if (box.scrollTop + box.clientHeight > n * LOG_ROW_H - 3 * LOG_ROW_H) void appendLogGit(directory)
        }}
      >
        <div style={{ height: n * LOG_ROW_H, position: 'relative' }}>
          <div style={{ position: 'absolute', top: from * LOG_ROW_H, left: 0, right: 0 }}>
            <ol className="git-log2__list">
              {slice.map((commit, i) => (
                <LogRow key={commit.hash} commit={commit} row={rows[from + i]!} now={now} />
              ))}
            </ol>
          </div>
        </div>
      </div>
    </div>
  )
}

function LogRow({ commit, row, now }: { commit: GitLogCommit; row: GraphRow; now: number }) {
  const t = useT()
  const chips = logChips(commit)
  return (
    <li className={commit.parents.length > 1 ? 'git-log2__row git-log2__row--merge' : 'git-log2__row'}>
      <GraphSvg row={row} />
      <div className="git-log2__main">
        <div className="git-log2__line">
          <span className="git-log2__subject" title={commit.subject}>
            {commit.subject}
          </span>
          {(chips.length > 0 || !commit.pushed) && (
            <span className="git-log2__chips">
              {chips.map((chip) => (
                <span key={chip.icon + chip.text} className={`git-log2__chip git-log2__chip--${chip.icon}`}>
                  <span className="git-log2__chip-icon" style={{ color: row.color }}>
                    {chip.icon === 'tag' ? <TagIcon /> : <BranchIcon />}
                  </span>
                  <span className="git-log2__chip-text">{chip.text}</span>
                </span>
              ))}
              {!commit.pushed && <span className="git-log2__chip git-log2__chip--local">{t('git.notPushed')}</span>}
            </span>
          )}
        </div>
        <span className="git-log2__meta">
          {commit.author} · {logWhen(commit.time, now)}
        </span>
      </div>
    </li>
  )
}

/** 한 줄의 레인 그림 (폭 상한을 넘는 레인은 맨 오른쪽 자리로 접힌다 — 그 줄에 … 표시) */
function GraphSvg({ row }: { row: GraphRow }) {
  const x = (lane: number) => PAD + Math.min(lane, LANE_CAP - 1) * LANE_W + LANE_W / 2
  const lines: ReactNode[] = []
  for (const lane of row.up) {
    lines.push(<line key={`u${lane}`} x1={x(lane)} y1={0} x2={x(lane)} y2={lane === row.lane ? MID : LOG_ROW_H} stroke={laneColor(lane)} strokeWidth={1.5} />)
  }
  for (const lane of row.down) {
    lines.push(<line key={`d${lane}`} x1={x(lane)} y1={lane === row.lane ? MID : 0} x2={x(lane)} y2={LOG_ROW_H} stroke={laneColor(lane)} strokeWidth={1.5} />)
  }
  row.diagonal.forEach((line, index) => {
    const other = line.from === row.lane ? line.to : line.from
    const start = line.from === row.lane ? { x: x(line.from), y: MID } : { x: x(line.from), y: 0 }
    const end = line.to === row.lane ? { x: x(line.to), y: MID } : { x: x(line.to), y: LOG_ROW_H }
    const bend = (end.y - start.y) * 0.55
    lines.push(
      <path
        key={`z${index}`}
        d={`M ${start.x} ${start.y} C ${start.x} ${start.y + bend}, ${end.x} ${end.y - bend}, ${end.x} ${end.y}`}
        stroke={laneColor(other)}
        strokeWidth={1.5}
        fill="none"
      />,
    )
  })
  return (
    <svg className="git-log2__graph" width={LOG_GUTTER} height={LOG_ROW_H} viewBox={`0 0 ${LOG_GUTTER} ${LOG_ROW_H}`} aria-hidden="true">
      {lines}
      <circle cx={x(row.lane)} cy={MID} r={3.5} fill={row.color} />
      {row.folded && <text x={LOG_GUTTER - 2} y={11} textAnchor="end" fontSize={9} fill="var(--text-caption)">…</text>}
    </svg>
  )
}
