// 난수 채우기 (이슈 #211) — Hermes 에는 `crypto.getRandomValues` 가 없다. @noble 의 randomBytes 가 그것을 불러 Noise 임시 키를 만든다
// (shared/noiseNK.ts) — 없으면 블루투스 핸드셰이크가 "crypto.getRandomValues must be defined" 로 죽는다.
// 앱 시작 지점(index.ts)에서 expo-crypto 의 것(네이티브 SecureRandom)을 걸어 둔다. 이미 있으면(Node·나중의 Hermes) 건드리지 않는다.

/** 받은 배열을 난수로 채워 그대로 돌려준다 (noble 은 Uint8Array 로 부른다) */
type Fill = (array: Uint8Array) => unknown

/** target(기본 globalThis)에 getRandomValues 가 없으면 source 로 채운다. 채웠으면 true */
export function installRandomValues(source: Fill, target: { crypto?: unknown } = globalThis as { crypto?: unknown }): boolean {
  const existing = target.crypto as { getRandomValues?: unknown } | undefined
  if (typeof existing?.getRandomValues === 'function') return false
  if (existing && typeof existing === 'object') {
    Object.defineProperty(existing, 'getRandomValues', { value: source, configurable: true, writable: true })
  } else {
    Object.defineProperty(target, 'crypto', { value: { getRandomValues: source }, configurable: true, writable: true })
  }
  return true
}
