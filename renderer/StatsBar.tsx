import { useState, type ReactNode } from 'react'
import { compactTokens, statsReadings, type ChatStats } from './stats.ts'
import { compactionThreshold } from './compaction.ts'
import './compaction.css'
import { useT } from './settingsStore.ts'

// 입력창 아래 통계 줄 — dsh ui-chat StatsPills(⏱·🗄 두 칸)와 ui-conversation ContextMeter(◔) 를 한 줄에.
// dsh 는 눌러서 여는 팝업이지만 여기서는 머물면(또는 포커스) 뜬다 (00_request "호버 팝업")

/** 칸 하나와 그 팝업. 팝업은 칸 위에 뜬다 */
function Pill({ icon, parts, title, value, align, children }: {
  icon: ReactNode
  parts: string[]
  title: string
  /** 팝업 제목 줄 오른쪽 값 (dsh ContextMeter 의 ~사용 / 한도 자리) */
  value?: string
  align: 'left' | 'center' | 'right'
  children: ReactNode
}) {
  const [open, setOpen] = useState(false)
  return (
    <span className="stats-anchor" onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      <button
        type="button"
        className="stats-pill"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`${title}: ${parts.join(' · ')}`}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={(event) => event.key === 'Escape' && setOpen(false)}
      >
        {icon}
        <span className="stats-pill__label">
          {parts.map((part, index) => (
            <span key={index}>
              {index > 0 && <span className="stats-pill__sep" aria-hidden="true">·</span>}
              {part}
            </span>
          ))}
        </span>
      </button>
      {open && (
        <div className={`stats-dialog stats-dialog--${align}`} role="dialog" aria-label={title}>
          <div className="stats-dialog__title">
            <span className="stats-dialog__title-label">
              {icon}
              {title}
            </span>
            {value && <span>{value}</span>}
          </div>
          <div className="stats-dialog__rule" aria-hidden="true" />
          {children}
        </div>
      )}
    </span>
  )
}

function Rows({ rows }: { rows: [label: string, value: string, swatch?: string][] }) {
  return (
    <dl className="stats-dialog__rows">
      {rows.map(([label, value, swatch]) => (
        <div key={label} className="stats-dialog__row">
          <dt>
            {swatch && <span className={`stats-swatch stats-swatch--${swatch}`} aria-hidden="true" />}
            {label}
          </dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  )
}

// dsh ui-primitives 의 IconGaugeOutline·IconDatabaseOutline (16 격자, 선 1px) 과 같은 그림
const GaugeIcon = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" strokeWidth="1" aria-hidden="true">
    <path d="M3.4 13.1A6.5 6.5 0 1 1 12.6 13.1" stroke="currentColor" />
    <path d="M8 8.5L11.6 4.9" stroke="currentColor" />
    <circle cx="8" cy="8.5" r="1.25" fill="currentColor" />
  </svg>
)

const DatabaseIcon = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" strokeWidth="1" aria-hidden="true">
    <ellipse cx="8" cy="3.8" rx="6" ry="2.7" stroke="currentColor" />
    <path d="M2 3.8V11.8M14 3.8V11.8M2 7.8C2 9.4 4.7 10.8 8 10.8S14 9.4 14 7.8M2 11.8C2 13.5 4.7 14.9 8 14.9S14 13.5 14 11.8" stroke="currentColor" />
  </svg>
)

/** dsh ContextMeter 의 고리 (14 격자, 반지름 5.5, 선 2) */
const RADIUS = 5.5
const CIRCUMFERENCE = 2 * Math.PI * RADIUS
const Ring = ({ percent }: { percent?: number }) => (
  <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
    <circle className="stats-ring__track" cx="7" cy="7" r={RADIUS} />
    {/* 모르면 빈 고리 — 0 길이 선도 둥근 끝 때문에 점으로 보인다 */}
    {percent !== undefined && percent > 0 && <circle
      className="stats-ring__fill"
      cx="7"
      cy="7"
      r={RADIUS}
      strokeDasharray={`${(CIRCUMFERENCE * percent) / 100} ${CIRCUMFERENCE}`}
      transform="rotate(-90 7 7)"
    />}
  </svg>
)

export function StatsBar({ stats }: { stats?: ChatStats }) {
  const t = useT()
  const r = statsReadings(stats)
  const percent = r.percent === undefined ? '—' : `${r.percent}%`
  const c = stats?.context
  // 막대 전체 길이는 백분율, 색 조각은 구성 비율로 나눈다 (dsh ContextMeter)
  const parts = c?.systemAndTools !== undefined && c.messages !== undefined && c.systemAndTools + c.messages > 0
    ? ([['system', c.systemAndTools], ['messages', c.messages]] as const)
    : undefined
  const sum = parts?.reduce((total, [, size]) => total + size, 0) ?? 0
  // 자동 요약 문턱 눈금 (01o) — 한도를 모르면(요약 꺼짐) 눈금·줄이 없다
  const compactAt = compactionThreshold(c?.limit, c?.maxOutput)

  return (
    <div className="composer-stats">
      <Pill icon={<GaugeIcon />} parts={r.pace} title={t('stats.session')} align="left">
        <Rows
          rows={[
            [t('stats.llmTime'), r.session.llm],
            [t('stats.toolTime'), r.session.tool],
            [t('stats.ttft'), r.session.ttft],
            [t('stats.tps'), r.session.tps],
          ]}
        />
      </Pill>
      <Pill icon={<DatabaseIcon />} parts={r.usage} title={t('stats.tokens')} align="center">
        <Rows
          rows={[
            [t('stats.total'), r.tokens.total],
            [t('stats.cacheHit'), r.tokens.cacheHit],
            [t('stats.uncached'), r.tokens.uncached],
            [t('stats.cached'), r.tokens.cached],
            [t('stats.output'), r.tokens.output],
          ]}
        />
      </Pill>
      <Pill icon={<Ring percent={r.percent} />} parts={[percent]} title={t('stats.context')} value={r.context.figures} align="right">
        <div className="stats-bar">
          {r.percent !== undefined &&
            r.percent > 0 &&
            (parts ?? [['total', 1] as const]).map(([key, size]) => (
              <div
                key={key}
                className={`stats-bar__segment stats-swatch--${key}`}
                style={{ width: `${(r.percent! * size) / (parts ? sum : 1)}%` }}
              />
            ))}
          {compactAt && <div className="stats-bar__tick" style={{ left: `${compactAt.percent}%` }} title={t('stats.compactAt')} />}
        </div>
        <Rows
          rows={[
            // opencode 는 시스템 프롬프트·도구 정의를 따로 알려 주지 않는다 — 나누지 않고 한 줄로 (01_probe)
            [t('stats.systemTools'), r.context.systemAndTools, 'system'],
            [t('stats.messages'), r.context.messages, 'messages'],
            ...(compactAt ? [[t('stats.compactAt'), `~${compactTokens(compactAt.tokens)} · ${compactAt.percent}%`] as [string, string]] : []),
          ]}
        />
      </Pill>
    </div>
  )
}
