// 새 provider 의 id — 표시 이름에서 만든다 (영숫자만, 겹치면 -2, -3…). 서비스가 정하고, 설정 화면은 같은 규칙으로
// 미리 보여준다 (추가 카드의 읽기 전용 id). 한 번 정한 id 는 바꾸지 않는다 — opencode providerID 로 넘어간다.
export function providerIdFor(displayName: string, taken: (id: string) => boolean): string {
  const base = displayName.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'provider'
  let id = base
  for (let n = 2; taken(id); n++) id = `${base}-${n}`
  return id
}
