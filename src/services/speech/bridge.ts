import type { SpeechReply, SpeechStreamEvent, SpeechStreamOpened } from '../../../shared/speech.ts'
import { SpeechError, speechReply, type SpeechService, type SpeechStream } from '../speech.ts'

// 실시간 받아쓰기의 IPC 쪽 장부 — 화면이 연 스트림 하나를 번호로 쥔다 (Electron 을 모른다: 채널은 electron/main.ts 가 잇는다).
// 화면은 한 번에 하나만 녹음하므로, 열려 있는데 또 열면 화면이 앞의 것을 잃은 것이다(새로 고침) — 앞의 것을 버리고 새로 연다.
// 번호가 다른 조각·정지·취소는 옛 녹음의 것이라 버린다. 스트림이 스스로 죽으면(엔진 종료·기한) 화면에 error 로 알린다.

export interface SpeechBridgeStreams {
  start(language: unknown): SpeechStreamOpened
  chunk(stream: unknown, pcm: unknown): void
  stop(stream: unknown): Promise<SpeechReply>
  /** 번호를 빼면 열려 있는 것을 버린다 */
  cancel(stream?: unknown): void
}

interface Open {
  id: number
  stream: SpeechStream
  /** 정지를 불렀다 — 조각을 더 받지 않고, 실패는 정지의 답으로 간다 */
  stopping?: boolean
}

export function speechBridgeStreams(speech: Pick<SpeechService, 'openStream'>, emit: (event: SpeechStreamEvent) => void): SpeechBridgeStreams {
  let seq = 0
  let open: Open | undefined
  return {
    start(language) {
      open?.stream.cancel()
      open = undefined
      const id = ++seq
      try {
        const stream = speech.openStream({ language }, (partial) => open?.id === id && emit({ stream: id, ...partial }))
        const mine: Open = { id, stream }
        open = mine
        stream.done.then(
          () => {
            if (open === mine) open = undefined
          },
          (error: unknown) => {
            if (open !== mine) return
            open = undefined
            // 정지를 기다리는 중이면 그 답이 사유를 준다
            if (!mine.stopping) emit({ stream: id, final: '', tentative: '', error: error instanceof SpeechError ? error.code : 'failed' })
          },
        )
        return { ok: true, stream: id }
      } catch (error) {
        return error instanceof SpeechError ? { ok: false, code: error.code, message: error.message } : { ok: false, code: 'failed', message: String((error as Error)?.message) }
      }
    },
    chunk(stream, pcm) {
      if (!open || open.id !== stream || open.stopping) return
      try {
        open.stream.write(pcm)
      } catch {
        // 모양이 틀린 조각 — 버린다 (화면이 오염됐을 수 있다)
      }
    },
    async stop(stream) {
      if (!open || open.id !== stream) return { ok: false, code: 'cancelled', message: '' }
      open.stopping = true
      return speechReply(open.stream.stop())
    },
    cancel(stream) {
      if (!open || (stream !== undefined && open.id !== stream)) return
      const { stream: active } = open
      open = undefined
      active.cancel()
    },
  }
}
