// 한글·한자·가나 문장에서 `**프로젝트명:**설명` 처럼 문장부호 옆 굵게를 닫게 하는 micromark 확장 (dsh ui-primitives
// markdown/cjkFriendlyStrong 참조 — 아이디어만 가져와 다시 썼다).
//
// CommonMark 는 `:**설` 의 `**` 를 닫는 쪽으로 안 본다 — 앞이 문장부호이고 뒤가 공백·문장부호가 아니면 "오른쪽 측면" 이 아니다.
// 영어는 단어 사이에 공백이 있어 문제가 안 되지만, 한국어 모델 답은 공백 없이 이어 써서 `**` 가 글자로 남는다.
// 그래서 `*` 두 개 이상이 (앞 문장부호 + 뒤 CJK 글자) 면 닫을 수 있게, (앞 CJK 글자 + 뒤 문장부호) 면 열 수 있게 넓힌다.
// 나머지 판단·짝 맞추기는 CommonMark attention 그대로다.

import { attention } from 'micromark-core-commonmark'
import { unicodePunctuation } from 'micromark-util-character'
import { classifyCharacter } from 'micromark-util-classify-character'
import { codes, constants } from 'micromark-util-symbol'
import type { Code, Construct, Extension, State, Tokenizer } from 'micromark-util-types'

const cjk = /\p{Script_Extensions=Han}|\p{Script_Extensions=Hangul}|\p{Script_Extensions=Hiragana}|\p{Script_Extensions=Katakana}/u

function isCjk(code: Code): boolean {
  return code !== null && code >= 0 && cjk.test(String.fromCodePoint(code))
}

const tokenize: Tokenizer = function (effects, ok, nok) {
  const markers = this.parser.constructs.attentionMarkers.null ?? []
  const previous = this.previous
  const before = classifyCharacter(previous)

  return start

  function start(code: Code): State | undefined {
    if (code !== codes.asterisk) return nok(code)
    effects.enter('attentionSequence')
    return inside(code)
  }

  function inside(code: Code): State | undefined {
    if (code === codes.asterisk) {
      effects.consume(code)
      return inside
    }
    const token = effects.exit('attentionSequence')
    const after = classifyCharacter(code)
    const strong = token.end.offset - token.start.offset >= 2
    // CommonMark 판단 (micromark-core-commonmark attention 과 같다)
    const open = !after || (after === constants.characterGroupPunctuation && Boolean(before)) || markers.includes(code)
    const close = !before || (before === constants.characterGroupPunctuation && Boolean(after)) || markers.includes(previous)
    token._open = open || (strong && isCjk(previous) && unicodePunctuation(code))
    token._close = close || (strong && unicodePunctuation(previous) && isCjk(code))
    return ok(code)
  }
}

const construct: Construct = { name: 'cjkStrong', tokenize, resolveAll: attention.resolveAll }

/** fromMarkdown 의 extensions 에 넣는다 — `*` 의 attention 을 이것으로 대신한다 */
export const cjkStrong: Extension = { text: { [codes.asterisk]: construct } }
