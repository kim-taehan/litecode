// 입력 카드 주변 팝업(모드 칩·모델 선택·+ 메뉴, 이슈 #374)이 닫히면 포커스는 입력창으로 — 트리거 버튼에 남으면
// 마우스를 다시 대야 쓰기 때문이다. 팝업은 늘 컴포저 안에서 열리므로 클래스로 찾는다.

/** 컴포저의 입력창 — 지금은 컴포저가 그려지지 않는 화면(추론 과정 탭)이면 없다 */
export function composerInput(): HTMLTextAreaElement | null {
  return document.querySelector<HTMLTextAreaElement>('.composer__input')
}

/** 팝업 닫힌 뒤 포커스를 입력창으로 건다 — 입력창이 없으면 false (호출 쪽이 트리거 버튼으로 돌린다) */
export function focusComposerInput(): boolean {
  const input = composerInput()
  if (!input) return false
  input.focus()
  return true
}
