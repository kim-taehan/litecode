import { randomInt } from 'node:crypto'
import { PAIR_ALPHABET, PAIR_CODE_LENGTH, PAIR_SHORT_CODE_LENGTH } from '../../../shared/remotePairing.ts'

// 짝짓기 코드 (01t 3절) — 한 번 발급에 둘: QR 에 싣는 12자 Crockford base32(60bit)와 직접 입력용 숫자 2자리.
// 둘은 한 세션이다 — 2분·1회용이고 둘을 합쳐 틀린 시도 3회째에 폐기한다. 그 규칙은 서비스(remote.ts)가 쥔다. 여기는 글자만 다룬다.
// 글자 규칙(정규화·네 글자씩·확인 코드)의 정의는 shared/remotePairing.ts 에 있다 — 폰 앱이 같은 함수로 같은 확인 코드를 낸다 (이슈 #62).
// 여기 남은 것은 Node 의 난수가 필요한 코드 만들기뿐이다.

export { confirmCode, groupCode, normalizePairCode, PAIR_CODE_LENGTH } from '../../../shared/remotePairing.ts'

export function newPairCode(): string {
  return Array.from({ length: PAIR_CODE_LENGTH }, () => PAIR_ALPHABET[randomInt(PAIR_ALPHABET.length)]).join('')
}

/** 직접 입력용 숫자 2자리 (00~99, crypto.randomInt — 고르게) */
export function newShortPairCode(): string {
  return String(randomInt(10 ** PAIR_SHORT_CODE_LENGTH)).padStart(PAIR_SHORT_CODE_LENGTH, '0')
}
