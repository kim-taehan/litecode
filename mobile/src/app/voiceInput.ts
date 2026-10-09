// 음성 입력 (#271) — 대화 입력창의 마이크 버튼이 쓰는 훅. 폰 자체 인식(modules/litecode-speech)을 부르고, 글 합치기·문구는 voiceText.ts.
// 들은 글은 입력창에만 들어간다 — 자동으로 보내지 않는다(폰은 고쳐 보낸다). 마이크 허용은 처음 누를 때 묻는다.

import { useEffect, useRef, useState } from 'react'
import { PermissionsAndroid } from 'react-native'
import { speech } from '../../modules/litecode-speech/index.ts'
import { joinHeard, VOICE_LANGUAGE, voiceProblem, type VoiceProblem } from './voiceText.ts'

export interface VoiceInput {
  /** 인식 서비스가 있는 기기에서만 true — false 면 버튼을 숨긴다 */
  available: boolean
  listening: boolean
  problem: VoiceProblem | undefined
  /** 듣기 시작 / 멈추기(들은 데까지 남긴다) */
  toggle(): void
  /** 결과 없이 버린다 — 보내기 직전에 (보낸 뒤 늦게 온 결과가 비운 입력창을 다시 채우지 않게) */
  cancel(): void
}

export function useVoiceInput(draft: string, setDraft: (text: string) => void): VoiceInput {
  const [available] = useState(() => speech?.available() ?? false)
  const [listening, setListening] = useState(false)
  const [problem, setProblem] = useState<VoiceProblem>()
  // 듣기 시작 때의 입력창 글 — 부분 결과는 늘 이 뒤에 다시 합친다
  const base = useRef('')
  // 이 듣기의 결과를 받을지 — cancel 하면 늦게 온 결과를 버린다
  const active = useRef(false)

  useEffect(() => {
    if (!speech) return
    const heard = ({ text }: { text: string }): void => {
      if (active.current) setDraft(joinHeard(base.current, text))
    }
    const subscriptions = [
      speech.addListener('onPartial', heard),
      speech.addListener('onFinal', heard),
      speech.addListener('onError', ({ code }) => {
        if (active.current) setProblem(voiceProblem(code))
      }),
      speech.addListener('onEnd', () => {
        active.current = false
        setListening(false)
      }),
    ]
    return () => {
      for (const subscription of subscriptions) subscription.remove()
      active.current = false
      void speech?.cancel()
    }
  }, [setDraft])

  const start = async (): Promise<void> => {
    if (!speech) return
    setProblem(undefined)
    const answer = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.RECORD_AUDIO)
    if (answer !== PermissionsAndroid.RESULTS.GRANTED) {
      setProblem('permission')
      return
    }
    base.current = draft
    active.current = true
    setListening(true)
    try {
      await speech.start(VOICE_LANGUAGE)
    } catch {
      active.current = false
      setListening(false)
      setProblem('failed')
    }
  }

  return {
    available,
    listening,
    problem,
    toggle: () => {
      if (listening) void speech?.stop()
      else void start()
    },
    cancel: () => {
      if (!listening) return
      active.current = false
      setListening(false)
      void speech?.cancel()
    },
  }
}
