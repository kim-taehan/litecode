import { translate, type Language, type MessageKey } from '../shared/i18n/index.ts'

// 메인 프로세스 문구 번역 — 오류는 IPC 를 지나면 message 문자열만 남는다(구조화 코드를 못 넘긴다, 01f). 그래서 메인이 지금 언어로
// 번역해서 던진다. 언어는 ctx.settings 가 올라올 때와 바뀔 때 넣는다. 서비스만 따로 돌릴 때(단위 테스트)는 키 정본 사전(ko).
// console 로그·opencode·게이트웨이가 준 원문 오류는 번역하지 않는다. 턴 도중 언어를 바꾸면 그 턴의 문구는 이전 언어일 수 있다(받아들임).

let current: Language = 'ko'

export function setMainLanguage(language: Language): void {
  current = language
}

export function tr(key: MessageKey, vars?: Record<string, string | number>): string {
  return translate(current, key, vars)
}
