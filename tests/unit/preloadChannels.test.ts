import fs from 'node:fs'
import { describe, expect, it } from 'vitest'
import { Channel } from '../../shared/ipc.ts'

// preload 는 CJS 라 shared/ipc.ts 를 import 하지 못하고 Channel 을 손으로 옮겨 적는다 (CLAUDE.md 아키텍처 함정 3).
// 철자가 하나 틀려도 typecheck 는 초록이고 런타임에서 그 채널만 "No handler registered" 로 죽는다 — 글자로 읽어 대조한다.

function preloadChannels(): Record<string, string> {
  const source = fs.readFileSync(new URL('../../electron/preload.cts', import.meta.url), 'utf8')
  const block = /^const Channel = \{\n([\s\S]*?)^\}/m.exec(source)
  if (!block) throw new Error('preload.cts 에서 const Channel = { … } 를 찾지 못했다')
  const entries: [string, string][] = []
  for (const line of block[1]!.split('\n')) {
    if (!line.trim()) continue
    const entry = /^\s*([A-Z0-9_]+): '([^']*)',?$/.exec(line)
    // 모르는 모양의 줄을 건너뛰면 그 채널이 대조에서 빠진다 — 실패시킨다
    if (!entry) throw new Error(`preload.cts Channel 의 읽을 수 없는 줄: ${line}`)
    entries.push([entry[1]!, entry[2]!])
  }
  return Object.fromEntries(entries)
}

describe('preload Channel 복사본', () => {
  it('shared/ipc.ts 의 Channel 과 이름·값이 모두 같다', () => {
    const copy = preloadChannels()
    expect(Object.keys(copy).length).toBeGreaterThan(0)
    expect(copy).toEqual({ ...Channel })
  })
})
