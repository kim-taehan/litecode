import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { startKeyProxy, type KeyProxy, type ProxyTarget } from '../../src/services/keyProxy.ts'

// 키 프록시 단위 테스트 — 외부 프로세스 없이 이 프로세스 안의 127.0.0.1 서버끼리만 돈다.
// 스트리밍·401·키 전달의 실물 확인은 tests/live/engine.live.test.ts.

let proxy: KeyProxy | undefined
let upstream: http.Server | undefined
afterEach(async () => {
  await proxy?.close()
  await new Promise<void>((resolve) => (upstream ? upstream.close(() => resolve()) : resolve()))
  proxy = upstream = undefined
})

async function startUpstream(): Promise<string> {
  upstream = http.createServer((_req, res) => res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}'))
  await new Promise<void>((resolve) => upstream!.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/v1`
}

describe('startKeyProxy', () => {
  // 03_qa 2차: 헤더에 못 쓰는 문자가 든 키는 http.request 가 ERR_INVALID_CHAR 를 동기로 던졌다 → uncaughtException + 응답 없이 매달림.
  // 저장은 이제 막지만(providers.save) 예전에 저장된 키가 있을 수 있다 — 처리기의 어떤 동기 예외도 502 로 끝나야 한다
  it('저장된 키에 헤더로 못 쓰는 문자가 있어도 502(오류 코드만)로 응답하고, 다음 요청도 받는다', async () => {
    const baseURL = await startUpstream()
    let target: ProxyTarget = { baseURL, apiKey: 'sk-bad\nSECRET' }
    proxy = await startKeyProxy(() => target)
    const call = () =>
      fetch(`${proxy!.baseURLFor('gw')}/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${proxy!.token}`, 'content-type': 'application/json' },
        body: '{}',
        signal: AbortSignal.timeout(5_000), // 매달리면 여기서 실패한다
      })

    const bad = await call()
    expect(bad.status).toBe(502)
    const body = await bad.text()
    expect(body).toContain('ERR_INVALID_CHAR')
    expect(body).not.toContain('SECRET')

    target = { baseURL, apiKey: 'sk-good' }
    expect((await call()).status).toBe(200)
  })
})
