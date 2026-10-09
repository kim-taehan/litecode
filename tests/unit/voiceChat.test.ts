import { createElement, isValidElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { translate } from '../../shared/i18n/index.ts'
import { en } from '../../shared/i18n/en.ts'
import { ko } from '../../shared/i18n/ko.ts'
import { SPEECH_MAX_SECONDS } from '../../shared/speech.ts'
import { VoiceButton, VoiceStrip, type VoiceInput } from '../../renderer/VoiceInput.tsx'
import {
  countdownLeft,
  restreamDelay,
  turnStopReason,
  RESTREAM_DEFER_MS,
  RESTREAM_MIN_LEVEL,
  VAD_OFF_MS,
  VOICE_CHAT_COUNTDOWN_MS,
  VOICE_CHAT_REOPEN_MS,
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

// 음성 대화 모드 1단계 (이슈 #238) — 말을 멈추면 카운트다운 뒤 저절로 보낸다. 읽어 주기·끼어들기는 없다.
// 계속 듣기 (#240) — 답이 오는 동안에도 마이크를 닫지 않고, 그때 한 말은 메인의 대기열에 쌓인다 (순서는 chat.test.ts 의 "음성 대화" 시험).
// 여기서 고정하는 것: 상태 기계(듣기 → 카운트다운 → 보내는 중 → 다시 듣기) / 말 끝 판정(엔진의 speaking·silentMs) /
// 자동 보내기 금지 표 / 턴 결과에 따른 멈춤 / 턴 상태에 따른 멈춤 / 버튼·띠의 그림.
// 버튼 하나 (#244) — 받아쓰기(끝내기를 눌러야 입력창에 들어가는 방식)와 'Talk' 버튼을 없애고 마이크 아이콘 버튼 하나가 음성 대화를 켜고 끈다.
// 마이크·타이머·IPC 를 쥔 훅(useVoiceInput)은 단위로 못 잡는다 — 마이크를 열지 않는다.

vi.mock('../../renderer/settingsStore.ts', () => ({ useT: () => (key: Parameters<typeof translate>[1], vars?: Record<string, string | number>) => translate('ko', key, vars) }))

const run = (events: VoiceEvent[], from: VoiceState = VOICE_IDLE): VoiceState => events.reduce(voiceReducer, from)
const listening: VoiceState = { phase: 'recording', run: 1, sessionId: 'a', chat: true }

describe('대화 모드 상태 기계', () => {
  it('듣기 → 카운트다운 → 보내는 중 → 다시 듣기 — 대화 모드 표시(chat)를 끝까지 쥔다. 마이크를 닫는 답 대기 단계는 없다 (#240)', () => {
    let state = voiceReducer(VOICE_IDLE, { type: 'start', run: 1, sessionId: 'a' })
    expect(state).toEqual({ phase: 'requesting', run: 1, sessionId: 'a', chat: true })
    state = voiceReducer(state, { type: 'granted', run: 1 })
    expect(state).toEqual(listening)
    state = voiceReducer(state, { type: 'countdown', run: 1, until: 5000 })
    expect(state.countdown).toBe(5000)
    state = voiceReducer(state, { type: 'stop', run: 1 })
    expect(state).toEqual({ phase: 'transcribing', run: 1, sessionId: 'a', chat: true }) // 카운트다운은 지운다
    state = voiceReducer(state, { type: 'listen', run: 1 })
    expect(state).toEqual(listening) // 같은 녹음(번호)으로 곧장 다시 듣는다 — 마이크를 다시 열지 않는다
  })

  it('다시 듣기는 보낸 글을 띠에서 지운다 (다음 말은 새 글로)', () => {
    const sending: VoiceState = { phase: 'transcribing', run: 1, sessionId: 'a', chat: true, live: { final: '보낸 말', tentative: '' } }
    expect(voiceReducer(sending, { type: 'listen', run: 1 })).toEqual(listening)
  })

  it('카운트다운 중에 다시 말하면(resume) 카운트다운만 지우고 그대로 듣는다 — 받아쓴 글은 남는다', () => {
    const counting = run([{ type: 'partial', run: 1, live: { final: '하나', tentative: '' } }, { type: 'countdown', run: 1, until: 900 }], listening)
    const resumed = voiceReducer(counting, { type: 'resume', run: 1 })
    expect(resumed).toEqual({ ...listening, live: { final: '하나', tentative: '' } })
    expect(voiceReducer(resumed, { type: 'resume', run: 1 })).toBe(resumed) // 카운트다운이 없으면 그대로
  })

  it('카운트다운은 듣는 중일 때만, 같은 번호일 때만', () => {
    expect(voiceReducer(listening, { type: 'countdown', run: 2, until: 1 })).toBe(listening)
    const sending: VoiceState = { phase: 'transcribing', run: 1, sessionId: 'a', chat: true }
    expect(voiceReducer(sending, { type: 'countdown', run: 1, until: 1 })).toBe(sending)
  })

  it('다시 듣기(listen)는 보내는 중일 때만, 같은 번호일 때만', () => {
    const sending: VoiceState = { phase: 'transcribing', run: 1, sessionId: 'a', chat: true }
    expect(voiceReducer(sending, { type: 'listen', run: 2 })).toBe(sending)
    expect(voiceReducer(listening, { type: 'listen', run: 1 })).toBe(listening)
  })

  it('듣는 중·보내는 중엔 다시 시작하지 않는다', () => {
    expect(voiceReducer(listening, { type: 'start', run: 2, sessionId: 'a' })).toBe(listening)
    const sending: VoiceState = { ...listening, phase: 'transcribing' }
    expect(voiceReducer(sending, { type: 'start', run: 2, sessionId: 'a' })).toBe(sending)
  })

  it('멈춤(end) — 어느 단계에서든 대화 모드를 끄고 사유를 남긴다. 대기면 사유만', () => {
    const notice = { tone: 'error', key: 'voice.chat.stop.attention' } as const
    for (const phase of ['requesting', 'recording', 'transcribing'] as const) {
      expect(voiceReducer({ ...listening, phase }, { type: 'end', notice })).toEqual({ phase: 'idle', run: 1, notice })
    }
    expect(voiceReducer(VOICE_IDLE, { type: 'end', notice })).toEqual({ phase: 'idle', run: 0, notice })
    expect(voiceReducer(VOICE_IDLE, { type: 'end' })).toBe(VOICE_IDLE)
    expect(voiceReducer({ ...listening, phase: 'transcribing' }, { type: 'end' })).toEqual({ phase: 'idle', run: 1 })
  })

  it('보내지 않고 입력창에 넣고 끝나면(done·failed·cancel) 대화 모드도 꺼진다', () => {
    const sending: VoiceState = { phase: 'transcribing', run: 1, sessionId: 'a', chat: true }
    expect(voiceReducer(sending, { type: 'done', run: 1 })).toEqual({ phase: 'idle', run: 1 })
    expect(voiceReducer(listening, { type: 'cancel' })).toEqual({ phase: 'idle', run: 1 })
  })

  it('닫기(dismiss)는 사유만 지우고 대화 모드·카운트다운은 그대로', () => {
    const state: VoiceState = { ...listening, countdown: 10, notice: { tone: 'info', key: 'voice.elsewhere' } }
    expect(voiceReducer(state, { type: 'dismiss' })).toEqual({ ...listening, countdown: 10 })
  })

  it('대화 모드는 어느 단계든 마이크를 쥔다 — Esc 는 음성 대화 끄기다 (답이 오는 중에도, #240)', () => {
    for (const phase of ['requesting', 'recording', 'transcribing'] as const) expect(voiceBusy({ ...listening, phase })).toBe(true)
    expect(voiceBusy(VOICE_IDLE)).toBe(false)
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
    // 재개 열 때 말소리가 들리면 미루는 2초를 써도 상한을 넘지 않는다
    expect(VOICE_CHAT_REOPEN_MS + RESTREAM_DEFER_MS).toBeLessThan(SPEECH_MAX_SECONDS * 1000)
  })

  it('재개 열 때 지금 소리가 있으면 2초 미룬다 — 엔진의 "소리 없음"은 0.9초 전의 것이라 (실측 2026-10-08)', () => {
    expect(restreamDelay(0.1)).toBe(true) // 보통 말소리 (바 절반)
    expect(restreamDelay(RESTREAM_MIN_LEVEL)).toBe(true) // 경계는 미루는 쪽
    expect(restreamDelay(RESTREAM_MIN_LEVEL / 2)).toBe(false) // 배경은 안 미룬다
  })
})

describe('자동 보내기 금지 표 (voiceChatBlock)', () => {
  const ready: VoiceChatTarget = { draft: '', attachments: 0, model: true, writable: true, attention: false }

  it('보낼 수 있으면 사유가 없다', () => {
    expect(voiceChatBlock(ready)).toBeUndefined()
    expect(voiceChatBlock(ready, '로그인 버튼 고쳐 줘')).toBeUndefined()
  })

  it('사유마다 문구 — 조용히 돌아가지 않는다', () => {
    expect(voiceChatBlock({ ...ready, attention: true, draft: '쓰던 글' })).toBe('voice.chat.stop.attention')
    expect(voiceChatBlock({ ...ready, draft: '쓰던 글' })).toBe('voice.chat.stop.draft')
    expect(voiceChatBlock({ ...ready, draft: '@src/' })).toBe('voice.chat.stop.draft') // 트리거(@ / !)를 치는 중
    expect(voiceChatBlock({ ...ready, attachments: 1 })).toBe('voice.chat.stop.draft')
    expect(voiceChatBlock({ ...ready, model: false })).toBe('voice.chat.stop.noModel')
    expect(voiceChatBlock({ ...ready, writable: false })).toBe('voice.chat.stop.cannotWrite')
  })

  it('그 대화에 도는 턴은 막는 사유가 아니다 — 보내면 메인이 대기열에 쌓는다 (#240)', () => {
    expect(voiceChatBlock({ ...ready, busy: true } as VoiceChatTarget, '이어서 이것도 해 줘')).toBeUndefined()
    expect(ko).not.toHaveProperty('voice.chat.stop.busy')
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

describe('턴 결과와 턴 상태', () => {
  it('실패·중지면 멈춘다 — 계속 들으면 같은 글이 또 막히거나 사용자가 멈춘 것을 되돌린다', () => {
    expect(turnStopReason('failed')).toBe('voice.chat.stop.failed')
    expect(turnStopReason('interrupted')).toBe('voice.chat.stop.interrupted')
    expect(turnStopReason('done')).toBeUndefined()
  })

  const quiet = { busy: false, attention: false }

  it('도는 턴·대기열이 있어도 멈추지 않는다 — 듣는 중·마이크를 여는 중·보내는 중 모두 (#240)', () => {
    for (const phase of ['requesting', 'recording', 'transcribing'] as const) {
      expect(voiceChatWatch({ ...listening, phase }, { busy: true, attention: false })).toBeUndefined()
    }
    expect(voiceChatWatch(listening, quiet)).toBeUndefined()
  })

  it('승인·질문 카드가 뜨면 어느 단계든 멈춘다 — 카드 중에 한 말이 답으로 쓰이지 않게', () => {
    for (const phase of ['requesting', 'recording', 'transcribing'] as const) {
      expect(voiceChatWatch({ ...listening, phase }, { busy: true, attention: true })).toBe('voice.chat.stop.attention')
    }
  })

  it('음성 대화가 꺼져 있으면 아무 일도 없다', () => {
    expect(voiceChatWatch(VOICE_IDLE, { busy: true, attention: true })).toBeUndefined()
  })
})

const voice = (state: VoiceState, on = true, answering = false): VoiceInput => ({
  on,
  state,
  dismiss() {},
  level: () => 0,
  answering,
  toggleChat() {},
  hold() {},
})
const mic = (state: VoiceState, on = true) => renderToStaticMarkup(createElement(VoiceButton, { voice: voice(state, on) }))
const strip = (state: VoiceState, answering = false) => renderToStaticMarkup(createElement(VoiceStrip, { voice: voice(state, true, answering) }))

/** 그려진 요소 나무에서 data-voice-action 이 있는 버튼의 onClick 을 모은다 (함수 컴포넌트는 직접 불러 펼친다 — useT 는 위에서 바꿔 둔 보통 함수다) */
function stripActions(input: VoiceInput): Record<string, unknown> {
  const actions: Record<string, unknown> = {}
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(walk)
    if (!isValidElement(node)) return
    const props = node.props as Record<string, unknown>
    if (typeof node.type === 'function' && node.type.name === 'VoiceChatStrip') return walk((node.type as (p: unknown) => unknown)(props))
    if (typeof props['data-voice-action'] === 'string') actions[props['data-voice-action']] = props.onClick
    walk(props.children)
  }
  walk(VoiceStrip({ voice: input }))
  return actions
}

describe('음성 버튼 하나 (#244, 시안 MgE8jmZ4f1XM578AUgQxp6 안 2) — 마이크 아이콘만, 누르면 음성 대화', () => {
  it('기능이 꺼져 있으면 버튼이 없다', () => {
    expect(mic(VOICE_IDLE, false)).toBe('')
  })

  it('버튼은 하나, 글자 없이 아이콘만 — 꺼짐은 접근 이름 "음성", 눌리지 않은 모양', () => {
    const html = mic(VOICE_IDLE)
    expect(html.match(/<button/g)).toHaveLength(1)
    expect(html).toContain('class="composer__voice"')
    expect(html).toContain('aria-pressed="false"')
    expect(html).toContain('aria-label="음성"')
    expect(html).not.toContain('<span')
    expect(html).not.toContain('disabled')
  })

  it('켜짐 — 마이크를 여는 중·듣는 중·보내는 중 모두 접근 이름 "음성 켜짐", 눌린 모양, 누를 수 있다', () => {
    for (const phase of ['requesting', 'recording', 'transcribing'] as const) {
      const html = mic({ ...listening, phase })
      expect(html).toContain('aria-pressed="true"')
      expect(html).toContain('aria-label="음성 켜짐"')
      expect(html).not.toContain('disabled')
    }
  })

  it('누르면 음성 대화를 켜고 끈다 — 끌 때는 들은 글을 입력창에 남기는 길(toggleChat)이다, 버리는 취소가 아니다', () => {
    for (const state of [VOICE_IDLE, listening, { ...listening, phase: 'transcribing' as const }]) {
      const input = voice(state)
      const button = VoiceButton({ voice: input })
      expect(isValidElement(button) && (button.props as { onClick: unknown }).onClick).toBe(input.toggleChat)
    }
  })

  it('띠의 끝내기·[취소]도 들은 글을 입력창에 남기고 끄는 길이다', () => {
    const listeningInput = voice(listening)
    expect(stripActions(listeningInput)['end-chat']).toBe(listeningInput.toggleChat)
    const counting = voice({ ...listening, countdown: 1234 })
    expect(stripActions(counting)).toEqual({ 'end-chat': counting.toggleChat, hold: counting.hold })
    expect(ko['voice.chat.end'].startsWith('끝내기')).toBe(true)
    expect(ko['voice.chat.end']).not.toContain('대화 끝내기')
  })

  it('옛 받아쓰기 경로가 없다 — 대화 버튼·받아쓰기 정지가 사라졌고, 녹음은 늘 음성 대화로 시작한다', async () => {
    const module = await import('../../renderer/VoiceInput.tsx')
    expect(Object.keys(module).sort()).toEqual(['VoiceButton', 'VoiceStrip', 'useVoiceInput'])
    expect(voiceReducer(VOICE_IDLE, { type: 'start', run: 1, sessionId: 'a' })).toEqual({ phase: 'requesting', run: 1, sessionId: 'a', chat: true })
    for (const phase of ['requesting', 'recording', 'transcribing'] as const) {
      const band = strip({ ...listening, phase })
      expect(band).not.toContain('data-voice-action="stop"')
      expect(band).not.toContain('data-voice-action="cancel"')
      expect(band).not.toContain('role="timer"')
    }
    for (const key of ['voice.start', 'voice.stop', 'voice.cancel', 'voice.recording', 'voice.transcribing', 'voice.empty', 'voice.chat.label']) {
      expect(ko, key).not.toHaveProperty(key)
      expect(en, key).not.toHaveProperty(key)
    }
  })

  it('설정 > 기능의 설명은 음성 대화를 말한다 — Talk·대화 버튼이 없다', () => {
    for (const dict of [ko, en] as const) {
      for (const key of ['feature.voice.description', 'feature.voice.detail', 'feature.voice.where'] as const) {
        expect(dict[key], key).not.toMatch(/Talk button|'대화' 버튼|대화 버튼/)
      }
    }
    expect(ko['feature.voice.where']).toBe('입력 카드의 마이크 버튼')
    expect(ko['feature.voice.detail']).toContain('말을 멈추면')
  })
})

describe('음성 대화 띠의 그림 (정적 렌더)', () => {
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

  it('보내는 중 — 상태 글과 끝내기', () => {
    const sending = strip({ ...listening, phase: 'transcribing' })
    expect(sending).toContain('data-voice-chat="sending"')
    expect(sending).toContain(ko['voice.chat.sending'])
    expect(sending).toContain('data-voice-action="end-chat"')
  })

  it('답이 오는 중에도 듣는 중 띠 — 음량이 살아 있고, 작은 "답변 중" 표시와 "대기열에 넣음" 안내 (#240)', () => {
    const band = strip(listening, true)
    expect(band).toContain('data-voice-chat="listening"')
    expect(band).toContain('data-voice-answering="true"')
    expect(band).toContain('voice-strip__meter')
    expect(band).toContain(`class="voice-strip__answering">${ko['voice.chat.answering']}<`)
    expect(band).toContain(ko['voice.chat.listeningQueued'])
    expect(band).not.toContain(ko['voice.chat.listening'] + '<')
    const counting = strip({ ...listening, countdown: 1234 }, true)
    expect(counting).toContain(ko['voice.chat.countdownQueued'])
    expect(counting).toContain('data-voice-action="hold"') // [취소] 는 그대로 — 대기열에도 넣지 않고 입력창에
  })

  it('답이 없으면 "답변 중" 표시가 없다', () => {
    const band = strip(listening)
    expect(band).not.toContain('voice-strip__answering')
    expect(band).not.toContain('data-voice-answering')
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
