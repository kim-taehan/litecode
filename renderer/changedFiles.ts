import type { FileDiff, TurnItem } from '../shared/contract.ts'

// 턴 끝 "AI 가 고친 파일" 카드 (이슈 #82) 의 데이터 — 새 데이터는 없다: 성공한 도구 줄에 실린 diff(toolDiffs — edit·write·apply_patch)를
// 턴 단위로 파일별로 묶는다. 실시간 턴과 다시 연 대화가 같은 줄(TurnItem)을 쓰므로 같은 함수로 같은 카드가 나온다.
//
// 한계 (실측 _workspace/01ad_changed_files.md 5절) — 카드가 그대로 말한다:
// - 명령(bash — sed·rm·mv·포매터)으로 바꾼 파일은 통째로 빠진다. 그래서 "바뀐 파일" 이 아니라 "AI 가 고친 파일" 이다
// - 같은 파일을 여러 번 고치면 줄 수는 호출별 합이라 실제 순 변경보다 클 수 있다 (line1→ONE→UNO 는 순 +1−1, 합 +2−2) → 횟수를 같이 보인다
// - 만들었다 지웠거나 고쳤다 되돌린 파일도 고친 것으로 나온다
// 엔진의 턴 요약(user 메시지 info.summary.diffs — snapshot 을 켜야 나온다, 지금은 꺼 둠)으로 갈아 끼울 자리가 이 함수다:
// 그때는 source 'engine' 을 더하고 화면은 source 로 안내 문구를 가른다
//
// 명령으로 바뀐 파일 (이슈 #213): 메인이 턴 앞뒤 git 스냅숏 차이를 턴 끝 줄 하나(kind 'changes')로 싣는다(src/services/commandChanges.ts).
// 도구 diff 가 있는 파일은 도구 쪽을 쓰고(호출별 diff·횟수가 더 자세하다), 도구가 안 건드린 파일만 더한다. 그 줄이 있으면(commands)
// 카드가 "명령으로 바뀐 파일도" 라고 말하고, 없으면(git 저장소 아님·git 없음·시간 초과·다시 연 대화) 위 한계 그대로다

/** 파일 하나 — 이 턴에서 고친 것의 합 */
export interface ChangedFile {
  /** 세션 폴더 기준 상대 경로 (밖이면 절대) — FileDiff.path 그대로 */
  path: string
  /** 이 턴에 만들었으면(뒤에 또 고쳐도) added, 마지막이 삭제면 deleted */
  status: FileDiff['status']
  /** 호출별 줄 수의 합 */
  added: number
  removed: number
  /** 덮어쓰기(write)가 끼어 삭제 줄 수를 모른다 */
  unknownBefore: boolean
  /** 고친 횟수 */
  edits: number
  /** 그 파일의 diff 들 (시간순) */
  diffs: FileDiff[]
}

export interface TurnChanges {
  /** 처음 손댄 순서 */
  files: ChangedFile[]
  added: number
  removed: number
  unknownBefore: boolean
  /** tools: 도구 줄을 모은 것 — 명령으로 바꾼 파일은 commands 일 때만 들어 있다 */
  source: 'tools'
  /** 턴 앞뒤 git 스냅숏을 비교했다 — 명령으로 바뀐 파일도 들어 있다 */
  commands: boolean
  /** 스냅숏이 상한에 걸려 명령으로 바뀐 파일은 일부만 들어 있다 */
  truncated: boolean
}

/** 카드가 한 번에 보이는 파일 수 — 넘으면 접고 "N개 더" */
export const CHANGED_FILES_FOLD = 8

/** 턴의 진행 줄(하위 작업 안 포함) → 고친 파일들. 성공한 도구 줄만 센다. 하나도 없으면 undefined (카드를 그리지 않는다) */
export function changedFiles(items: readonly TurnItem[]): TurnChanges | undefined {
  const files = new Map<string, ChangedFile>()
  collect(items, files)
  const snapshots = items.filter((item): item is Extract<TurnItem, { kind: 'changes' }> => item.kind === 'changes')
  for (const diff of snapshots.flatMap((item) => item.diffs)) {
    if (!files.has(diff.path)) files.set(diff.path, fileOf(diff)) // 도구 diff 가 있는 파일은 도구 쪽
  }
  if (files.size === 0) return undefined
  const list = [...files.values()]
  return {
    files: list,
    added: list.reduce((sum, file) => sum + file.added, 0),
    removed: list.reduce((sum, file) => sum + file.removed, 0),
    unknownBefore: list.some((file) => file.unknownBefore),
    source: 'tools',
    commands: snapshots.length > 0,
    truncated: snapshots.some((item) => item.truncated === true),
  }
}

function fileOf(diff: FileDiff): ChangedFile {
  return { path: diff.path, status: diff.status, added: diff.added, removed: diff.removed, unknownBefore: diff.unknownBefore === true, edits: 1, diffs: [diff] }
}

function collect(items: readonly TurnItem[], files: Map<string, ChangedFile>): void {
  for (const item of items) {
    if (item.kind === 'subtask') collect(item.items, files)
    if (item.kind !== 'tool' || item.status !== 'done' || !item.diffs) continue
    for (const diff of item.diffs) {
      const file = files.get(diff.path)
      if (!file) {
        files.set(diff.path, fileOf(diff))
        continue
      }
      // 이 턴에 만든 파일은 뒤에 고쳐도 새 파일이다. 지웠으면 삭제, 지운 자리에 다시 썼으면 그 상태
      if (diff.status === 'deleted' || file.status !== 'added') file.status = diff.status
      file.added += diff.added
      file.removed += diff.removed
      file.unknownBefore ||= diff.unknownBefore === true
      file.edits++
      file.diffs.push(diff)
    }
  }
}

/** 줄에 보일 이름과 흐리게 보일 폴더 */
export function splitPath(path: string): { name: string; folder: string } {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return cut === -1 ? { name: path, folder: '' } : { name: path.slice(cut + 1), folder: path.slice(0, cut) }
}
