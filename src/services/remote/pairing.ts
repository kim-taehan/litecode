import { createHash, randomInt } from 'node:crypto'

// 짝짓기 코드 (01t 3절) — 직접 입력용 12자 Crockford base32(60bit). 사람이 읽고 치는 글자라 헷갈리는 I·L·O·U 가 없다.
// 코드는 2분·1회용이고 틀리면 5회째에 폐기한다 — 그 규칙은 서비스(remote.ts)가 쥔다. 여기는 글자만 다룬다.

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
export const PAIR_CODE_LENGTH = 12

export function newPairCode(): string {
  return Array.from({ length: PAIR_CODE_LENGTH }, () => ALPHABET[randomInt(ALPHABET.length)]).join('')
}

/** 사람이 친 코드를 견줄 모양으로 — 대문자, 칸 나눔(공백·-) 제거, Crockford 규칙대로 O→0 · I/L→1 */
export function normalizePairCode(input: string): string {
  return input
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1')
}

/** 화면에 보일 모양 — 네 글자씩 */
export function groupCode(code: string): string {
  return code.match(/.{1,4}/g)?.join('-') ?? code
}

/**
 * 확인 코드 8자 — 데스크탑 [허용] 확인과 폰 화면에 같은 글자가 보여야 한다. 이번 라운드엔 TLS 지문이 없어(루프백 평문)
 * 요청 자체에서 만든다: sha256("litecode-pair\n" + 코드 + "\n" + 기기 이름 + "\n" + 플랫폼) 의 앞 40bit 를 Crockford base32 8자로.
 * 폰도 같은 식으로 계산할 수 있다. TLS 라운드에서는 인증서 지문 앞 8자로 바뀐다 (01t 3절)
 */
export function confirmCode(code: string, deviceName: string, platform: string): string {
  const digest = createHash('sha256').update(`litecode-pair\n${code}\n${deviceName}\n${platform}`).digest()
  let bits = 0n
  for (const byte of digest.subarray(0, 5)) bits = (bits << 8n) | BigInt(byte)
  let text = ''
  for (let index = 7; index >= 0; index--) text += ALPHABET[Number((bits >> BigInt(index * 5)) & 31n)]
  return groupCode(text)
}
