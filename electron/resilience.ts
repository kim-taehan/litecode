// 메인 프로세스의 "버티기" 판단들 (참고 레포 검토 02x A·D) — electron 을 import 하지 않는 순수 함수라 단위 테스트가 닿는다.
// 실제로 거는 곳(창 다시 불러오기·종료·권한 핸들러·부팅 안내)은 main.ts 다.

/** 아직 안 뜬 서비스 이름 — 서비스 하나가 안 뜨면 그것을 inject 한 플러그인(bootstrap)이 말없이 기다리기만 한다 */
export function missingServices(names: readonly string[], get: (name: string) => unknown): string[] {
  return names.filter((name) => get(name) === undefined)
}

/** 렌더러가 죽었을 때 다시 불러와도 되는가 — withinMs 안에 max 번까지만. 넘으면 멈춘다(죽고 불러오기의 무한 반복 방지) */
export function reloadGuard(opts: { max: number; withinMs: number; now?: () => number }): { allow(): boolean } {
  const now = opts.now ?? Date.now
  let recent: number[] = []
  return {
    allow() {
      const at = now()
      recent = recent.filter((time) => at - time < opts.withinMs)
      if (recent.length >= opts.max) return false
      recent.push(at)
      return true
    },
  }
}

/** work 가 ms 안에 끝나면 'done', 아니면 'timeout' — 어느 쪽이든 던지지 않는다 (work 의 실패도 'done': 끝난 것이다) */
export function withDeadline(work: Promise<unknown>, ms: number): Promise<'done' | 'timeout'> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve('timeout'), ms)
    const done = (): void => {
      clearTimeout(timer)
      resolve('done')
    }
    work.then(done, done)
  })
}

/** `media` 권한을 판단할 때 보는 것 — 음성 입력 기능이 켜졌는지와, 무엇을 달라는지.
 *  요청 핸들러에는 details.mediaTypes(배열), 검사 핸들러에는 details.mediaType(하나)이 온다 — 검사 쪽은 하나짜리 배열로 넘긴다.
 *  **getUserMedia 직전의 검사에는 mediaType 이 안 실려 온다**(실측 01ag §2.3 — undefined). 그 검사는 거절해도 요청 핸들러가 불린다 */
export interface MediaAsk {
  /** 기능 `voice` 가 켜져 있다 */
  voice: boolean
  mediaTypes?: readonly string[]
}

/** 화면(웹 내용)의 권한 요청을 허용할까 — 기본 거부. 앱 화면이 실제로 쓰는 것은 "복사" 버튼의 navigator.clipboard.writeText
 *  (Electron 권한 이름 clipboard-sanitized-write)와, 음성 입력을 켰을 때의 마이크뿐이다 — `media` 는 달라는 것이 정확히 소리 하나일 때만
 *  (카메라·화면이 끼거나 종류를 모르면 거절). 미리보기 iframe 같은 하위 프레임은 어느 것도 안 준다 */
export function allowPermission(permission: string, isMainFrame: boolean, media?: MediaAsk): boolean {
  if (!isMainFrame) return false
  if (permission === 'clipboard-sanitized-write') return true
  return permission === 'media' && media?.voice === true && media.mediaTypes?.length === 1 && media.mediaTypes[0] === 'audio'
}

/** 권한 요청 핸들러의 답 — allowPermission 을 통과한 마이크 요청은 macOS 에서 OS 허락(askForMediaAccess)까지 받아야 허용이다.
 *  OS 가 이미 거절했으면 다시 묻지 않고 false 가 온다 (사용자가 시스템 설정에서 풀어야 한다). Windows 엔 그 창이 없다 */
export async function grantPermission(
  permission: string,
  isMainFrame: boolean,
  media: MediaAsk,
  os: { platform: string; askMicrophone(): Promise<boolean> },
): Promise<boolean> {
  if (!allowPermission(permission, isMainFrame, media)) return false
  if (permission !== 'media' || os.platform !== 'darwin') return true
  return os.askMicrophone().catch(() => false)
}
