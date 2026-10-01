import { useEffect, useMemo, useState } from 'react'
import type { Trajectory as TrajectoryData, TrajectoryRecord } from '../shared/ipc.ts'
import { formatDuration, groupTurns, matchesSearch, timeline, type TimelineMode } from './trajectoryView.ts'

// Trajectory 탭 — 한 대화의 스텝·도구 호출을 턴별 목록과 시간축으로 본다. dsh ui-trajectory 참조(모양·동작만):
// 툴바(Duration 토글·Turns/Calls 전체 접기·검색), 3레인 시간축(Input·Model·Tools), 턴별 목록(USER·ASSISTANT·TOOL·CONTEXT).
// 확대·끌기·상세 패널·가상 스크롤은 첫 버전에서 뺐다. 진행 중 갱신은 턴이 끝나면(pending 이 풀리면) 다시 읽는 것으로 한다.

const LANES = ['Input', 'Model', 'Tools'] as const
const TAG: Record<TrajectoryRecord['kind'], string> = { user: 'USER', assistant: 'ASSISTANT', tool: 'TOOL', context: 'CONTEXT' }

const firstLine = (text: string) => text.trim().split('\n')[0] ?? ''

interface Props {
  /** 대화의 작업 폴더 */
  directory: string
  /** 엔진 세션 — 아직 아무것도 안 보낸 대화면 없다 */
  sessionId?: string
  /** 답을 기다리는 중 — 풀리면 다시 읽는다 */
  pending: boolean
}

export function Trajectory({ directory, sessionId, pending }: Props) {
  const [data, setData] = useState<TrajectoryData>()
  const [mode, setMode] = useState<TimelineMode>('sequence')
  const [query, setQuery] = useState('')
  const [foldedTurns, setFoldedTurns] = useState<ReadonlySet<number>>(new Set())
  const [foldedCalls, setFoldedCalls] = useState<ReadonlySet<number>>(new Set())

  useEffect(() => {
    if (!sessionId) {
      setData({ records: [] })
      return
    }
    if (pending) return // 지난 기록을 그대로 두고 턴이 끝나면 다시 읽는다
    let stale = false
    void window.litecode.loadTrajectory(directory, sessionId).then((loaded) => {
      if (!stale) setData(loaded)
    })
    return () => {
      stale = true
    }
  }, [directory, sessionId, pending])

  const records = data?.records ?? []
  const turns = useMemo(() => groupTurns(records), [records])
  const bars = useMemo(() => timeline(records, mode), [records, mode])
  /** 도구를 부른 스텝 id → 그 도구 id 들 (스텝 바로 뒤에 온다) */
  const callsOf = useMemo(() => {
    const calls = new Map<number, number[]>()
    let owner: number | undefined
    records.forEach((record, id) => {
      if (record.kind === 'assistant') owner = id
      else if (record.kind === 'tool' && owner !== undefined) calls.set(owner, [...(calls.get(owner) ?? []), id])
      else owner = undefined
    })
    return calls
  }, [records])
  const ownerOf = useMemo(() => new Map([...callsOf].flatMap(([owner, calls]) => calls.map((id) => [id, owner] as const))), [callsOf])

  const searching = query.trim() !== ''
  const allTurnsFolded = turns.length > 0 && turns.every((turn) => foldedTurns.has(turn.number))
  const allCallsFolded = callsOf.size > 0 && [...callsOf.keys()].every((id) => foldedCalls.has(id))
  const toggle = (set: ReadonlySet<number>, key: number) => {
    const next = new Set(set)
    if (!next.delete(key)) next.add(key)
    return next
  }

  if (!data) return <div className="trajectory"><div className="empty">불러오는 중…</div></div>

  return (
    <div className="trajectory">
      <div className="trajectory__toolbar" role="toolbar" aria-label="Trajectory 도구">
        <button
          type="button"
          className="trajectory__toggle"
          aria-pressed={mode === 'duration'}
          title={mode === 'duration' ? '같은 너비로 보기' : '실제 걸린 시간으로 보기'}
          onClick={() => setMode(mode === 'duration' ? 'sequence' : 'duration')}
        >
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true">
            <circle cx="8" cy="8" r="5.25" />
            <path d="M8 4.75V8l2.25 1.5" />
          </svg>
          Duration
        </button>
        <button
          type="button"
          className="trajectory__toggle"
          aria-pressed={allTurnsFolded}
          title={allTurnsFolded ? '모든 턴 펴기' : '모든 턴 접기'}
          onClick={() => setFoldedTurns(allTurnsFolded ? new Set() : new Set(turns.map((turn) => turn.number)))}
        >
          <span aria-hidden="true">{allTurnsFolded ? '⊞' : '⊟'}</span> Turns
        </button>
        <button
          type="button"
          className="trajectory__toggle"
          aria-pressed={allCallsFolded}
          title={allCallsFolded ? '모든 도구 호출 펴기' : '모든 도구 호출 접기'}
          onClick={() => setFoldedCalls(allCallsFolded ? new Set() : new Set(callsOf.keys()))}
        >
          <span aria-hidden="true">{allCallsFolded ? '⊞' : '⊟'}</span> Calls
        </button>
        <input
          type="search"
          className="trajectory__search"
          aria-label="기록 검색"
          placeholder="검색"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>

      {data.missingFolder ? (
        <div className="empty" role="alert">폴더가 없습니다: {directory}</div>
      ) : data.error ? (
        <div className="empty" role="alert">{data.error}</div>
      ) : records.length === 0 ? (
        <div className="empty">아직 기록이 없습니다</div>
      ) : (
        <>
          <div className="trajectory__timeline" data-mode={mode} aria-label="시간축">
            {LANES.map((lane, index) => (
              <div key={lane} className="trajectory__lane">
                <span className="trajectory__lane-name">{lane}</span>
                <div className="trajectory__track">
                  {bars.spans
                    .filter((span) => span.lane === index)
                    .map((span) => {
                      const record = records[span.id]!
                      const left = (span.start / bars.total) * 100
                      const width = ((span.end - span.start) / bars.total) * 100
                      const wait = span.firstAt === undefined || span.end === span.start ? 0 : ((span.firstAt - span.start) / (span.end - span.start)) * 100
                      return (
                        <span
                          key={span.id}
                          className={`trajectory__bar${span.error ? ' trajectory__bar--error' : ''}${span.open ? ' trajectory__bar--open' : ''}`}
                          data-kind={record.kind}
                          style={{ left: `${left}%`, width: `${width}%`, ...(wait > 0 ? { ['--wait' as string]: `${wait}%` } : {}) }}
                          title={barTitle(record)}
                        />
                      )
                    })}
                </div>
              </div>
            ))}
          </div>

          <div className="trajectory__ledger">
            {turns.map((turn) => {
              const items = turn.items.filter(({ record }) => !searching || matchesSearch(record, query))
              if (searching && items.length === 0) return null
              const folded = !searching && foldedTurns.has(turn.number)
              return (
                <section key={turn.number} className="trajectory__turn" aria-label={`Turn ${turn.number}`}>
                  <button
                    type="button"
                    className="trajectory__turn-head"
                    aria-expanded={!folded}
                    onClick={() => setFoldedTurns(toggle(foldedTurns, turn.number))}
                  >
                    <span aria-hidden="true">{folded ? '▸' : '▾'}</span> Turn {turn.number}
                  </button>
                  {!folded &&
                    items
                      .filter(({ id }) => searching || !foldedCalls.has(ownerOf.get(id) ?? -1))
                      .map(({ id, record }) => (
                        <Row
                          key={id}
                          record={record}
                          calls={callsOf.get(id)?.length}
                          callsFolded={foldedCalls.has(id)}
                          onToggleCalls={() => setFoldedCalls(toggle(foldedCalls, id))}
                        />
                      ))}
                </section>
              )
            })}
            {searching && turns.every((turn) => turn.items.every(({ record }) => !matchesSearch(record, query))) && (
              <div className="empty">일치하는 기록이 없습니다</div>
            )}
          </div>
        </>
      )}
    </div>
  )
}

function Row({ record, calls, callsFolded, onToggleCalls }: { record: TrajectoryRecord; calls?: number; callsFolded: boolean; onToggleCalls: () => void }) {
  const error = 'error' in record ? record.error : undefined
  const took = record.kind === 'assistant' || record.kind === 'tool' ? (record.end === undefined ? '…' : formatDuration(record.end - record.start)) : ''
  return (
    <div className={`trajectory__row${error ? ' trajectory__row--error' : ''}`} data-kind={record.kind}>
      <span className="trajectory__fold">
        {calls !== undefined && (
          <button type="button" aria-label={callsFolded ? '도구 호출 펴기' : '도구 호출 접기'} aria-expanded={!callsFolded} onClick={onToggleCalls}>
            {callsFolded ? '▸' : '▾'}
          </button>
        )}
      </span>
      <span className="trajectory__tag">{TAG[record.kind]}</span>
      <span className="trajectory__text">
        {record.kind === 'tool' ? (
          <>
            <span className="trajectory__call">
              {record.name} {record.input}
            </span>
            <span className="trajectory__result">
              → {error ? firstLine(error) : firstLine(record.result) || '(빈 결과)'}
              {record.exit !== undefined && record.exit !== 0 && ` · exit ${record.exit}`}
            </span>
          </>
        ) : record.kind === 'assistant' ? (
          error ? firstLine(error) : firstLine(record.text) || '—'
        ) : (
          firstLine(record.text)
        )}
      </span>
      <span className="trajectory__time">{took}</span>
    </div>
  )
}

function barTitle(record: TrajectoryRecord): string {
  if (record.kind === 'tool') return `${record.name} · ${record.end === undefined ? '끝나지 않음' : formatDuration(record.end - record.start)}`
  if (record.kind === 'assistant') {
    if (record.end === undefined) return 'ASSISTANT · 끝나지 않음'
    return `ASSISTANT · 대기 ${formatDuration(record.firstAt - record.start)} · 생성 ${formatDuration(record.end - record.firstAt)}`
  }
  return `${TAG[record.kind]} · ${firstLine(record.text)}`
}
