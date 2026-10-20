import fs from 'node:fs'
import { describe, expect, it } from 'vitest'
import { Channel } from '../../shared/ipc.ts'

// 확장 IPC (이슈 #482) — 채널은 shared/ipc.ts · electron/preload.cts(CJS 라 손으로 옮긴 복사본) · electron/main.ts(브리지) 세 곳에 있다.
// 이름 대조는 preloadChannels.test.ts 가 한다. 여기는 채널마다 반대쪽이 실제로 있는지 — preload 가 부르고 main 이 받는지(또는 main 이 보내고
// preload 가 듣는지) — 를 글자로 본다. 빠지면 typecheck 는 초록인데 런타임에 "No handler registered" 로 그 채널만 죽는다

const read = (file: string) => fs.readFileSync(new URL(file, import.meta.url), 'utf8')
const preload = read('../../electron/preload.cts')
const main = read('../../electron/main.ts')

const keys = (Object.keys(Channel) as (keyof typeof Channel)[]).filter((key) => key.startsWith('EXTENSIONS_'))
const requests = keys.filter((key) => key !== 'EXTENSIONS_CHANGED')

/** main.ts 의 extensionsBridge 본문 */
function bridgeBody(): string {
  const body = /^function extensionsBridge\(ctx: Context\): void \{\n([\s\S]*?)^\}/m.exec(main)
  if (!body) throw new Error('main.ts 에서 extensionsBridge 를 찾지 못했다')
  return body[1]!
}

describe('확장 IPC 채널', () => {
  it('설계의 채널이 다 있다', () => {
    expect(keys.map((key) => Channel[key]).sort()).toEqual(
      [
        'extensions:allow-origin',
        'extensions:call',
        'extensions:cancel',
        'extensions:changed',
        'extensions:install',
        'extensions:list',
        'extensions:pick',
        'extensions:read-entry',
        'extensions:read-locale',
        'extensions:remove',
        'extensions:revoke-origin',
        'extensions:set-enabled',
      ],
    )
  })

  it('read-entry (이슈 #511) — preload 는 id 를 넘기고, 브리지는 문자열로 바꿔 ctx.extensions.readEntry 에 맡긴다', () => {
    expect(preload).toMatch(/readExtensionEntry: \(id\) => ipcRenderer\.invoke\(Channel\.EXTENSIONS_READ_ENTRY, id\)/)
    expect(bridgeBody()).toMatch(/handle\(ctx, Channel\.EXTENSIONS_READ_ENTRY, async \(_event, id: unknown\) => ctx\.extensions\.readEntry\(String\(id\)\)\)/)
  })

  it('read-locale (이슈 #525) — preload 는 language 를 넘기고, 브리지는 문자열로 바꿔 ctx.extensions.readLocale 에 맡긴다', () => {
    expect(preload).toMatch(/readLocalePack: \(language\) => ipcRenderer\.invoke\(Channel\.EXTENSIONS_READ_LOCALE, language\)/)
    expect(bridgeBody()).toMatch(/handle\(ctx, Channel\.EXTENSIONS_READ_LOCALE, async \(_event, language: unknown\) => ctx\.extensions\.readLocale\(String\(language\)\)\)/)
  })

  it('call (이슈 #536) — 프로젝트는 등록된 것만 이름과 함께 넘긴다(화면이 준 폴더를 그대로 믿지 않는다)', () => {
    expect(preload).toMatch(/callExtension: \(id, method, params, directory\) => ipcRenderer\.invoke\(Channel\.EXTENSIONS_CALL, id, method, params, directory\)/)
    const body = bridgeBody()
    expect(body).toMatch(/\(await ctx\.projects\.list\(\)\)\.find\(\(project\) => project\.path === directory\)/)
    expect(body).toMatch(/ctx\.extensions\.call\(String\(id\), String\(method\), params, found && \{ directory: found\.path, name: found\.name \}\)/)
  })

  it('요청 채널마다 preload 가 invoke 하고 main 의 브리지가 handle 한다', () => {
    const body = bridgeBody()
    for (const key of requests) {
      expect(preload, key).toMatch(new RegExp(`ipcRenderer\\.invoke\\(Channel\\.${key}\\b`))
      expect(body, key).toMatch(new RegExp(`handle\\(ctx, Channel\\.${key},`))
    }
  })

  it('바뀜 이벤트는 main 이 broadcast 하고 preload 가 듣는다', () => {
    expect(bridgeBody()).toMatch(/ctx\.on\('extensions\/changed', \(extensions\) => broadcast\(Channel\.EXTENSIONS_CHANGED, extensions\)\)/)
    expect(preload).toMatch(/listen\(Channel\.EXTENSIONS_CHANGED, listener\)/)
  })

  it('broadcast 는 창마다 send 를 감싼다 — 창 하나의 실패가 나머지 창과 서비스 쪽으로 번지지 않는다 (QA 03_qa_ext_pr3)', () => {
    const body = /^function broadcast\(channel: string, \.\.\.args: unknown\[\]\): void \{\n([\s\S]*?)^\}/m.exec(main)?.[1]
    expect(body).toMatch(/for \(const win of BrowserWindow\.getAllWindows\(\)\) \{\s*try \{\s*win\.webContents\.send\(channel, \.\.\.args\)\s*\} catch/)
  })

  it('브리지는 inject 로 extensions 를 기다리고, 기능 묶음이 아니라 바탕으로 올라간다 (부팅 진단 목록에도)', () => {
    expect(main).toMatch(/^extensionsBridge\.inject = \['extensions', 'projects'\]$/m)
    expect(main).toMatch(/^mounted\.push\(ctx\.plugin\(extensionsBridge\)\)$/m)
    expect(main).toMatch(/\.\.\.extensionsBridge\.inject/)
  })
})
