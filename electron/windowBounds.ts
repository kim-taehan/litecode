// 창 크기·위치 기억 (참고 레포 검토 02x E) — 닫을 때 userData/window.json 에 적고 다음 실행에 되돌린다.
// 저장한 자리가 지금 화면 밖일 수 있다(모니터를 뺐다·해상도가 바뀌었다) — 그대로 되돌리면 못 찾는 창이 뜨므로 보이는지 먼저 본다.
// electron 을 import 하지 않는다(단위 테스트) — 화면 목록은 main.ts 가 screen 에서 읽어 넘긴다. 최대화·전체 화면 여부는 기억하지 않는다

export interface Bounds {
  x: number
  y: number
  width: number
  height: number
}

/** 이보다 작게 저장된 것은 믿지 않는다 */
const MIN_WIDTH = 400
const MIN_HEIGHT = 300
/** 어느 화면에든 이만큼은 걸쳐 있어야 잡아 끌 수 있다 */
const MIN_VISIBLE = 100

/** 저장된 값이 쓸 만하고 지금 화면 어딘가에 보이면 그 자리, 아니면 undefined (기본 크기로 가운데) */
export function restorableBounds(saved: unknown, workAreas: readonly Bounds[]): Bounds | undefined {
  const { x, y, width, height } = (saved ?? {}) as Partial<Record<keyof Bounds, unknown>>
  if (![x, y, width, height].every((value): value is number => typeof value === 'number' && Number.isFinite(value))) return undefined
  const bounds = { x: x as number, y: y as number, width: width as number, height: height as number }
  if (bounds.width < MIN_WIDTH || bounds.height < MIN_HEIGHT) return undefined
  const visible = workAreas.some((area) => {
    const overlapX = Math.min(bounds.x + bounds.width, area.x + area.width) - Math.max(bounds.x, area.x)
    const overlapY = Math.min(bounds.y + bounds.height, area.y + area.height) - Math.max(bounds.y, area.y)
    return overlapX >= MIN_VISIBLE && overlapY >= MIN_VISIBLE
  })
  return visible ? bounds : undefined
}
