import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { translate } from '../../shared/i18n/index.ts'
import { en } from '../../shared/i18n/en.ts'
import { ko } from '../../shared/i18n/ko.ts'
import { SPEECH_MAX_SECONDS } from '../../shared/speech.ts'
import { VoiceButton, VoiceChatButton, VoiceStrip, type VoiceInput } from '../../renderer/VoiceInput.tsx'
import {
  countdownLeft,
  turnStopReason,
  VAD_OFF_MS,
  VOICE_CHAT_COUNTDOWN_MS,
  VOICE_CHAT_REOPEN_MS,
  VOICE_CHAT_SETTLE_MS,
  VOICE_CHAT_SILENCE_MS,
  VOICE_IDLE,
  voiceBusy,
  voiceChatBlock,
  voiceChatWatch,
  voiceReducer,
  type VoiceChatTarget,
  type VoiceEvent,
  type VoiceState,
} from '../../renderer/voiceView.ts'

// 음성 대화 모드 1단계 (이슈 #238) — 말을 멈추면 카운트다운 뒤 저절로 보내고, 답이 끝나면 다시 듣는다. 읽어 주기·끼어들기는 없다.
// 여기서 고정하는 것: 상태 기계(듣기 → 카운트다운 → 보내는 중 → 답 대기 → 다시 듣기) / 말 끝 판정(엔진의 speaking·silentMs) /
// 자동 보내기 금지 표 / 턴 결과에 따른 멈춤 / 답 대기 중 무엇을 할지 / 버튼·띠의 그림.
// 마이크·타이머·IPC 를 쥔 훅(useVoiceInput)은 단위로 못 잡는다 — 마이크를 열지 않는다.

vi.mock('../../renderer/settingsStore.ts', () => ({ useT: () => (key: Parameters<typeof translate>[1], vars?: Record<string, string | number>) => translate('ko', key, vars) }))

const run = (events: VoiceEvent[], from: VoiceState = VOICE_IDLE): VoiceState => events.reduce(voiceReducer, from)
const listening: VoiceState = { phase: 'recording', run: 1, sessionId: 'a', chat: true }

describe('대화 모드 상태 기계', () => {
  it('듣기 → 카운트다운 → 보내는 중 → 답 대기 → 다시 듣기 — 대화 모드 표시(chat)를 끝까지 쥔다', () => {
    let state = voiceReducer(VOICE_IDLE, { type: 'start', run: 1, sessionId: 'a', chat: true })
    expect(state).toEqual({ phase: 'requesting', run: 1, sessionId: 'a', chat: true })
    state = voiceReducer(state, { type: 'granted', run: 1 })
    expect(state).toEqual(listening)
    state = voiceReducer(state, { type: 'countdown', run: 1, until: 5000 })
    expect(state.countdown).toBe(5000)
    state = voiceReducer(state, { type: 'stop', run: 1 })
    expect(state).toEqual({ phase: 'transcribing', run: 1, sessionId: 'a', chat: true }) // 카운트다운은 지운다
    state = voiceReducer(state, { type: 'wait', run: 1 })
    expect(state).toEqual({ phase: 'waiting', run: 1, sessionId: 'a', chat: true })
    state = voiceReducer(state, { type: 'start', run: 2, sessionId: 'a', chat: true })
    expect(state).toEqual({ phase: 'requesting', run: 2, sessionId: 'a', chat: true })
  })

  it('카운트다운 중에 다시 말하면(resume) 카운트다운만 지우고 그대로 듣는다 — 받아쓴 글은 남는다', () => {
    const counting = run([{ type: 'partial', run: 1, live: { final: '하나', tentative: '' } }, { type: 'countdown', run: 1, until: 900 }], listening)
    const resumed = voiceReducer(counting, { type: 'resume', run: 1 })
    expect(resumed).toEqual({ ...listening, live: { final: '하나', tentative: '' } })
    expect(voiceReducer(resumed, { type: 'resume', run: 1 })).toBe(resumed) // 카운트다운이 없으면 그대로
  })

  it('카운트다운은 대화 모드로 녹음 중일 때만, 같은 번호일 때만', () => {
    const dictating: VoiceState = { phase: 'recording', run: 1, sessionId: 'a' }
    expect(voiceReducer(dictating, { type: 'countdown', run: 1, until: 1 })).toBe(dictating)
    expect(voiceReducer(listening, { type: 'countdown', run: 2, until: 1 })).toBe(listening)
    const sending: VoiceState = { phase: 'transcribing', run: 1, sessionId: 'a', chat: true }
    expect(voiceReducer(sending, { type: 'countdown', run: 1, until: 1 })).toBe(sending)
  })

  it('답 대기(wait)는 대화 모드로 보내는 중일 때만 — 받아쓰기의 정지는 대기로 가지 않는다', () => {
    const transcribing: VoiceState = { phase: 'transcribing', run: 1, sessionId: 'a' }
    expect(voiceReducer(transcribing, { type: 'wait', run: 1 })).toBe(transcribing)
    expect(voiceReducer({ ...transcribing, chat: true }, { type: 'wait', run: 2 })).toEqual({ ...transcribing, chat: true })
  })

  it('답 대기에서 다시 듣기는 대화 모드 시작으로만 — 받아쓰기(마이크 버튼)로는 시작하지 않는다', () => {
    const waiting: VoiceState = { phase: 'waiting', run: 1, sessionId: 'a', chat: true }
    expect(voiceReducer(waiting, { type: 'start', run: 2, sessionId: 'a' })).toBe(waiting)
    expect(voiceReducer(listening, { type: 'start', run: 2, sessionId: 'a', chat: true })).toBe(listening) // 듣는 중엔 다시 시작하지 않는다
  })

  it('멈춤(end) — 어느 단계에서든 대화 모드를 끄고 사유를 남긴다. 대기면 사유만', () => {
    const notice = { tone: 'error', key: 'voice.chat.stop.attention' } as const
    for (const phase of ['requesting', 'recording', 'transcribing', 'waiting'] as const) {
      expect(voiceReducer({ ...listening, phase }, { type: 'end', notice })).toEqual({ phase: 'idle', run: 1, notice })
    }
    expect(voiceReducer(VOICE_IDLE, { type: 'end', notice })).toEqual({ phase: 'idle', run: 0, notice })
    expect(voiceReducer(VOICE_IDLE, { type: 'end' })).toBe(VOICE_IDLE)
    expect(voiceReducer({ ...listening, phase: 'waiting' }, { type: 'end' })).toEqual({ phase: 'idle', run: 1 })
  })

  it('보내지 않고 입력창에 넣고 끝나면(done·failed·cancel) 대화 모드도 꺼진다', () => {
    const sending: VoiceState = { phase: 'transcribing', run: 1, sessionId: 'a', chat: true }
    expect(voiceReducer(sending, { type: 'done', run: 1 })).toEqual({ phase: 'idle', run: 1 })
    expect(voiceReducer(listening, { type: 'cancel' })).toEqual({ phase: 'idle', run: 1 })
  })

  it('닫기(dismiss)는 사유만 지우고 대화 모드·카운트다운은 그대로', () => {
    const state: VoiceState = { ...listening, countdown: 10, notice: { tone: 'info', key: 'voice.empty' } }
    expect(voiceReducer(state, { type: 'dismiss' })).toEqual({ ...listening, countdown: 10 })
  })

  it('답 대기는 마이크를 쥐지 않는다 — Esc 는 답변 중지("Esc 두 번")의 것이다', () => {
    expect(voiceBusy({ phase: 'waiting', run: 1, sessionId: 'a', chat: true })).toBe(false)
    expect(voiceBusy(listening)).toBe(true)
  })
})

describe('말 끝 판정 (엔진의 speaking·silentMs)', () => {
  it('무음 1.2초 = VAD 꺼짐(0.5초) + 카운트다운 0.7초', () => {
    expect(VAD_OFF_MS + VOICE_CHAT_COUNTDOWN_MS).toBe(VOICE_CHAT_SILENCE_MS)
    expect(VOICE_CHAT_SILENCE_MS).toBe(1200)
    expect(VOICE_CHAT_COUNTDOWN_MS).toBe(700)
  })

  it('VAD 가 꺼졌고 받아쓴 글이 있으면 남은 카운트다운 — 이미 지난 무음만큼 짧다', () => {
    expect(countdownLeft({ final: '안녕', tentative: '', speaking: false, silentMs: 0 })).toBe(700)
    expect(countdownLeft({ final: '안녕', tentative: '', speaking: false, silentMs: 500 })).toBe(200)
    expect(countdownLeft({ final: '안녕', tentative: '', speaking: false, silentMs: 3000 })).toBe(0)
  })

  it('말하는 중 · 받아쓴 글 없음(숨소리·잡음) · 임시 글이 남아 있으면 말 끝이 아니다', () => {
    expect(countdownLeft({ final: '안녕', tentative: '', speaking: true, silentMs: 0 })).toBeUndefined()
    expect(countdownLeft({ final: '  ', tentative: '', speaking: false, silentMs: 5000 })).toBeUndefined()
    expect(countdownLeft({ final: '안녕', tentative: '하세', speaking: false, silentMs: 900 })).toBeUndefined()
  })

  it('120초 상한 전에 받아쓰기를 닫고 다시 연다 — 상한보다 앞, 카운트다운이 끝날 여유를 둔다', () => {
    expect(VOICE_CHAT_REOPEN_MS).toBeLessThan(SPEECH_MAX_SECONDS * 1000 - VOICE_CHAT_COUNTDOWN_MS)
    expect(VOICE_CHAT_REOPEN_MS).toBeGreaterThan(60_000)
  })
})

describe('자동 보내기 금지 표 (voiceChatBlock)', () => {
  const ready: VoiceChatTarget = { draft: '', attachments: 0, model: true, writable: true, busy: false, attention: false }

  it('보낼 수 있으면 사유가 없다', () => {
    expect(voiceChatBlock(ready)).toBeUndefined()
    expect(voiceChatBlock(ready, '로그인 버튼 고쳐 줘')).toBeUndefined()
  })

  it('사유마다 문구 — 조용히 돌아가지 않는다', () => {
    expect(voiceChatBlock({ ...ready, attention: true, busy: true })).toBe('voice.chat.stop.attention')
    expect(voiceChatBlock({ ...ready, busy: true })).toBe('voice.chat.stop.busy')
    expect(voiceChatBlock({ ...ready, draft: '쓰던 글' })).toBe('voice.chat.stop.draft')
    expect(voiceChatBlock({ ...ready, draft: '@src/' })).toBe('voice.chat.stop.draft') // 트리거(@ / !)를 치는 중
    expect(voiceChatBlock({ ...ready, attachments: 1 })).toBe('voice.chat.stop.draft')
    expect(voiceChatBlock({ ...ready, model: false })).toBe('voice.chat.stop.noModel')
    expect(voiceChatBlock({ ...ready, writable: false })).toBe('voice.chat.stop.cannotWrite')
  })

  it('공백뿐인 초안은 빈 것으로 본다', () => {
    expect(voiceChatBlock({ ...ready, draft: ' \n ' })).toBeUndefined()
  })

  it('받아쓴 글이 / 나 ! 로 시작하면 보내지 않는다 — 명령·셸이 말로 실행되지 않게', () => {
    expect(voiceChatBlock(ready, '/clear')).toBe('voice.chat.stop.trigger')
    expect(voiceChatBlock(ready, ' !rm -rf build')).toBe('voice.chat.stop.trigger')
    expect(voiceChatBlock(ready, '느낌표! 는 괜찮다')).toBeUndefined()
  })
})

describe('턴 결과와 답 대기', () => {
  it('실패·중지면 멈춘다 — 다시 들으면 같은 글이 또 막히거나 사용자가 멈춘 것을 되돌린다', () => {
    expect(turnStopReason('failed')).toBe('voice.chat.stop.failed')
    expect(turnStopReason('interrupted')).toBe('voice.chat.stop.interrupted')
    expect(turnStopReason('done')).toBeUndefined()
  })

  const waiting: VoiceState = { phase: 'waiting', run: 1, sessionId: 'a', chat: true }
  const quiet = { busy: false, attention: false }

  it('답 대기 — 턴이 시작된 걸 본 뒤, 도는 턴·대기열이 없으면 다시 듣는다 (유지 시간은 훅이 잰다)', () => {
    expect(VOICE_CHAT_SETTLE_MS).toBe(300)
    expect(voiceChatWatch(waiting, quiet, true)).toEqual({ type: 'relisten' })
    expect(voiceChatWatch(waiting, quiet, false)).toBeUndefined() // 보낸 턴이 아직 시작 전 — 곧바로 다시 듣지 않는다
    expect(voiceChatWatch(waiting, { busy: true, attention: false }, true)).toBeUndefined() // 훅의 다음 턴·대기열
  })

  it('승인·질문 카드가 뜨면 멈춘다 — 손으로 고르게', () => {
    expect(voiceChatWatch(waiting, { busy: true, attention: true }, true)).toEqual({ type: 'end', key: 'voice.chat.stop.attention' })
  })

  it('듣는 중에 그 대화에 턴이 시작되면(다른 곳에서 보냄) 멈춘다 — 받아쓴 글은 훅이 입력창에 넣는다', () => {
    expect(voiceChatWatch(listening, { busy: true, attention: false }, false)).toEqual({ type: 'end', key: 'voice.chat.stop.busy' })
    expect(voiceChatWatch({ ...listening, phase: 'requesting' }, { busy: true, attention: false }, false)).toEqual({ type: 'end', key: 'voice.chat.stop.busy' })
    expect(voiceChatWatch(listening, quiet, false)).toBeUndefined()
  })

  it('보내는 중·대화 모드가 아니면 아무 일도 없다', () => {
    expect(voiceChatWatch({ ...listening, phase: 'transcribing' }, { busy: true, attention: true }, true)).toBeUndefined()
    expect(voiceChatWatch({ phase: 'recording', run: 1, sessionId: 'a' }, { busy: true, attention: true }, true)).toBeUndefined()
    expect(voiceChatWatch(VOICE_IDLE, quiet, true)).toBeUndefined()
  })
})

describe('대화 버튼·대화 모드 띠의 그림 (정적 렌더)', () => {
  const voice = (state: VoiceState, on = true): VoiceInput => ({
    on,
    state,
    since: undefined,
    toggle() {},
    cancel() {},
    dismiss() {},
    level: () => 0,
    toggleChat() {},
    hold() {},
  })
  const button = (state: VoiceState, on = true) => renderToStaticMarkup(createElement(VoiceChatButton, { voice: voice(state, on) }))
  const mic = (state: VoiceState) => renderToStaticMarkup(createElement(VoiceButton, { voice: voice(state) }))
  const strip = (state: VoiceState) => renderToStaticMarkup(createElement(VoiceStrip, { voice: voice(state) }))

  it('대화 버튼은 기능이 켜져 있을 때만 — 대기면 눌리지 않은 모양', () => {
    expect(button(VOICE_IDLE, false)).toBe('')
    const html = button(VOICE_IDLE)
    expect(html).toContain('class="composer__talk"')
    expect(html).toContain('aria-pressed="false"')
    expect(html).toContain(`aria-label="${ko['voice.chat.start']}"`)
    expect(html).toContain(ko['voice.chat.label'])
  })

  it('대화 모드 중 — 대화 버튼은 눌린 모양(끝내기), 받아쓰기 마이크는 못 누른다', () => {
    for (const phase of ['requesting', 'recording', 'transcribing', 'waiting'] as const) {
      const state = { ...listening, phase }
      expect(button(state)).toContain('aria-pressed="true"')
      expect(button(state)).toContain(`aria-label="${ko['voice.chat.end']}"`)
      expect(mic(state)).toContain('disabled=""')
    }
  })

  it('받아쓰기 중엔 대화 버튼을 못 누른다', () => {
    expect(button({ phase: 'recording', run: 1, sessionId: 'a' })).toContain('disabled=""')
  })

  it('듣는 중 — 상태 글 · 음량 · 끝내기. 경과·정지는 없다 (상한 전에 스스로 다시 연다)', () => {
    const band = strip(listening)
    expect(band).toContain('data-voice-chat="listening"')
    expect(band).toContain(ko['voice.chat.listening'])
    expect(band).toContain('voice-strip__meter')
    expect(band).toContain('data-voice-action="end-chat"')
    expect(band).not.toContain('role="timer"')
    expect(band).not.toContain('data-voice-action="stop"')
  })

  it('카운트다운 — 차오르는 띠와 [취소] (보내지 않고 입력창에 남긴다)', () => {
    const band = strip({ ...listening, countdown: 1234 })
    expect(band).toContain('data-voice-chat="countdown"')
    expect(band).toContain(ko['voice.chat.countdown'])
    expect(band).toContain('class="voice-strip__countdown"')
    expect(band).toContain('data-voice-action="hold"')
    expect(band).toContain(`title="${ko['voice.chat.holdTitle']}"`)
    expect(band).toContain(`>${ko['voice.chat.hold']}<`)
  })

  it('보내는 중 · 답 대기 — 상태 글과 끝내기', () => {
    const sending = strip({ ...listening, phase: 'transcribing' })
    expect(sending).toContain('data-voice-chat="sending"')
    expect(sending).toContain(ko['voice.chat.sending'])
    const waiting = strip({ ...listening, phase: 'waiting' })
    expect(waiting).toContain('data-voice-chat="waiting"')
    expect(waiting).toContain(ko['voice.chat.waiting'])
    expect(waiting).toContain('data-voice-action="end-chat"')
    expect(waiting).not.toContain('voice-strip__meter') // 답을 기다리는 동안 마이크는 닫혀 있다
  })

  it('멈춘 사유는 대화 모드가 꺼진 뒤 한 줄로 남는다', () => {
    const band = strip({ phase: 'idle', run: 1, notice: { tone: 'error', key: 'voice.chat.stop.draft' } })
    expect(band).toContain(ko['voice.chat.stop.draft'])
    expect(band).toContain('data-voice-action="dismiss"')
  })

  it('문구는 두 언어에 다 있다', () => {
    const keys = Object.keys(ko).filter((key) => key.startsWith('voice.chat.'))
    expect(keys.length).toBeGreaterThan(15)
    for (const key of keys) expect(en[key as keyof typeof en], key).toBeTruthy()
  })
})
