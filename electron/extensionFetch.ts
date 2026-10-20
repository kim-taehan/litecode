import { net, session, type IncomingMessage } from 'electron'
import type { ExtensionFetch } from '../src/services/extensions/network.ts'

// 확장 network.fetch 의 메인 쪽 (이슈 #536 QA 경고) — Node(undici) fetch 는 번들 Mozilla CA 만 써서 사내 CA 로 서명된 https(폐쇄망 SonarQube)에 못 닿는다.
// Chromium 네트워크(net.request)는 OS 인증서 저장소와 시스템 프록시를 쓴다.
// - 확장마다 비영속 session(`ext:<id>`, persist: 없음) — 캐시·연결이 앱 화면·다른 확장과 섞이지 않는다. 쿠키·자격 증명은 싣지 않는다(credentials 'omit')
// - 실측(2026-10-20, Electron 33.4.11): ses.fetch 의 redirect 'manual' 은 3xx 를 주지 않고 "Redirect was cancelled" 로 던진다. 그래서 net.request 의
//   'redirect' 이벤트를 3xx 응답으로 바꿔 돌려주고 요청은 끊는다 — 같은 origin 인지는 fetchForExtension 이 hop 마다 본다
// - 오류는 net 의 메시지 그대로(net::ERR_CERT_AUTHORITY_INVALID 등) 던진다

export function extensionFetch(id: string): ExtensionFetch {
  const ses = session.fromPartition(`ext:${id}`)
  return (url, init) =>
    new Promise((resolve, reject) => {
      const aborted = () => new DOMException('This operation was aborted', 'AbortError')
      if (init.signal?.aborted) return reject(aborted())
      const request = net.request({ url: url.href, method: init.method, session: ses, redirect: 'manual', credentials: 'omit' })
      let failBody: ((error: Error) => void) | undefined
      init.signal?.addEventListener('abort', () => {
        request.abort()
        if (failBody) failBody(aborted())
        else reject(aborted())
      })
      request.on('redirect', (status, _method, _redirectUrl, headers) => {
        request.abort()
        resolve(new Response(null, { status, headers: { location: String(headers.location ?? '') } }))
      })
      request.on('response', (response) => {
        const body = streamOf(response, () => request.abort())
        failBody = body.fail
        const nullBody = response.statusCode === 204 || response.statusCode === 205 || response.statusCode === 304
        resolve(new Response(nullBody ? null : body.stream, { status: response.statusCode, headers: headersOf(response.headers) }))
      })
      request.on('error', reject)
      for (const [name, value] of Object.entries(init.headers)) request.setHeader(name, value)
      if (init.body !== undefined) request.write(init.body)
      request.end()
    })
}

/** 응답 본문 → 웹 스트림. 읽는 쪽이 그만두면 요청을 끊고, 끊긴 뒤 온 조각은 버린다 */
function streamOf(response: IncomingMessage, abort: () => void): { stream: ReadableStream<Uint8Array>; fail: (error: Error) => void } {
  let done = false
  let controller!: ReadableStreamDefaultController<Uint8Array>
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c
    },
    cancel() {
      done = true
      abort()
    },
  })
  const fail = (error: Error) => {
    if (done) return
    done = true
    controller.error(error)
  }
  response.on('data', (chunk) => {
    if (!done) controller.enqueue(new Uint8Array(chunk))
  })
  response.on('end', () => {
    if (done) return
    done = true
    controller.close()
  })
  response.on('error', fail)
  response.on('aborted', () => fail(new Error('aborted')))
  return { stream, fail }
}

/** set-cookie 처럼 여러 값인 머리는 합친다 (쓰는 쪽은 content-type·location 만 본다) */
function headersOf(raw: Record<string, string | string[]>): Headers {
  const headers = new Headers()
  for (const [name, value] of Object.entries(raw)) headers.set(name, Array.isArray(value) ? value.join(', ') : value)
  return headers
}
