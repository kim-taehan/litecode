import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { translate } from '../../shared/i18n/index.ts'
import { VoiceButton, VoiceStrip, type VoiceInput } from '../../renderer/VoiceInput.tsx'
import { en } from '../../shared/i18n/en.ts'
import { ko } from '../../shared/i18n/ko.ts'
import { SPEECH_MAX_SAMPLES, SPEECH_SAMPLE_RATE, type SpeechErrorCode } from '../../shared/speech.ts'
import { changeDraft, draftOf, type Drafts } from '../../renderer/drafts.ts'
import {
  barLevel,
  captureFailure,
  elapsedLabel,
  insertTranscript,
  notReady,
  pushLevel,
  RECORDING_FAILED,
  replyFailure,
  resampledLength,
  rms,
  toPcm16,
  VOICE_IDLE,
  voiceBusy,
  voiceReducer,
  type VoiceEvent,
  type VoiceNotice,
  type VoiceState,
} from '../../renderer/voiceView.ts'

// 음성 입력 화면 (이슈 #109 2단계)의 순수 규칙. 마이크·오디오 API(voiceRecorder.ts)와 그림(VoiceInput.tsx)은 단위로 못 잡는다 —
// 여기서 고정하는 것: 녹음 상태 기계(취소된 녹음의 늦은 사건을 버린다) / PCM 변환과 길이 상한 / 받아쓴 글을 넣는 자리 / 실패 문구 / 경과 초

// 화면 설정 저장소는 메인에서 값을 받아야 해서 여기선 한국어 사전으로 바로 번역한다
vi.mock('../../renderer/settingsStore.ts', () => ({ useT: () => (key: Parameters<typeof translate>[1], vars?: Record<string, string | number>) => translate('ko', key, vars) }))

const run = (events: VoiceEvent[], from: VoiceState = VOICE_IDLE): VoiceState => events.reduce(voiceReducer, from)
const EMPTY: VoiceNotice = { tone: 'info', key: 'voice.empty' }
const FAILED: VoiceNotice = { tone: 'error', key: 'voice.error.failed' }

describe('녹음 상태 기계', () => {
  it('대기 → 권한 요청 → 녹음 중 → 받아쓰는 중 → 대기', () => {
    let state = voiceReducer(VOICE_IDLE, { type: 'start', run: 1, sessionId: 'a' })
    expect(state).toEqual({ phase: 'requesting', run: 1, sessionId: 'a' })
    state = voiceReducer(state, { type: 'granted', run: 1 })
    expect(state.phase).toBe('recording')
    state = voiceReducer(state, { type: 'stop', run: 1 })
    expect(state).toEqual({ phase: 'transcribing', run: 1, sessionId: 'a' })
    state = voiceReducer(state, { type: 'done', run: 1 })
    expect(state).toEqual({ phase: 'idle', run: 1 })
    expect(voiceBusy(state)).toBe(false)
  })

  it('녹음을 시작한 대화를 끝까지 쥔다 — 대화를 바꿔도 결과는 그 대화의 것이다', () => {
    const state = run([{ type: 'start', run: 1, sessionId: 'a' }, { type: 'granted', run: 1 }, { type: 'stop', run: 1 }])
    expect(state.sessionId).toBe('a')
  })

  it('도는 중에 다시 시작하지 않는다 (버튼은 정지로 쓰인다)', () => {
    const recording = run([{ type: 'start', run: 1, sessionId: 'a' }, { type: 'granted', run: 1 }])
    expect(voiceReducer(recording, { type: 'start', run: 2, sessionId: 'b' })).toBe(recording)
  })

  it('정지는 녹음 중일 때만 — 권한을 기다리는 중·받아쓰는 중엔 아무 일도 없다', () => {
    const requesting = run([{ type: 'start', run: 1, sessionId: 'a' }])
    expect(voiceReducer(requesting, { type: 'stop', run: 1 })).toBe(requesting)
    const transcribing = run([{ type: 'granted', run: 1 }, { type: 'stop', run: 1 }], requesting)
    expect(voiceReducer(transcribing, { type: 'stop', run: 1 })).toBe(transcribing)
  })

  it('취소는 어느 단계에서든 대기로 돌리고, 그 녹음의 늦은 사건은 버린다', () => {
    for (const before of [[], [{ type: 'granted', run: 1 }], [{ type: 'granted', run: 1 }, { type: 'stop', run: 1 }]] as VoiceEvent[][]) {
      const cancelled = run([{ type: 'start', run: 1, sessionId: 'a' }, ...before, { type: 'cancel' }])
      expect(cancelled).toEqual({ phase: 'idle', run: 1 })
      // 권한 창이 뒤늦게 승인됐다 / 인식 결과가 뒤늦게 왔다 / 뒤늦게 실패했다
      expect(run([{ type: 'granted', run: 1 }, { type: 'stop', run: 1 }, { type: 'done', run: 1, notice: EMPTY }, { type: 'failed', run: 1, notice: FAILED }], cancelled)).toBe(cancelled)
    }
  })

  it('취소한 뒤 새로 시작한 녹음은 앞 녹음의 사건에 흔들리지 않는다', () => {
    const second = run([{ type: 'start', run: 1, sessionId: 'a' }, { type: 'cancel' }, { type: 'start', run: 2, sessionId: 'a' }])
    expect(second.phase).toBe('requesting')
    expect(voiceReducer(second, { type: 'granted', run: 1 })).toBe(second)
    expect(voiceReducer(second, { type: 'failed', run: 1, notice: FAILED })).toBe(second)
    expect(voiceReducer(second, { type: 'granted', run: 2 }).phase).toBe('recording')
  })

  it('같거나 작은 번호로는 시작하지 못한다', () => {
    const idle = run([{ type: 'start', run: 3, sessionId: 'a' }, { type: 'cancel' }])
    expect(voiceReducer(idle, { type: 'start', run: 3, sessionId: 'a' })).toBe(idle)
  })

  it('실패는 대기로 돌리고 사유를 남긴다 — 마이크를 못 열었을 때·녹음 중·받아쓰는 중 모두', () => {
    const requesting = run([{ type: 'start', run: 1, sessionId: 'a' }])
    for (const state of [requesting, run([{ type: 'granted', run: 1 }], requesting), run([{ type: 'granted', run: 1 }, { type: 'stop', run: 1 }], requesting)]) {
      expect(voiceReducer(state, { type: 'failed', run: 1, notice: FAILED })).toEqual({ phase: 'idle', run: 1, notice: FAILED })
    }
  })

  it('말이 없었으면 끝나면서 한 줄을 남기고, 닫으면 사라진다', () => {
    const done = run([{ type: 'start', run: 1, sessionId: 'a' }, { type: 'granted', run: 1 }, { type: 'stop', run: 1 }, { type: 'done', run: 1, notice: EMPTY }])
    expect(done).toEqual({ phase: 'idle', run: 1, notice: EMPTY })
    expect(voiceReducer(done, { type: 'dismiss' })).toEqual({ phase: 'idle', run: 1 })
  })

  it('다시 녹음을 시작하면 남아 있던 줄은 지워진다', () => {
    const failed = run([{ type: 'start', run: 1, sessionId: 'a' }, { type: 'failed', run: 1, notice: FAILED }])
    expect(voiceReducer(failed, { type: 'start', run: 2, sessionId: 'a' })).toEqual({ phase: 'requesting', run: 2, sessionId: 'a' })
  })

  it('준비 안 됨 알림은 대기일 때만 — 녹음을 시작하지 않는다', () => {
    const notice: VoiceNotice = { tone: 'error', key: 'voice.error.unavailable' }
    expect(voiceReducer(VOICE_IDLE, { type: 'notify', notice })).toEqual({ phase: 'idle', run: 0, notice })
    const recording = run([{ type: 'start', run: 1, sessionId: 'a' }, { type: 'granted', run: 1 }])
    expect(voiceReducer(recording, { type: 'notify', notice })).toBe(recording)
  })

  it('아무 일도 없는 사건은 같은 상태를 돌려준다 (다시 그리지 않는다)', () => {
    expect(voiceReducer(VOICE_IDLE, { type: 'cancel' })).toBe(VOICE_IDLE)
    expect(voiceReducer(VOICE_IDLE, { type: 'dismiss' })).toBe(VOICE_IDLE)
    expect(voiceReducer(VOICE_IDLE, { type: 'done', run: 0 })).toBe(VOICE_IDLE)
  })
})

describe('PCM 변환', () => {
  it('재표본 길이는 16kHz 기준이고 120초에서 잘린다', () => {
    expect(resampledLength(4.86)).toBe(77_760) // 실측 01ag §2.3 — 4.9초 녹음이 77,760 샘플
    expect(resampledLength(120)).toBe(SPEECH_MAX_SAMPLES)
    expect(resampledLength(120.4)).toBe(SPEECH_MAX_SAMPLES) // 상한 타이머가 조금 늦게 멈춘 녹음
    expect(resampledLength(600)).toBe(SPEECH_MAX_SAMPLES)
  })

  it('빈 녹음·깨진 길이는 0', () => {
    for (const seconds of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) expect(resampledLength(seconds)).toBe(0)
    expect(resampledLength(0.00001)).toBe(0)
  })

  it('-1..1 을 PCM16 끝값까지 편다', () => {
    expect([...toPcm16(new Float32Array([0, 1, -1, 0.5, -0.5]))]).toEqual([0, 32767, -32768, 16384, -16384])
  })

  it('범위를 넘는 값은 자르고 NaN 은 0 으로 — 넘쳐서 부호가 뒤집히지 않는다', () => {
    expect([...toPcm16(new Float32Array([1.7, -3, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]))]).toEqual([32767, -32768, 0, 32767, -32768])
  })

  it('상한을 넘는 길이는 앞에서부터 상한까지만 (메인이 too-long 으로 거절하지 않게)', () => {
    const samples = new Float32Array(SPEECH_MAX_SAMPLES + SPEECH_SAMPLE_RATE)
    samples[0] = 1
    samples[SPEECH_MAX_SAMPLES] = 1
    const pcm = toPcm16(samples)
    expect(pcm).toBeInstanceOf(Int16Array)
    expect(pcm.length).toBe(SPEECH_MAX_SAMPLES)
    expect(pcm[0]).toBe(32767)
  })

  it('빈 입력은 빈 PCM', () => {
    expect(toPcm16(new Float32Array(0)).length).toBe(0)
  })
})

describe('음량 막대', () => {
  it('RMS — 무음은 0, 꽉 찬 사각파는 1', () => {
    expect(rms(new Float32Array(256))).toBe(0)
    expect(rms(new Float32Array(256).fill(-1))).toBe(1)
    expect(rms(new Float32Array([0.5, -0.5]))).toBeCloseTo(0.5)
    expect(rms([])).toBe(0)
  })

  it('막대 높이는 0..1 로 눌린다', () => {
    expect(barLevel(0)).toBe(0)
    expect(barLevel(0.1)).toBeCloseTo(0.5)
    expect(barLevel(0.9)).toBe(1)
    expect(barLevel(-1)).toBe(0)
  })

  it('새 값은 오른쪽 끝에 들어오고 길이는 그대로다', () => {
    expect(pushLevel([0, 0.2, 0.4], 0.9)).toEqual([0.2, 0.4, 0.9])
  })
})

describe('경과 초', () => {
  it('분:초', () => {
    expect(elapsedLabel(0)).toBe('0:00')
    expect(elapsedLabel(999)).toBe('0:00')
    expect(elapsedLabel(7_300)).toBe('0:07')
    expect(elapsedLabel(65_000)).toBe('1:05')
  })

  it('상한을 넘겨 그리지 않고, 음수도 0 이다', () => {
    expect(elapsedLabel(120_000)).toBe('2:00')
    expect(elapsedLabel(125_000)).toBe('2:00')
    expect(elapsedLabel(-50)).toBe('0:00')
  })
})

describe('받아쓴 글을 넣는 자리', () => {
  it('빈 입력창엔 그대로', () => {
    expect(insertTranscript('', '안녕하세요', { text: '', at: 0 })).toEqual({ text: '안녕하세요', cursor: 5 })
  })

  it('녹음을 시작할 때의 커서 자리에 — 앞뒤에 공백을 둔다', () => {
    expect(insertTranscript('앞뒤', '가운데', { text: '앞뒤', at: 1 })).toEqual({ text: '앞 가운데 뒤', cursor: 5 })
  })

  it('이미 공백·줄바꿈이 있으면 더 두지 않는다', () => {
    expect(insertTranscript('앞 ', '말', { text: '앞 ', at: 2 })).toEqual({ text: '앞 말', cursor: 3 })
    expect(insertTranscript('앞\n뒤', '말', { text: '앞\n뒤', at: 2 })).toEqual({ text: '앞\n말 뒤', cursor: 3 })
    expect(insertTranscript('앞 뒤', '말', { text: '앞 뒤', at: 1 })).toEqual({ text: '앞 말 뒤', cursor: 3 })
  })

  it('맨 앞·맨 끝에 넣을 땐 바깥쪽 공백이 없다', () => {
    expect(insertTranscript('뒤', '말', { text: '뒤', at: 0 })).toEqual({ text: '말 뒤', cursor: 1 })
    expect(insertTranscript('앞', '말', { text: '앞', at: 1 })).toEqual({ text: '앞 말', cursor: 3 })
  })

  it('받아쓴 글의 앞뒤 공백은 뗀다', () => {
    expect(insertTranscript('', '  로그인 버튼 \n', { text: '', at: 0 }).text).toBe('로그인 버튼')
  })

  it('그사이 글을 고쳤으면 시작 자리를 버리고 지금 커서 자리에', () => {
    // 시작할 땐 "abc" 의 끝(3)이었는데 앞에 글을 더 써서 그 자리는 낱말 한가운데가 됐다
    expect(insertTranscript('새 글 abc', '말', { text: 'abc', at: 3 }, 3)).toEqual({ text: '새 글 말 abc', cursor: 5 })
  })

  it('글이 바뀌었고 커서도 모르면(다른 대화를 보고 있다) 끝에', () => {
    expect(insertTranscript('고친 글', '말', { text: '원래 글', at: 1 })).toEqual({ text: '고친 글 말', cursor: 6 })
    expect(insertTranscript('고친 글', '말', undefined)).toEqual({ text: '고친 글 말', cursor: 6 })
  })

  it('커서가 글 밖이면 글 안으로 당긴다', () => {
    expect(insertTranscript('짧다', '말', { text: '긴 글이었다', at: 6 }, 40).text).toBe('짧다 말')
    expect(insertTranscript('짧다', '말', undefined, -3).text).toBe('말 짧다')
  })

  it('말이 없으면 글을 건드리지 않는다', () => {
    expect(insertTranscript('그대로', '   ', { text: '그대로', at: 1 })).toEqual({ text: '그대로', cursor: 1 })
  })

  it('다른 대화로 옮겨 가도 녹음을 시작한 대화의 초안에 들어간다 (drafts.ts)', () => {
    let drafts: Drafts = {}
    drafts = changeDraft(drafts, 'a', (draft) => ({ ...draft, text: '로그를' }))
    drafts = changeDraft(drafts, 'b', (draft) => ({ ...draft, text: 'b 에 쓰던 글' }))
    const anchor = { text: '로그를', at: 3 }
    // 지금 b 를 보고 있다 — 커서는 b 의 것이라 넘기지 않는다
    drafts = changeDraft(drafts, 'a', (draft) => ({ ...draft, text: insertTranscript(draft.text, '봐 줘', anchor).text }))
    expect(draftOf(drafts, 'a').text).toBe('로그를 봐 줘')
    expect(draftOf(drafts, 'b').text).toBe('b 에 쓰던 글')
  })

  it('붙여 둔 칩은 그대로 둔다', () => {
    const chip = { kind: 'file' as const, name: 'x.ts', path: '/p/x.ts', size: 1 }
    let drafts: Drafts = changeDraft({}, 'a', () => ({ text: '', attached: [chip] }))
    drafts = changeDraft(drafts, 'a', (draft) => ({ ...draft, text: insertTranscript(draft.text, '이 파일', undefined).text }))
    expect(draftOf(drafts, 'a')).toEqual({ text: '이 파일', attached: [chip] })
  })
})

describe('실패 문구', () => {
  it('마이크 권한 거절 — macOS 는 시스템 설정 자리까지 안내한다', () => {
    expect(captureFailure({ name: 'NotAllowedError' }, 'darwin')).toBe('voice.error.permission.mac')
    expect(captureFailure({ name: 'NotAllowedError' }, 'win32')).toBe('voice.error.permission')
    expect(captureFailure({ name: 'NotAllowedError' }, undefined)).toBe('voice.error.permission')
    expect(ko['voice.error.permission.mac']).toContain('시스템 설정 > 개인정보 보호 및 보안 > 마이크')
    expect(en['voice.error.permission.mac']).toContain('System Settings > Privacy & Security > Microphone')
  })

  it('마이크 없음 · 다른 곳이 쥐고 있음 · 그 밖의 녹음 실패', () => {
    expect(captureFailure({ name: 'NotFoundError' }, 'darwin')).toBe('voice.error.noMicrophone')
    expect(captureFailure({ name: 'NotReadableError' }, 'win32')).toBe('voice.error.microphoneBusy')
    expect(captureFailure({ name: RECORDING_FAILED }, 'darwin')).toBe('voice.error.recording')
    expect(captureFailure(new Error('decode'), 'darwin')).toBe('voice.error.recording')
    expect(captureFailure('문자열', 'darwin')).toBe('voice.error.recording')
    expect(captureFailure(undefined, 'darwin')).toBe('voice.error.recording')
  })

  it('받아쓰기 실패 코드마다 문구가 있고, 취소는 알리지 않는다', () => {
    const codes: SpeechErrorCode[] = ['invalid', 'too-long', 'unavailable', 'busy', 'timeout', 'cancelled', 'failed']
    expect(codes.map(replyFailure)).toEqual([
      'voice.error.recording',
      'voice.error.tooLong',
      'voice.error.unavailable',
      'voice.error.busy',
      'voice.error.timeout',
      undefined,
      'voice.error.failed',
    ])
  })

  it('엔진 파일이 없거나 손상이면 마이크를 열기 전에 알린다 — 대조 중·준비됨·모름은 막지 않는다', () => {
    expect(notReady({ state: 'unavailable', reason: 'missing', language: 'ko' })).toBe('voice.error.unavailable')
    expect(notReady({ state: 'unavailable', reason: 'mismatch', language: 'ko' })).toBe('voice.error.unavailable')
    expect(notReady({ state: 'unavailable', reason: 'checking', language: 'ko' })).toBeUndefined()
    expect(notReady({ state: 'ready', language: 'ko' })).toBeUndefined()
    expect(notReady({ state: 'starting', language: 'ko' })).toBeUndefined()
    expect(notReady(undefined)).toBeUndefined()
  })

  it('문구는 두 언어에 다 있다', () => {
    const keys = Object.keys(ko).filter((key) => key.startsWith('voice.') || key.startsWith('settings.speechLanguage'))
    expect(keys.length).toBeGreaterThan(15)
    for (const key of keys) expect(en[key as keyof typeof en], key).toBeTruthy()
  })
})

describe('마이크 버튼·녹음 띠의 그림 (정적 렌더)', () => {
  const voice = (state: VoiceState, on = true): VoiceInput => ({ on, state, since: undefined, toggle() {}, cancel() {}, dismiss() {}, level: () => 0 })
  const button = (state: VoiceState, on = true) => renderToStaticMarkup(createElement(VoiceButton, { voice: voice(state, on) }))
  const strip = (state: VoiceState, on = true) => renderToStaticMarkup(createElement(VoiceStrip, { voice: voice(state, on) }))
  const recording: VoiceState = { phase: 'recording', run: 1, sessionId: 'a' }

  it('기능이 꺼져 있으면 버튼도 띠도 없다', () => {
    expect(button(VOICE_IDLE, false)).toBe('')
    expect(strip(recording, false)).toBe('')
  })

  it('대기 — 버튼은 눌리지 않은 모양이고 띠는 없다', () => {
    const html = button(VOICE_IDLE)
    expect(html).toContain('class="composer__voice"')
    expect(html).toContain('aria-pressed="false"')
    expect(html).toContain(`aria-label="${ko['voice.start']}"`)
    expect(strip(VOICE_IDLE)).toBe('')
  })

  it('녹음 중 — 버튼은 눌린 모양(정지), 띠엔 취소 · 상태 글 · 음량 · 경과 · 정지', () => {
    const html = button(recording)
    expect(html).toContain('aria-pressed="true"')
    expect(html).toContain('data-voice="recording"')
    expect(html).toContain(`aria-label="${ko['voice.stop']}"`)
    const band = strip(recording)
    expect(band).toContain('class="voice-strip" data-voice="recording"')
    expect(band).toContain('data-voice-action="cancel"')
    expect(band).toContain('data-voice-action="stop"')
    expect(band).toContain('role="status"')
    expect(band).toContain('녹음 중')
    expect(band).toContain('voice-strip__meter')
    expect(band).toMatch(/role="timer"[^>]*>0:00 \/ 2:00</)
    expect(band).not.toContain('data-voice-action="dismiss"')
  })

  it('받아쓰는 중 — 버튼은 못 누르고, 띠엔 취소와 "받아쓰는 중"', () => {
    const state: VoiceState = { phase: 'transcribing', run: 1, sessionId: 'a' }
    expect(button(state)).toContain('disabled=""')
    const band = strip(state)
    expect(band).toContain('받아쓰는 중')
    expect(band).toContain('data-voice-action="cancel"')
    expect(band).not.toContain('data-voice-action="stop"')
  })

  it('끝난 뒤의 한 줄 — 말소리 없음은 안내, 실패는 오류 모양이고 닫기가 있다', () => {
    const empty = strip({ phase: 'idle', run: 1, notice: EMPTY })
    expect(empty).toContain('data-tone="info"')
    expect(empty).toContain('말소리를 찾지 못했습니다')
    const failed = strip({ phase: 'idle', run: 1, notice: { tone: 'error', key: 'voice.error.permission.mac' } })
    expect(failed).toContain('data-tone="error"')
    expect(failed).toContain('시스템 설정 &gt; 개인정보 보호 및 보안 &gt; 마이크')
    expect(failed).toContain('data-voice-action="dismiss"')
    expect(failed).not.toContain('data-voice-action="cancel"')
  })
})
