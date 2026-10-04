// 대화별 읽던 자리 (dsh ui-chat "Scroll ownership") — 대화(·탭)를 바꿨다 돌아오면 위로 올려 읽던 자리로 되돌린다.
// 맨 아래를 따라가던 대화는 적지 않는다: 돌아오면 맨 아래다 (그사이 답이 늘었어도 끝을 본다). 처음 여는 대화도 기억이 없어 맨 아래.
// 화면이 떠 있는 동안만 기억한다

export class ScrollMemory {
  private readonly tops = new Map<string, number>()

  /** following: 맨 아래를 따라가는 중. 아니면 top(scrollTop)을 적는다 */
  remember(key: string, following: boolean, top: number): void {
    if (following) this.tops.delete(key)
    else this.tops.set(key, top)
  }

  /** 되돌릴 scrollTop — 없으면 맨 아래 */
  recall(key: string): number | undefined {
    return this.tops.get(key)
  }
}
