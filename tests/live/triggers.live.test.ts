import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core'
import { createServer, type ViteDevServer } from 'vite'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import { freePort, isolatedEnv } from './support/opencodeServer.ts'

// 입력창 트리거 실물 테스트 — 진짜 Electron 창에서 `@`·`/`·`!` 를 친다. 렌더러 → preload → IPC → ctx.triggers → 플러그인 →
// ctx.llm/ctx.shell/ctx.terminals → opencode(fs·command·pty) → (가짜) LLM 을 관통한다. 자기 앱·userData·프로젝트를 따로 띄워 다른 실물 테스트
// 순서에 기대지 않는다. 가짜로 두는 것은 OS 폴더 대화상자와 LLM 뿐이다.
// 명령 파일(.opencode/command/hi.md)은 앱을 띄우기 전에 둔다 — opencode 는 명령 목록을 폴더별로 캐시해 재시작 전엔 새 파일을 못 본다 (01d).

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

let vite: ViteDevServer
let devServerUrl: string
let app: ElectronApplication
let page: Page
/** 이 테스트가 만든 임시 폴더 — 끝나면 이것만 지운다 */
let tmp: string
let userData: string
let project: string

async function launch(): Promise<void> {
  app = await electron.launch({
    args: ['.', `--user-data-dir=${userData}`, '--use-mock-keychain'],
    cwd: root,
    env: { ...isolatedEnv(tmp), LITECODE_TEST_HIDDEN: '1', LITECODE_DEV_SERVER_URL: devServerUrl, LITECODE_GATEWAY_URL: `${inject('fakeLlmUrl')}/v1` },
  })
  page = await app.firstWindow()
  await page.locator('.sidebar-toggle:visible').waitFor()
}

beforeAll(async () => {
  execFileSync(path.join(root, 'node_modules/.bin/tsc'), ['-p', 'tsconfig.electron.json'], { cwd: root, stdio: 'inherit' })

  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'litecode-triggers-')))
  userData = path.join(tmp, 'userData')
  project = path.join(tmp, 'trig-app')
  await fs.mkdir(path.join(project, 'src', 'deep'), { recursive: true })
  await fs.mkdir(path.join(project, 'sp ace'))
  await fs.mkdir(path.join(project, '.opencode', 'command'), { recursive: true })
  await fs.writeFile(path.join(project, 'src', 'alpha.ts'), 'export const alpha = 1\n')
  await fs.writeFile(path.join(project, 'src', 'deep', 'beta.md'), '# beta\n')
  await fs.writeFile(path.join(project, 'sp ace', 'note.md'), 'note\n')
  await fs.writeFile(path.join(project, '.opencode', 'command', 'hi.md'), '---\ndescription: say hi\n---\nSay $ARGUMENTS first=$1\n')

  const port = await freePort()
  vite = await createServer({ configFile: path.join(root, 'vite.config.ts'), server: { port, strictPort: true } })
  await vite.listen()
  devServerUrl = `http://localhost:${port}`

  await launch()
  // 폴더 대화상자 대신 프로젝트를 고른 것으로
  await app.evaluate(({ dialog }, picked) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [picked] })) as typeof dialog.showOpenDialog
  }, project)
  await page.locator('.open-guide').getByRole('button', { name: '폴더 열기…' }).click()
  await input().waitFor({ timeout: 10_000 })
})

afterAll(async () => {
  await app?.close()
  await vite?.close()
  if (tmp) await fs.rm(tmp, { recursive: true, force: true })
})

const input = () => page.getByPlaceholder('메시지를 입력하세요…')
const menu = () => page.getByRole('listbox', { name: '입력 후보' })
const options = () => menu().getByRole('option')
const replies = () => page.locator('.bubble--assistant')
const cards = () => page.locator('.shell-card')
const value = () => input().inputValue()
const fakeLlm = async () =>
  (await (await fetch(`${inject('fakeLlmUrl')}/requests`)).json()) as { count: number; lastChat?: { messages: { role: string; text: string }[] }; lastChatText: string }

/** 입력을 비우고 사람처럼 친다 (fill 은 캐럿 이벤트를 안 낸다) */
async function typeFresh(text: string): Promise<void> {
  await input().fill('')
  await input().focus()
  await page.keyboard.type(text)
}

/** Enter 로 내고 새 답 말풍선을 기다린다 */
async function enterAndWait(): Promise<string> {
  const before = await replies().count()
  await page.keyboard.press('Enter')
  await expect.poll(() => replies().count(), { timeout: 30_000 }).toBe(before + 1)
  return (await replies().last().textContent()) ?? ''
}

describe('입력 트리거 ↔ 실물 opencode', () => {
  it('@ 를 치면 프로젝트 맨 위 폴더 목록이 뜨고, 폴더에서 Tab 을 누르면 그 안으로 들어간다 (.git·폴더 밖은 없다)', async () => {
    await typeFresh('@')
    await expect.poll(() => options().allTextContents(), { timeout: 10_000 }).toEqual(
      expect.arrayContaining([expect.stringContaining('src/'), expect.stringContaining('sp ace/')]),
    )
    await options().filter({ hasText: /^src\// }).hover()
    await page.keyboard.press('Tab')
    expect(await value()).toBe('@src/')
    await expect.poll(() => options().allTextContents(), { timeout: 10_000 }).toEqual(
      expect.arrayContaining([expect.stringContaining('alpha.ts'), expect.stringContaining('deep/')]),
    )
    // Esc 는 메뉴만 닫는다 — 쓰던 글은 그대로
    await page.keyboard.press('Escape')
    await expect.poll(() => menu().count()).toBe(0)
    expect(await value()).toBe('@src/')
  })

  it('@ 로 고른 파일은 경로 텍스트로만 가고(prompt.files 없음), 같은 세션의 다음 턴도 성공한다', async () => {
    // 퍼지 색인은 새 파일을 몇 초 늦게 잡는다 (01d) — 잡힐 때까지 다시 친다
    await expect
      .poll(
        async () => {
          await typeFresh('@alpha')
          await page.waitForTimeout(500)
          return options().allTextContents()
        },
        { timeout: 30_000 },
      )
      .toEqual(expect.arrayContaining([expect.stringContaining('alpha.ts')]))
    await options().filter({ hasText: 'alpha.ts' }).first().hover()
    await page.keyboard.press('Enter')
    expect(await value()).toBe('@src/alpha.ts ')
    await page.keyboard.type('봐 줘')
    expect(await enterAndWait()).toBe('echo: @src/alpha.ts 봐 줘')

    await typeFresh('두 번째')
    expect(await enterAndWait()).toBe('echo: 두 번째') // files 독약이면 여기서 같은 오류로 실패한다 (01d)
  })

  it('공백 있는 경로는 @"…" 로 들어간다', async () => {
    await typeFresh('@"sp ace/')
    await expect.poll(() => options().allTextContents(), { timeout: 10_000 }).toEqual([expect.stringContaining('note.md')])
    await page.keyboard.press('Enter')
    expect(await value()).toBe('@"sp ace/note.md" ')
  })

  it('/ 는 그 폴더의 명령을 보이고, /hi world 는 template 을 풀어 보내되 말풍선엔 친 글 그대로다', async () => {
    await page.getByRole('button', { name: '+ 새 대화' }).click()
    await typeFresh('/h')
    await expect.poll(() => options().allTextContents(), { timeout: 10_000 }).toEqual(expect.arrayContaining([expect.stringContaining('/hi')]))
    await options().filter({ hasText: '/hi' }).hover()
    await page.keyboard.press('Enter')
    expect(await value()).toBe('/hi ')
    await page.keyboard.type('world')

    expect(await enterAndWait()).toBe('echo: Say world first=world')
    expect(await page.locator('.bubble--user').last().textContent()).toBe('/hi world')
    expect(await page.locator('.main__header').textContent()).toBe('/hi world')
    const users = (await fakeLlm()).lastChat!.messages.filter((message) => message.role === 'user')
    expect(users.at(-1)!.text.trim()).toBe('Say world first=world')
  })

  it('모르는 /xxx 는 보내지 않고 알린다 — 입력은 그대로', async () => {
    const before = (await fakeLlm()).count
    await typeFresh('/nope 인자')
    await page.keyboard.press('Enter')
    await expect.poll(() => page.getByRole('alert').textContent(), { timeout: 10_000 }).toContain('모르는 명령입니다: /nope')
    expect(await value()).toBe('/nope 인자')
    expect((await fakeLlm()).count).toBe(before)
  })

  it('! 로 시작하면 입력 카드가 경고색이 되고, Enter 로 프로젝트 폴더에서 돌아 대화에 결과 카드로 남는다 — LLM 은 안 부르고 터미널 칸도 안 열린다', async () => {
    const before = (await fakeLlm()).count
    await typeFresh('!echo LITE-$((6*7)); pwd')
    await expect.poll(() => page.locator('.composer__box--danger').count(), { timeout: 10_000 }).toBe(1)
    // 클래스만 붙고 색이 안 보이던 적이 있다 (styles.css 의 .composer__box 그림자가 덮음) — 실제 그려진 테두리 색을 본다
    expect(await page.locator('.composer__box--danger').evaluate((box) => getComputedStyle(box).boxShadow)).toContain('rgb(229, 72, 77)')
    expect(await page.getByRole('status').textContent()).toContain('셸')
    await page.keyboard.press('Enter')

    const card = cards().last()
    await expect.poll(() => card.locator('.shell-card__badge').textContent(), { timeout: 20_000 }).toBe('종료 코드 0')
    expect(await card.locator('.shell-card__command').textContent()).toBe('echo LITE-$((6*7)); pwd')
    expect(await card.locator('.shell-card__output').textContent()).toContain('LITE-42')
    expect(await card.locator('.shell-card__output').textContent()).toContain(project)
    expect(await card.getByRole('button', { name: 'AI 에게 보내기' }).isEnabled()).toBe(true)
    expect(await value()).toBe('')
    expect(await page.locator('.shell-drawer').count()).toBe(0)
    expect((await fakeLlm()).count).toBe(before)
  })

  it('셸 결과는 대화 맥락에 안 들어간다 — 다음 질문의 LLM 요청에 없다', async () => {
    await typeFresh('셸 다음 질문')
    expect(await enterAndWait()).toBe('echo: 셸 다음 질문')
    expect((await fakeLlm()).lastChatText).not.toContain('LITE-42')
  })

  it('"AI 에게 보내기" 를 누르면 LLM 은 안 돌고 "보냄" 이 되며, 다음 질문의 LLM 요청에 명령·출력이 실린다', async () => {
    const before = (await fakeLlm()).count
    const card = cards().filter({ hasText: 'LITE-42' })
    await card.getByRole('button', { name: 'AI 에게 보내기' }).click()
    await expect.poll(() => card.locator('.shell-card__share').textContent(), { timeout: 10_000 }).toBe('보냄')
    expect(await card.locator('.shell-card__share').isDisabled()).toBe(true)
    expect((await fakeLlm()).count).toBe(before)

    await typeFresh('보낸 뒤 질문')
    expect(await enterAndWait()).toBe('echo: 보낸 뒤 질문')
    const sent = (await fakeLlm()).lastChatText
    expect(sent).toContain('$ echo LITE-$((6*7)); pwd')
    expect(sent).toContain('LITE-42')
    expect(sent).toContain('exit code 0')
    expect(await page.locator('.bubble--user').allTextContents()).not.toContain(expect.stringContaining('LITE-42')) // 말풍선으로 새지 않는다
  })

  it('그 대화의 턴이 도는 동안 "AI 에게 보내기" 는 막혀 있고(이유 툴팁), 턴이 끝나면 풀린다', async () => {
    await typeFresh('!echo BUSY-1')
    await page.keyboard.press('Enter')
    const card = cards().filter({ hasText: 'BUSY-1' })
    await expect.poll(() => card.locator('.shell-card__badge').textContent(), { timeout: 20_000 }).toBe('종료 코드 0')
    const share = card.getByRole('button', { name: 'AI 에게 보내기' })
    expect(await share.isEnabled()).toBe(true)

    await typeFresh('[drip] 턴 도는 중')
    const replied = enterAndWait()
    await expect.poll(() => share.isDisabled(), { timeout: 5_000 }).toBe(true)
    expect(await share.locator('..').getAttribute('title')).toContain('답을 기다리는 중')
    await replied
    await expect.poll(() => share.isEnabled(), { timeout: 5_000 }).toBe(true)
  })

  it('돌고 있는 명령은 ■ 로 멈춘다', async () => {
    await typeFresh('!sleep 30; echo NEVER')
    await page.keyboard.press('Enter')
    const card = cards().last()
    await expect.poll(() => card.locator('.shell-card__badge').textContent(), { timeout: 10_000 }).toBe('실행 중')
    await card.getByRole('button', { name: '중단' }).click()
    await expect.poll(() => card.locator('.shell-card__badge').textContent(), { timeout: 10_000 }).toBe('중단됨')
    expect(await card.locator('.shell-card__output').textContent()).not.toContain('NEVER')
  })

  it('터미널 칸: ⌘↓ 로 펴서 키가 칸으로 내려가고, ⌘↑ 로 접혀 입력창으로 올라온다. 다시 펴면 앞 출력이 남아 있다', async () => {
    await input().focus()
    await page.keyboard.press('Meta+ArrowDown')
    const screen = page.locator('.shell-drawer .xterm-rows')
    await expect.poll(() => page.locator('.shell-drawer').count(), { timeout: 5_000 }).toBe(1)
    await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest('.shell-drawer')), { timeout: 5_000 }).toBe(true)
    await expect.poll(() => screen.textContent(), { timeout: 20_000 }).not.toBe('') // 프롬프트가 뜰 때까지
    await page.keyboard.type('echo KEYS-$((3+4))')
    await page.keyboard.press('Enter')
    await expect.poll(() => screen.textContent(), { timeout: 20_000 }).toContain('KEYS-7')

    await page.keyboard.press('Meta+ArrowUp')
    await expect.poll(() => page.locator('.shell-drawer').count(), { timeout: 5_000 }).toBe(0)
    expect(await page.evaluate(() => (document.activeElement as HTMLTextAreaElement | null)?.placeholder)).toBe('메시지를 입력하세요…')

    await page.keyboard.press('Meta+ArrowDown')
    await expect.poll(() => screen.textContent(), { timeout: 20_000 }).toContain('KEYS-7')
    await page.keyboard.press('Meta+ArrowUp')
  })

  it('앱을 껐다 켜서 /hi 대화를 다시 열어도 말풍선은 /hi world 다', async () => {
    await app.close()
    await launch()
    await page.locator('.session-item__main', { hasText: '/hi world' }).click()
    await expect.poll(() => page.locator('.bubble--user').first().textContent({ timeout: 1_000 }), { timeout: 20_000 }).toBe('/hi world')
    expect(await replies().first().textContent()).toBe('echo: Say world first=world')
  })

  it('다시 켜도 `!` 카드가 제자리에 남는다 — 보낸 카드는 "보냄", 맥락에 넣은 본문은 말풍선으로 안 보인다', async () => {
    const sent = cards().filter({ hasText: 'LITE-42' })
    await expect.poll(() => sent.locator('.shell-card__share').textContent(), { timeout: 20_000 }).toBe('보냄')
    expect(await cards().filter({ hasText: 'BUSY-1' }).locator('.shell-card__share').textContent()).toBe('AI 에게 보내기')
    expect(await cards().filter({ hasText: 'sleep 30' }).locator('.shell-card__badge').textContent()).toBe('중단됨')
    const users = await page.locator('.bubble--user').allTextContents()
    expect(users).toEqual(['/hi world', '셸 다음 질문', '보낸 뒤 질문', '[drip] 턴 도는 중'])
    // 자리: LITE-42 카드는 "셸 다음 질문" 바로 앞
    const order = await page.locator('.shell-card, .bubble--user').evaluateAll((elements) =>
      elements.map((element) => (element.classList.contains('shell-card') ? `card:${element.querySelector('.shell-card__command')?.textContent}` : element.textContent)),
    )
    expect(order.slice(0, 3)).toEqual(['/hi world', 'card:echo LITE-$((6*7)); pwd', '셸 다음 질문'])
  })
})
