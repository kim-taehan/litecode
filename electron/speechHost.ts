import { utilityProcess } from 'electron'
import type { SpeechHost } from '../src/services/speech.ts'
import type { WorkerReply } from '../src/services/speech/audio.ts'

// ctx.speech 의 워커 쪽 — 음성 입력 엔진(electron/speechWorker.ts)을 Electron utilityProcess 로 띄운다.
// utilityProcess 인 이유(실측 01ag §2.3·§3.2): 네이티브 추론이 죽어도 메인이 살고, ELECTRON_RUN_AS_NODE 퓨즈에 기대지 않으며,
// postMessage 가 형식 배열(PCM)을 그대로 옮긴다. app ready 뒤에만 fork 할 수 있다 — 워커는 화면의 첫 받아쓰기 요청 때 뜨므로 늘 ready 다.

/** main.ts 의 child-process-gone 기록에 찍히는 이름 */
export const SPEECH_PROCESS_NAME = 'litecode speech'

/** workerPath: 컴파일된 워커(dist-electron/electron/speechWorker.js)의 절대 경로 */
export function systemSpeechHost(workerPath: string): SpeechHost {
  return {
    start(root, on) {
      const child = utilityProcess.fork(workerPath, [root], { serviceName: SPEECH_PROCESS_NAME, stdio: 'ignore' })
      child.on('message', (reply: WorkerReply) => on.message(reply))
      child.on('exit', () => on.exit())
      return {
        post: (request) => child.postMessage(request),
        kill: () => void child.kill(),
      }
    },
  }
}
