import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// 확장 network.fetch 의 Electron 쪽 (이슈 #536 QA 경고) — Chromium 네트워크(OS 인증서 저장소·시스템 프록시)로 보낸다.
// 실측(2026-10-20, Electron 33.4.11): ses.fetch 의 redirect 'manual' 은 3xx 를 주지 않고 "Redirect was cancelled" 로 던진다 → net.request 의
// 'redirect' 이벤트를 3xx 응답으로 바꿔 fetchForExtension 의 같은 origin 규칙이 hop 마다 보게 한다. 실제 net 은 가짜로 바꿔 끼운다

class FakeRequest extends EventEmitter {
  headers: Record<string, string> = {}
  written: string[] = []
  ended = false
  aborted = false
  constructor(readonly options: Record<string, unknown>) {
    super()
  }
  setHeader(name: string, value: string) {
    this.headers[name] = value
  }
  write(chunk: string) {
    this.written.push(chunk)
  }
  end() {
    this.ended = true
  }
  abort() {
    this.aborted = true
  }
}

class FakeResponse extends EventEmitter {
  constructor(
    readonly statusCode: number,
    readonly headers: Record<string, string | string[]>,
  ) {
    super()
  }
}

const requests: FakeRequest[] = []
const partitions: string[] = []

vi.mock('electron', () => ({
  net: {
    request: (options: Record<string, unknown>) => {
      const request = new FakeRequest(options)
      requests.push(request)
      return request
    },
  },
  session: {
    fromPartition: (partition: string) => {
      partitions.push(partition)
      return { partition }
    },
  },
}))

const { extensionFetch } = await import('../../electron/extensionFetch.ts')

beforeEach(() => {
  requests.length = 0
  partitions.length = 0
})

const last = () => requests[requests.length - 1]!

describe('extensionFetch', () => {
  it('확장별 비영속 session(ext:<id>)·쿠키/자격 증명 안 실음·리다이렉트 manual — 헤더와 본문을 싣는다', async () => {
    const pending = extensionFetch('sonar-ext')(new URL('https://sonar.corp.local/api'), { method: 'POST', headers: { authorization: 'Bearer t' }, body: 'a=1' })
    const request = last()
    expect(partitions).toEqual(['ext:sonar-ext'])
    expect(request.options).toMatchObject({ url: 'https://sonar.corp.local/api', method: 'POST', session: { partition: 'ext:sonar-ext' }, redirect: 'manual', credentials: 'omit' })
    expect(request.headers).toEqual({ authorization: 'Bearer t' })
    expect(request.written).toEqual(['a=1'])
    expect(request.ended).toBe(true)
    const response = new FakeResponse(200, { 'content-type': 'application/json', 'set-cookie': ['a=1', 'b=2'] })
    request.emit('response', response)
    response.emit('data', Buffer.from('{"ok":'))
    response.emit('data', Buffer.from('true}'))
    response.emit('end')
    const result = await pending
    expect(result.status).toBe(200)
    expect(result.headers.get('content-type')).toBe('application/json')
    expect(await result.text()).toBe('{"ok":true}')
  })

  it('리다이렉트는 따라가지 않고 3xx 응답(location)으로 돌려준다 — 요청은 끊는다', async () => {
    const pending = extensionFetch('a-ext')(new URL('http://sonar.local/start'), { method: 'GET', headers: {} })
    const request = last()
    request.emit('redirect', 302, 'GET', 'http://other.local/', { location: ['http://other.local/'] })
    const result = await pending
    expect(result.status).toBe(302)
    expect(result.headers.get('location')).toBe('http://other.local/')
    expect(request.aborted).toBe(true)
  })

  it('네트워크 오류는 메시지 그대로 던진다 (fetchForExtension 이 net::ERR_CERT_* 를 tls-failed 로 가른다)', async () => {
    const pending = extensionFetch('a-ext')(new URL('https://sonar.corp.local/'), { method: 'GET', headers: {} })
    last().emit('error', new Error('net::ERR_CERT_AUTHORITY_INVALID'))
    await expect(pending).rejects.toThrow('net::ERR_CERT_AUTHORITY_INVALID')
  })

  it('본문이 없는 상태(204·304)도 응답으로', async () => {
    const pending = extensionFetch('a-ext')(new URL('http://sonar.local/'), { method: 'GET', headers: {} })
    const response = new FakeResponse(204, {})
    last().emit('response', response)
    response.emit('end')
    const result = await pending
    expect(result.status).toBe(204)
    expect(await result.text()).toBe('')
  })

  it('signal 로 끊으면 — 머리 전이면 AbortError 로 던지고, 본문 중이면 본문 읽기가 실패한다. 둘 다 요청을 끊는다', async () => {
    const before = new AbortController()
    const pending = extensionFetch('a-ext')(new URL('http://sonar.local/'), { method: 'GET', headers: {}, signal: before.signal })
    const first = last()
    before.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(first.aborted).toBe(true)

    const during = new AbortController()
    const streaming = extensionFetch('a-ext')(new URL('http://sonar.local/'), { method: 'GET', headers: {}, signal: during.signal })
    const second = last()
    const response = new FakeResponse(200, {})
    second.emit('response', response)
    const result = await streaming
    response.emit('data', Buffer.from('part'))
    during.abort()
    response.emit('data', Buffer.from('late')) // 끊은 뒤 온 조각은 버린다(던지지 않는다)
    await expect(result.text()).rejects.toMatchObject({ name: 'AbortError' })
    expect(second.aborted).toBe(true)
  })

  it('이미 끊긴 signal 이면 요청하지 않는다', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(extensionFetch('a-ext')(new URL('http://sonar.local/'), { method: 'GET', headers: {}, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
    expect(requests).toEqual([])
  })
})
