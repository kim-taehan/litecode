import { useEffect, useLayoutEffect, useReducer, useRef, useState, type RefObject } from 'react'
import type { MessageKey } from '../shared/i18n/index.ts'
import type { SpeechReply, SpeechStatus, SpeechStreamOpened } from '../shared/ipc.ts'
import { SPEECH_MAX_SECONDS, type SpeechPartial } from '../shared/speech.ts'
import { useFeatures } from './featuresStore.ts'
import { useT } from './settingsStore.ts'
import { StopIcon } from './stopTurn.tsx'
import { VoiceRecording } from './voiceRecorder.ts'
import {
  barLevel,
  captureFailure,
  countdownLeft,
  elapsedLabel,
  insertTranscript,
  notReady,
  pushLevel,
  replyFailure,
  turnStopReason,
  VOICE_BARS,
  VOICE_CHAT_REOPEN_MS,
  VOICE_CHAT_SETTLE_MS,
  VOICE_IDLE,
  VOICE_NOTICE_MS,
  voiceBusy,
  voiceChatWatch,
  voiceReducer,
  type VoiceAnchor,
  type VoiceChatActivity,
  type VoiceNotice,
  type VoiceState,
} from './voiceView.ts'
import './voice.css'

// 음성 입력 (이슈 #109 2단계) — 입력 카드의 마이크 버튼(모델 선택과 보내기 사이)과 녹음 띠. dsh client-ui-voice-input 의 동작을 따른다:
// 누르면 녹음(토글), 다시 누르면 정지 → 받아쓰기, 결과는 **입력창에 넣기만 하고 보내지 않는다**. 누르고 있는 동안만 녹음·단축키는 없다.
// **말하는 동안 받아쓴 글이 띠 아래에 보인다** (3단계, 실시간 받아쓰기) — 녹음 조각(0.1초)을 메인에 흘리면 끝난 말소리 구간은 확정 글로, 말하고 있는
// 구간은 흐린 임시 글로 돌아온다(`speech:partial`). 입력창은 말하는 동안 건드리지 않고 정지의 답을 한 번에 넣는다 — 글이 바뀌며 커서가 튀지 않게.
// 녹음을 시작할 때의 커서 자리에 넣고, 그사이 글을 고쳤으면 지금 커서 자리에, 대화를 바꿨으면 녹음을 시작한 대화의 초안에 넣는다 (voiceView insertTranscript).
// 120초에 스스로 멈추고 받아쓴다. 녹음 중 Esc 는 취소다 — 먼저 써서(preventDefault) 답변 중지의 "Esc 두 번" 에 세어지지 않는다.
// 턴이 도는 중에도 녹음된다(초안은 쓸 수 있다). 창이 뒤로 가도 녹음은 이어진다(dsh 는 취소한다 — 다른 창을 보며 말할 수 있게 두었다).
// 기능 `voice` 가 꺼져 있으면 버튼·띠가 없고 채널도 부르지 않는다. 마이크는 어느 길로 끝나든 놓는다 — 정지·취소·실패·대화 삭제·기능 끔·화면이 내려갈 때.
// 상태는 App 에 훅 하나(useVoiceInput)로 두고 버튼과 띠가 나눠 그린다 — 둘이 입력 카드의 다른 줄에 있다.
// 음성 대화 모드 1단계 (#238, 시안 CkySBn4p42AwG7w1jxL8ZZ ②~④, 실측 _workspace/01aq_voice_chat_feasibility.md) — 마이크 옆 '대화' 버튼. 같은 녹음·스트림 길을 쓰고:
// 말을 멈추면(엔진의 VAD 가 꺼지고 silentMs 가 차면) 카운트다운 띠가 차오른 뒤 받아쓴 글**만** 보낸다(첨부·트리거 없이). 카운트다운 중에 다시 말하면 이어서 받아쓴다.
// 보내면 마이크를 닫고 답을 기다리다가, 그 대화에 도는 턴·대기열이 없는 상태가 300ms 이어지면 다시 듣는다(새 이벤트 없이 — after-turn 훅의 다음 턴과 겹치지 않게).
// 보낼 수 없으면(초안·첨부·`/`·`!`·모델 없음·쓸 수 없는 대화·도는 턴·대화 전환) 받아쓴 글을 입력창에 넣고 사유를 띠에 남기고 끈다 — 조용히 돌아가지 않는다.
// 승인·질문 카드·실패·중지에서도 멈춘다. 받아쓰기 120초 상한 전에 스트림만 닫고 다시 연다(마이크는 그대로). 읽어 주기·말로 끼어들기는 없다(2·3단계).

export interface VoiceInputOptions {
  /** 지금 보는 대화 — 입력 카드가 없으면 undefined */
  sessionId: string | undefined
  inputRef: RefObject<HTMLTextAreaElement | null>
  /** 그 대화가 아직 있는가 — 녹음 중에 지워진 대화의 녹음은 버린다 */
  hasSession(id: string): boolean
  /** 그 대화 초안의 글을 고친다 (지금 보는 대화가 아니어도) */
  edit(id: string, change: (text: string) => string): void
  /** 음성 대화 모드 (#238) — 지금 보는 대화의 턴 상태와 보내기 */
  chat: {
    activity: VoiceChatActivity
    /** 자동 보내기 금지 표 (voiceView voiceChatBlock) — 시작할 때는 transcript 없이 */
    block(transcript?: string): MessageKey | undefined
    /** 그 글만 지금 보는 대화에 보낸다 (첨부·트리거 없이) */
    send(text: string): void
  }
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
  /** 대화 버튼 — 꺼져 있으면 음성 대화를 시작하고, 켜져 있으면 끈다 (들은 글은 입력창에) */
  toggleChat(): void
  /** 카운트다운의 [취소] — 보내지 않고 입력창에 남기고 음성 대화를 끈다 */
  hold(): void
}

interface Flight {
  run: number
  sessionId: string
  recording: VoiceRecording
  anchor: VoiceAnchor | undefined
  since?: number
  timer?: ReturnType<typeof setTimeout>
  stopping?: boolean
  /** 메인의 받아쓰기 스트림 번호 — 마이크가 열린 뒤에 연다 */
  stream?: number
  /** 스트림 번호를 받기 전에 나온 조각 (대화 모드는 스트림을 다시 여는 사이의 것도) */
  held: Int16Array[]
  /** 음성 대화 모드의 듣기 */
  chat?: boolean
  /** 지금 스트림의 마지막 글·말 끝 신호 */
  live?: SpeechPartial
  /** 말 끝 카운트다운 — 끝나면 정지하고 보낸다 */
  countdown?: ReturnType<typeof setTimeout>
  /** 대화 모드인데 보내지 않고 입력창에 넣고 끈다 — 그때 남길 사유 */
  keep?: { notice?: VoiceNotice }
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
  const current = useRef(state)
  current.current = state
  /** 대화 모드의 답 대기 — 보낸 턴이 시작된 걸 봤다 (그 전엔 다시 듣지 않는다) */
  const [started, setStarted] = useState(false)

  /** 마이크와 메인의 스트림을 놓는다 (끝난 스트림을 버려도 된다) */
  function release(active: Flight): void {
    clearTimeout(active.timer)
    clearTimeout(active.countdown)
    active.recording.dispose()
    if (active.stream !== undefined) void window.litecode.cancelSpeechStream(active.stream).catch(() => {})
  }

  function cancel(): void {
    const active = flight.current
    flight.current = undefined
    if (active) release(active)
    dispatch({ type: 'cancel' })
  }

  function fail(active: Flight, key: MessageKey): void {
    if (flight.current !== active) return
    flight.current = undefined
    release(active)
    dispatch({ type: 'failed', run: active.run, notice: { tone: 'error', key } })
  }

  /** 메인이 준 실패 코드로 끝낸다 — 취소는 조용히 */
  function failWith(active: Flight, code: Parameters<typeof replyFailure>[0]): void {
    if (flight.current !== active) return
    const key = replyFailure(code)
    if (key) fail(active, key)
    else cancel()
  }

  function done(active: Flight, notice?: VoiceNotice): void {
    flight.current = undefined
    dispatch({ type: 'done', run: active.run, ...(notice && { notice }) })
  }

  /** chat: 음성 대화 모드의 듣기 — 대기나 답 대기에서. 보낼 수 없는 대화면 시작하지 않고 사유를 남긴다 */
  async function start(chat = false): Promise<void> {
    const { sessionId, inputRef } = latest.current
    if (!sessionId || flight.current) return
    const blocked = notReady(status.current) ?? (chat ? latest.current.chat.block() : undefined)
    if (blocked) return dispatch(chat ? { type: 'end', notice: { tone: 'error', key: blocked } } : { type: 'notify', notice: { tone: 'error', key: blocked } })
    const input = inputRef.current
    const active: Flight = {
      run: ++runs.current,
      sessionId,
      recording: new VoiceRecording(),
      anchor: input ? { text: input.value, at: input.selectionEnd } : undefined,
      held: [],
      ...(chat && { chat: true }),
    }
    flight.current = active
    dispatch({ type: 'start', run: active.run, sessionId, chat })
    try {
      await active.recording.start(
        () => fail(active, 'voice.error.recording'),
        (pcm) => {
          if (flight.current !== active) return
          if (active.stream === undefined) active.held.push(pcm)
          else window.litecode.sendSpeechChunk(active.stream, pcm)
        },
      )
    } catch (error) {
      return fail(active, captureFailure(error, platform()))
    }
    if (flight.current !== active) return // 권한 창을 기다리는 사이 취소됐다 — 마이크는 녹음기가 놓았다
    // 마이크가 열린 뒤에 메인의 스트림을 연다 (권한이 거절되면 엔진을 띄우지 않는다). 언어는 메인이 설정에서 읽는다 (settings.speechLanguage, 없으면 화면 언어)
    let opened: SpeechStreamOpened
    try {
      opened = await window.litecode.startSpeechStream()
    } catch {
      return fail(active, 'voice.error.failed')
    }
    if (flight.current !== active) {
      if (opened.ok) void window.litecode.cancelSpeechStream(opened.stream).catch(() => {})
      return
    }
    if (!opened.ok) return failWith(active, opened.code)
    active.stream = opened.stream
    for (const pcm of active.held.splice(0)) window.litecode.sendSpeechChunk(opened.stream, pcm)
    active.since = performance.now()
    active.timer = active.chat ? setTimeout(() => void reopen(active), VOICE_CHAT_REOPEN_MS) : setTimeout(() => void finish(active), SPEECH_MAX_SECONDS * 1000)
    dispatch({ type: 'granted', run: active.run })
  }

  /** 대화 모드 — 받아쓰기 상한(120초) 전에 스트림만 닫고 새로 연다 (마이크는 그대로, 그사이 조각은 쥐었다가 새 스트림에). 들은 글이 있으면 입력창에 넣고 끈다 */
  async function reopen(active: Flight): Promise<void> {
    if (flight.current !== active || active.stopping || active.stream === undefined || active.countdown !== undefined) return // 카운트다운이면 곧 보낸다
    if (active.live && (active.live.speaking || active.live.final.trim() !== '' || active.live.tentative !== '')) return endChat({ tone: 'error', key: 'voice.chat.stop.tooLong' })
    const old = active.stream
    active.stream = undefined
    active.live = undefined
    void window.litecode.cancelSpeechStream(old).catch(() => {})
    let opened: SpeechStreamOpened
    try {
      opened = await window.litecode.startSpeechStream()
    } catch {
      return fail(active, 'voice.error.failed')
    }
    if (flight.current !== active) {
      if (opened.ok) void window.litecode.cancelSpeechStream(opened.stream).catch(() => {})
      return
    }
    if (!opened.ok) return failWith(active, opened.code)
    active.stream = opened.stream
    for (const pcm of active.held.splice(0)) window.litecode.sendSpeechChunk(opened.stream, pcm)
    active.timer = setTimeout(() => void reopen(active), VOICE_CHAT_REOPEN_MS)
  }

  /** 대화 모드 — 말 끝이면 카운트다운을 걸고(끝나면 보낸다), 다시 말하면 거둔다 */
  function listen(active: Flight, partial: SpeechPartial): void {
    active.live = partial
    if (active.stopping) return
    const left = countdownLeft(partial)
    if (left === undefined) {
      if (active.countdown === undefined) return
      clearTimeout(active.countdown)
      active.countdown = undefined
      dispatch({ type: 'resume', run: active.run })
    } else if (active.countdown === undefined) {
      active.countdown = setTimeout(() => void finish(active), left)
      dispatch({ type: 'countdown', run: active.run, until: performance.now() + left })
    }
  }

  /** 대화 모드 — 보냈다(또는 들은 글이 없다). 마이크를 놓고 답을 기다린다. relisten: 턴을 기다리지 않고 곧 다시 듣는다 */
  function wait(active: Flight, relisten: boolean): void {
    flight.current = undefined
    setStarted(relisten)
    dispatch({ type: 'wait', run: active.run })
  }

  /** 음성 대화를 끈다 — 듣는 중·보내는 중이면 들은 글을 입력창에 넣고, 아니면 마이크만 놓는다. notice: 띠에 남길 사유 */
  function endChat(notice?: VoiceNotice): void {
    const active = flight.current
    if (active?.since !== undefined) {
      active.keep = notice ? { notice } : {}
      void finish(active) // 이미 정지 중이면(보내는 중) 그 답이 keep 을 보고 보내지 않는다
      return
    }
    if (active) {
      flight.current = undefined
      release(active)
    }
    dispatch({ type: 'end', ...(notice && { notice }) })
  }

  async function finish(active: Flight): Promise<void> {
    if (flight.current !== active || active.stopping || active.since === undefined) return
    active.stopping = true
    clearTimeout(active.timer)
    clearTimeout(active.countdown)
    dispatch({ type: 'stop', run: active.run })
    await active.recording.stop() // 남은 조각까지 흘리고 마이크를 놓는다
    if (flight.current !== active) return
    if (active.stream === undefined) return done(active, active.keep ? active.keep.notice : EMPTY) // 대화 모드가 스트림을 다시 여는 사이 (들은 글이 없을 때만 다시 연다)
    let reply: SpeechReply
    try {
      reply = await window.litecode.stopSpeechStream(active.stream) // 남은 말소리 구간까지 확정한 글
    } catch {
      return fail(active, 'voice.error.failed')
    }
    if (flight.current !== active) return
    if (!reply.ok) return failWith(active, reply.code)
    const said = reply.text
    const sending = active.chat && !active.keep
    if (said.trim() === '') return sending ? wait(active, true) : done(active, active.keep ? active.keep.notice : EMPTY)
    if (sending) {
      // 자동 보내기 금지 표 — 막히면 입력창에 넣고 사유를 남기고 끈다
      const blocked = latest.current.sessionId !== active.sessionId ? 'voice.chat.stop.switched' : latest.current.chat.block(said)
      if (!blocked) {
        latest.current.chat.send(said.trim())
        return wait(active, false)
      }
      active.keep = { notice: { tone: 'error', key: blocked } }
    }
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
    done(active, active.keep?.notice ?? (input ? undefined : ELSEWHERE))
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

  // 말하는 동안의 글 — 지금 녹음의 스트림 것만. 스트림이 죽었으면(엔진 종료·기한) 녹음을 멈추고 알린다
  useEffect(() => {
    if (!on) return
    return window.litecode.onSpeechPartial((event) => {
      const active = flight.current
      if (!active || active.stream !== event.stream) return
      if (event.error) return failWith(active, event.error)
      dispatch({ type: 'partial', run: active.run, live: event })
      if (active.chat) listen(active, event)
    })
  }, [on])

  // 대화 모드의 답 대기 — 그 대화의 턴이 끝났다. 실패·중지면 멈추고, 아니면 "턴이 시작된 걸 봤다" (아주 짧은 턴은 도는 표시가 안 그려질 수 있다)
  useEffect(() => {
    if (!on) return
    return window.litecode.onTurnEnded((event) => {
      const now = current.current
      if (!now.chat || now.phase !== 'waiting' || event.cid !== now.sessionId) return
      const reason = turnStopReason(event.outcome)
      if (reason) endChat({ tone: event.outcome === 'interrupted' ? 'info' : 'error', key: reason })
      else setStarted(true)
    })
  }, [on])

  // 대화 모드 — 그 대화의 턴 상태를 본다: 답 대기면 카드에서 멈추거나 "도는 턴·대기열 없음" 이 300ms 이어질 때 다시 듣고, 듣는 중에 턴이 시작되면 멈춘다
  const { busy: turnBusy, attention } = options.chat.activity
  useEffect(() => {
    if (state.phase === 'waiting' && turnBusy && !started) return setStarted(true)
    const next = voiceChatWatch(state, { busy: turnBusy, attention }, started)
    if (next?.type === 'end') return endChat({ tone: 'error', key: next.key })
    if (next?.type !== 'relisten') return
    const timer = setTimeout(() => void start(true), VOICE_CHAT_SETTLE_MS)
    return () => clearTimeout(timer)
  }, [state.phase, state.chat, turnBusy, attention, started])

  // 대화 모드 중에 다른 대화로 옮겨 가면 끈다 — 들은 글은 시작한 대화의 입력창에
  const showing = options.sessionId
  useEffect(() => {
    if (state.chat && state.sessionId !== undefined && showing !== state.sessionId) endChat({ tone: 'info', key: 'voice.chat.stop.switched' })
  }, [showing, state.chat, state.sessionId])

  // 기능을 끄거나 화면이 내려가면 놓는다
  useEffect(() => {
    if (!on) cancel()
    return cancel
  }, [on])

  // 녹음을 시작한 대화가 지워졌거나, 마이크를 쥔 채 입력 카드가 사라졌으면(프로젝트 없음) 놓는다 — 받아쓰는 중인 것은 그 대화가 있는 한 끝까지
  useEffect(() => {
    const active = flight.current
    if (!active) return
    if (!latest.current.hasSession(active.sessionId) || (latest.current.sessionId === undefined && !active.stopping)) cancel()
  })

  // Esc = 취소. 메뉴·대화상자가 먼저 쓴 Esc 와 입력기 조합 중인 Esc 는 건드리지 않는다. window 의 "Esc 두 번" 보다 먼저 돈다(document 가 안쪽)
  const busy = voiceBusy(state)
  useEffect(() => {
    if (!busy) return
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing) return
      if (event.target instanceof Element && event.target.closest('[role="dialog"], [role="menu"]')) return
      event.preventDefault()
      if (current.current.chat) endChat() // 대화 모드는 들은 글을 입력창에 남기고 끈다
      else cancel()
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
      if (current.current.chat) return // 대화 모드 중엔 마이크 버튼을 못 누른다
      if (!active) void start()
      else if (active.since === undefined) cancel()
      else void finish(active)
    },
    cancel,
    dismiss: () => dispatch({ type: 'dismiss' }),
    level: () => flight.current?.recording.level() ?? 0,
    toggleChat() {
      if (current.current.chat) endChat()
      else if (current.current.phase === 'idle') void start(true)
    },
    hold: () => endChat(),
  }
}

/** 마이크 버튼 — 녹음·받아쓰는 동안 눌린 모양(aria-pressed). 누를 때 입력창의 포커스·커서를 뺏지 않는다 */
export function VoiceButton({ voice }: { voice: VoiceInput }) {
  const t = useT()
  if (!voice.on) return null
  // 음성 대화 중엔 받아쓰기 마이크가 쉬는 모양으로 못 누른다 — 녹음은 대화 버튼의 것이다
  const chat = !!voice.state.chat
  const phase = chat ? 'idle' : voice.state.phase
  const label = t(phase === 'idle' ? 'voice.start' : phase === 'recording' ? 'voice.stop' : phase === 'requesting' ? 'voice.cancel' : 'voice.transcribing')
  return (
    <button
      type="button"
      className="composer__voice"
      data-voice={phase}
      aria-pressed={phase !== 'idle'}
      aria-label={label}
      title={label}
      disabled={phase === 'transcribing' || chat}
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

/** 대화 버튼 (#238) — 마이크 옆. 음성 대화 중엔 눌린 모양이고 누르면 끈다. 받아쓰기 녹음 중엔 못 누른다. 누를 때 입력창의 포커스를 뺏지 않는다 */
export function VoiceChatButton({ voice }: { voice: VoiceInput }) {
  const t = useT()
  if (!voice.on) return null
  const on = !!voice.state.chat
  const label = t(on ? 'voice.chat.end' : 'voice.chat.start')
  return (
    <button
      type="button"
      className="composer__talk"
      aria-pressed={on}
      aria-label={label}
      title={label}
      disabled={!on && voice.state.phase !== 'idle'}
      onMouseDown={(event) => event.preventDefault()}
      onClick={voice.toggleChat}
    >
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M2.75 3.75A1.5 1.5 0 0 1 4.25 2.25H11.75A1.5 1.5 0 0 1 13.25 3.75V9.25A1.5 1.5 0 0 1 11.75 10.75H7L4.25 13.25V10.75A1.5 1.5 0 0 1 2.75 9.25Z" />
        <path d="M6 5.25V7.75M8 4.5V8.5M10 5.25V7.75" />
      </svg>
      <span>{t('voice.chat.label')}</span>
    </button>
  )
}

/** 음성 대화 띠의 단계 — 시안 ② 듣는 중 · ③ 보내는 중(카운트다운 → 보냄) · ④ 답변 중 대기 */
type ChatStage = 'requesting' | 'listening' | 'countdown' | 'sending' | 'waiting'

function chatStage(state: VoiceState): ChatStage {
  if (state.phase === 'waiting') return 'waiting'
  if (state.phase === 'transcribing') return 'sending'
  if (state.phase === 'requesting') return 'requesting'
  return state.countdown !== undefined ? 'countdown' : 'listening'
}

const CHAT_TEXT: Record<ChatStage, MessageKey> = {
  requesting: 'voice.requesting',
  listening: 'voice.chat.listening',
  countdown: 'voice.chat.countdown',
  sending: 'voice.chat.sending',
  waiting: 'voice.chat.waiting',
}

/** 음성 대화 띠 — 끝내기 · 상태 글 · (듣는 중) 음량 · (카운트다운) 차오르는 띠와 [취소]. 들은 글은 받아쓰기처럼 띠 아래에 */
function VoiceChatStrip({ voice }: { voice: VoiceInput }) {
  const t = useT()
  const { phase, live, countdown } = voice.state
  const stage = chatStage(voice.state)
  return (
    <>
      <div className="voice-strip" data-voice={phase} data-voice-chat={stage}>
        <button type="button" className="voice-strip__button" data-voice-action="end-chat" aria-label={t('voice.chat.end')} title={t('voice.chat.end')} onClick={voice.toggleChat}>
          <CloseIcon />
        </button>
        <span className="voice-strip__text" role="status">
          <span className="voice-strip__dot" aria-hidden="true" />
          {t(CHAT_TEXT[stage])}
        </span>
        {stage === 'listening' && <VoiceMeter level={voice.level} />}
        {stage === 'countdown' && countdown !== undefined && (
          <>
            <Countdown key={countdown} until={countdown} />
            <button
              type="button"
              className="voice-strip__hold"
              data-voice-action="hold"
              title={t('voice.chat.holdTitle')}
              onMouseDown={(event) => event.preventDefault()}
              onClick={voice.hold}
            >
              {t('voice.chat.hold')}
            </button>
          </>
        )}
      </div>
      {live && (live.final || live.tentative) && <VoiceLive final={live.final} tentative={live.tentative} />}
    </>
  )
}

/** 말 끝 카운트다운 — 남은 시간 동안 왼쪽에서 차오른다 (CSS 애니메이션 한 번, 끝나면 훅이 보낸다) */
function Countdown({ until }: { until: number }) {
  const [ms] = useState(() => Math.max(0, Math.round(until - performance.now())))
  return (
    <span className="voice-strip__countdown" aria-hidden="true">
      <span className="voice-strip__countdown-fill" style={{ animationDuration: `${ms}ms` }} />
    </span>
  )
}

/** 녹음 띠 — 입력칸과 아래 줄 사이. 마이크를 여는 중·녹음 중(취소 · 음량 · 경과 · 정지)·받아쓰는 중, 끝난 뒤의 한 줄(말소리 없음·실패 사유).
 *  녹음 중·받아쓰는 중엔 띠 아래에 말하는 동안 받아쓴 글이 붙는다 */
export function VoiceStrip({ voice }: { voice: VoiceInput }) {
  const t = useT()
  const { phase, notice, live } = voice.state
  if (!voice.on || (phase === 'idle' && !notice)) return null
  if (voice.state.chat && phase !== 'idle') return <VoiceChatStrip voice={voice} />
  const text = phase === 'requesting' ? t('voice.requesting') : phase === 'recording' ? t('voice.recording') : phase === 'transcribing' ? t('voice.transcribing') : notice ? t(notice.key) : ''
  return (
    <>
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
      {live && (live.final || live.tentative) && <VoiceLive final={live.final} tentative={live.tentative} />}
    </>
  )
}

/** 말하는 동안 받아쓴 글 — 확정된 글 뒤에 말하고 있는 구간의 임시 글(흐리게, 다음에 통째로 바뀔 수 있다). 길어지면 끝(가장 최근 글)이 보이게 흘린다.
 *  읽어 주지 않는다(aria-live 없음) — 1초에 한두 번 바뀐다. 입력창에 들어가는 글은 정지 뒤의 것이다 */
function VoiceLive({ final, tentative }: { final: string; tentative: string }) {
  const root = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    if (root.current) root.current.scrollTop = root.current.scrollHeight
  }, [final, tentative])
  return (
    <div className="voice-live" data-voice-live ref={root}>
      {final && <span data-voice-final>{final}</span>}
      {final && tentative && ' '}
      {tentative && (
        <span className="voice-live__tentative" data-voice-tentative>
          {tentative}
        </span>
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
