import { Context } from 'cordis'
import fs from 'node:fs/promises'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ProviderRegistry, type KeyCipher, type ProviderRegistryOptions } from '../../src/services/providers.ts'
import { canSealKeys } from '../../electron/keyStorage.ts'

const config = {
  id: 'gw',
  displayName: 'Gateway',
  baseURL: 'http://gw/v1',
  protocol: 'openai-chat-completions' as const,
  models: [{ id: 'm1', displayName: 'Model 1' }],
}

/** 뒤집기만 하는 가짜 암호 — 평문이 파일에 그대로 안 남는지 볼 수 있을 만큼만 */
const reversing: KeyCipher = {
  available: () => true,
  encrypt: (plain) => Buffer.from([...plain].reverse().join('')),
  decrypt: (sealed) => [...sealed.toString()].reverse().join(''),
}

async function registry(options?: ProviderRegistryOptions): Promise<ProviderRegistry> {
  const ctx = new Context()
  ctx.plugin(ProviderRegistry, options)
  return new Promise((resolve) => ctx.inject(['providers'], (ready) => resolve(ready.providers)))
}

let tmp: string
let files: ProviderRegistryOptions
beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'litecode-providers-'))
  files = { file: path.join(tmp, 'providers.json'), keysFile: path.join(tmp, 'provider-keys.json'), cipher: reversing, defaults: [config] }
})
afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true })
})

describe('ProviderRegistry', () => {
  it('등록한 provider 를 id 로 찾고, 반환된 함수로 등록을 되돌린다', async () => {
    const providers = await registry()
    const unregister = providers.register(config)

    expect(providers.get('gw')).toEqual(config)
    unregister()
    expect(providers.get('gw')).toBeUndefined()
  })

  it('파일이 없으면 기본값으로 시작하고, 저장한 provider 는 다시 열어도 남는다', async () => {
    const first = await registry(files)
    expect(first.list()).toEqual([{ ...config, custom: false, hasKey: false }])

    const saved = first.save({ displayName: 'My Relay', baseURL: 'http://relay/v1', protocol: 'openai-chat-completions', models: [{ id: 'a', displayName: 'A' }] })
    expect(saved.map((provider) => provider.id)).toEqual(['gw', 'my-relay'])

    const second = await registry(files)
    expect(second.list()[1]).toEqual({ id: 'my-relay', displayName: 'My Relay', baseURL: 'http://relay/v1', protocol: 'openai-chat-completions', models: [{ id: 'a', displayName: 'A' }], custom: true, hasKey: false })
  })

  it('키는 암호화해 따로 두고 목록에는 설정 여부만 보인다 — 빈 키로 다시 저장하면 기존 키를 유지한다', async () => {
    const providers = await registry(files)
    providers.save({ ...config, apiKey: 'sk-secret-123' })
    providers.save({ ...config, displayName: 'Renamed' })

    expect(providers.list()[0]).toMatchObject({ displayName: 'Renamed', hasKey: true })
    expect(JSON.stringify(providers.list())).not.toContain('sk-secret-123')
    expect(await fs.readFile(files.file!, 'utf8')).not.toContain('sk-secret-123')
    expect(await fs.readFile(files.keysFile!, 'utf8')).not.toContain('sk-secret-123')
  })

  it('OS 암호화를 못 쓰면 키 저장을 거부하고 아무것도 안 바꾼다 (평문 저장 금지)', async () => {
    const providers = await registry({ ...files, cipher: { ...reversing, available: () => false } })

    expect(() => providers.save({ ...config, displayName: 'X', apiKey: 'sk-1' })).toThrow('안전하게 저장할 수 없')
    expect(providers.list()[0]!.displayName).toBe('Gateway')
  })

  // 03_qa 2차: 헤더에 못 쓰는 문자가 든 키는 키 프록시의 http.request 가 동기로 던져 메인 프로세스를 흔든다 — 저장부터 막는다
  it('헤더에 쓸 수 없는 문자(줄바꿈·제어 문자·보이지 않는 문자·비ASCII)가 든 키는 거부하고, 메시지에 키가 없으며 아무것도 안 바뀐다', async () => {
    const providers = await registry(files)
    for (const bad of ['sk-abc\ndef', 'sk-abc\u0007def', 'sk-abc\u200bdef', 'sk-키값', 'sk-abc\u00a0def']) {
      let message = ''
      try {
        providers.save({ ...config, id: 'gw', displayName: 'X', apiKey: bad })
      } catch (error) {
        message = (error as Error).message
      }
      expect(message).toContain('키에 쓸 수 없는 문자가 섞였습니다')
      expect(message).not.toContain('abc')
    }
    expect(providers.list()[0]).toMatchObject({ displayName: 'Gateway', hasKey: false })
  })

  it('잘못된 입력은 거부한다 — 빈 이름, http(s) 가 아닌 주소, 모델 없음, 겹치는 모델 id', async () => {
    const providers = await registry(files)
    expect(() => providers.save({ ...config, displayName: ' ' })).toThrow('표시 이름')
    expect(() => providers.save({ ...config, baseURL: 'gw/v1' })).toThrow('Base URL')
    expect(() => providers.save({ ...config, models: [] })).toThrow('모델')
    expect(() => providers.save({ ...config, models: [{ id: 'a', displayName: '' }, { id: 'a', displayName: '' }] })).toThrow('겹')
  })

  // 컨텍스트 길이(선택) — opencode 가 custom 모델의 한도를 몰라 설정에서 받는다 (01_probe, 2026-10-01). 통계 줄의 % 에 쓴다
  it('모델의 컨텍스트 길이는 양의 정수일 때만 남고 다시 열어도 그대로다, 비우면 없다', async () => {
    const providers = await registry(files)
    providers.save({ ...config, models: [{ id: 'm1', displayName: 'M', contextLength: 32_768 }, { id: 'm2', displayName: 'N' }] })
    expect((await registry(files)).get('gw')!.models).toEqual([{ id: 'm1', displayName: 'M', contextLength: 32_768 }, { id: 'm2', displayName: 'N' }])
    expect(() => providers.save({ ...config, models: [{ id: 'm1', displayName: 'M', contextLength: -1 }] })).toThrow('컨텍스트 길이')
    expect(() => providers.save({ ...config, models: [{ id: 'm1', displayName: 'M', contextLength: 1.5 }] })).toThrow('컨텍스트 길이')
  })

  // 최대 출력(선택, 이슈 #27) — opencode limit.output → 요청 max_tokens. 컨텍스트 길이보다 작아야 문턱(context − 출력)이 남는다
  it('모델의 최대 출력은 양의 정수이고 컨텍스트 길이보다 작을 때만 남는다, 비우면 없다', async () => {
    const providers = await registry(files)
    providers.save({ ...config, models: [{ id: 'm1', displayName: 'M', contextLength: 24_000, maxOutput: 4_000 }, { id: 'm2', displayName: 'N', maxOutput: 8_000 }] })
    expect((await registry(files)).get('gw')!.models).toEqual([
      { id: 'm1', displayName: 'M', contextLength: 24_000, maxOutput: 4_000 },
      { id: 'm2', displayName: 'N', maxOutput: 8_000 },
    ])
    expect(() => providers.save({ ...config, models: [{ id: 'm1', displayName: 'M', maxOutput: 0 }] })).toThrow('최대 출력')
    expect(() => providers.save({ ...config, models: [{ id: 'm1', displayName: 'M', maxOutput: 2.5 }] })).toThrow('최대 출력')
    expect(() => providers.save({ ...config, models: [{ id: 'm1', displayName: 'M', contextLength: 24_000, maxOutput: 24_000 }] })).toThrow('최대 출력')
  })

  // 이미지 입력(이슈 #44) — 켠 모델만 엔진이 modalities 를 싣는다 (01y). 기본 꺼짐
  it('모델의 이미지 입력은 켰을 때만 남고 다시 열어도 그대로다', async () => {
    const providers = await registry(files)
    providers.save({ ...config, models: [{ id: 'm1', displayName: 'M', imageInput: true }, { id: 'm2', displayName: 'N', imageInput: false }] })
    expect((await registry(files)).get('gw')!.models).toEqual([{ id: 'm1', displayName: 'M', imageInput: true }, { id: 'm2', displayName: 'N' }])
  })

  // 03_qa 1차 재확인 · 리더 결정: 주소를 바꿔 저장하려면 키를 다시 넣어야 한다 — 안 그러면 save → fetch 로 저장 키가 새 주소로 간다
  it('저장 키가 있는 provider 의 Base URL 을 키 없이 바꾸면 저장을 거부하고 파일·키는 그대로다', async () => {
    const providers = await registry(files)
    providers.save({ ...config, apiKey: 'sk-1' })
    const before = [await fs.readFile(files.file!, 'utf8'), await fs.readFile(files.keysFile!, 'utf8')]

    expect(() => providers.save({ ...config, id: 'gw', baseURL: 'http://elsewhere/v1', apiKey: '' })).toThrow('키를 다시 입력하세요')
    expect([await fs.readFile(files.file!, 'utf8'), await fs.readFile(files.keysFile!, 'utf8')]).toEqual(before)
    expect(providers.get('gw')!.baseURL).toBe('http://gw/v1')

    providers.save({ ...config, id: 'gw', baseURL: 'http://gw/v1/ ' }) // 끝 슬래시·공백 차이는 같은 주소
    providers.save({ ...config, id: 'gw', baseURL: 'http://elsewhere/v1', apiKey: 'sk-2' })
    expect(providers.get('gw')!.baseURL).toBe('http://elsewhere/v1')
    expect(await fs.readFile(files.keysFile!, 'utf8')).toContain(JSON.stringify(reversing.encrypt('sk-2').toString('base64')))
  })

  // ctx.engine 이 이 알림으로 opencode 를 다시 띄운다 (설정 변경 = 재시작, 01_probe Q3)
  it('저장·삭제하면 providers/changed 를 알리고, 거부된 저장은 알리지 않는다', async () => {
    const ctx = new Context()
    ctx.plugin(ProviderRegistry, files)
    const ready = await new Promise<Context>((resolve) => ctx.inject(['providers'], (context) => resolve(context)))
    let changes = 0
    ctx.on('providers/changed', () => void changes++)

    ready.providers.save({ ...config, id: 'gw', apiKey: 'k' })
    expect(() => ready.providers.save({ ...config, id: 'gw', displayName: '' })).toThrow()
    ready.providers.remove('gw')
    expect(changes).toBe(2)
  })

  it('삭제하면 목록과 키에서 모두 빠진다', async () => {
    const providers = await registry(files)
    providers.save({ ...config, apiKey: 'sk-1' })
    expect(providers.remove('gw')).toEqual([])
    expect(await fs.readFile(files.keysFile!, 'utf8')).toBe('{}')
    expect((await registry(files)).list()).toEqual([])
  })

  describe('fetchAvailableModels', () => {
    let server: http.Server
    let baseURL: string
    let auth: string | undefined
    beforeEach(async () => {
      server = http.createServer((req, res) => {
        auth = req.headers.authorization
        if (req.url !== '/v1/models') return void res.writeHead(404).end()
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: [{ id: 'x' }, { id: 'y' }] }))
      })
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
      baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
    })
    afterEach(() => new Promise<void>((resolve) => server.close(() => resolve())))

    let requests: number
    beforeEach(() => {
      requests = 0
      server.on('request', () => requests++)
    })

    it('GET {baseURL}/models 의 id 목록을 준다 — 입력한 키는 그 요청에만 싣는다', async () => {
      const providers = await registry(files)
      providers.save({ ...config, apiKey: 'sk-stored' })

      expect(await providers.fetchAvailableModels({ id: 'gw', baseURL, apiKey: 'sk-typed' })).toEqual([
        { id: 'x', displayName: 'x' },
        { id: 'y', displayName: 'y' },
      ])
      expect(auth).toBe('Bearer sk-typed')
    })

    it('저장된 키는 저장된 Base URL 로만 나간다 (끝 슬래시·공백은 같은 주소로 본다)', async () => {
      const providers = await registry(files)
      providers.save({ ...config, baseURL, apiKey: 'sk-stored' })

      await providers.fetchAvailableModels({ id: 'gw', baseURL: ` ${baseURL}/ ` })
      expect(auth).toBe('Bearer sk-stored')
    })

    // 03_qa 차단: 편집에서 주소만 바꾸고 키 칸을 비운 채 가져오면 저장 키가 새 주소로 새던 결함
    it('주소를 바꾸고 키를 안 넣었으면 저장된 키를 싣지 않고 요청 자체를 보내지 않는다', async () => {
      const providers = await registry(files)
      providers.save({ ...config, apiKey: 'sk-stored' }) // 저장 주소는 http://gw/v1

      await expect(providers.fetchAvailableModels({ id: 'gw', baseURL, apiKey: '' })).rejects.toThrow('키를 다시 입력하세요')
      expect(requests).toBe(0)
    })

    it('응답이 실패면 상태 코드로 알린다', async () => {
      const providers = await registry(files)
      await expect(providers.fetchAvailableModels({ baseURL: `${baseURL}/nope` })).rejects.toThrow('404')
    })
  })
})

// 03_qa 경고 · 리더 결정: 키링 없는 Linux 에서 Electron 은 고정 비밀번호(basic_text)로도 "사용 가능" 이라 답한다 — 난독화일 뿐이라 거부
describe('canSealKeys', () => {
  it('Linux 의 basic_text 백엔드는 쓸 수 없는 것으로 친다', () => {
    expect(canSealKeys('linux', true, 'basic_text')).toBe(false)
    expect(canSealKeys('linux', true, 'gnome_libsecret')).toBe(true)
  })

  it('암호화를 못 쓰면 어느 OS 든 false, macOS·Windows 는 백엔드를 안 본다', () => {
    expect(canSealKeys('darwin', false)).toBe(false)
    expect(canSealKeys('darwin', true)).toBe(true)
    expect(canSealKeys('win32', true)).toBe(true)
  })
})
