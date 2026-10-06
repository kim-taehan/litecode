import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core'
import { createServer, type ViteDevServer } from 'vite'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import { freePort, isolatedEnv } from './support/opencodeServer.ts'
import type { Launch } from '../../src/services/openIn.ts'

// 파일 미리보기 패널 실물 테스트 (이슈 #17) — 진짜 Electron 창에서 가짜 LLM 이 echo 한 답의 파일 칩을 눌러, 렌더러 → preload
// (chat:preview-file) → 메인 검사(등록 프로젝트·realpath·크기·이진) → 패널까지 관통하는지 본다. Finder·다른 앱은 띄우지
// 않는다(reveal 은 기록, openIn 실행기는 숨김 테스트 모드의 기록기). 자기 앱·vite·임시 폴더를 띄우고, 끝나면 그 임시 폴더만 지운다.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

let vite: ViteDevServer
let app: ElectronApplication
let page: Page
/** 이 테스트가 만든 임시 폴더 — 끝나면 이 경로만 지운다 */
let tmp: string
let userData: string
let project: string
let outside: string

const HELLO = 'export const a = 1\nexport const b = 2\nconsole.log(a + b)\n'
const README = '# 제목\n\n본문 **굵게** 와 `src/hello.ts`\n'
const BIG_LINE = 'x'.repeat(99) + '\n' // 100 바이트
const BIG = BIG_LINE.repeat(15_000) // 1.5MB — 한도(1MB) 넘음

beforeAll(async () => {
  execFileSync(path.join(root, 'node_modules/.bin/tsc'), ['-p', 'tsconfig.electron.json'], { cwd: root, stdio: 'inherit' })
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'litecode-file-preview-')))
  userData = path.join(tmp, 'userData')
  project = path.join(tmp, 'preview-app')
  outside = path.join(tmp, 'outside')
  await fs.mkdir(path.join(project, 'src'), { recursive: true })
  await fs.mkdir(outside)
  await fs.writeFile(path.join(outside, 'secret.txt'), 'TOP-SECRET-OUTSIDE\n')
  await fs.writeFile(path.join(project, 'src', 'hello.ts'), HELLO)
  await fs.writeFile(path.join(project, 'README.md'), README)
  await fs.writeFile(path.join(project, 'link.ts'), 'inside for now\n') // 칩이 그려진 뒤 밖을 가리키는 링크로 바꾼다
  await fs.writeFile(path.join(project, 'big.txt'), BIG)
  await fs.writeFile(path.join(project, 'bin.dat'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00, 0x01, 0x02]))

  const port = await freePort()
  vite = await createServer({ configFile: path.join(root, 'vite.config.ts'), server: { port, strictPort: true } })
  await vite.listen()
  app = await electron.launch({
    args: ['.', `--user-data-dir=${userData}`, '--use-mock-keychain'],
    cwd: root,
    env: {
      ...isolatedEnv(tmp),
      LITECODE_TEST_HIDDEN: '1',
      LITECODE_DEV_SERVER_URL: `http://localhost:${port}`,
      LITECODE_GATEWAY_URL: `${inject('fakeLlmUrl')}/v1`,
    },
  })
  page = await app.firstWindow()
  await page.locator('.sidebar-toggle:visible').waitFor()
  await app.evaluate(({ dialog, shell }, picked) => {
    const state = globalThis as { revealed?: string[] }
    state.revealed = []
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [picked] })) as typeof dialog.showOpenDialog
    shell.showItemInFolder = (file: string) => void state.revealed!.push(file)
  }, project)
  await page.evaluate(() => {
    const state = window as unknown as { copied: string[] }
    state.copied = []
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (text: string) => void state.copied.push(text) } })
  })
  await page.locator('.open-guide').getByRole('button', { name: '폴더 열기…' }).click()
  await page.getByPlaceholder('메시지를 입력하세요…').waitFor({ timeout: 10_000 })
  // 가짜 LLM 은 "echo: <보낸 글>" 로 답한다 — 인라인 코드가 그대로 답에 실려 칩이 된다
  await page.getByPlaceholder('메시지를 입력하세요…').fill('파일 `src/hello.ts` `README.md` `link.ts` `big.txt` `bin.dat`')
  await page.keyboard.press('Enter')
  await page.locator('.bubble--assistant .md-file').nth(4).waitFor({ timeout: 30_000 })
})

afterAll(async () => {
  await app?.close()
  await vite?.close()
  if (tmp) await fs.rm(tmp, { recursive: true, force: true })
})

const panel = () => page.locator('.file-preview')
const chip = (name: string) => page.locator('.bubble--assistant .md-file', { hasText: name }).first()
const launches = () => app.evaluate(() => (globalThis as unknown as { __litecodeOpenInTest: { launches: Launch[] } }).__litecodeOpenInTest.launches)

describe('파일 미리보기 패널', () => {
  it('칩을 누르면 채팅 오른쪽에 패널 — 머리에 경로, 본문은 줄 번호 + 내용. 첫 폭은 창의 45%', async () => {
    await chip('src/hello.ts').click()
    await panel().waitFor()
    expect(await panel().locator('.file-preview__path').textContent()).toBe('src/hello.ts')
    expect(await panel().locator('.file-preview__path').getAttribute('title')).toBe(path.join(project, 'src', 'hello.ts'))
    expect(await panel().locator('.file-preview__gutter').textContent()).toBe('1\n2\n3')
    expect(await panel().locator('.file-preview__text').textContent()).toBe(HELLO.slice(0, -1))
    const main = (await page.locator('main.main').boundingBox())!
    const box = (await panel().boundingBox())!
    expect(Math.round(box.x)).toBe(Math.round(main.x + main.width)) // 대화 칸 바로 오른쪽
    const viewport = await page.evaluate(() => window.innerWidth)
    expect(Math.abs(box.width - viewport * 0.45)).toBeLessThan(2)
    // 머리 높이가 대화 머리와 같다 — 두 밑줄이 이어진다
    expect((await panel().locator('.file-preview__head').boundingBox())!.height).toBe((await page.locator('.main__header').boundingBox())!.height)
  })

  it('머리 버튼 — Finder에서 보기(기록), 경로 복사(절대 경로)', async () => {
    await panel().getByRole('button', { name: 'Finder에서 보기' }).click()
    await expect.poll(() => app.evaluate(() => (globalThis as { revealed?: string[] }).revealed ?? [])).toEqual([path.join(project, 'src', 'hello.ts')])
    await panel().getByRole('button', { name: '경로 복사' }).click()
    expect(await page.evaluate(() => (window as unknown as { copied: string[] }).copied)).toEqual([path.join(project, 'src', 'hello.ts')])
    await expect.poll(() => panel().locator('.file-preview__copy').getAttribute('aria-label'), { timeout: 1_000 }).toBe('복사됨')
  })

  it('다른 칩을 누르면 내용이 바뀐다 — .md 는 마크다운(안의 칩도 살아 있음), 원문 보기로 줄 번호', async () => {
    await chip('README.md').click()
    await expect.poll(() => panel().locator('.file-preview__path').textContent()).toBe('README.md')
    expect(await panel().locator('.file-preview__md h1').textContent()).toBe('제목')
    expect(await panel().locator('.file-preview__md strong').textContent()).toBe('굵게')
    await expect.poll(() => panel().locator('.file-preview__md .md-file').count()).toBe(1)
    await page.screenshot({ path: path.join(root, 'shots', 'file-preview-md.png') })
    await panel().getByRole('button', { name: '원문 보기' }).click()
    await page.screenshot({ path: path.join(root, 'shots', 'file-preview-source.png') })
    expect(await panel().locator('.file-preview__gutter').textContent()).toBe('1\n2\n3')
    expect(await panel().locator('.file-preview__text').textContent()).toBe(README.slice(0, -1))
    await panel().getByRole('button', { name: '마크다운으로 보기' }).click()
    // 패널 안 마크다운의 칩 → 그 파일로
    await panel().locator('.file-preview__md .md-file').click()
    await expect.poll(() => panel().locator('.file-preview__path').textContent()).toBe('src/hello.ts')
  })

  it('1MB 넘는 파일은 앞부분만 + 안내, 이진 파일은 "미리볼 수 없음"', async () => {
    await chip('big.txt').click()
    await expect.poll(() => panel().locator('.file-preview__notice').textContent().catch(() => '')).toBe('앞 1.0 MB만 보입니다 (전체 1.4 MB)')
    const shown = (await panel().locator('.file-preview__text').textContent())!
    expect(shown.length).toBe(1024 * 1024)
    expect(BIG.startsWith(shown)).toBe(true)

    await chip('bin.dat').click()
    await expect.poll(() => panel().locator('.file-preview__empty').textContent()).toBe('이진 파일이라 미리볼 수 없습니다 (8 B)')
    expect(await panel().locator('.file-preview__notice').count()).toBe(0)
    expect(await panel().locator('.file-preview__text').count()).toBe(0)
  })

  it('칩이 그려진 뒤 파일이 밖을 가리키는 링크로 바뀌면 메인이 거부 — 내용은 화면에 안 온다. 등록 안 된 폴더도 거부', async () => {
    await fs.rm(path.join(project, 'link.ts'))
    await fs.symlink(path.join(outside, 'secret.txt'), path.join(project, 'link.ts'))
    await chip('link.ts').click()
    await expect.poll(() => panel().getByRole('alert').textContent()).toBe('미리볼 수 없는 파일입니다 — 프로젝트 밖이거나 없는 파일입니다')
    expect(await page.content()).not.toContain('TOP-SECRET-OUTSIDE')
    expect(await panel().getByRole('button', { name: 'Finder에서 보기' }).count()).toBe(0) // 못 읽은 파일엔 머리 버튼도 없다
    // 화면이 오염돼 다른 폴더를 물어도 — 등록된 프로젝트가 아니면 읽지 않는다
    expect(await page.evaluate((dir) => window.litecode.previewFile(dir, 'secret.txt'), outside)).toEqual({ status: 'unavailable' })
    expect(await page.evaluate((dir) => window.litecode.previewFile(dir, '../outside/secret.txt'), project)).toEqual({ status: 'unavailable' })
  })

  it('미리보기 패널에는 "다른 앱에서 열기" 버튼이 없다 — 파일을 다른 앱에서 여는 길(openIn:open-file)은 걷었다 (#126)', async () => {
    await chip('src/hello.ts').click()
    await expect.poll(() => panel().locator('.file-preview__path').textContent()).toBe('src/hello.ts')
    expect(await panel().locator('.open-in__split').count()).toBe(0)
    expect(await launches()).toEqual([])
  })

  it('왼쪽 끝을 끌면 폭이 바뀐다 — 대화 칸은 400 이상 남기고(창의 70% 도 넘지 않음), 좁히면 300 까지', async () => {
    const handle = panel().locator('.file-preview__resize')
    async function dragBy(dx: number): Promise<void> {
      const at = (await handle.boundingBox())!
      await page.mouse.move(at.x + at.width / 2, at.y + 200)
      await page.mouse.down()
      await page.mouse.move(at.x + at.width / 2 + dx, at.y + 200, { steps: 4 })
      await page.mouse.up()
    }
    const width = async () => Math.round((await panel().boundingBox())!.width)
    const before = await width()
    await dragBy(-20)
    expect((await width()) - before).toBe(20)
    await dragBy(-5_000)
    expect(Math.round((await page.locator('main.main').boundingBox())!.width)).toBe(400)
    expect(await width()).toBeLessThanOrEqual(Math.round((await page.evaluate(() => window.innerWidth)) * 0.7))
    await dragBy(5_000)
    expect(await width()).toBe(300)
  })

  it('Esc 로 닫히고 누른 칩으로 포커스가 돌아간다, 닫기 버튼도', async () => {
    await chip('src/hello.ts').click()
    await panel().waitFor()
    await page.keyboard.press('Escape')
    await panel().waitFor({ state: 'detached' })
    expect(await page.evaluate(() => document.activeElement?.textContent)).toBe('src/hello.ts')
    await chip('README.md').click()
    await panel().getByRole('button', { name: '닫기 (Esc)' }).click()
    await panel().waitFor({ state: 'detached' })
  })
})
