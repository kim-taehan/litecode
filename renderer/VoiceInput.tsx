import { useEffect, useLayoutEffect, useReducer, useRef, useState, type RefObject } from 'react'
import type { MessageKey } from '../shared/i18n/index.ts'
import type { SpeechReply, SpeechStatus } from '../shared/ipc.ts'
import { SPEECH_MAX_SECONDS } from '../shared/speech.ts'
import { useFeatures } from './featuresStore.ts'
import { useT } from './settingsStore.ts'
import { StopIcon } from './stopTurn.tsx'
import { VoiceRecording } from './voiceRecorder.ts'
import {
  barLevel,
  captureFailure,
  elapsedLabel,
  insertTranscript,
  notReady,
  pushLevel,
  replyFailure,
  VOICE_BARS,
  VOICE_IDLE,
  VOICE_NOTICE_MS,
  voiceBusy,
  voiceReducer,
  type VoiceAnchor,
  type VoiceNotice,
  type VoiceState,
} from './voiceView.ts'
import './voice.css'

// 음성 입력 (이슈 #109 2단계) — 입력 카드의 마이크 버튼(모델 선택과 보내기 사이)과 녹음 띠. dsh client-ui-voice-input 의 동작을 따른다:
// 누르면 녹음(토글), 다시 누르면 정지 → 받아쓰기, 결과는 **입력창에 넣기만 하고 보내지 않는다**. 누르고 있는 동안만 녹음·단축키·말하는 동안 글 보이기는 없다.
// 녹음을 시작할 때의 커서 자리에 넣고, 그사이 글을 고쳤으면 지금 커서 자리에, 대화를 바꿨으면 녹음을 시작한 대화의 초안에 넣는다 (voiceView insertTranscript).
// 120초에 스스로 멈추고 받아쓴다. 녹음 중 Esc 는 취소다 — 먼저 써서(preventDefault) 답변 중지의 "Esc 두 번" 에 세어지지 않는다.
// 턴이 도는 중에도 녹음된다(초안은 쓸 수 있다). 창이 뒤로 가도 녹음은 이어진다(dsh 는 취소한다 — 다른 창을 보며 말할 수 있게 두었다).
// 기능 `voice` 가 꺼져 있으면 버튼·띠가 없고 채널도 부르지 않는다. 마이크는 어느 길로 끝나든 놓는다 — 정지·취소·실패·대화 삭제·기능 끔·화면이 내려갈 때.
// 상태는 App 에 훅 하나(useVoiceInput)로 두고 버튼과 띠가 나눠 그린다 — 둘이 입력 카드의 다른 줄에 있다.

export interface VoiceInputOptions {
  /** 지금 보는 대화 — 입력 카드가 없으면 undefined */
  sessionId: string | undefined
  inputRef: RefObject<HTMLTextAreaElement | null>
  /** 그 대화가 아직 있는가 — 녹음 중에 지워진 대화의 녹음은 버린다 */
  hasSession(id: string): boolean
  /** 그 대화 초안의 글을 고친다 (지금 보는 대화가 아니어도) */
  edit(id: string, change: (text: string) => string): void
}

export interface VoiceInput {
  /** 기능이 켜져 있다 */
  on: boolean
  state: VoiceState
  /** 녹음이 시작된 때 (performance.now) — 녹음 중에만 */
  since: number | undefined
  /** 마이크 버튼 — 대기면 녹음 시작, 녹음 중이면 정지하고 받아쓰기, 마이크를 여는 중이면 취소 */
  toggle(): void
  cancel(): void
  dismiss(): void
  /** 지금 음량 (RMS) */
  level(): number
}

interface Flight {
  run: number
  sessionId: string
  recording: VoiceRecording
  anchor: VoiceAnchor | undefined
  since?: number
  timer?: ReturnType<typeof setTimeout>
  stopping?: boolean
  /** 메인에 보냈다 — 취소하면 메인의 받아쓰기도 멈춘다 */
  sent?: boolean
}

const EMPTY: VoiceNotice = { tone: 'info', key: 'voice.empty' }
const ELSEWHERE: VoiceNotice = { tone: 'info', key: 'voice.elsewhere' }
const platform = (): string | undefined => document.documentElement.dataset.platform

export function useVoiceInput(options: VoiceInputOptions): VoiceInput {
  const on = useFeatures().has('voice')
  const [state, dispatch] = useReducer(voiceReducer, VOICE_IDLE)
  const flight = useRef<Flight>(undefined)
  const runs = useRef(0)
  const status = useRef<SpeechStatus>(undefined)
  /** 넣은 글 바로 뒤로 옮길 커서 — 초안이 그려진 뒤에 놓는다 */
  const caret = useRef<{ sessionId: string; at(): number | undefined }>(undefined)
  const latest = useRef(options)
  latest.current = options

  function cancel(): void {
    const active = flight.current
    flight.current = undefined
    if (active) {
      clearTimeout(active.timer)
      active.recording.dispose()
      if (active.sent) void window.litecode.cancelSpeech().catch(() => {})
    }
    dispatch({ type: 'cancel' })
  }

  function fail(active: Flight, key: MessageKey): void {
    if (flight.current !== active) return
    flight.current = undefined
    clearTimeout(active.timer)
    active.recording.dispose()
    dispatch({ type: 'failed', run: active.run, notice: { tone: 'error', key } })
  }

  function done(active: Flight, notice?: VoiceNotice): void {
    flight.current = undefined
    dispatch({ type: 'done', run: active.run, ...(notice && { notice }) })
  }

  async function start(): Promise<void> {
    const { sessionId, inputRef } = latest.current
    if (!sessionId || flight.current) return
    const blocked = notReady(status.current)
    if (blocked) return dispatch({ type: 'notify', notice: { tone: 'error', key: blocked } })
    const input = inputRef.current
    const active: Flight = {
      run: ++runs.current,
      sessionId,
      recording: new VoiceRecording(),
      anchor: input ? { text: input.value, at: input.selectionEnd } : undefined,
    }
    flight.current = active
    dispatch({ type: 'start', run: active.run, sessionId })
    try {
      await active.recording.start(() => fail(active, 'voice.error.recording'))
    } catch (error) {
      return fail(active, captureFailure(error, platform()))
    }
    if (flight.current !== active) return // 권한 창을 기다리는 사이 취소됐다 — 마이크는 녹음기가 놓았다
    active.since = performance.now()
    active.timer = setTimeout(() => void finish(active), SPEECH_MAX_SECONDS * 1000)
    dispatch({ type: 'granted', run: active.run })
  }

  async function finish(active: Flight): Promise<void> {
    if (flight.current !== active || active.stopping || active.since === undefined) return
    active.stopping = true
    clearTimeout(active.timer)
    dispatch({ type: 'stop', run: active.run })
    let pcm: Int16Array
    try {
      pcm = await active.recording.stop()
    } catch (error) {
      return fail(active, captureFailure(error, platform()))
    }
    if (flight.current !== active) return
    if (pcm.length === 0) return done(active, EMPTY)
    active.sent = true
    let reply: SpeechReply
    try {
      reply = await window.litecode.transcribeSpeech(pcm) // 언어는 메인이 설정에서 읽는다 (settings.speechLanguage, 없으면 화면 언어)
    } catch {
      return fail(active, 'voice.error.failed')
    }
    if (flight.current !== active) return
    if (!reply.ok) {
      const key = replyFailure(reply.code)
      return key ? fail(active, key) : done(active)
    }
    const said = reply.text
    if (said.trim() === '') return done(active, EMPTY)
    const { sessionId: showing, inputRef, edit } = latest.current
    const input = showing === active.sessionId ? inputRef.current : null
    const cursor = input?.selectionEnd
    let placed: number | undefined
    edit(active.sessionId, (text) => {
      const next = insertTranscript(text, said, active.anchor, cursor)
      placed = next.cursor
      return next.text
    })
    if (input) caret.current = { sessionId: active.sessionId, at: () => placed }
    done(active, input ? undefined : ELSEWHERE)
  }

  // 넣은 글 뒤에 커서를 둔다 — 초안이 입력창에 그려진 다음이라야 자리가 맞는다. 포커스는 입력 카드 안이나 아무 데도 없을 때만 가져온다
  useLayoutEffect(() => {
    const pending = caret.current
    const at = pending?.at()
    if (!pending || at === undefined) return
    caret.current = undefined
    const input = latest.current.inputRef.current
    if (!input || latest.current.sessionId !== pending.sessionId || at > input.value.length) return
    const focused = document.activeElement
    if (!focused || focused === document.body || focused.closest('.composer')) input.focus()
    input.setSelectionRange(at, at)
  })

  // 엔진 상태 — 파일이 없거나 손상이면 마이크를 열기 전에 알린다
  useEffect(() => {
    if (!on) return
    let current = true
    const apply = (next: SpeechStatus): void => {
      if (current) status.current = next
    }
    const off = window.litecode.onSpeechChanged(apply)
    void window.litecode.speechStatus().then(apply, () => {}) // 못 읽으면 모르는 채로 — 받아쓰기의 답이 사유를 준다
    return () => {
      current = false
      off()
      status.current = undefined
    }
  }, [on])

  // 기능을 끄거나 화면이 내려가면 놓는다
  useEffect(() => {
    if (!on) cancel()
    return cancel
  }, [on])

  // 녹음을 시작한 대화가 지워졌거나, 마이크를 쥔 채 입력 카드가 사라졌으면(프로젝트 없음) 놓는다 — 받아쓰는 중인 것은 그 대화가 있는 한 끝까지
  useEffect(() => {
    const active = flight.current
    if (!active) return
    if (!latest.current.hasSession(active.sessionId) || (latest.current.sessionId === undefined && !active.sent)) cancel()
  })

  // Esc = 취소. 메뉴·대화상자가 먼저 쓴 Esc 와 입력기 조합 중인 Esc 는 건드리지 않는다. window 의 "Esc 두 번" 보다 먼저 돈다(document 가 안쪽)
  const busy = voiceBusy(state)
  useEffect(() => {
    if (!busy) return
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing) return
      if (event.target instanceof Element && event.target.closest('[role="dialog"], [role="menu"]')) return
      event.preventDefault()
      cancel()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [busy])

  // "말소리를 찾지 못했습니다" 같은 줄은 잠깐만 — 오류는 닫을 때까지 남는다
  const notice = state.notice
  useEffect(() => {
    if (notice?.tone !== 'info') return
    const timer = setTimeout(() => dispatch({ type: 'dismiss' }), VOICE_NOTICE_MS)
    return () => clearTimeout(timer)
  }, [notice])

  return {
    on,
    state,
    since: state.phase === 'recording' ? flight.current?.since : undefined,
    toggle() {
      const active = flight.current
      if (!active) void start()
      else if (active.since === undefined) cancel()
      else void finish(active)
    },
    cancel,
    dismiss: () => dispatch({ type: 'dismiss' }),
    level: () => flight.current?.recording.level() ?? 0,
  }
}

/** 마이크 버튼 — 녹음·받아쓰는 동안 눌린 모양(aria-pressed). 누를 때 입력창의 포커스·커서를 뺏지 않는다 */
export function VoiceButton({ voice }: { voice: VoiceInput }) {
  const t = useT()
  if (!voice.on) return null
  const { phase } = voice.state
  const label = t(phase === 'idle' ? 'voice.start' : phase === 'recording' ? 'voice.stop' : phase === 'requesting' ? 'voice.cancel' : 'voice.transcribing')
  return (
    <button
      type="button"
      className="composer__voice"
      data-voice={phase}
      aria-pressed={phase !== 'idle'}
      aria-label={label}
      title={label}
      disabled={phase === 'transcribing'}
      onMouseDown={(event) => event.preventDefault()}
      onClick={voice.toggle}
    >
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <rect x="5.75" y="1.75" width="4.5" height="7.5" rx="2.25" />
        <path d="M3.25 7.5A4.75 4.75 0 0 0 12.75 7.5M8 12.25V14.25" />
      </svg>
    </button>
  )
}

/** 녹음 띠 — 입력칸과 아래 줄 사이. 마이크를 여는 중·녹음 중(취소 · 음량 · 경과 · 정지)·받아쓰는 중, 끝난 뒤의 한 줄(말소리 없음·실패 사유) */
export function VoiceStrip({ voice }: { voice: VoiceInput }) {
  const t = useT()
  const { phase, notice } = voice.state
  if (!voice.on || (phase === 'idle' && !notice)) return null
  const text = phase === 'requesting' ? t('voice.requesting') : phase === 'recording' ? t('voice.recording') : phase === 'transcribing' ? t('voice.transcribing') : notice ? t(notice.key) : ''
  return (
    <div className="voice-strip" data-voice={phase} data-tone={phase === 'idle' ? notice?.tone : undefined}>
      {phase !== 'idle' && (
        <button type="button" className="voice-strip__button" data-voice-action="cancel" aria-label={t('voice.cancel')} title={t('voice.cancel')} onClick={voice.cancel}>
          <CloseIcon />
        </button>
      )}
      <span className="voice-strip__text" role="status">
        {phase !== 'idle' && <span className="voice-strip__dot" aria-hidden="true" />}
        {text}
      </span>
      {phase === 'recording' && (
        <>
          <VoiceMeter level={voice.level} />
          <Elapsed since={voice.since} />
          <button
            type="button"
            className="voice-strip__button voice-strip__stop"
            data-voice-action="stop"
            aria-label={t('voice.stop')}
            title={t('voice.stop')}
            onMouseDown={(event) => event.preventDefault()}
            onClick={voice.toggle}
          >
            <StopIcon size={14} />
          </button>
        </>
      )}
      {phase === 'idle' && (
        <button type="button" className="voice-strip__button" data-voice-action="dismiss" aria-label={t('voice.dismiss')} title={t('voice.dismiss')} onClick={voice.dismiss}>
          <CloseIcon />
        </button>
      )}
    </div>
  )
}

function CloseIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden="true">
      <path d="M4 4L12 12M12 4L4 12" />
    </svg>
  )
}

/** 경과 "0:07 / 2:00" — 상한에 닿으면 훅이 스스로 멈춘다 */
function Elapsed({ since }: { since: number | undefined }) {
  const [now, setNow] = useState(() => performance.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(performance.now()), 250)
    return () => clearInterval(timer)
  }, [])
  return (
    <span className="voice-strip__time" role="timer" data-voice-elapsed>
      {elapsedLabel(since === undefined ? 0 : now - since)} / {elapsedLabel(SPEECH_MAX_SECONDS * 1000)}
    </span>
  )
}

/** 음량 막대 — 최근 값이 오른쪽에서 들어와 왼쪽으로 흐른다. React 상태를 거치지 않고 높이만 고친다 (dsh Waveform 방식) */
function VoiceMeter({ level }: { level(): number }) {
  const root = useRef<HTMLSpanElement>(null)
  const read = useRef(level)
  read.current = level
  useEffect(() => {
    const bars = [...(root.current?.children ?? [])] as HTMLElement[]
    let levels: number[] = bars.map(() => 0)
    const timer = setInterval(() => {
      levels = pushLevel(levels, barLevel(read.current()))
      bars.forEach((bar, index) => (bar.style.height = `${2 + Math.round(levels[index]! * 16)}px`))
    }, 60)
    return () => clearInterval(timer)
  }, [])
  return (
    <span className="voice-strip__meter" ref={root} aria-hidden="true">
      {Array.from({ length: VOICE_BARS }, (_, index) => (
        <span key={index} className="voice-strip__bar" />
      ))}
    </span>
  )
}
