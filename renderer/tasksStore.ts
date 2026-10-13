import { useSyncExternalStore } from 'react'
import type { Subtask } from '../shared/ipc.ts'

// 백그라운드 하위 작업 목록 (이슈 #319) — 대화 id → 작업 줄. 작업 줄(JobsDock)과 오른쪽 패널의 작업 탭(#325)이 같이 본다:
// 처음 쓰일 때 한 번 스냅샷(chat:tasks-snapshot)을 받고, 그 뒤로는 알림(chat:tasks)으로. 화면이 다시 뜨면 스냅샷으로 이어 그린다

type TaskMap = Readonly<Record<string, Subtask[]>>

let all: TaskMap = {}
let started = false
const listeners = new Set<() => void>()

function set(next: TaskMap): void {
  all = next
  for (const listener of listeners) listener()
}

function start(): void {
  if (started) return
  started = true
  let heard = false
  window.litecode.onTasksChanged((cid, tasks) => {
    heard = true
    set({ ...all, [cid]: tasks })
  })
  void window.litecode.taskSnapshot().then(
    (snapshot) => !heard && set(snapshot),
    () => {},
  )
}

function subscribe(listener: () => void): () => void {
  start()
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useTaskMap(): TaskMap {
  return useSyncExternalStore(subscribe, () => all)
}

/** 작업 id(`bgtask:<대화>:<번호>`)로 찾는다 — 끝난 작업이 밀려났거나(메인은 대화마다 최근 10개) 대화가 지워졌으면 undefined */
export function findTask(map: TaskMap, taskId: string): Subtask | undefined {
  for (const list of Object.values(map)) {
    const found = list.find((task) => task.id === taskId)
    if (found) return found
  }
  return undefined
}
