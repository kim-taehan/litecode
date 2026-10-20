import type { ExtensionCallResult } from '../shared/extensions.ts'

// 확장 ↔ 앱 통로의 화면 쪽 (이슈 #536) — 순수 규칙. 확장 탭(FilePreview.tsx ExtensionTab)이 이것만 부른다.
// 패널은 parent.postMessage({ litecode: 1, id, method, params }) 로 묻고, 앱은 그 iframe 으로 { litecode: 1, id, ok, result | error } 를 돌려준다.
// 확장 id 는 메시지 내용이 아니라 어느 iframe 에서 왔나(event.source === 그 탭 iframe 의 contentWindow)로 정한다 — 탭이 자기 id 를 쥐고 있다.
// iframe 은 sandbox(allow-same-origin 없음)라 출처가 불투명("null")이다 — 그래서 origin 이 아니라 source 로 가린다

export interface BridgeRequest {
  id: string | number
  method: string
  params: unknown
}

/** 이 탭의 iframe 이 보낸 통로 요청 — 아니면 undefined (다른 iframe·창·앱 자신의 메시지, 모양이 틀린 것) */
export function bridgeRequestOf(event: { source: unknown; data: unknown }, frame: unknown): BridgeRequest | undefined {
  if (frame === null || frame === undefined || event.source !== frame) return undefined
  const data = event.data
  if (typeof data !== 'object' || data === null) return undefined
  const { litecode, id, method, params } = data as Record<string, unknown>
  if (litecode !== 1 || (typeof id !== 'string' && typeof id !== 'number') || typeof method !== 'string') return undefined
  return { id, method, params }
}

/** iframe 으로 돌려보낼 응답 — 실패는 코드만 (consent-required 의 origin 같은 화면용 값은 싣지 않는다) */
export function bridgeReply(id: string | number, result: ExtensionCallResult): { litecode: 1; id: string | number; ok: true; result: unknown } | { litecode: 1; id: string | number; ok: false; error: string } {
  return result.ok ? { litecode: 1, id, ok: true, result: result.result } : { litecode: 1, id, ok: false, error: result.error }
}

export interface BridgeDeps {
  /** 메인에 묻는다 (extensions:call — 확장 id·프로젝트는 탭이 채운다) */
  call(method: string, params: unknown): Promise<ExtensionCallResult>
  /** 동의 띠로 묻는다 — 허용이면 true */
  ask(origin: string): Promise<boolean>
  /** 허용 목록에 넣는다 (extensions:allow-origin) */
  allow(origin: string): Promise<ExtensionCallResult>
  /** 오른쪽 패널에 파일을 연다 (project.openFile) */
  open(path: string, line: number | undefined): void
  /** 지금 프로젝트에 새 대화를 열고 입력창을 채운다 (chat.compose, 이슈 #557) — send 면 곧바로 보낸다(#559) */
  compose(text: string, send: boolean): void
}

/** 요청 하나 — 허용 목록에 없는 주소면 묻고(거절 → network-denied, 허용 → 목록에 넣고 다시), openFile 이 통과하면 패널에 연다. 던지지 않는다 */
export async function runBridgeCall(request: BridgeRequest, deps: BridgeDeps): Promise<ExtensionCallResult> {
  try {
    let result = await deps.call(request.method, request.params)
    if (!result.ok && result.error === 'consent-required' && result.origin !== undefined) {
      if (!(await deps.ask(result.origin))) return { ok: false, error: 'network-denied' }
      const allowed = await deps.allow(result.origin)
      if (!allowed.ok) return allowed
      result = await deps.call(request.method, request.params)
      if (!result.ok && result.error === 'consent-required') return { ok: false, error: 'network-denied' }
    }
    if (result.ok && request.method === 'project.openFile') {
      const { path, line } = result.result as { path: string; line?: number }
      deps.open(path, line)
      return { ok: true, result: null }
    }
    if (result.ok && request.method === 'chat.compose') {
      const { text, send } = result.result as { text: string; send?: boolean }
      deps.compose(text, send === true)
      return { ok: true, result: null }
    }
    return result
  } catch {
    return { ok: false, error: 'io-failed' }
  }
}

/** 동의 띠의 줄 — 한 번에 한 주소만 보인다. 같은 주소를 여러 요청이 물으면 띠 하나로 모두 답한다 */
export class ConsentQueue {
  private pending: { origin: string; resolvers: ((allowed: boolean) => void)[] }[] = []
  private readonly listeners = new Set<() => void>()

  /** 지금 묻는 주소 */
  get current(): string | undefined {
    return this.pending[0]?.origin
  }

  ask(origin: string): Promise<boolean> {
    return new Promise((resolve) => {
      const found = this.pending.find((item) => item.origin === origin)
      if (found) found.resolvers.push(resolve)
      else this.pending.push({ origin, resolvers: [resolve] })
      this.notify()
    })
  }

  /** 지금 주소에 답한다 */
  answer(allowed: boolean): void {
    const first = this.pending.shift()
    if (!first) return
    for (const resolve of first.resolvers) resolve(allowed)
    this.notify()
  }

  /** 탭이 사라졌다 — 남은 질문은 모두 거절 */
  clear(): void {
    const pending = this.pending
    this.pending = []
    for (const item of pending) for (const resolve of item.resolvers) resolve(false)
    if (pending.length > 0) this.notify()
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private notify(): void {
    for (const listener of this.listeners) listener()
  }
}
