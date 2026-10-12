import { Context, Service } from 'cordis'
import { describe, expect, it } from 'vitest'
import type { TerminalEvents, TerminalHandle } from '../../src/services/opencodePty.ts'
import { TerminalsService } from '../../src/services/terminals.ts'

// 터미널 (이슈 #303) — 서비스의 규칙: 폴더별 id(탭 이름 터미널 1·2·…), 출력은 메인이 쌓아 두고, 이벤트는 (폴더, id)로 실린다,
// 셸이 끝나면(exit) 그 번호는 지워진다, 앱 MCP open(터미널) 은 맨 마지막 연 것을 재사용한다. 엔진(ctx.llm.openTerminal)은 가짜.

interface FakeShell {
  written: string[]
  resizeCalls: [number, number][]
  closed: boolean
  emit(chunk: string): void
  kill(): void
}

/** ctx.llm 가짜 — openTerminal 만 갖고, 셸이 내보낸 글자·끝남은 테스트가 부른다 */
class FakeLlm extends Service {
  shells: FakeShell[] = []
  constructor(ctx: Context) {
    super(ctx, 'llm')
  }
  async openTerminal(_directory: string, on: TerminalEvents): Promise<TerminalHandle> {
    const shell: FakeShell = {
      written: [],
      resizeCalls: [],
      closed: false,
      emit: (chunk) => on.data(chunk),
      kill: () => on.exit(),
    }
    this.shells.push(shell)
    return {
      write: (data) => shell.written.push(data),
      resize: async (rows, cols) => void shell.resizeCalls.push([rows, cols]),
      close: () => {
        shell.closed = true
        shell.kill()
      },
    }
  }
}

async function start() {
  const ctx = new Context()
  ctx.plugin(FakeLlm)
  const fiber = ctx.plugin(TerminalsService)
  const ready = await new Promise<Context>((resolve) => ctx.inject(['llm', 'terminals'], resolve))
  const data: [string, number, string, number][] = []
  const exits: [string, number][] = []
  ctx.on('terminal/data', (directory, id, chunk, end) => void data.push([directory, id, chunk, end]))
  ctx.on('terminal/exit', (directory, id) => void exits.push([directory, id]))
  return {
    llm: ready.llm as unknown as FakeLlm,
    terminals: ready.terminals,
    data,
    exits,
    dispose: async () => {
      await fiber.dispose() // effect 정리 — 여는 셸 전체를 close
    },
  }
}

describe('open — id 는 폴더별로 1부터', () => {
  it('같은 폴더는 이어지고, 다른 폴더는 다시 1부터', async () => {
    const { terminals, dispose } = await start()
    expect((await terminals.open('/a')).id).toBe(1)
    expect((await terminals.open('/a')).id).toBe(2)
    expect((await terminals.open('/b')).id).toBe(1)
    expect((await terminals.open('/a')).id).toBe(3)
    await dispose()
  })
})

describe('출력 쌓기·이벤트 (folder, id)', () => {
  it('attach 는 쌓인 출력과 끝 위치를 준다 — open 당장은 비어 있다', async () => {
    const { llm, terminals, data, dispose } = await start()
    const opened = await terminals.open('/a')
    expect(opened).toEqual({ id: 1, output: '', end: 0 })
    llm.shells[0]!.emit('hello ')
    llm.shells[0]!.emit('world')
    expect(data).toEqual([
      ['/a', 1, 'hello ', 6],
      ['/a', 1, 'world', 11],
    ])
    expect(await terminals.attach('/a', 1)).toEqual({ output: 'hello world', end: 11 })
    await dispose()
  })

  it('둘을 열었으면 각 번호의 출력·이벤트만 자기 번호에', async () => {
    const { llm, terminals, data, dispose } = await start()
    const one = await terminals.open('/a')
    const two = await terminals.open('/a')
    llm.shells[0]!.emit('A')
    llm.shells[1]!.emit('B')
    llm.shells[1]!.emit('B2')
    expect(data).toEqual([
      ['/a', one.id, 'A', 1],
      ['/a', two.id, 'B', 1],
      ['/a', two.id, 'B2', 3], // end 는 그 번호의 누적 — 'B'(1) + 'B2'(2)
    ])
    expect(await terminals.attach('/a', one.id)).toEqual({ output: 'A', end: 1 })
    expect(await terminals.attach('/a', two.id)).toEqual({ output: 'BB2', end: 3 })
    await dispose()
  })

  it('출력 상한(256KB)을 넘으면 앞을 잘라 끝 위치는 계속 온다', async () => {
    const { llm, terminals, dispose } = await start()
    await terminals.open('/a')
    llm.shells[0]!.emit('a'.repeat(256 * 1024 + 10))
    const attached = (await terminals.attach('/a', 1))!
    expect(attached.output).toHaveLength(256 * 1024)
    expect(attached.output.startsWith('a')).toBe(true)
    expect(attached.end).toBe(256 * 1024 + 10)
    await dispose()
  })
})

describe('write·resize·close — 해당 번호로만', () => {
  it('키·크기는 자기 번호의 셸로만, 끝난 번호는 건드리지 않는다', async () => {
    const { llm, terminals, dispose } = await start()
    const one = await terminals.open('/a')
    const two = await terminals.open('/a')
    await terminals.write('/a', one.id, 'ls')
    await terminals.write('/a', two.id, 'pwd')
    expect(llm.shells[0]!.written).toEqual(['ls'])
    expect(llm.shells[1]!.written).toEqual(['pwd'])
    await terminals.resize('/a', two.id, 30, 100)
    expect(llm.shells[0]!.resizeCalls).toEqual([])
    expect(llm.shells[1]!.resizeCalls).toEqual([[30, 100]])
    await terminals.close('/a', one.id)
    await terminals.write('/a', one.id, 'nope')
    await terminals.resize('/a', one.id, 1, 1)
    await terminals.close('/a', one.id) // 이미 없으면 아무 일도 없다
    expect(llm.shells[0]!.written).toEqual(['ls'])
    expect(llm.shells[0]!.resizeCalls).toEqual([])
    await dispose()
  })
})

describe('셸 끝 — exit·닫기', () => {
  it('셸이 끝나면 그 번호만 지워진다 (exit 이벤트에 번호가 실린다) — 다른 번호는 그대로', async () => {
    const { llm, terminals, exits, dispose } = await start()
    const one = await terminals.open('/a')
    const two = await terminals.open('/a')
    llm.shells[0]!.kill()
    expect(exits).toEqual([['/a', 1]])
    expect(await terminals.attach('/a', one.id)).toBeUndefined()
    expect(await terminals.attach('/a', two.id)).toEqual({ output: '', end: 0 })
    expect(terminals.list('/a')).toEqual([two.id])
    await dispose()
  })

  it('탭 닫기(close) 도 셸을 끝낸다 — exit 이벤트가 나가고 list 에서 빠진다', async () => {
    const { terminals, exits, dispose } = await start()
    await terminals.open('/a')
    await terminals.open('/a')
    expect(terminals.list('/a')).toEqual([1, 2])
    await terminals.close('/a', 2)
    expect(exits).toEqual([['/a', 2]])
    expect(terminals.list('/a')).toEqual([1])
    await dispose()
  })
})

describe('openOrReuse — 앱 MCP open(터미널)', () => {
  it('켜져 있으면 맨 마지막 연 것을 쓰고, 없으면 새로 연다', async () => {
    const { terminals, dispose } = await start()
    expect(await terminals.openOrReuse('/a')).toBe(1)
    expect(await terminals.openOrReuse('/a')).toBe(1) // 새로 안 연다
    const second = await terminals.open('/a')
    expect(second.id).toBe(2)
    expect(await terminals.openOrReuse('/a')).toBe(2) // 맨 마지막 연 것
    await dispose()
  })
})
