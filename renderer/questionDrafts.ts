// 질문 카드에 쓰던 답 — 카드(QuestionCard)는 대화를 바꾸거나 탭을 옮기면 내려가 로컬 state 를 잃는다. 요청 id 로 따로 쥐어
// 돌아오면 그대로 보이게 한다 (dsh ui-user-questions 의 초안 보존). 메모리에만 — 다시 불러오면 사라진다.
// 요청이 풀리면(답했다·거절했다·턴이 끝났다) keepOnly 로 버린다

export class QuestionDrafts<T> {
  private readonly drafts = new Map<string, T>()

  load(requestId: string): T | undefined {
    return this.drafts.get(requestId)
  }

  save(requestId: string, draft: T): void {
    this.drafts.set(requestId, draft)
  }

  /** 아직 기다리는 요청의 초안만 남긴다 */
  keepOnly(pending: readonly string[]): void {
    for (const id of [...this.drafts.keys()]) if (!pending.includes(id)) this.drafts.delete(id)
  }
}
