import { useEffect, useReducer, useRef } from 'react'
import { AMBIENT_SEGMENT_SECONDS } from '../shared/ambient.ts'
import { useT } from './settingsStore.ts'
import type { MessageKey } from '../shared/i18n/index.ts'
import type { SpeechErrorCode, SpeechStreamEvent } from '../shared/ipc.ts'
import { VoiceRecording } from './voiceRecorder.ts'
import './ambient.css'

// AMBIENT MEMO (이슈 #494) — 오른쪽 패널 고정 탭. 녹음을 켜면 마이크가 계속 열리고 1분 단위로 speech 스트림을
// 닫고 다시 연다. 각 구간이 확정되면 메인(ctx.ambient)이 누적 전사에 반영하고, LLM 으로 롤링 요약을 새로 쓴다.
// 요약·전사는 AmbientEvent 로 온다.

interface AmbientFlight {
  run: number
  recording: VoiceRecording
  stream: number | undefined
  held: Int16Array[]
  timer: ReturnType<typeof setTimeout> | undefined
  stopping: boolean
}

interface AmbientState {
  phase: 'idle' | 'recording' | 'failed'
  run: number
  transcript: string
  summary: string
  error?: string
  notice?: { tone: 'info' | 'error'; key: MessageKey }
}

const IDLE: AmbientState = { phase: 'idle', run: 0, transcript: '', summary: '' }

type Action =
  | { type: 'start'; run: number }
  | { type: 'granted'; run: number }
  | { type: 'stopped'; run: number }
  | { type: 'failed'; run: number; key: MessageKey }
  | { type: 'transcript'; text: string }
  | { type: 'summary'; text: string }
  | { type: 'notice'; key: MessageKey; tone: 'info' | 'error' }
  | { type: 'dismiss' }

function reducer(state: AmbientState, action: Action): AmbientState {
  switch (action.type) {
    case 'start':
      return { phase: 'recording', run: action.run, transcript: '', summary: '' }
    case 'granted':
      return state.phase === 'recording' && state.run === action.run ? state : state
    case 'stopped':
      return { ...state, phase: 'idle' }
    case 'failed':
      return { phase: 'idle', run: action.run, transcript: state.transcript, summary: state.summary, notice: { tone: 'error', key: action.key } }
    case 'transcript':
      return { ...state, transcript: action.text }
    case 'summary':
      return { ...state, summary: action.text }
    case 'notice':
      return { ...state, notice: { tone: action.tone, key: action.key } }
    case 'dismiss':
      return { ...state, notice: undefined }
  }
}

export function AmbientMemo() {
  const t = useT()
  const [state, dispatch] = useReducer(reducer, IDLE)
  const flight = useRef<AmbientFlight>(undefined)
  const runs = useRef(0)
  const current = useRef(state)
  current.current = state

  function release(active: AmbientFlight): void {
    clearTimeout(active.timer)
    active.recording.dispose()
    if (active.stream !== undefined) void window.litecode.cancelSpeechStream(active.stream).catch(() => {})
  }

  function cancel(): void {
    const active = flight.current
    flight.current = undefined
    if (active) release(active)
  }

  function fail(active: AmbientFlight, key: MessageKey): void {
    if (flight.current !== active) return
    flight.current = undefined
    release(active)
    dispatch({ type: 'failed', run: active.run, key })
  }

  function failWith(active: AmbientFlight, code: string): void {
    const key = code === 'busy' ? 'speech.error.busy' : code === 'timeout' ? 'speech.error.timeout' : code === 'cancelled' ? 'speech.error.cancelled' : code === 'unavailable' ? 'speech.error.unavailable' : 'voice.error.failed'
    fail(active, key)
  }

  async function stopSegment(active: AmbientFlight): Promise<string | { error: SpeechErrorCode }> {
    clearTimeout(active.timer)
    const old = active.stream
    active.stream = undefined
    if (old === undefined) {
      await active.recording.stop()
      return ''
    }
    void active.recording.stop()
    const reply = await window.litecode.stopSpeechStream(old)
    return reply.ok ? reply.text : { error: reply.code }
  }

  async function nextSegment(active: AmbientFlight): Promise<boolean> {
    if (flight.current !== active || active.stopping) return false
    let opened
    try {
      opened = await window.litecode.startSpeechStream()
    } catch {
      return false
    }
    if (flight.current !== active || active.stopping) {
      if (opened.ok) void window.litecode.cancelSpeechStream(opened.stream).catch(() => {})
      return false
    }
    if (!opened.ok) return false
    active.stream = opened.stream
    for (const pcm of active.held.splice(0)) window.litecode.sendSpeechChunk(opened.stream, pcm)
    active.timer = setTimeout(() => void rollover(active), AMBIENT_SEGMENT_SECONDS * 1000)
    return true
  }

  async function rollover(active: AmbientFlight): Promise<void> {
    if (flight.current !== active || active.stopping) return
    const result = await stopSegment(active)
    if (flight.current !== active || active.stopping) return
    if (typeof result === 'object') return
    if (result.trim() !== '') void window.litecode.ambientSegment(result).catch(() => {})
    const ok = await nextSegment(active)
    if (!ok && flight.current === active && !active.stopping) void window.litecode.ambientStop().catch(() => {})
  }

  async function start(): Promise<void> {
    if (flight.current) return
    const active: AmbientFlight = {
      run: ++runs.current,
      recording: new VoiceRecording(),
      stream: undefined,
      held: [],
      timer: undefined,
      stopping: false,
    }
    flight.current = active
    dispatch({ type: 'start', run: active.run })
    try {
      await window.litecode.ambientStart()
    } catch {
      return fail(active, 'voice.error.failed')
    }
    if (flight.current !== active) return
    try {
      await active.recording.start(
        () => {
          if (flight.current === active) {
            flight.current = undefined
            release(active)
            void window.litecode.ambientStop().catch(() => {})
            dispatch({ type: 'failed', run: active.run, key: 'voice.error.recording' })
          }
        },
        (pcm) => {
          if (flight.current !== active) return
          if (active.stream === undefined) active.held.push(pcm)
          else window.litecode.sendSpeechChunk(active.stream, pcm)
        },
      )
    } catch (error) {
      flight.current = undefined
      release(active)
      void window.litecode.ambientStop().catch(() => {})
      return dispatch({ type: 'failed', run: active.run, key: 'voice.error.recording' })
    }
    if (flight.current !== active) return
    const opened = await nextSegment(active)
    if (!opened) {
      if (flight.current === active) {
        flight.current = undefined
        release(active)
        void window.litecode.ambientStop().catch(() => {})
        dispatch({ type: 'failed', run: active.run, key: 'voice.error.failed' })
      }
      return
    }
    dispatch({ type: 'granted', run: active.run })
  }

  async function stop(): Promise<void> {
    const active = flight.current
    if (!active) return
    active.stopping = true
    flight.current = undefined
    clearTimeout(active.timer)
    const result = await stopSegment(active)
    release(active)
    await window.litecode.ambientStop().catch(() => {})
    if (typeof result === 'string' && result.trim() !== '') dispatch({ type: 'transcript', text: result })
    dispatch({ type: 'stopped', run: active.run })
  }

  // ambient:event — 구간 확정·요약 갱신 + speech:partial — 스트림 오류 (엔진 종료·기한)
  useEffect(() => {
    const offAmbient = window.litecode.onAmbientEvent((event) => {
      if (event.channel === 'segment' && event.transcript) dispatch({ type: 'transcript', text: event.transcript })
      else if (event.channel === 'summary' && event.summary) dispatch({ type: 'summary', text: event.summary })
    })
    const offPartial = window.litecode.onSpeechPartial((event: SpeechStreamEvent) => {
      if (!event.error) return
      const active = flight.current
      if (!active || active.stream !== event.stream) return
      flight.current = undefined
      release(active)
      void window.litecode.ambientStop().catch(() => {})
      const key = event.error === 'busy' ? 'speech.error.busy' : event.error === 'unavailable' ? 'speech.error.unavailable' : 'voice.error.failed'
      dispatch({ type: 'failed', run: active.run, key })
    })
    return () => {
      offAmbient()
      offPartial()
    }
  }, [])

  // noise — 사라지도록
  useEffect(() => {
    if (state.notice?.tone !== 'info') return
    const timer = setTimeout(() => dispatch({ type: 'dismiss' }), 5000)
    return () => clearTimeout(timer)
  }, [state.notice])

  const { phase, transcript, summary } = state

  return (
    <div className="ambient">
      <div className="ambient__header">
        <span className={`ambient__status${phase === 'recording' ? ' ambient__status--on' : ''}`} role="status">
          {phase === 'recording' && <span className="ambient__dot" aria-hidden="true" />}
          {phase === 'recording' ? t('ambient.recording') : phase === 'failed' ? t(state.notice?.key ?? 'voice.error.failed') : t('ambient.idle')}
        </span>
        {phase === 'recording' ? (
          <button type="button" className="ambient__button" data-ambient-action="stop" aria-label={t('ambient.stop')} title={t('ambient.stop')} onClick={() => void stop()}>
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
              <rect x="3" y="3" width="10" height="10" rx="1.5" />
            </svg>
          </button>
        ) : (
          <button type="button" className="ambient__button" data-ambient-action="start" aria-label={t('ambient.start')} title={t('ambient.start')} onClick={() => void start()}>
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
              <circle cx="8" cy="8" r="5" />
            </svg>
          </button>
        )}
      </div>
      {summary && (
        <div className="ambient__summary" role="status">
          <span className="ambient__label">{t('ambient.summary')}</span>
          <p className="ambient__summary-text">{summary}</p>
        </div>
      )}
      {transcript && (
        <div className="ambient__transcript">
          <span className="ambient__label">{t('ambient.transcript')}</span>
          <div className="ambient__transcript-body">{transcript}</div>
        </div>
      )}
      {!summary && !transcript && phase === 'idle' && !state.notice && (
        <p className="ambient__hint">{t('ambient.idle')}</p>
      )}
      {!summary && !transcript && phase === 'idle' && state.notice && (
        <p className="ambient__hint" data-tone={state.notice.tone}>
          {t(state.notice.key)}
        </p>
      )}
    </div>
  )
}
