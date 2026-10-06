import { useEffect, useState } from 'react'

/** 1초마다 지금 시각 — on 일 때만 돈다 */
export function useNow(on: boolean): number {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (!on) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1_000)
    return () => clearInterval(timer)
  }, [on])
  return now
}
