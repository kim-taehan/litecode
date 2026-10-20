import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { translate, type MessageKey } from '../../shared/i18n/index.ts'
import type { ExtensionCallResult } from '../../shared/extensions.ts'
import { bridgeReply, bridgeRequestOf, ConsentQueue, runBridgeCall, type BridgeDeps } from '../../renderer/extensionBridge.ts'
import { ExtensionConsentBar } from '../../renderer/FilePreview.tsx'

// 확장 ↔ 앱 통로의 화면 쪽 (이슈 #536, 시안 _workspace/mock-sonarqube-ext Ask) — 메시지 판정(어느 iframe 에서 왔나), 동의 흐름(consent-required →
// 묻기 → 허용이면 목록에 넣고 다시 요청, 거절이면 network-denied), openFile 의 패널 열기, 동의 띠 마크업. 실제 postMessage·클릭은 jsdom 이 없어 못 본다

vi.mock('../../renderer/settingsStore.ts', async (original) => ({
  ...(await original<typeof import('../../renderer/settingsStore.ts')>()),
  useT: () => (key: MessageKey, vars?: Record<string, string | number>) => translate('ko', key, vars),
}))

const ko = (key: MessageKey, vars?: Record<string, string | number>) => translate('ko', key, vars)

describe('bridgeRequestOf — 이 탭의 iframe 이 보낸 통로 요청만', () => {
  const frame = { name: '이 탭의 iframe' }
  const data = { litecode: 1, id: 7, method: 'storage.get', params: { key: 'k' } }

  it('source 가 이 iframe 이고 모양이 맞으면 요청', () => {
    expect(bridgeRequestOf({ source: frame, data }, frame)).toEqual({ id: 7, method: 'storage.get', params: { key: 'k' } })
    expect(bridgeRequestOf({ source: frame, data: { litecode: 1, id: 'a', method: 'project.info' } }, frame)).toEqual({ id: 'a', method: 'project.info', params: undefined })
  })

  it('다른 iframe·창·앱 자신에서 온 메시지는 무시 — 내용에 다른 확장 id 를 적어도 소용없다', () => {
    expect(bridgeRequestOf({ source: { name: '다른 탭의 iframe' }, data }, frame)).toBeUndefined()
    expect(bridgeRequestOf({ source: null, data }, frame)).toBeUndefined()
    expect(bridgeRequestOf({ source: frame, data }, null)).toBeUndefined()
  })

  it('통로 모양이 아니면 무시 — litecode:1·id(글·수)·method(글)', () => {
    for (const bad of [null, 'x', { ...data, litecode: 2 }, { ...data, id: undefined }, { ...data, id: {} }, { ...data, method: 3 }]) {
      expect(bridgeRequestOf({ source: frame, data: bad }, frame), JSON.stringify(bad)).toBeUndefined()
    }
  })
})

describe('bridgeReply', () => {
  it('성공은 result, 실패는 error 코드만 (origin 같은 화면용 값은 싣지 않는다)', () => {
    expect(bridgeReply(7, { ok: true, result: { a: 1 } })).toEqual({ litecode: 1, id: 7, ok: true, result: { a: 1 } })
    expect(bridgeReply('x', { ok: false, error: 'consent-required', origin: 'http://a' })).toEqual({ litecode: 1, id: 'x', ok: false, error: 'consent-required' })
  })
})

function deps(over: Partial<BridgeDeps> & { results?: ExtensionCallResult[] } = {}) {
  const results = over.results ?? []
  const log: string[] = []
  const base: BridgeDeps = {
    call: async (method, params) => {
      log.push(`call ${method} ${JSON.stringify(params)}`)
      return results.shift() ?? { ok: true, result: null }
    },
    ask: async (origin) => {
      log.push(`ask ${origin}`)
      return true
    },
    allow: async (origin) => {
      log.push(`allow ${origin}`)
      return { ok: true, result: null }
    },
    open: (path, line) => log.push(`open ${path} ${line}`),
    compose: (text) => log.push(`compose ${text}`),
  }
  return { deps: { ...base, ...over }, log }
}

describe('runBridgeCall — 동의 흐름', () => {
  const fetchRequest = { id: 1, method: 'network.fetch', params: { url: 'http://sonar.local/api' } }
  const consent: ExtensionCallResult = { ok: false, error: 'consent-required', origin: 'http://sonar.local' }
  const fetched: ExtensionCallResult = { ok: true, result: { status: 200, headers: {}, body: 'ok' } }

  it('허용 목록에 있으면 묻지 않는다', async () => {
    const { deps: d, log } = deps({ results: [fetched] })
    expect(await runBridgeCall(fetchRequest, d)).toEqual(fetched)
    expect(log).toEqual(['call network.fetch {"url":"http://sonar.local/api"}'])
  })

  it('consent-required → 묻고, 허용하면 목록에 넣은 뒤 다시 요청한다', async () => {
    const { deps: d, log } = deps({ results: [consent, fetched] })
    expect(await runBridgeCall(fetchRequest, d)).toEqual(fetched)
    expect(log).toEqual(['call network.fetch {"url":"http://sonar.local/api"}', 'ask http://sonar.local', 'allow http://sonar.local', 'call network.fetch {"url":"http://sonar.local/api"}'])
  })

  it('거절이면 network-denied — 목록에 넣지 않고 다시 요청하지 않는다', async () => {
    const { deps: d, log } = deps({ results: [consent], ask: async () => false })
    expect(await runBridgeCall(fetchRequest, d)).toEqual({ ok: false, error: 'network-denied' })
    expect(log).toEqual(['call network.fetch {"url":"http://sonar.local/api"}'])
  })

  it('허용 저장이 실패하면 그 오류', async () => {
    const { deps: d } = deps({ results: [consent], allow: async () => ({ ok: false, error: 'permission-missing' }) })
    expect(await runBridgeCall(fetchRequest, d)).toEqual({ ok: false, error: 'permission-missing' })
  })

  it('project.openFile 이 통과하면 오른쪽 패널에 그 파일을 열고 패널에는 null', async () => {
    const { deps: d, log } = deps({ results: [{ ok: true, result: { path: 'src/a.ts', line: 3 } }] })
    expect(await runBridgeCall({ id: 1, method: 'project.openFile', params: { path: 'src/a.ts', line: 3 } }, d)).toEqual({ ok: true, result: null })
    expect(log.at(-1)).toBe('open src/a.ts 3')
  })

  it('IPC 가 던지면 io-failed', async () => {
    const { deps: d } = deps({ call: async () => Promise.reject(new Error('gone')) })
    expect(await runBridgeCall({ id: 1, method: 'storage.get', params: {} }, d)).toEqual({ ok: false, error: 'io-failed' })
  })
})

describe('ConsentQueue — 한 번에 하나씩 묻는다', () => {
  it('같은 주소를 여러 번 물으면 띠 하나, 답하면 모두 받는다. 다음 주소가 이어서 보인다', async () => {
    const queue = new ConsentQueue()
    const seen: (string | undefined)[] = []
    queue.subscribe(() => seen.push(queue.current))
    const a1 = queue.ask('http://a')
    const a2 = queue.ask('http://a')
    const b = queue.ask('http://b')
    expect(queue.current).toBe('http://a')
    queue.answer(true)
    expect(await a1).toBe(true)
    expect(await a2).toBe(true)
    expect(queue.current).toBe('http://b')
    queue.answer(false)
    expect(await b).toBe(false)
    expect(queue.current).toBeUndefined()
    // 띠가 바뀔 때마다 알린다 — a → b → 없음
    expect([...new Set(seen)]).toEqual(['http://a', 'http://b', undefined])
  })

  it('탭이 닫히면(clear) 남은 질문은 모두 거절로', async () => {
    const queue = new ConsentQueue()
    const a = queue.ask('http://a')
    const b = queue.ask('http://b')
    queue.clear()
    expect([await a, await b]).toEqual([false, false])
    expect(queue.current).toBeUndefined()
  })
})

describe('ExtensionConsentBar — 동의 띠 (시안 Ask, iframe 바깥에 앱이 그린다)', () => {
  const out = renderToStaticMarkup(createElement(ExtensionConsentBar, { name: 'SonarQube', origin: 'http://sonar.corp.local:9000', onAnswer: () => {} }))

  it('제목 · 고정폭 주소 · 보조 글 · [거절][허용]', () => {
    expect(out).toContain('role="alertdialog"')
    expect(out).toContain(ko('extensions.consent.title', { name: 'SonarQube' }))
    expect(out).toContain('<code>http://sonar.corp.local:9000</code>')
    expect(out).toContain(ko('extensions.consent.note'))
    expect(out).toContain(`>${ko('extensions.consent.deny')}</button>`)
    expect(out).toContain(`>${ko('extensions.consent.allow')}</button>`)
    expect(out.indexOf(`>${ko('extensions.consent.deny')}</button>`)).toBeLessThan(out.indexOf(`>${ko('extensions.consent.allow')}</button>`))
  })
})

describe('runBridgeCall — chat.compose (이슈 #557)', () => {
  it('메인이 통과시키면 새 대화를 열고 입력창을 채우게 알리고(보내지 않는다) 패널에는 null', async () => {
    const { deps: d, log } = deps({ results: [{ ok: true, result: { text: '고쳐 주세요' } }] })
    expect(await runBridgeCall({ id: 1, method: 'chat.compose', params: { text: '고쳐 주세요' } }, d)).toEqual({ ok: true, result: null })
    expect(log).toEqual(['call chat.compose {"text":"고쳐 주세요"}', 'compose 고쳐 주세요'])
  })

  it('메인이 거절하면(권한 없음 등) 열지 않는다', async () => {
    const { deps: d, log } = deps({ results: [{ ok: false, error: 'permission-missing' }] })
    expect(await runBridgeCall({ id: 1, method: 'chat.compose', params: { text: 'x' } }, d)).toEqual({ ok: false, error: 'permission-missing' })
    expect(log).toEqual(['call chat.compose {"text":"x"}'])
  })
})
