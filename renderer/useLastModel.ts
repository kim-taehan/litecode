import { useEffect, useState } from 'react'
import { parseModelRef, type ModelRef } from './modelChoice.ts'

/** 마지막으로 고른 모델 — 새 대화가 이것으로 시작한다(재시작해도). 같은 편의 설정이라 localStorage 에 둔다 */
const LAST_MODEL_KEY = 'litecode.model'

function readLastModel(): ModelRef | undefined {
  try {
    return parseModelRef(localStorage.getItem(LAST_MODEL_KEY))
  } catch {
    return undefined
  }
}

/** 마지막으로 고른 모델 — 바뀌면 localStorage 에 적는다 */
export function useLastModel() {
  const [lastModel, setLastModel] = useState(readLastModel)
  useEffect(() => {
    if (!lastModel) return
    try {
      localStorage.setItem(LAST_MODEL_KEY, JSON.stringify(lastModel))
    } catch {
      // 못 쓰면 이번 실행 동안만 기억한다
    }
  }, [lastModel])
  return [lastModel, setLastModel] as const
}
