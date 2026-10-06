// 시험용 지문 고정 "네이티브" — 폰의 Kotlin 모듈(modules/litecode-pinned-net/android/…/PinnedNetModule.kt)과 **같은 모양·같은 규칙**을 Node TLS 로.
// 시험은 이것을 core/net.ts 의 createNativePinnedNet 에 넣어, 폰과 같은 다리(이벤트 id 가르기·오류 code)를 지나 가짜 TLS 데스크탑에 붙는다.
// 규칙: leaf 인증서의 SPKI SHA-256(base64url) == pin 일 때만 요청을 보낸다(대조 전에는 응용 데이터 0). https 만. 오류 code 는 NATIVE_ERROR 의 키.

import { createHash, X509Certificate } from 'node:crypto'
import { EventEmitter } from 'node:events'
import http from 'node:http'
import tls from 'node:tls'
import type { NativeStreamEvent, PinnedNetNative } from '../src/core/net.ts'

const MISMATCH = 'certificate fingerprint mismatch: '

/** PEM 인증서의 지문 — 데스크탑이 QR 의 fp 로 싣는 값 */
export function spkiFingerprint(certificatePem: string): string {
  return fingerprintOf(new X509Certificate(certificatePem))
}

function fingerprintOf(certificate: X509Certificate): string {
  return createHash('sha256').update(certificate.publicKey.export({ type: 'spki', format: 'der' })).digest('base64url')
}

function nativeError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code })
}

function classify(error: unknown): Error & { code: string } {
  if ((error as { code?: unknown }).code === 'ERR_PIN_MISMATCH') return error as Error & { code: string }
  const code = String((error as { code?: unknown }).code ?? '')
  const message = (error as Error).message ?? String(error)
  if (code === 'ECONNREFUSED') return nativeError('ERR_REFUSED', message)
  if (code === 'ETIMEDOUT' || code === 'ERR_TIMEOUT') return nativeError('ERR_TIMEOUT', message)
  // Kotlin 과 같게: 경로 없음만 unreachable, TLS 단계는 ERR_TLS, 닿은 뒤 끊긴 것은 ERR_IO
  if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH' || code === 'ENOTFOUND' || code === 'EAI_AGAIN') return nativeError('ERR_UNREACHABLE', message)
  if (/^ERR_(SSL|TLS)_/.test(code)) return nativeError('ERR_TLS', message)
  return nativeError('ERR_IO', message)
}

/** TLS 를 열고 지문을 본다. pin 을 주면 다를 때 끊는다 */
function handshake(host: string, port: number, timeoutMs: number, pin?: string): Promise<{ socket: tls.TLSSocket; fingerprint: string }> {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host, port, rejectUnauthorized: false })
    const timer = setTimeout(() => {
      socket.destroy()
      reject(nativeError('ERR_TIMEOUT', 'timeout'))
    }, timeoutMs)
    socket.once('secureConnect', () => {
      clearTimeout(timer)
      const certificate = socket.getPeerX509Certificate()
      if (!certificate) {
        socket.destroy()
        return reject(nativeError('ERR_UNREACHABLE', 'no server certificate'))
      }
      const fingerprint = fingerprintOf(certificate)
      if (pin !== undefined && fingerprint !== pin) {
        socket.destroy()
        return reject(nativeError('ERR_PIN_MISMATCH', MISMATCH + fingerprint))
      }
      resolve({ socket, fingerprint })
    })
    socket.once('error', (error) => {
      clearTimeout(timer)
      reject(classify(error))
    })
  })
}

export interface NodePinnedNative extends PinnedNetNative {
  /** 지문 대조를 지나 실제로 보낸 요청 (method + url) — "지문이 다르면 아무것도 안 보낸다" 를 본다 */
  readonly sent: string[]
  /** 열린 스트림 수 */
  openStreams(): number
}

export function nodePinnedNative(): NodePinnedNative {
  const events = new EventEmitter()
  const streams = new Map<string, { closed: boolean; destroy(): void }>()
  const sent: string[] = []

  const open = async (url: string, method: string, headers: Record<string, string>, pin: string, timeoutMs: number): Promise<{ request: http.ClientRequest; socket: tls.TLSSocket }> => {
    const target = new URL(url)
    if (target.protocol !== 'https:') throw nativeError('ERR_UNREACHABLE', 'pinned requests must be https')
    const { socket } = await handshake(target.hostname, Number(target.port || 443), timeoutMs, pin)
    sent.push(`${method} ${url}`)
    const request = http.request({ method, host: target.hostname, port: target.port, path: target.pathname + target.search, headers, createConnection: () => socket })
    return { request, socket }
  }

  return {
    sent,
    openStreams: () => streams.size,

    async probe(host, port, timeoutMs) {
      const { socket, fingerprint } = await handshake(host, port, timeoutMs)
      socket.destroy()
      return fingerprint
    },

    async request(url, method, headers, body, timeoutMs, pin) {
      const deadline = Date.now() + timeoutMs
      const { request, socket } = await open(url, method, headers, pin, timeoutMs)
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => {
            socket.destroy()
            reject(nativeError('ERR_TIMEOUT', 'timeout'))
          },
          Math.max(0, deadline - Date.now()),
        )
        request.once('response', (response) => {
          let text = ''
          response.setEncoding('utf8')
          response.on('data', (chunk: string) => (text += chunk))
          response.once('end', () => {
            clearTimeout(timer)
            socket.destroy()
            resolve({ status: response.statusCode ?? 0, body: text })
          })
        })
        request.once('error', (error) => {
          clearTimeout(timer)
          reject(classify(error))
        })
        request.end(body ?? undefined)
      })
    },

    openStream(id, url, headers, pin) {
      const entry = { closed: false, destroy: () => undefined as void }
      streams.set(id, entry)
      const emit = (name: string, event: NativeStreamEvent): void => {
        if (!entry.closed) events.emit(name, event)
      }
      const end = (error?: Error & { code: string }): void => {
        if (entry.closed) return
        streams.delete(id)
        emit('onStreamEnd', error ? { id, code: error.code, message: error.message } : { id })
        entry.closed = true
      }
      open(url, 'GET', headers, pin, 10_000).then(
        ({ request, socket }) => {
          entry.destroy = () => socket.destroy()
          if (entry.closed) return socket.destroy()
          request.once('response', (response) => {
            emit('onStreamOpen', { id, status: response.statusCode ?? 0 })
            if (response.statusCode !== 200) {
              response.resume()
              return end()
            }
            response.setEncoding('utf8')
            response.on('data', (text: string) => emit('onStreamData', { id, text }))
            response.once('end', () => end())
            response.once('error', (error) => end(classify(error)))
          })
          request.once('error', (error) => end(classify(error)))
          socket.once('close', () => end())
          request.end()
        },
        (error: unknown) => end(classify(error)),
      )
    },

    closeStream(id) {
      const entry = streams.get(id)
      if (!entry) return
      entry.closed = true
      streams.delete(id)
      entry.destroy()
    },

    addListener(event, listener) {
      events.on(event, listener)
      return { remove: () => events.off(event, listener) }
    },
  }
}
