import { execFileSync } from 'node:child_process'
import net from 'node:net'
import path from 'node:path'
import type { EngineOptions } from '../../../src/services/engine.ts'

// 실물 테스트가 띄우는 opencode 는 전부 제품 코드(ctx.engine)가 띄운다 — 서비스 테스트는 EngineService 로, 앱 테스트는
// 앱 자신이. 여기에는 그 opencode 를 사용자 환경과 떼어 놓는 값만 둔다.
//
// 격리하는 이유 (실측 2026-09-30):
// - 사용자가 평소 쓰는 opencode 가 :4096 에 떠 있을 수 있다 → 엔진은 빈 포트를 잡는다
// - 엔진은 XDG_CONFIG_HOME 을 안 바꾼다(제품 결정 — bash·git 이 물려받는다). OPENCODE_CONFIG_DIR 이 전역 설정을 대신하지만
//   (01_probe Q4) 테스트는 한 겹 더: XDG_* 를 테스트 임시 폴더로 돌려 전역 설정의 진짜 게이트웨이 키를 아예 못 보게 하고,
//   로그·스냅숏을 사용자 저장소에 안 남긴다 (로그에 키가 없는지도 여기서 찾는다). 캐시(XDG_CACHE_HOME)는 그대로 —
//   provider 패키지를 매번 받지 않게
// - 끌 때는 엔진이 자기가 띄운 PID 만 끈다

export async function freePort(): Promise<number> {
  const server = net.createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as net.AddressInfo
  await new Promise((resolve) => server.close(resolve))
  return port
}

/** 테스트용 opencode 실행 파일 — OPENCODE_BIN 이 있으면 그것, 없으면 PATH 의 opencode */
export function opencodeBin(): string {
  return process.env.OPENCODE_BIN ?? execFileSync('which', ['opencode'], { encoding: 'utf8' }).trim()
}

/** root 아래로 XDG 를 돌린 환경 */
export function isolatedEnv(root: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    OPENCODE_BIN: opencodeBin(),
    XDG_CONFIG_HOME: path.join(root, 'xdg', 'config'),
    XDG_DATA_HOME: path.join(root, 'xdg', 'data'),
    XDG_STATE_HOME: path.join(root, 'xdg', 'state'),
  }
}

/** root 아래에 상태를 두는 엔진 옵션 (앱의 userData 배치와 같은 이름) */
export function engineOptions(root: string): EngineOptions {
  return {
    configDir: path.join(root, 'opencode'),
    db: path.join(root, 'opencode.db'),
    pidFile: path.join(root, 'opencode-server.json'),
    env: isolatedEnv(root),
  }
}

/** 그 PID 가 살아 있나 */
export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
