import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { INSTRUCTIONS_MAX_BYTES, instructionsNote, projectInstructions } from '../../src/services/instructions.ts'

// 프로젝트 지시문 사슬의 바이트 예산·.local.md (이슈 #176, dsh agent-instructions 의 아이디어만).
// 임시 폴더는 이 파일이 만든 base 아래에만 만들고 끝나면 그 경로만 지운다.

const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'litecode-instructions-')))
let seq = 0
afterAll(() => fs.rmSync(base, { recursive: true, force: true }))

/** git 루트(.git 폴더) 하나와 그 아래 sub 폴더. files 는 루트 기준 상대 경로 → 내용 */
function repo(files: Record<string, string>): { root: string; sub: string } {
  const root = path.join(base, `r${++seq}`)
  const sub = path.join(root, 'sub')
  fs.mkdirSync(path.join(root, '.git'), { recursive: true })
  fs.mkdirSync(sub, { recursive: true })
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(root, name), text)
  return { root, sub }
}

const block = (file: string, text: string) => `Instructions from: ${file}\n${text}`
const bytes = (text: string) => Buffer.byteLength(text, 'utf8')

describe('projectInstructions — 사슬 순서·.local.md', () => {
  it('작업 폴더에서 위로, 폴더마다 이긴 이름의 파일 다음에 AGENTS.local.md·CLAUDE.local.md 를 덧붙인다. AGENTS.md 가 있으면 CLAUDE.md 는 안 싣는다', async () => {
    const { root, sub } = repo({
      'AGENTS.md': 'root rules',
      'AGENTS.local.md': 'root mine',
      'CLAUDE.local.md': 'root claude mine',
      'CLAUDE.md': 'root claude',
      'sub/AGENTS.md': 'sub rules',
      'sub/CLAUDE.md': 'sub claude',
      'sub/AGENTS.local.md': 'sub mine',
    })
    expect(await projectInstructions(sub)).toBe(
      [
        block(path.join(sub, 'AGENTS.md'), 'sub rules'),
        block(path.join(sub, 'AGENTS.local.md'), 'sub mine'),
        block(path.join(root, 'AGENTS.md'), 'root rules'),
        block(path.join(root, 'AGENTS.local.md'), 'root mine'),
        block(path.join(root, 'CLAUDE.local.md'), 'root claude mine'),
      ].join('\n\n'),
    )
  })

  it('CLAUDE.md 사슬에도 .local.md 를 덧붙인다 (어느 이름이 이기는지는 기본 파일만 정한다)', async () => {
    const { root } = repo({ 'CLAUDE.md': 'claude', 'AGENTS.local.md': 'mine' })
    expect(await projectInstructions(root)).toBe([block(path.join(root, 'CLAUDE.md'), 'claude'), block(path.join(root, 'AGENTS.local.md'), 'mine')].join('\n\n'))
  })

  it('기본 파일 없이 .local.md 만 있어도 싣는다', async () => {
    const { root } = repo({ 'CLAUDE.local.md': 'only mine' })
    expect(await projectInstructions(root)).toBe(block(path.join(root, 'CLAUDE.local.md'), 'only mine'))
  })

  it('.local.md 가 없으면 전과 같다', async () => {
    const { root } = repo({ 'AGENTS.md': 'rules\n' })
    expect(await projectInstructions(root)).toBe(block(path.join(root, 'AGENTS.md'), 'rules\n'))
  })

  it('비어 있는(공백뿐인) .local.md 는 싣지 않는다', async () => {
    const { root } = repo({ 'AGENTS.md': 'rules', 'AGENTS.local.md': '', 'CLAUDE.local.md': ' \n\n' })
    expect(await projectInstructions(root)).toBe(block(path.join(root, 'AGENTS.md'), 'rules'))
    const { root: lonely } = repo({ 'AGENTS.local.md': '\n' })
    expect(await projectInstructions(lonely)).toBeUndefined()
  })
})

describe('projectInstructions — 바이트 예산', () => {
  it('기본 상한은 65,536바이트다', () => {
    expect(INSTRUCTIONS_MAX_BYTES).toBe(65_536)
  })

  it('상한 안이면 그대로, 정확히 상한이어도 그대로 (잘림 표시 없음)', async () => {
    const { root } = repo({ 'AGENTS.md': 'x' })
    const whole = block(path.join(root, 'AGENTS.md'), 'x')
    expect(await projectInstructions(root, bytes(whole) + 1)).toBe(whole)
    expect(await projectInstructions(root, bytes(whole))).toBe(whole)
  })

  it('기본 상한에서 정확히 상한이면 그대로, 1바이트 넘으면 자른다', async () => {
    const { root } = repo({})
    const head = `Instructions from: ${path.join(root, 'AGENTS.md')}\n`
    fs.writeFileSync(path.join(root, 'AGENTS.md'), 'a'.repeat(INSTRUCTIONS_MAX_BYTES - bytes(head)))
    expect(bytes((await projectInstructions(root))!)).toBe(INSTRUCTIONS_MAX_BYTES)
    fs.writeFileSync(path.join(root, 'AGENTS.md'), 'a'.repeat(INSTRUCTIONS_MAX_BYTES - bytes(head) + 1))
    const cut = (await projectInstructions(root))!
    expect(cut).toBe(`${head}${'a'.repeat(INSTRUCTIONS_MAX_BYTES - bytes(head))}\n\n(잘림: ${INSTRUCTIONS_MAX_BYTES + 1}바이트 중 ${INSTRUCTIONS_MAX_BYTES})`)
  })

  it('사슬 전체를 이어 붙인 뒤 자른다 — 위 폴더(넓은 쪽)가 먼저 잘린다', async () => {
    const { root, sub } = repo({ 'AGENTS.md': 'ROOT', 'sub/AGENTS.md': 'SUB' })
    const whole = [block(path.join(sub, 'AGENTS.md'), 'SUB'), block(path.join(root, 'AGENTS.md'), 'ROOT')].join('\n\n')
    const max = bytes(whole) - 2
    expect(await projectInstructions(sub, max)).toBe(`${whole.slice(0, -2)}\n\n(잘림: ${bytes(whole)}바이트 중 ${max})`)
  })

  it('한글(3바이트) 가운데에서 자르지 않는다 — 그 글자 앞까지만 남기고 남긴 바이트 수를 적는다', async () => {
    const { root } = repo({ 'AGENTS.md': '가나다' })
    const head = block(path.join(root, 'AGENTS.md'), '')
    const total = bytes(head) + 9
    for (const extra of [1, 2]) {
      // '가'(3바이트) 의 1·2바이트째에서 상한이 끝난다 → '가' 를 통째로 뺀다
      expect(await projectInstructions(root, bytes(head) + extra)).toBe(`${head}\n\n(잘림: ${total}바이트 중 ${bytes(head)})`)
    }
    // '가' 를 다 담고 '나' 의 1바이트째에서 끝난다 → '가' 까지
    const cut = (await projectInstructions(root, bytes(head) + 4))!
    expect(cut).toBe(`${head}가\n\n(잘림: ${total}바이트 중 ${bytes(head) + 3})`)
    expect(cut).not.toContain('�')
  })
})

describe('instructionsNote — 진행 줄 지시문 항목의 글', () => {
  const root = '/w/p'
  it('.local.md 도 없고 잘리지도 않았으면 없다', () => {
    expect(instructionsNote(undefined, root)).toBeUndefined()
    expect(instructionsNote(block('/w/p/AGENTS.md', 'rules'), root)).toBeUndefined()
  })

  it('.local.md 가 실렸으면 그 파일을 작업 폴더 기준으로 적는다', () => {
    const system = [block('/w/p/AGENTS.md', 'a'), block('/w/p/AGENTS.local.md', 'b'), block('/w/CLAUDE.local.md', 'c')].join('\n\n')
    expect(instructionsNote(system, root)).toBe('개인 지시문(.local.md)도 AI 에게 보냄 · AGENTS.local.md, ../CLAUDE.local.md')
  })

  it('잘렸으면 원래 바이트와 보낸 바이트를 적는다 (맥락 글이 뒤에 붙어 있어도 읽는다)', () => {
    const system = `${block('/w/p/AGENTS.md', 'aaa')}\n\n(잘림: 70000바이트 중 65536)\n\nbranch: main`
    expect(instructionsNote(system, root)).toBe('지시문이 길어 잘림 · 70000바이트 중 65536바이트만 보냄')
  })

  it('둘 다면 이어 적는다', () => {
    const system = `${block('/w/p/AGENTS.local.md', 'aaa')}\n\n(잘림: 9바이트 중 5)`
    expect(instructionsNote(system, root)).toBe('개인 지시문(.local.md)도 AI 에게 보냄 · AGENTS.local.md · 지시문이 길어 잘림 · 9바이트 중 5바이트만 보냄')
  })
})
