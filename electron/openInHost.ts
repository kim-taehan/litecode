import { nativeImage, shell } from 'electron'
import { execFile } from 'node:child_process'
import type { Launch, OpenInHost } from '../src/services/openIn.ts'

// ctx.openIn 의 Electron 쪽 — 아이콘과 실행. 실물 테스트(LITECODE_TEST_HIDDEN=1)는 실행만 기록으로 바꾼다(사용자 화면에 앱 창을 띄우지 않게).

/** 아이콘은 createThumbnailFromPath — app.getFileIcon 은 .app 에 회색 자리표시 아이콘만 준다 (실측 2026-10-02, Electron 33·macOS 15.2, 01m E1) */
async function icon(bundle: string): Promise<string | null> {
  const image = await nativeImage.createThumbnailFromPath(bundle, { width: 64, height: 64 })
  return image.isEmpty() ? null : image.toDataURL()
}

export const systemOpenInHost: OpenInHost = {
  icon,
  async launch(what: Launch) {
    if (what.kind === 'os-open') {
      // openPath 는 실패를 예외가 아니라 사유 문자열로 준다 (성공 = 빈 문자열)
      const failure = await shell.openPath(what.path)
      if (failure) throw new Error(failure)
      return
    }
    // 셸을 거치지 않는다 — 인자는 ctx.openIn 의 허용 목록 번들과 등록된 프로젝트 realpath 뿐. open 은 LaunchServices 에 넘기고 바로 끝난다
    await new Promise<void>((resolve, reject) =>
      execFile('open', what.args, { timeout: 15_000 }, (error, _stdout, stderr) => (error ? reject(new Error(stderr.trim() || error.message)) : resolve())),
    )
  },
}

/** 테스트가 app.evaluate 로 읽는 기록 — globalThis.__litecodeOpenInTest.launches. fail 을 넣으면 그 사유로 실패한다 */
export interface OpenInTestRecord {
  launches: Launch[]
  fail?: string
}

export function recordingOpenInHost(record: OpenInTestRecord): OpenInHost {
  return {
    icon,
    async launch(what) {
      record.launches.push(what)
      if (record.fail) throw new Error(record.fail)
    },
  }
}
