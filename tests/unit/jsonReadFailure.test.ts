import { Context, Service } from 'cordis'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readJsonFile, readJsonFileSync } from '../../src/services/jsonFile.ts'
import { McpService } from '../../src/services/mcp.ts'
import { ProjectsService } from '../../src/services/projects.ts'
import { ProviderRegistry } from '../../src/services/providers.ts'
import { DeviceStore, hashToken } from '../../src/services/remote/devices.ts'
import { loadNoiseIdentity } from '../../src/services/remote/noiseIdentity.ts'
import { loadTlsIdentity } from '../../src/services/remote/tlsIdentity.ts'
import { SessionsService } from '../../src/services/sessions.ts'
import { SettingsService } from '../../src/services/settings.ts'
import { box, setUp, start, tearDown } from './support/remoteHarness.ts'

// 이슈 #195 (01am B3) — 읽기 실패(권한·잠김·폴더)를 "파일 없음" 과 똑같이 보면 다음 쓰기가 원본을 덮는다:
// 대화 목록이 사라지고, TLS·블루투스 키가 새로 만들어져 짝지은 폰이 전부 지문 불일치가 된다.
// 규칙: ENOENT 만 "없음". 그 밖의 읽기 실패는 던지고, 부르는 서비스는 기본값으로 뜨되 그 파일을 덮지 않는다(쓰기 거절).
// 재현은 chmod 000 — root 는 권한을 무시하고, Windows 는 chmod 가 읽기를 막지 않는다
const canDenyRead = process.platform !== 'win32' && process.getuid?.() !== 0

let root: string
/** chmod 000 으로 막은 파일 — 끝나면 풀어 준다 (지우기 전에) */
let locked: string[] = []
beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'litecode-jsonread-')))
  locked = []
})
afterEach(async () => {
  for (const file of locked) await fs.chmod(file, 0o600).catch(() => {})
  await fs.rm(root, { recursive: true, force: true })
})

async function lock(file: string): Promise<void> {
  await fs.chmod(file, 0o000)
  locked.push(file)
}

async function unlockAndRead(file: string): Promise<string> {
  await fs.chmod(file, 0o600)
  return fs.readFile(file, 'utf8')
}

class FakeLlm extends Service {
  constructor(ctx: Context) {
    super(ctx, 'llm')
  }
  async deleteSession(): Promise<void> {}
  purgeDeleted(): void {}
  hideMcpTools(): void {}
}

describe.skipIf(!canDenyRead)('jsonFile — 읽기 실패는 "없음" 이 아니다', () => {
  it('권한으로 못 읽으면 동기·비동기 모두 던진다 (EACCES) — 파일은 옮기지 않는다', async () => {
    const file = path.join(root, 'a.json')
    await fs.writeFile(file, '{"a":1}')
    await lock(file)
    expect(() => readJsonFileSync(file, 'object')).toThrow(expect.objectContaining({ code: 'EACCES' }))
    await expect(readJsonFile(file, 'object')).rejects.toMatchObject({ code: 'EACCES' })
    expect(await fs.readdir(root)).toEqual(['a.json'])
    expect(await unlockAndRead(file)).toBe('{"a":1}')
  })

  it('파일 자리에 폴더가 있으면 던진다 (EISDIR) — 없음도 깨짐도 아니다', async () => {
    const file = path.join(root, 'b.json')
    await fs.mkdir(file)
    expect(() => readJsonFileSync(file, 'object')).toThrow(expect.objectContaining({ code: 'EISDIR' }))
    await expect(readJsonFile(file, 'object')).rejects.toMatchObject({ code: 'EISDIR' })
  })
})

describe.skipIf(!canDenyRead)('서비스 — 못 읽은 파일을 덮지 않는다', () => {
  it('sessions: 못 읽는 사이 저장은 실패하고 기존 대화 목록은 남는다. 목록 읽기는 빈 목록으로 (앱 시작을 막지 않는다)', async () => {
    const file = path.join(root, 'sessions.json')
    const old = [1, 2, 3].map((n) => ({ id: `c${n}`, project: '/p', title: `t${n}`, updatedAt: n }))
    const raw = JSON.stringify({ conversations: old, orphans: [], viewed: {} })
    await fs.writeFile(file, raw)
    await lock(file)

    const ctx = new Context()
    ctx.plugin(FakeLlm)
    ctx.plugin(SessionsService, { file })
    const sessions = await new Promise<SessionsService>((resolve) => ctx.inject(['sessions'], (ready) => resolve(ready.sessions)))
    expect(await sessions.list()).toEqual([])
    expect(await sessions.lastViewed()).toEqual({})
    await expect(sessions.save({ id: 'c4', project: '/p', title: 't4', updatedAt: 4 })).rejects.toThrow('sessions.json')

    expect(await unlockAndRead(file)).toBe(raw)
    // 다시 읽을 수 있으면 원래대로 이어 쓴다
    await sessions.save({ id: 'c4', project: '/p', title: 't4', updatedAt: 4 })
    expect((await sessions.list()).map((entry) => entry.id).sort()).toEqual(['c1', 'c2', 'c3', 'c4'])
  })

  it('projects: 못 읽는 사이 열기는 실패하고 최근 목록은 남는다. 목록 읽기는 빈 목록으로', async () => {
    const file = path.join(root, 'projects.json')
    const raw = JSON.stringify({ recent: [root], favorites: [], names: {} })
    await fs.writeFile(file, raw)
    await lock(file)

    const ctx = new Context()
    ctx.plugin(ProjectsService, { file })
    const projects = await new Promise<ProjectsService>((resolve) => ctx.inject(['projects'], (ready) => resolve(ready.projects)))
    expect(await projects.list()).toEqual([])
    const other = path.join(root, 'other')
    await fs.mkdir(other)
    await expect(projects.open(other)).rejects.toThrow('projects.json')
    expect(await unlockAndRead(file)).toBe(raw)
  })

  it('TLS 키: 못 읽으면 새 키를 만들지 않고 던진다 — 다시 읽히면 같은 지문', async () => {
    const file = path.join(root, 'remote-tls-key.json')
    const first = await loadTlsIdentity(file)
    const raw = await fs.readFile(file, 'utf8')
    await lock(file)
    await expect(loadTlsIdentity(file)).rejects.toMatchObject({ code: 'EACCES' })
    expect(await unlockAndRead(file)).toBe(raw)
    expect((await loadTlsIdentity(file)).fingerprint).toBe(first.fingerprint)
  })

  it('블루투스 키: 못 읽으면 새 키를 만들지 않고 던진다 — 다시 읽히면 같은 공개키', async () => {
    const file = path.join(root, 'remote-noise-key.json')
    const first = await loadNoiseIdentity(file)
    const raw = await fs.readFile(file, 'utf8')
    await lock(file)
    await expect(loadNoiseIdentity(file)).rejects.toMatchObject({ code: 'EACCES' })
    expect(await unlockAndRead(file)).toBe(raw)
    expect((await loadNoiseIdentity(file)).publicKeyText).toBe(first.publicKeyText)
  })

  it('기기 목록(DeviceStore): 못 읽으면 빈 목록으로 뜨되 짝짓기 저장은 실패하고 파일은 남는다', async () => {
    const file = path.join(root, 'remote-devices.json')
    const raw = JSON.stringify({ version: 1, desktopId: '0123456789abcdef', devices: [{ id: 'dev_old', name: 'Old', platform: 'android', tokenHash: hashToken('t'), pairedAt: 1 }] })
    await fs.writeFile(file, raw)
    await lock(file)
    const store = new DeviceStore(file)
    await store.load()
    expect(store.unreadable).toMatchObject({ code: 'EACCES' })
    expect(store.list()).toEqual([])
    await expect(store.add('New', 'android')).rejects.toThrow('remote-devices.json')
    expect(await unlockAndRead(file)).toBe(raw)
  })

  it('providers: 못 읽어도 서비스는 뜬다(기본값) — 저장은 거절하고 두 파일 모두 남는다', async () => {
    const file = path.join(root, 'providers.json')
    const keysFile = path.join(root, 'provider-keys.json')
    const raw = JSON.stringify([{ id: 'gw', displayName: 'GW', baseURL: 'http://gw', protocol: 'openai', models: [{ id: 'm', displayName: 'm' }] }])
    await fs.writeFile(file, raw)
    await fs.writeFile(keysFile, '{"gw":"sealed"}')
    await lock(file)

    const ctx = new Context()
    ctx.plugin(ProviderRegistry, { file, keysFile, defaults: [] })
    const providers = await new Promise<ProviderRegistry>((resolve) => ctx.inject(['providers'], (ready) => resolve(ready.providers)))
    expect(providers.all()).toEqual([])
    expect(() => providers.save({ displayName: 'X', baseURL: 'http://x', protocol: 'openai-chat-completions', models: [{ id: 'm', displayName: 'm' }] })).toThrow('providers.json')
    expect(() => providers.remove('gw')).toThrow('providers.json')
    expect(await unlockAndRead(file)).toBe(raw)
    expect(await fs.readFile(keysFile, 'utf8')).toBe('{"gw":"sealed"}')
  })

  it('settings: 못 읽어도 서비스는 뜬다(기본값) — 바꾸기는 거절하고 파일은 남는다', async () => {
    const file = path.join(root, 'settings.json')
    const raw = '{\n  "language": "ko"\n}\n'
    await fs.writeFile(file, raw)
    await lock(file)

    const ctx = new Context()
    ctx.plugin(SettingsService, { file })
    const settings = await new Promise<SettingsService>((resolve) => ctx.inject(['settings'], (ready) => resolve(ready.settings)))
    expect(settings.get().language).toBe('en') // 기본값
    expect(() => settings.set({ language: 'ko' })).toThrow('settings.json')
    expect(settings.get().language).toBe('en') // 거절한 값은 메모리에도 안 든다
    expect(await unlockAndRead(file)).toBe(raw)
  })

  it('mcp: 못 읽어도 서비스는 뜬다(빈 목록) — 저장은 거절하고 세 파일 모두 남는다', async () => {
    const file = path.join(root, 'mcp.json')
    const secretsFile = path.join(root, 'mcp-secrets.json')
    const projectsFile = path.join(root, 'mcp-projects.json')
    const raw = JSON.stringify([{ name: 'wiki', type: 'remote', url: 'http://127.0.0.1:9/mcp', vars: [] }])
    await fs.writeFile(file, raw)
    await fs.writeFile(secretsFile, '{}')
    await fs.writeFile(projectsFile, '{}')
    await lock(secretsFile)

    const ctx = new Context()
    ctx.plugin(FakeLlm)
    ctx.plugin(McpService, { file, secretsFile, projectsFile, env: {}, fallbackCwd: root })
    const mcp = await new Promise<McpService>((resolve) => ctx.inject(['mcp'], (ready) => resolve(ready.mcp)))
    expect(() => mcp.setEnabled('wiki', false, root)).toThrow('mcp-secrets.json')
    expect(() => mcp.remove('wiki')).toThrow('mcp-secrets.json')
    expect(await fs.readFile(file, 'utf8')).toBe(raw)
    expect(await fs.readFile(projectsFile, 'utf8')).toBe('{}')
    expect(await unlockAndRead(secretsFile)).toBe('{}')
  })
})

describe.skipIf(!canDenyRead)('ctx.remote — 기기 목록을 못 읽으면', () => {
  beforeEach(setUp)
  afterEach(async () => {
    await fs.chmod(path.join(box.root, 'remote-devices.json'), 0o600).catch(() => {})
    await tearDown()
  })

  it('짝지은 폰에 401(해제됨) 대신 503 — 폰이 짝짓기를 버리지 않는다. 짝짓기도 503, 사유는 status().error', async () => {
    const file = path.join(box.root, 'remote-devices.json')
    const device = { id: 'dev_old', name: 'Old Phone', platform: 'android', tokenHash: hashToken('old-token'), pairedAt: 1 }
    const raw = JSON.stringify({ version: 1, desktopId: '0123456789abcdef', devices: [device] })
    await fs.writeFile(file, raw)
    await fs.chmod(file, 0o000)
    const { remote, api } = await start()
    expect((await api('GET', '/v1/hello', { token: 'old-token' })).status).toBe(503)
    expect((await api('GET', '/v1/hello', { token: 'nope' })).status).toBe(503)
    expect((await api('POST', '/v1/pair', { body: { code: 'x', deviceName: 'P', platform: 'android' } })).status).toBe(503)
    expect(remote.status().error).toMatchObject({ code: 'EACCES' })
    await fs.chmod(file, 0o600)
    expect(await fs.readFile(file, 'utf8')).toBe(raw)
  })
})
