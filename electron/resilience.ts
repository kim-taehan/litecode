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

/** 화면(웹 내용)의 권한 요청을 허용할까 — 기본 거부. 앱 화면이 실제로 쓰는 것은 "복사" 버튼의 navigator.clipboard.writeText 하나다
 *  (Electron 권한 이름 clipboard-sanitized-write). 미리보기 iframe 같은 하위 프레임은 그것도 안 준다 */
export function allowPermission(permission: string, isMainFrame: boolean): boolean {
  return isMainFrame && permission === 'clipboard-sanitized-write'
}
